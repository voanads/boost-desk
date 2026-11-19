// Auto daily report: each client's report goes to their own Telegram group at a set time.
const cfg = require('./config');
const db = require('./db');
const sync = require('./sync');
const telegram = require('./telegram');
const reports = require('./reports');

const hasLive = (c) => c.type === 'live' || c.type === 'both';
const hasPost = (c) => c.type === 'post' || c.type === 'both';

// ---------- auto daily report ----------
const AR_DEFAULT = { on: false, time: '20:00', skip: [], withImage: true, weekly: false, monthly: false };
async function autoSettings(owner) {
  const s = { ...AR_DEFAULT, ...((await db.getUserSetting(owner, 'autoReport', null)) || {}) };
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s.time)) s.time = AR_DEFAULT.time;
  s.skip = (Array.isArray(s.skip) ? s.skip : []).map(Number).filter(Number.isFinite);
  return s;
}
const nowHHMM = () => new Intl.DateTimeFormat('en-GB', { timeZone: cfg.tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
async function saveAutoSettings(owner, b) {
  const cur = await autoSettings(owner);
  const next = {
    on: 'on' in b ? !!b.on : cur.on,
    time: /^([01]\d|2[0-3]):[0-5]\d$/.test(b.time) ? b.time : cur.time,
    skip: Array.isArray(b.skip) ? [...new Set(b.skip.map(Number).filter(Number.isFinite))] : cur.skip,
    withImage: 'withImage' in b ? !!b.withImage : cur.withImage,
    weekly: 'weekly' in b ? !!b.weekly : !!cur.weekly, // Monday 09:00: last week (Mon–Sun) to each client's group
    monthly: 'monthly' in b ? !!b.monthly : !!cur.monthly, // the 1st, 09:00: last month
  };
  await db.setUserSetting(owner, 'autoReport', next);
  // Switched on (or time moved) after today's time has already passed → start tomorrow, don't fire right away.
  if (next.on && (!cur.on || cur.time !== next.time) && nowHHMM() >= next.time) {
    const last = (await db.getUserSetting(owner, 'autoReportLast', null)) || {};
    if (last.day !== sync.todayIn()) await db.setUserSetting(owner, 'autoReportLast', { ...last, day: sync.todayIn(), skipped: true });
  }
  return next;
}

// Send every client's report for one day to their own group. Clients with no spend, no group,
// unticked in the settings, or already sent by hand that day are left out.
async function sendClientReports(user, day = sync.todayIn(), { refresh = true, hold = false } = {}) {
  const set = await autoSettings(user.fb_id);
  const out = { day, at: new Date().toISOString(), sent: [], failed: [], already: [], noGroup: [], differs: [], noSpend: 0, warn: '', held: false };
  if (refresh) {
    try { await sync.exclusive(user.fb_id, () => sync.syncDay(day, { ...user, name: 'Auto report' })); }
    catch (e) { out.warn = e.message; if (hold) { out.held = true; return out; } } // the automatic run never sends numbers it could not refresh from Meta (tick() tries again); "Send now" is a person's own decision and goes ahead with a warning
  }
  for (const c of await db.listClients(user.fb_id)) {
    if (c.archived || set.skip.includes(c.id)) continue;
    const e = await db.getEntry(day, c.id);
    const spend = (hasLive(c) ? Object.values(e.lives || {}).reduce((s, l) => s + (Number(l && l.spend) || 0), 0) : 0) + (hasPost(c) ? Number((e.post || {}).spend) || 0 : 0);
    if (!(spend > 0)) { out.noSpend++; continue; }
    if (!reports.routes(c).some((r) => r.chat)) { out.noGroup.push(c.name); continue; } // spent today but has no Telegram group
    if (e.reportSent) { out.already.push(c.name); continue; }
    // The saved numbers against what Meta reports for this client's campaigns: a difference is told to the PM, not hidden.
    try { const meta = (await sync.scopeEntries(user.fb_id, c, day, day, { exclude: [] }))[0]; if (meta) { const d = meta.data || {}; const m = (hasLive(c) ? Object.values(d.lives || {}).reduce((t, l) => t + (Number(l && l.spend) || 0), 0) : 0) + (hasPost(c) ? Number((d.post || {}).spend) || 0 : 0); if (Math.abs(m - spend) >= 0.01) out.differs.push({ name: c.name, saved: Math.round(spend * 100) / 100, meta: Math.round(m * 100) / 100 }); } } catch (_) {}
    try {
      const done = await reports.send(user, c, day, day, { withImage: set.withImage }); // one per Page topic, if set
      if (!done.length) { out.noSpend++; continue; }
      await db.putEntry(day, c.id, { ...(await db.getEntry(day, c.id)), reportSent: { at: new Date().toISOString(), by: 'Auto report' } });
      out.sent.push(c.name);
    } catch (err) { out.failed.push({ name: c.name, error: err.message }); }
  }
  return out;
}
// What happened, to the PM's own Telegram — only when there is something to do (a failure, a client without a group,
// numbers that differ from Meta, or reports held back).
async function tellPm(user, r, title = 'របាយការណ៍ប្រចាំថ្ងៃជូនភ្ញៀវ') {
  const chat = ((await db.getUserSetting(user.fb_id, 'tgChat', null)) || {}).id; if (!chat) return;
  const money = (n) => '$' + Number(n).toFixed(2), lines = [];
  if (r.held) lines.push(`⏸ ${title}មិនទាន់ផ្ញើ — ទាញលេខថ្មីពី Meta មិនបាន៖ ${r.warn || ''}`, r.final ? 'បានសាក 3 ដងហើយ។ សូមបើក Reports ហើយចុច Send now ក្រោយ Sync បាន។' : 'នឹងសាកម្ដងទៀតក្នុង 15 នាទី។');
  else {
    if (!r.failed.length && !r.noGroup.length && !r.differs.length) return;
    lines.push(`📨 ${title} — ផ្ញើ ${r.sent.length}`);
    if (r.failed.length) lines.push('', `❌ ផ្ញើមិនបាន ${r.failed.length}៖`, ...r.failed.slice(0, 10).map((f) => `• ${f.name} — ${f.error}`));
    if (r.noGroup.length) lines.push('', `⚠ មានចំណាយ តែគ្មាន Telegram group ${r.noGroup.length}៖`, ...r.noGroup.slice(0, 10).map((n) => `• ${n}`));
    if (r.differs.length) lines.push('', `🔎 លេខក្នុង Boost Desk ខុសពី Meta ${r.differs.length} (របាយការណ៍បានផ្ញើតាមលេខក្នុង Boost Desk)៖`, ...r.differs.slice(0, 10).map((d) => `• ${d.name} — Boost Desk ${money(d.saved)} · Meta ${money(d.meta)}`));
  }
  try { await telegram.send(lines.join('\n'), chat); } catch (_) {}
}
// Weekly (Monday) and monthly (the 1st) summary to each client's group, when switched on. One period is sent once.
const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
function duePeriods(today) {
  const d = new Date(today + 'T00:00:00Z'), out = {};
  if (d.getUTCDay() === 1) out.weekly = { from: addDays(today, -7), to: addDays(today, -1) };
  if (today.slice(8) === '01') { const to = addDays(today, -1); out.monthly = { from: to.slice(0, 8) + '01', to }; }
  return out;
}
async function sendPeriodReports(user, from, to) {
  const set = await autoSettings(user.fb_id), out = { from, to, at: new Date().toISOString(), sent: [], failed: [], noGroup: [], differs: [], held: false };
  for (const c of await db.listClients(user.fb_id)) {
    if (c.archived || set.skip.includes(c.id)) continue;
    let spend = 0; try { spend = (await sync.clientReport(user.fb_id, c.id, from, to, '', null, null, { orders: false })).spend; } catch (_) {}
    if (!(spend > 0)) continue;
    if (!reports.routes(c).some((r) => r.chat)) { out.noGroup.push(c.name); continue; }
    try { const done = await reports.send(user, c, from, to, { withImage: false }); if (done.length) out.sent.push(c.name); } catch (err) { out.failed.push({ name: c.name, error: err.message }); }
  }
  return out;
}

// Called every minute: send for each account whose time has come and that hasn't sent today.
let ticking = false;
async function tick() {
  if (ticking || !telegram.hasBot()) return;
  ticking = true;
  try {
    const today = sync.todayIn(), now = nowHHMM();
    for (const user of await db.activeUsers()) {
      try {
        const set = await autoSettings(user.fb_id);
        // weekly / monthly summaries at 09:00
        if ((set.weekly || set.monthly) && now >= '09:00') {
          const due = duePeriods(today), done = (await db.getUserSetting(user.fb_id, 'autoPeriodLast', null)) || {};
          for (const k of ['weekly', 'monthly']) {
            if (!set[k] || !due[k] || done[k] === due[k].to) continue;
            done[k] = due[k].to; await db.setUserSetting(user.fb_id, 'autoPeriodLast', done); // claim first: never twice
            const r = await sendPeriodReports(user, due[k].from, due[k].to);
            console.log(new Date().toISOString(), `[auto report] ${user.name}: ${k} ${due[k].from}..${due[k].to} sent ${r.sent.length}, failed ${r.failed.length}`);
            await tellPm(user, r, k === 'weekly' ? 'របាយការណ៍ប្រចាំសប្ដាហ៍ជូនភ្ញៀវ' : 'របាយការណ៍ប្រចាំខែជូនភ្ញៀវ');
          }
        }
        if (!set.on || now < set.time) continue;
        const last = (await db.getUserSetting(user.fb_id, 'autoReportLast', null)) || {};
        if (last.day === today) {
          // held back because Meta could not be refreshed: try again every 15 minutes, three times in all
          if (!last.held || last.final || last.running || Date.now() - Date.parse(last.at || 0) < 15 * 60e3) continue;
        }
        const tries = last.day === today && last.held ? (last.tries || 1) + 1 : 1;
        await db.setUserSetting(user.fb_id, 'autoReportLast', { day: today, running: true, at: new Date().toISOString() }); // claim the day first, so it can never send twice
        let r; try { r = await sendClientReports(user, today, { hold: true }); }
        catch (e) { r = { day: today, at: new Date().toISOString(), sent: [], failed: [], already: [], noGroup: [], differs: [], noSpend: 0, warn: e.message, held: true }; } // never leave the day claimed as "running"
        if (r.held) { r.tries = tries; r.final = tries >= 3; }
        await db.setUserSetting(user.fb_id, 'autoReportLast', r);
        console.log(new Date().toISOString(), `[auto report] ${user.name}: ${r.held ? `held (try ${tries}) — ${r.warn}` : `sent ${r.sent.length}, failed ${r.failed.length}, no group ${r.noGroup.length}, differ ${r.differs.length}`}`);
        if (!r.held || tries === 1 || r.final) await tellPm(user, r);
      } catch (e) { console.error('[auto report]', user.name, e.message); }
    }
  } finally { ticking = false; }
}

module.exports = { autoSettings, saveAutoSettings, sendClientReports, sendPeriodReports, duePeriods, tellPm, tick };
