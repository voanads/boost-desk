// System health: server, database, background jobs, outside services, recent errors — and Telegram
// alerts to the owner when something serious happens. Kept in memory (resets when the server restarts),
// except the alert chat and alert state, which are saved.
const os = require('os');

const startedAt = Date.now();

// ---------- recent errors ----------
const errors = [];
function noteError(where, err) {
  const msg = String((err && (err.message || err)) || 'Unknown error').replace(/access_token=[^&\s]+/g, 'access_token=…').slice(0, 300);
  errors.unshift({ at: new Date().toISOString(), where: String(where || '').slice(0, 60), message: msg });
  if (errors.length > 50) errors.length = 50;
}
// Everything logged with console.error is kept too.
const origErr = console.error.bind(console);
console.error = (...args) => {
  try {
    const text = args.map((a) => (a instanceof Error ? a.message : typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
    const m = text.match(/^\[([^\]]{1,60})\]\s*(.*)$/s);
    noteError(m ? m[1] : 'server', m ? m[2] : text);
  } catch (_) { /* never break logging */ }
  origErr(...args);
};
process.on('unhandledRejection', (e) => { noteError('unhandled', e); });

// ---------- background jobs ----------
// name → { every (minutes), schedule (text), lastStart, lastEnd, ok, error, ms, runs, fails, running }
const jobs = {};
function register(name, every, schedule) { jobs[name] = jobs[name] || { name, every, schedule, runs: 0, fails: 0, failStreak: 0 }; }
async function track(name, fn) {
  const j = jobs[name] || (register(name, 0, ''), jobs[name]);
  j.lastStart = new Date().toISOString(); j.running = true; const t = Date.now();
  try { const r = await fn(); j.ok = true; j.error = ''; j.failStreak = 0; return r; }
  catch (e) { j.ok = false; j.error = String(e && e.message || e).slice(0, 200); j.fails++; j.failStreak++; noteError('job: ' + name, e); throw e; }
  finally { j.running = false; j.lastEnd = new Date().toISOString(); j.ms = Date.now() - t; j.runs++; }
}
function jobList() {
  const now = Date.now();
  return Object.values(jobs).map((j) => {
    const last = j.lastEnd ? Date.parse(j.lastEnd) : 0;
    // Late: a job that should run every N minutes hasn't finished for 3×N (and at least 15 min) since the server started.
    const late = j.every > 0 && now - Math.max(last, startedAt) > Math.max(3 * j.every, 15) * 60e3;
    const next = j.every > 0 ? new Date(Math.max(last || startedAt, startedAt) + j.every * 60e3).toISOString() : null;
    return { ...j, late, next, status: j.running ? 'running' : late ? 'late' : j.ok === false ? 'failed' : j.runs ? 'ok' : 'waiting' };
  });
}

// ---------- request speed ----------
const times = [];
function middleware(req, res, next) {
  if (!req.path.startsWith('/api/')) return next();
  const t = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    times.push(ms); if (times.length > 300) times.shift();
  });
  next();
}
function speed() {
  if (!times.length) return { avg: 0, p95: 0, n: 0 };
  const s = [...times].sort((a, b) => a - b);
  return { avg: Math.round(s.reduce((a, b) => a + b, 0) / s.length), p95: Math.round(s[Math.floor(s.length * 0.95)] || s[s.length - 1]), n: s.length };
}

// ---------- Meta API usage (from Meta's own headers) ----------
const metaUsage = {}; // key → { pct, kind, at, detail }
function noteMetaHeaders(headers) {
  try {
    const take = (kind, raw) => {
      if (!raw) return;
      const v = JSON.parse(raw);
      const put = (key, o) => {
        if (!o || typeof o !== 'object') return;
        const pct = Math.max(Number(o.call_count) || 0, Number(o.total_cputime) || 0, Number(o.total_time) || 0, Number(o.acc_id_util_pct) || 0);
        metaUsage[key] = { kind, pct, at: new Date().toISOString(), wait: Number(o.estimated_time_to_regain_access) || 0 };
      };
      if (kind === 'business') for (const [id, arr] of Object.entries(v)) for (const o of [].concat(arr)) put('business ' + id + ' ' + (o.type || ''), o);
      else put(kind, v);
    };
    take('app', headers.get('x-app-usage'));
    take('ad account', headers.get('x-ad-account-usage'));
    take('business', headers.get('x-business-use-case-usage'));
  } catch (_) { /* headers are a bonus */ }
}
function metaSummary() {
  const now = Date.now();
  const list = Object.entries(metaUsage).filter(([, v]) => now - Date.parse(v.at) < 2 * 3600e3).map(([k, v]) => ({ key: k, ...v })).sort((a, b) => b.pct - a.pct);
  return { max: list.length ? list[0].pct : 0, top: list.slice(0, 5) };
}

// ---------- outside services timing ----------
const services = {}; // name → { ok, ms, at, error }
function noteService(name, ok, ms, error) { services[name] = { ok: !!ok, ms: Math.round(ms || 0), at: new Date().toISOString(), error: error ? String(error).slice(0, 200) : '' }; }

