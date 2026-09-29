// Turns Meta campaign rows into per-client daily entries, and builds the text report.
const cfg = require('./config');
const db = require('./db');
const meta = require('./meta');
const { decrypt } = require('./crypto');

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const hasLive = (c) => c.type === 'live' || c.type === 'both';
const hasPost = (c) => c.type === 'post' || c.type === 'both';
const money = (n) => '$' + (Number(n) || 0).toFixed(2);
const round2 = (n) => Math.round(n * 100) / 100;

function todayIn(tz = cfg.tz, date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
function hhmm(ms, tz = cfg.tz) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));
}
// "DC Shop | 29" → "DC Shop"
const campaignPrefix = (name) => { const m = String(name).match(/^(.*?)\s*\|/); return (m ? m[1] : String(name)).trim(); };

const isAutoPost = (name) => /^post:/i.test(String(name || '')) || !name;

// Match order: the Facebook Page the ad promotes (name, then ID) → campaign name ("DC Shop | 29")
// → linked ad account. Lives and boost posts both match by Page first.
function matchClient(item, clients) {
  const active = clients.filter((c) => !c.archived);
  // A client can own several Pages: its name, its alternate name and every Page listed on it all count.
  const names = (c) => [c.name, c.match, ...(c.pages || [])].filter(Boolean).map(norm);
  if (item.page) {
    const byPage = active.find((c) => names(c).includes(norm(item.page)));
    if (byPage) return byPage;
  }
  if (item.pageId) {
    const byId = active.find((c) => names(c).includes(norm(item.pageId)));
    if (byId) return byId;
  }
  if (!isAutoPost(item.name)) {
    const prefix = norm(campaignPrefix(item.name));
    const byName = active.find((c) => names(c).includes(prefix));
    if (byName) return byName;
  }
  return active.find((c) => c.account && (norm(c.account) === norm(item.account) || c.account === item.accountId)) || null;
}

/**
 * Group campaign rows by client. For live clients, campaigns that start within
 * `gapMs` of the first campaign in a group count as one live.
 * items: [{name, account, accountId, spend, start(ms|null)}]
 */
function buildPlan(items, clients, gapMs = cfg.liveGapMinutes * 60000) {
  const groups = new Map();
  const unmatched = new Map();
  for (const it of items) {
    if (!(it.spend > 0)) continue;
    const c = matchClient(it, clients);
    if (!c) {
      const auto = isAutoPost(it.name);
      const label = auto
        ? (it.page ? `Post boosts for Page "${it.page}"` : it.pageId ? `Post boosts for Page ID ${it.pageId} (name hidden)` : 'Post boosts (Page unknown)') + (it.account ? ' · ' + it.account : '')
        : (it.page ? `Lives for Page "${it.page}"` : campaignPrefix(it.name)) + (it.account ? ' · ' + it.account : '');
      const u = unmatched.get(label) || { label, page: it.page || it.pageId || (auto ? '' : campaignPrefix(it.name)), pageId: it.pageId || '', kind: auto ? 'post' : 'live', spend: 0, count: 0 };
      u.spend = round2(u.spend + it.spend); u.count++;
      unmatched.set(label, u);
      continue;
    }
    if (!groups.has(c.id)) groups.set(c.id, { client: c, items: [] });
    groups.get(c.id).items.push(it);
  }
  const targets = [];
  for (const { client, items: g } of groups.values()) {
    // Post clients: everything is post spend. Live clients: everything is lives.
    // Post + live clients: auto-named "Post: …" boosts are posts, named campaigns are lives.
    const toPost = (it) => client.type === 'post' || (client.type === 'both' && isAutoPost(it.name));
    const postItems = g.filter(toPost), liveItems = g.filter((it) => !toPost(it));
    const slots = [];
    liveItems.sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity));
    for (const it of liveItems) {
      const last = slots[slots.length - 1];
      if (last && it.start != null && last.start != null && it.start - last.start <= gapMs) {
        last.spend = round2(last.spend + it.spend); last.count++;
      } else slots.push({ start: it.start, spend: round2(it.spend), count: 1 });
    }
    const post = postItems.length ? { spend: round2(postItems.reduce((s, x) => s + x.spend, 0)), count: postItems.length } : null;
    targets.push({ clientId: client.id, slots, post });
  }
  return { targets, unmatched: [...unmatched.values()].sort((a, b) => b.spend - a.spend) };
}