// ---------- snapshot ----------
const MEM_LIMIT_MB = Number(process.env.MEMORY_LIMIT_MB) || 512;
async function snapshot(db) {
  const mem = process.memoryUsage();
  let dbInfo = { ok: false, ms: 0, sizeMb: 0, tables: [], error: '' };
  try {
    const t = Date.now();
    await db.pool.query('SELECT 1');
    dbInfo.ms = Date.now() - t; dbInfo.ok = true;
    const r = (await db.pool.query('SELECT pg_database_size(current_database()) AS b')).rows[0];
    dbInfo.sizeMb = Math.round(Number(r.b) / 1048576 * 10) / 10;
    dbInfo.tables = (await db.pool.query(`SELECT relname AS name, pg_total_relation_size(relid) AS b FROM pg_catalog.pg_statio_user_tables ORDER BY 2 DESC LIMIT 5`)).rows.map((x) => ({ name: x.name, mb: Math.round(Number(x.b) / 1048576 * 10) / 10 }));
    const hist = (await db.getSetting('dbSizeLog', [])) || [];
    dbInfo.weekAgoMb = (hist.find((h) => Date.now() - Date.parse(h.at) >= 6.5 * 864e5) || {}).mb ?? null;
  } catch (e) { dbInfo.error = e.message; }
  return {
    now: new Date().toISOString(), startedAt: new Date(startedAt).toISOString(), uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    node: process.version, deploy: process.env.RAILWAY_DEPLOYMENT_ID ? String(process.env.RAILWAY_GIT_COMMIT_SHA || '').slice(0, 7) : '',
    memory: { rssMb: Math.round(mem.rss / 1048576), heapMb: Math.round(mem.heapUsed / 1048576), limitMb: MEM_LIMIT_MB, pct: Math.round(mem.rss / 1048576 / MEM_LIMIT_MB * 100) },
    load: os.loadavg().map((x) => Math.round(x * 100) / 100), cpus: os.cpus().length,
    speed: speed(), db: dbInfo, jobs: jobList(), meta: metaSummary(), services, errors: errors.slice(0, 20),
  };
}

// ---------- alerts to the owner's Telegram ----------
// Problems are found every 5 minutes; each is sent once when it starts and once when it's fixed.
function problems(s) {
  const p = [];
  if (!s.db.ok) p.push({ key: 'db', text: `🛑 Database is not answering: ${s.db.error}` });
  else if (s.db.ms > 2000) p.push({ key: 'dbslow', text: `🐢 Database is very slow (${s.db.ms} ms per query)` });
  if (s.memory.pct >= 85) p.push({ key: 'mem', text: `🧠 Memory is high: ${s.memory.rssMb} MB of ${s.memory.limitMb} MB (${s.memory.pct}%) — the server may restart` });
  for (const j of s.jobs) {
    if (j.late) p.push({ key: 'late:' + j.name, text: `⏱ Background job "${j.name}" has not run since ${j.lastEnd ? new Date(j.lastEnd).toLocaleString('en-GB') : 'the server started'}` });
    else if (j.failStreak >= 3) p.push({ key: 'fail:' + j.name, text: `⚠️ Background job "${j.name}" failed ${j.failStreak} times in a row: ${j.error}` });
  }
  if (s.meta.max >= 90) p.push({ key: 'meta', text: `📈 Meta API usage is at ${s.meta.max}% — syncs may be blocked for a while` });
  const recent = s.errors.filter((e) => Date.now() - Date.parse(e.at) < 10 * 60e3).length;
  if (recent >= 10) p.push({ key: 'errors', text: `🔥 ${recent} server errors in the last 10 minutes. Latest: ${s.errors[0].message}` });
  return p;
}
async function checkAndAlert(db, telegram) {
  // remember the database size once a day, to show growth
  try {
    const s = await snapshot(db);
    const log = (await db.getSetting('dbSizeLog', [])) || [];
    if (s.db.ok && (!log.length || Date.now() - Date.parse(log[log.length - 1].at) > 20 * 3600e3)) { log.push({ at: s.now, mb: s.db.sizeMb }); await db.setSetting('dbSizeLog', log.slice(-30)); }
    const chat = (await db.getSetting('alertChat', null)) || null;
    if (!chat || !chat.id || !telegram.hasBot()) return;
    const now = problems(s), was = (await db.getSetting('alertState', {})) || {};
    const next = {};
    for (const x of now) {
      next[x.key] = was[x.key] || new Date().toISOString();
      if (!was[x.key]) await telegram.send(`🩺 Boost Desk alert\n${x.text}`, chat.id).catch(() => {});
    }
    // A problem counts as fixed only after 30 minutes without it, so a flapping one doesn't ping every few minutes.
    const clear = (await db.getSetting('alertClear', {})) || {};
    const label = { db: 'the database answers again', dbslow: 'the database is fast again', mem: 'memory is back to normal', meta: 'Meta API usage is back to normal', errors: 'server errors have stopped' };
    const fixed = [];
    for (const k of Object.keys(was)) {
      if (next[k]) { delete clear[k]; continue; }
      clear[k] = clear[k] || new Date().toISOString();
      if (Date.now() - Date.parse(clear[k]) >= 30 * 60e3) { fixed.push(label[k] || k.replace(/^late:/, 'job running again: ').replace(/^fail:/, 'job working again: ')); delete clear[k]; }
      else next[k] = was[k]; // keep it open until the 30 minutes pass
    }
    if (fixed.length) await telegram.send(`✅ Boost Desk back to normal: ${fixed.join(', ')}`, chat.id).catch(() => {});
    await db.setSetting('alertClear', clear);
    await db.setSetting('alertState', next);
  } catch (e) { noteError('health check', e); }
}

module.exports = { noteError, register, track, middleware, noteMetaHeaders, noteService, snapshot, problems, checkAndAlert, startedAt };