// Spend + progress for one client's entry.
function entryStats(c, e = {}) {
  let spend = 0, total = 0, done = 0;
  const lives = [];
  if (hasPost(c)) { const p = e.post || {}; spend += Number(p.spend) || 0; total++; if (p.on) done++; }
  if (hasLive(c)) {
    const n = e.liveCount ?? 1;
    for (let i = 1; i <= n; i++) {
      const l = (e.lives || {})['l' + i] || {};
      spend += Number(l.spend) || 0; total++; if (l.on) done++;
      lives.push(l);
    }
  }
  return { spend: round2(spend), total, done, lives };
}

async function tokenFor(user) {
  if (!user) throw new meta.MetaError('Nobody is logged in with Facebook yet. Log in once so the app can read Ads Manager.', { needsLogin: true });
  return decrypt(user.token_enc);
}

async function refreshAccounts(user) {
  const token = await tokenFor(user);
  const owner = user.fb_id;
  const list = await meta.adAccounts(token);
  await db.saveAccounts(owner, list);
  return list;
}

function addDays(day, n) {
  const d = new Date(day + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Pull campaign spend for every enabled ad account over [since, until].
async function fetchRange(since, until, user, onProgress = () => {}) {
  const token = await tokenFor(user);
  const owner = user.fb_id;
  meta.rememberPageNames(await db.getSetting('pageNames', {}));
  // Always load this admin's current ad accounts first, so a sync only ever reads what they can access.
  onProgress({ phase: 'accounts', done: 0, total: 0, account: 'loading your ad accounts…' });
  try { await refreshAccounts(user); } catch (e) { if (e.needsLogin) throw e; console.error('[sync] could not refresh ad accounts:', e.message); }
  const ids = await db.enabledAccountIds(owner);
  const names = Object.fromEntries((await db.listAccounts(owner)).map((a) => [a.id, a.name]));
  const items = [];
  const errors = [];
  const checks = [];
  for (const [i, id] of ids.entries()) {
    onProgress({ phase: 'accounts', done: i, total: ids.length, account: names[id] || id });
    try {
      const rows = await meta.campaignSpendRange(token, id, since, until, names[id]);
      items.push(...rows);
      // Completeness check: the account's own total vs what we collected campaign by campaign.
      try {
        const total = round2(await meta.accountSpendRange(token, id, since, until));
        const found = round2(rows.reduce((t, r) => t + r.spend, 0));
        if (total > 0 || found > 0) checks.push({ account: names[id] || id, meta: total, found, missing: round2(total - found) });
      } catch (e) { if (e.needsLogin || e.rateLimited) throw e; }
    } catch (e) {
      if (e.needsLogin) throw e;
      console.error(`[sync] ${names[id] || id} failed:`, e.code, e.message);
      errors.push({ account: names[id] || id, message: (e.code ? `(#${e.code}) ` : '') + e.message });
      if (e.rateLimited) break;
    }
  }
  try { await db.setSetting('pageNames', meta.knownPageNames()); } catch (_) {}
  return { items, errors, checks };
}

// Write one day's campaign rows into the client entries.
async function applyDay(day, items, errors, user, clients, { rematch = false } = {}) {
  if (!rematch) await db.notePages(user.fb_id, items.map((it) => it.page), day);
  const plan = buildPlan(items, clients);
  const syncedAt = new Date().toISOString();
  const touched = new Set();
  for (const t of plan.targets) {
    touched.add(t.clientId);
    const c = clients.find((x) => x.id === t.clientId);
    const e = await db.getEntry(day, t.clientId);
    if (t.slots.length) {
      const lives = {};
      t.slots.forEach((sl, i) => {
        const prev = (e.lives || {})['l' + (i + 1)] || {};
        lives['l' + (i + 1)] = { ...prev, spend: sl.spend, on: true, campaigns: sl.count, time: sl.start != null ? hhmm(sl.start) : prev.time || '' };
      });
      // Clear spend on slots Meta no longer reports.
      for (const k of Object.keys(e.lives || {})) if (!lives[k]) lives[k] = { ...e.lives[k], spend: 0, campaigns: 0 };
      e.lives = lives;
      e.liveCount = Math.max(e.liveCount ?? 0, t.slots.length);
    }
    if (t.post) e.post = { ...(e.post || {}), spend: t.post.spend, on: true, campaigns: t.post.count };
    e.syncedAt = syncedAt;
    await db.putEntry(day, t.clientId, e);
  }
  // Clients that had synced spend this day but no longer match (a Page was moved to another client,
  // a client was changed…): clear their synced spend so nothing is counted twice.
  const { entries } = await db.getDay(user.fb_id, day);
  for (const [cid, e] of Object.entries(entries)) {
    if (touched.has(Number(cid)) || !e.syncedAt) continue;
    for (const l of Object.values(e.lives || {})) { l.spend = 0; l.campaigns = 0; l.on = false; }
    if (e.post) { e.post.spend = 0; e.post.campaigns = 0; e.post.on = false; }
    delete e.syncedAt;
    await db.putEntry(day, Number(cid), e);
  }
  if (rematch) await db.setDayUnmatched(user.fb_id, day, { unmatched: plan.unmatched, errors });
  else await db.putDayMeta(user.fb_id, day, user.name || user.fb_id, { unmatched: plan.unmatched, errors });
  return { day, matched: plan.targets.length, unmatched: plan.unmatched, errors, campaigns: items.length };
}

// Learn which client owns each Page ID: a named campaign ("DC Shop | 29") matched by name tells us
// its Page belongs to that client, so auto-named "Post: …" boosts from the same Page match too —
// even when Meta hides the Page's name. Learned links are saved and reused on later syncs.
async function clientsWithLearnedPages(owner, items) {
  const clients = await db.listClients(owner);
  const learned = await db.getUserSetting(owner, 'pageOwners', {}); // { pageId: clientId }
  for (const it of items) {
    if (!it.pageId || isAutoPost(it.name)) continue;
    if (it.page && clients.some((x) => !x.archived && [x.name, x.match, ...(x.pages || [])].filter(Boolean).map(norm).includes(norm(it.page)))) continue;
    const prefix = norm(campaignPrefix(it.name));
    const c = clients.find((x) => !x.archived && [x.name, x.match, ...(x.pages || [])].filter(Boolean).map(norm).includes(prefix));
    if (c) learned[it.pageId] = c.id;
  }
  // A Page the user linked by hand (name or ID on the client) always wins over a learned link.
  for (const c of clients) for (const p of c.pages || []) if (/^\d+$/.test(p)) learned[p] = c.id;
  await db.setUserSetting(owner, 'pageOwners', learned);
  const extra = {};
  for (const [pid, cid] of Object.entries(learned)) (extra[cid] = extra[cid] || []).push(pid);
  return clients.map((c) => (extra[c.id] ? { ...c, pages: [...new Set([...(c.pages || []), ...extra[c.id]])] } : c));
}

async function syncDay(day, user) {
  const { items, errors } = await fetchRange(day, day, user);
  const failed = new Set(errors.map((e) => e.account));
  let rows = items;
  if (failed.size) { const prev = (await db.getRaw(user.fb_id, day)) || []; rows = rows.concat(prev.filter((r) => failed.has(r.account))); }
  await db.putRaw(user.fb_id, day, rows);
  return applyDay(day, rows, errors, user, await clientsWithLearnedPages(user.fb_id, rows));
}

// One sync at a time per admin — the Sync button and background syncs share this.
const busy = new Set();
const isBusy = (owner) => busy.has(owner);
async function exclusive(owner, fn) {
  if (busy.has(owner)) return null;
  busy.add(owner);
  try { return await fn(); } finally { busy.delete(owner); }
}

// Re-match every saved day after clients change — uses the saved campaign rows, no Meta call.
async function rematch(user) {
  const t0 = Date.now();
  const days = await db.listRaw(user.fb_id);
  const all = days.flatMap((d) => d.rows);
  const clients = await clientsWithLearnedPages(user.fb_id, all);
  for (const d of days) {
    const prevErrors = ((await db.getDay(user.fb_id, d.day)).meta?.unmatched?.errors) || [];
    await applyDay(d.day, d.rows, prevErrors, user, clients, { rematch: true });
  }
  return { days: days.length, ms: Date.now() - t0 };
}

// Backfill several days with one API call per account (Meta allows up to ~37 months back).
async function syncRange(since, until, user, onProgress = () => {}) {
  const { items, errors, checks } = await fetchRange(since, until, user, onProgress);
  await db.setUserSetting(user.fb_id, 'lastSyncCheck', { from: since, to: until, at: new Date().toISOString(), checks });
  const clients = await clientsWithLearnedPages(user.fb_id, items);
  const byDay = {};
  for (const it of items) (byDay[it.day] = byDay[it.day] || []).push(it);
  const results = [];
  const allDays = [];
  for (let d = since; d <= until; d = addDays(d, 1)) allDays.push(d);
  const failed = new Set(errors.map((e) => e.account));
  for (const [i, d] of allDays.entries()) {
    onProgress({ phase: 'saving', done: i, total: allDays.length, account: '' });
    let rows = byDay[d] || [];
    if (failed.size) { const prev = (await db.getRaw(user.fb_id, d)) || []; rows = rows.concat(prev.filter((r) => failed.has(r.account))); }
    await db.putRaw(user.fb_id, d, rows);
    results.push(await applyDay(d, rows, errors, user, clients));
  }
  return {
    days: results.length,
    campaigns: items.length,
    matched: results.reduce((s, r) => s + r.matched, 0),
    daysWithSpend: results.filter((r) => r.campaigns).length,
    errors,
    checks,
  };
}

// Per-client totals over [from, to] for the dashboard.
async function dashboard(owner, from, to) {
  const clients = await db.listClients(owner);
  const rows = await db.monthEntries(owner, from, to); // [{day, client_id, data}]
  const per = new Map(clients.map((c) => [c.id, {
    id: c.id, name: c.name, type: c.type, pages: [...new Set([c.name, c.match, ...(c.pages || [])].filter(Boolean))],
    budget: c.budget, archived: c.archived, telegram: c.telegram || '', days: 0, lives: 0, liveSpend: 0, postSpend: 0, spend: 0, overDays: 0, daily: {},
  }]));
  const byDay = {};
  for (const r of rows) {
    const c = clients.find((x) => x.id === r.client_id);
    const p = per.get(r.client_id);
    if (!c || !p) continue;
    const e = r.data || {};
    const post = hasPost(c) ? Number((e.post || {}).spend) || 0 : 0;
    let live = 0, lives = 0;
    if (hasLive(c)) for (const l of Object.values(e.lives || {})) { const v = Number(l && l.spend) || 0; live += v; if (v > 0) lives++; }
    const total = round2(post + live);
    if (!total) continue;
    p.days++; p.lives += lives; p.liveSpend = round2(p.liveSpend + live); p.postSpend = round2(p.postSpend + post);
    p.spend = round2(p.spend + total); p.daily[r.day] = total;
    if (c.budget && total > c.budget + 0.009) p.overDays++;
    byDay[r.day] = round2((byDay[r.day] || 0) + total);
  }
  const list = [...per.values()].map((p) => ({ ...p, planned: round2(p.days * p.budget), diff: round2(p.spend - p.days * p.budget) }));
  list.sort((a, b) => b.spend - a.spend || a.name.localeCompare(b.name));
  const days = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push({ day: d, spend: byDay[d] || 0 });
  const totals = list.reduce((t, p) => ({ spend: round2(t.spend + p.spend), planned: round2(t.planned + p.planned), live: round2(t.live + p.liveSpend), post: round2(t.post + p.postSpend), lives: t.lives + p.lives, active: t.active + (p.spend > 0 ? 1 : 0) }), { spend: 0, planned: 0, live: 0, post: 0, lives: 0, active: 0 });
  return { from, to, clients: list, days, totals };
}

const niceDay = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const shortDay = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const monthName = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const isWholeMonth = (from, to) => from.slice(8) === '01' && from.slice(0, 7) === to.slice(0, 7) && addDays(to, 1).slice(8) === '01';
const fmt = (n) => '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Report for one client: a single day (every live + posts) or a range (total + day by day).
// Client reports show the total plus tax (TAX_RATE %, default 10). Rounded to the cent in whole cents.
const TAX_RATE = Number.isFinite(Number(process.env.TAX_RATE)) && process.env.TAX_RATE !== '' ? Number(process.env.TAX_RATE) : 10;
function totalWithTax(total) {
  if (!(total > 0) || !TAX_RATE) return `💰 Total: ${fmt(total)}`;
  const cents = Math.round(total * 100);
  const withTax = Math.round(cents * (100 + TAX_RATE) / 100) / 100;
  return `💰 Total: ${fmt(cents / 100)} +Tax ${TAX_RATE}% = ${fmt(withTax)}`;
}

async function clientReport(owner, clientId, from, to) {
  const c = (await db.listClients(owner)).find((x) => x.id === Number(clientId));
  if (!c) { const e = new Error('Client not found.'); e.status = 404; throw e; }
  const rows = (await db.monthEntries(owner, from, to)).filter((r) => r.client_id === c.id).sort((a, b) => a.day.localeCompare(b.day));
  const lines = [];
  if (from === to) {
    const e = (rows[0] || {}).data || {};
    lines.push(`📊 ${c.name} — Boost report`, `🗓 ${niceDay(from)}`, '');
    let total = 0;
    if (hasLive(c)) {
      const lives = Object.entries(e.lives || {}).sort(([a], [b]) => Number(a.slice(1)) - Number(b.slice(1)));
      for (const [k, l] of lives) {
        if (!(Number(l.spend) > 0)) continue;
        total += Number(l.spend);
        lines.push(`🔴 Live ${k.slice(1)}${l.time ? ' (' + l.time + ')' : ''}: ${fmt(l.spend)}`);
      }
    }
    if (hasPost(c) && Number((e.post || {}).spend) > 0) { total += Number(e.post.spend); lines.push(`📌 Boost post: ${fmt(e.post.spend)}`); }
    if (!total) lines.push('No boost spend on this day.');
    lines.push('', totalWithTax(total));
    if (e.note) lines.push(`📝 ${e.note}`);
  } else {
    const whole = isWholeMonth(from, to);
    lines.push(`📊 ${c.name} — Boost report`, `🗓 ${whole ? monthName(from) : shortDay(from) + ' – ' + shortDay(to)}`, '');
    let total = 0, live = 0, post = 0, lives = 0, days = 0;
    const daily = [];
    for (const r of rows) {
      const e = r.data || {};
      let dl = 0, dn = 0, dp = 0;
      if (hasLive(c)) for (const l of Object.values(e.lives || {})) { const v = Number(l && l.spend) || 0; if (v > 0) { dl += v; dn++; } }
      if (hasPost(c)) dp = Number((e.post || {}).spend) || 0;
      const t = dl + dp;
      if (!t) continue;
      days++; total += t; live += dl; post += dp; lives += dn;
      const parts = [];
      if (dn) parts.push(`${dn} live${dn > 1 ? 's' : ''}`);
      if (dp) parts.push('post');
      daily.push(`• ${shortDay(r.day)}: ${fmt(t)}${parts.length ? ' (' + parts.join(' + ') + ')' : ''}`);
    }
    if (!total) lines.push('No boost spend in this period.');
    else {
      lines.push(totalWithTax(total));
      const sub = [];
      if (hasLive(c)) sub.push(`🔴 Lives: ${fmt(live)} (${lives} live${lives === 1 ? '' : 's'})`);
      if (hasPost(c)) sub.push(`📌 Boost posts: ${fmt(post)}`);
      lines.push(...sub, `📅 ${days} day${days === 1 ? '' : 's'} with boosts`, '', ...daily);
    }
  }
  return { text: lines.join('\n'), client: { id: c.id, name: c.name, telegram: c.telegram, telegramTitle: c.telegram_title } };
}

// Team summary: every client's total for a day or a range.
async function summaryReport(owner, from, to) {
  if (from === to) return buildReport(owner, from);
  const d = await dashboard(owner, from, to);
  const list = d.clients.filter((c) => c.spend > 0);
  const lines = [`📊 Boost summary — ${isWholeMonth(from, to) ? monthName(from) : shortDay(from) + ' – ' + shortDay(to)}`, ''];
  for (const c of list) lines.push(`• ${c.name}: ${fmt(c.spend)}${c.lives ? ` · ${c.lives} live${c.lives > 1 ? 's' : ''}` : ''}`);
  if (!list.length) lines.push('No boost spend in this period.');
  lines.push('', `💰 Total: ${fmt(d.totals.spend)} · ${list.length} client${list.length === 1 ? '' : 's'}`);
  return lines.join('\n');
}

async function buildReport(owner, day) {
  const clients = (await db.listClients(owner)).filter((c) => !c.archived);
  const { entries, meta: m } = await db.getDay(owner, day);
  const nice = new Date(day + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const lines = [`📊 Boost report — ${nice}`, ''];
  let T = 0;
  for (const c of clients) {
    const e = entries[c.id] || {};
    const s = entryStats(c, e);
    if (!s.spend && !s.done) continue;
    T += s.spend;
    lines.push(`• ${c.name}: ${money(s.spend)}`);
    const parts = [];
    if (hasPost(c)) parts.push(`Post ${money((e.post || {}).spend)}`);
    s.lives.forEach((l, i) => { if (l.spend || l.on) parts.push(`L${i + 1}${l.time ? ' (' + l.time + ')' : ''} ${money(l.spend)}`); });
    if (parts.length) lines.push('   ' + parts.join(' · '));
    if (e.note) lines.push('   📝 ' + e.note);
  }
  if (lines.length === 2) lines.push('No boost spend recorded.');
  lines.push('', `Total: ${money(T)}`);
  const un = m?.unmatched?.unmatched || [];
  if (un.length) lines.push(`Not matched to a client: ${money(un.reduce((s, u) => s + u.spend, 0))}`);
  return lines.join('\n');
}

module.exports = { isBusy, exclusive, rematch, clientReport, summaryReport, dashboard, buildPlan, entryStats, syncDay, syncRange, addDays, refreshAccounts, buildReport, todayIn, hhmm, tokenFor, campaignPrefix };
