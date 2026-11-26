const net = require('./src/net'); // first: time limits on every outside call
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieSession = require('cookie-session');
const cfg = require('./src/config');
const db = require('./src/db');
const meta = require('./src/meta');
const sync = require('./src/sync');
const lives = require('./src/lives');
const invoice = require('./src/invoice');
const health = require('./src/health');
const reportImage = require('./src/reportImage');
const kindOf = (k) => (k === 'live' || k === 'post' ? k : '');
// Ticked report lines: "l1,l3,post" or ['l1','post'] → clean list, or null for everything.
// parts: lines ticked on a one-day report ('l1', 'post'), and lines left out of a longer report ('!2026-10-18:l1').
const partsOf = (v) => { const a = (Array.isArray(v) ? v : String(v || '').split(',')).map(String).filter((x) => /^(l\d{1,2}|post)$/.test(x) || /^!\d{4}-\d{2}-\d{2}:(l\d{1,2}|post)$/.test(x)); return a.length ? [...new Set(a)].sort().slice(0, 400) : null; };
const jobs = require('./src/jobs');
const extras = require('./src/extras');
const reports = require('./src/reports');
const pm = require('./src/pm');
const orders = require('./src/orders');
const pageOrders = require('./src/pageOrders'); // Boost Desk's own order counting (Messenger + comments)
const telegram = require('./src/telegram');
const profit = require('./src/profit');
const { encrypt } = require('./src/crypto');

// 19 Nov 2026 — KPIs and the daily task menu moved to GenZ KPI. Boost Desk follows clients: their status, the MB <-> PM
// handover, reports to clients and AI advice per client. The My Task page, KPI screens and the Telegram messages about
// daily tasks are switched off here (data and code are kept; KPI_TASKS=on in the environment brings them back).
const TASKS_OFF = process.env.KPI_TASKS !== 'on';
// A promise nobody caught must not stop the app; it is logged instead.
process.on('unhandledRejection', (e) => console.error('[unhandled]', e && e.message ? e.message : e));
const app = express();
app.set('trust proxy', 1);
// Smaller pages on slow connections: text responses are compressed (the app script goes from ~530 KB to ~130 KB).
app.use(require('compression')({ threshold: 1024 }));
// Basic browser protections on every response. Frames are allowed from this site only.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Only rules that cannot break the pages (they use inline scripts and handlers): no plugins, no <base> hijack, no framing elsewhere.
  res.setHeader('Content-Security-Policy', "object-src 'none'; base-uri 'self'; frame-ancestors 'self'");
  if (cfg.baseUrl.startsWith('https')) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  next();
});
// Public addresses: a limit per address, so nobody can hammer the login or the open API.
app.use(['/auth', '/admin/login', '/mediabuyer/login', '/mb/login'], net.rateLimit(40, 60000, 'auth'));
app.use(['/public-api', '/hooks/adsbox'], net.rateLimit(240, 60000, 'pub')); // /hooks/meta is signed by Facebook and can be busy during a Live, so it has no per-address limit
app.use('/api', net.sameOrigin);
// /hooks/meta keeps the raw body too: Facebook signs it (X-Hub-Signature-256) and the signature is checked on those bytes.
app.use(express.json({ limit: '8mb', verify: (req, res, buf) => { if (req.originalUrl.startsWith('/hooks/meta')) req.rawBody = buf; } })); // room for the invoice logo / QR / signature pictures
app.use(cookieSession({
  name: 'bd_session', secret: cfg.sessionSecret, maxAge: 30 * 864e5,
  sameSite: 'lax', secure: cfg.baseUrl.startsWith('https'), httpOnly: true,
}));

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const isDay = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d);

// ---- Facebook login: sign-in, connecting more Facebook accounts and Pages (src/routes/auth-facebook.js) ----
const { fbNameOf, loggedIn, newState, stateOk } = require('./src/routes/auth-facebook')(app, null, { encrypt, wrap, get LOGINS() { return LOGINS; }, get MB() { return MB; } });
// ---- Username + password sign-in (src/routes/auth-logins.js, accounts in src/logins.js) ----
const { LOGINS } = require('./src/routes/auth-logins')(app, null, { wrap, get MB() { return MB; } });
// ---- Admin website (/admin): Google sign-in for people the owner allows (src/routes/auth-google.js) ----
const { googleRedirect, normEmail, siteCfg, sitePerson } = require('./src/routes/auth-google')(app, null, { loggedIn, newState, stateOk, wrap });
// ---- Public read-only API for adsbox.biz, and the Check My Ads extension hooks (src/routes/public-api.js) ----
const { lastSeenMem, sha } = require('./src/routes/public-api')(app, null, { isDay, wrap });
// ---- Media buyer site, the login wall and the four sites (/mediabuyer, /owner, /projectmanager, /admin) (src/routes/sites.js) ----
const { MB } = require('./src/routes/sites')(app, null, { lastSeenMem, sitePerson, wrap, get AI() { return AI; }, get KPI() { return KPI; }, get canSeeAdmin() { return canSeeAdmin; }, get roleOf() { return roleOf; }, get tgt() { return tgt; } });
// ---------- API ----------
const api = express.Router();
// ---- Activity log, roles, me, auto sync, teams, main dashboard and company (src/routes/team.js) ----
const { LEAD, ROLES, adminOnly, adminViewers, auditFlush, canSeeAdmin, dayTasks, fullAdmins, getTeams, isFull, ownerOnly, roleMap, roleOf, tgt } = require('./src/routes/team')(null, api, { LOGINS, MB, TASKS_OFF, fbNameOf, isDay, sitePerson, wrap });
// ---- Admin panel: users, health, settings, Page pictures (src/routes/admin-panel.js) ----
require('./src/routes/admin-panel')(null, api, { LEAD, ROLES, adminOnly, adminViewers, fullAdmins, getTeams, isFull, get linkCode() { return linkCode; }, ownerOnly, roleMap, roleOf, sha, wrap });
// ---- Every ad account of every person (Admin → Ad accounts) (src/routes/admin-ad-accounts.js) ----
require('./src/routes/admin-ad-accounts')(null, api, { adminOnly, getTeams, ownerOnly, wrap });
// ---- Admin website access, security, backups, blocked accounts, auto sync control (src/routes/admin-security.js) ----
const { cleanClient } = require('./src/routes/admin-security')(null, api, { adminOnly, get dedupeClients() { return dedupeClients; }, googleRedirect, isFull, normEmail, ownerOnly, siteCfg, wrap });
// ---- Clients, post pictures, day checklist and Sync from Meta (src/routes/clients.js) ----
const { deepMerge } = require('./src/routes/clients')(null, api, { cleanClient, isDay, wrap });
// ---- Payments: service fees and invoices (src/routes/invoices.js) ----
require('./src/routes/invoices')(null, api, { isDay, isFull, wrap });
// ---- Live videos, live setups, Dashboard and Page names (src/routes/lives-dashboard.js) ----
const { accountsWithToday } = require('./src/routes/lives-dashboard')(null, api, { isDay, sha, wrap, get rangeOk() { return rangeOk; } });
// ---- Ad accounts tab, Telegram link codes and the chat list (src/routes/accounts-telegram.js) ----
const { chatsNow, linkCode, newCode, rangeOk } = require('./src/routes/accounts-telegram')(null, api, { LOGINS, MB, accountsWithToday, isDay, wrap, get AI() { return AI; } });
// ---- Client reports: preview, picture, send, delete; summary and day report (src/routes/client-reports.js) ----
require('./src/routes/client-reports')(null, api, { chatsNow, deepMerge, isDay, kindOf, linkCode, partsOf, rangeOk, wrap });
// ---- Auto daily report, report status, handoff notes and today's to-do (src/routes/auto-report-handoff.js) ----
const { HANDOFF_DEPS } = require('./src/routes/auto-report-handoff')(null, api, { MB, adminOnly, dayTasks, getTeams, isDay, wrap });
// ---- Orders (adsbox.biz API), AI advice, KPIs, people today / month, audit, nudges (src/routes/orders-ai-kpi.js) ----
const { AI, KPI, kpiPerson, ownClient, ownsBuyer } = require('./src/routes/orders-ai-kpi')(null, api, { LEAD, LOGINS, MB, ROLES, TASKS_OFF, adminOnly, adminViewers, auditFlush, canSeeAdmin, dayTasks, getTeams, isDay, ownerOnly, roleMap, roleOf, wrap, get MENU() { return MENU; } });
// ---- Weekly AI strategy per client, and merging duplicate clients (src/routes/strategy-merge.js) ----
const { dedupeClients, mergeClients, sameName } = require('./src/routes/strategy-merge')(null, api, { AI, ownClient, wrap });
// ---- Boosts: one row per post in a boost plan, and Live boosts (src/routes/boosts.js) ----
require('./src/routes/boosts')(null, api, { wrap, get STATUS() { return STATUS; } });
// ---- Client status, admin today / lives / invoices pages, KPI copy and targets (src/routes/client-status.js) ----
const { STATUS } = require('./src/routes/client-status')(null, api, { KPI, LEAD, MB, adminOnly, getTeams, isDay, kpiPerson, ownClient, roleMap, tgt, wrap });
// ---- My profile, onboarding, usernames, Facebook accounts, my Telegram and alerts (src/routes/me.js) ----
const { MENU, menuPerson } = require('./src/routes/me')(null, api, { KPI, LOGINS, MB, TASKS_OFF, canSeeAdmin, fbNameOf, getTeams, isFull, newCode, roleOf, wrap });
// ---- Task menu, tasks, team, targets and client workbooks (src/routes/task-menu.js) ----
require('./src/routes/task-menu')(null, api, { AI, KPI, MB, MENU, TASKS_OFF, adminOnly, canSeeAdmin, dayTasks, getTeams, isDay, menuPerson, ownClient, wrap });
// ---- Media buyers, and client tasks given to them (src/routes/media-buyers.js) ----
require('./src/routes/media-buyers')(app, api, { AI, LOGINS, MB, adminOnly, canSeeAdmin, isFull, ownClient, ownsBuyer, wrap });
// ---- AI status, orders compare / Pages / pull / report, and Live or Post by hand (src/routes/orders-pages.js) ----
require('./src/routes/orders-pages')(null, api, { adminOnly, canSeeAdmin, isDay, ownerOnly, wrap });
// The bigger live/post window (a day or less = live): recount saved days once.
app.use('/api', api);

// A page nobody has: a small branded 404 with a way back (API paths keep their JSON 404).
app.use((req, res, next) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not found.' });
  res.status(404).type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Page not found · Ads Box</title><link rel="icon" href="/favicon.ico"><style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:Inter,system-ui,sans-serif;background:#f6f7f9;color:#0f172a}main{text-align:center;padding:32px;max-width:420px}h1{font-size:22px;margin:0 0 8px}p{color:#64748b;margin:0 0 20px;line-height:1.5}a{display:inline-block;background:#2563eb;color:#fff;text-decoration:none;font-weight:600;padding:10px 18px;border-radius:10px}</style></head><body><main><h1>This page doesn't exist</h1><p>The link may be old or mistyped. Go back to Boost Desk and pick a page from the menu.</p><a href="/">Open Boost Desk</a></main></body></html>`);
});
// Errors → JSON with a clear message.
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (!err.status || err.status >= 500) console.error('[' + req.method + ' ' + req.path.slice(0, 40) + ']', err.message || err); else console.log('[' + req.path + ']', err.message);
  if (err instanceof meta.MetaError) {
    return res.status(err.needsLogin ? 401 : 502).json({
      error: err.needsLogin ? 'Your Facebook login has expired. Log in again.' : err.rateLimited ? 'Meta is limiting requests right now. Wait a few minutes and try again.' : 'Meta: ' + err.message,
      needsLogin: err.needsLogin,
    });
  }
  res.status(err.status || 500).json({ error: err.message || 'Something went wrong.' });
});

db.init().then(() => pageOrders.init()).then(() => { profit.init().catch((e) => console.log('[profit] init skipped:', e.message)); }).then(() => {
  require('./src/security').rekey().then((r) => { if (r.oldKey) console.log('[security] re-encrypted with the new key:', r.logins, 'logins,', r.keys, 'API keys', r.failed ? `(${r.failed} could not be read)` : ''); }).catch((e) => console.log('[security] rekey failed:', e.message));
  db.getSetting('invoiceQr', '').then((q) => invoice.setQr(q)).catch(() => {});
  // FULL_ADMIN_EMAILS (Railway variable, comma-separated Gmail addresses): on start, each one is put on the Admin website
  // list as a full admin (same rights as the owner). It only adds or upgrades — removing someone is done in Admin → Settings.
  (async () => {
    const want = String(process.env.FULL_ADMIN_EMAILS || '').split(',').map(normEmail).filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)); if (!want.length) return;
    const site = await siteCfg(); let n = 0;
    for (const email of want) { const cur = site.people.find((x) => x.email === email);
      if (!cur) { site.people.push({ email, name: '', linkTo: '', full: true, addedAt: new Date().toISOString(), addedBy: 'FULL_ADMIN_EMAILS' }); n++; }
      else if (!cur.full || cur.linkTo) { cur.full = true; cur.linkTo = ''; n++; } }
    if (n) { await db.setSetting('adminSite', site); console.log('[admin] full admin by Gmail set for', n, 'address(es)'); }
  })().catch((e) => console.log('[admin] FULL_ADMIN_EMAILS skipped:', e.message));
  // One time (18 Nov 2026): a workspace whose username was made for a named PM takes that PM's name; the Facebook
  // account's name is kept beside it and shown under Team Facebook accounts.
  (async () => {
    const flag = 'migr:pmNames:2026-11-18'; if (await db.getSetting(flag, null)) return; let n = 0;
    for (const l of await LOGINS().list()) {
      if (l.role !== 'pm' || !l.fbId || !String(l.name || '').trim()) continue;
      const u = await db.getUser(l.fbId); if (!u || u.name === l.name.trim() || (await db.getUserSetting(u.fb_id, 'fbName', ''))) continue;
      await db.setUserSetting(u.fb_id, 'fbName', u.name); await db.pool.query('UPDATE users SET name=$2 WHERE fb_id=$1', [u.fb_id, l.name.trim()]); n++;
    }
    await db.setSetting(flag, { at: new Date().toISOString(), renamed: n }); if (n) console.log('[accounts] workspace named after its PM for', n, 'account(s)');
  })().catch((e) => console.log('[accounts] PM names skipped:', e.message));
  // One time (17 Nov 2026): the company moved — every account's saved invoice address becomes the new one.
  (async () => {
    const flag = 'migr:invoiceAddress:2026-11-17'; if (await db.getSetting(flag, null)) return;
    const rows = (await db.pool.query(`SELECT key, value FROM settings WHERE key LIKE '%:invoiceProfile'`)).rows; let n = 0;
    for (const r of rows) { const v = r.value || {}; if (v.address1 === invoice.DEFAULT_PROFILE.address1 && v.address2 === invoice.DEFAULT_PROFILE.address2) continue; await db.setSetting(r.key, { ...v, address1: invoice.DEFAULT_PROFILE.address1, address2: invoice.DEFAULT_PROFILE.address2 }); n++; }
    await db.setSetting(flag, { at: new Date().toISOString(), updated: n }); console.log('[invoice] address updated for', n, 'account(s)');
  })().catch((e) => console.log('[invoice] address update skipped:', e.message));
  const server = app.listen(cfg.port, () => console.log(`Boost Desk running on ${cfg.baseUrl} (port ${cfg.port})`));
  // A restart (every deploy) lets the requests in flight finish first, then closes the database, at most 10 seconds.
  let closing = false;
  const stop = (sig) => { if (closing) return; closing = true; console.log(`[stop] ${sig}: finishing open requests`); const t = setTimeout(() => process.exit(0), 10000); if (t.unref) t.unref(); server.close(() => db.pool.end().catch(() => {}).finally(() => process.exit(0))); };
  process.on('SIGTERM', () => stop('SIGTERM')); process.on('SIGINT', () => stop('SIGINT'));
  jobs.start({ handoff: HANDOFF_DEPS });
  // One-off repair (19 Nov 2026): a merge left ad accounts the merged account was syncing unticked in the target, so its
  // sync read nothing. For every workspace merged into since 19 Nov: tick the unticked accounts that have synced rows in
  // the last 30 days, then pull this month again from Meta. Runs once (setting mergeRepair1).
  setTimeout(async () => {
    try {
      if (await db.getSetting('mergeRepair1', null)) return;
      const targets = [...new Set(((await db.getSetting('mergeLog', [])) || []).filter((m) => String(m.at) >= '2026-11-19' && m.into && m.into.id).map((m) => String(m.into.id)))];
      const today = sync.todayIn(), done = [];
      for (const owner of targets) {
        const u = await db.getUser(owner); if (!u) continue;
        const total = (await db.pool.query('SELECT count(*)::int n, count(*) FILTER (WHERE enabled)::int e FROM ad_accounts WHERE owner=$1', [owner])).rows[0];
        const used = (await db.pool.query(`SELECT DISTINCT regexp_replace(x->>'accountId', '^act_', '') id FROM raw_rows r, jsonb_array_elements(r.rows) x WHERE r.owner=$1 AND r.day >= $2::date AND x->>'accountId' IS NOT NULL`, [owner, sync.addDays(today, -30)])).rows.map((r) => r.id);
        const fixed = (await db.pool.query(`UPDATE ad_accounts SET enabled=true WHERE owner=$1 AND NOT enabled AND regexp_replace(id, '^act_', '') = ANY($2) RETURNING name`, [owner, used])).rows;
        console.log(`[merge repair] ${u.name}: ${total.n} ad accounts, ${total.e} ticked before; ${used.length} with synced rows in 30 days; ticked now: ${fixed.length}${fixed.length ? ' — ' + fixed.map((r) => r.name).join(', ') : ''}`);
        done.push({ owner, name: u.name, before: total, used: used.length, fixed: fixed.length });
        if (fixed.length) sync.exclusive(owner, () => sync.syncRange(today.slice(0, 8) + '01', today, { ...u, name: 'Auto sync' })).then((r) => console.log(`[merge repair] ${u.name}: month sync ${r ? `done, ${r.campaigns} campaigns, ${r.errors.length} account errors` : 'skipped (another sync is running — the next automatic sync picks it up)'}`)).catch((e) => console.error('[merge repair] month sync failed:', e.message));
      }
      await db.setSetting('mergeRepair1', { at: new Date().toISOString(), done });
    } catch (e) { console.error('[merge repair]', e.message); }
  }, 20e3).unref();
  // One-off (owner's request, 19 Nov 2026): in the workspaces merged into today, merge the FIRST pair of clients with the
  // same name and log this month's spend before and after, so the result can be checked before the rest is done.
  setTimeout(async () => {
    try {
      if (await db.getSetting('dupMerge1', null)) return;
      const targets = [...new Set(((await db.getSetting('mergeLog', [])) || []).filter((m) => String(m.at) >= '2026-11-19' && m.into && m.into.id).map((m) => String(m.into.id)))];
      const today = sync.todayIn(), from = today.slice(0, 8) + '01', out = [];
      for (const owner of targets) {
        const u = await db.getUser(owner); if (!u) continue;
        const list = (await db.listClients(owner)).filter((c) => !c.archived), groups = {};
        for (const c of list) (groups[String(c.name || '').trim().toLowerCase()] = groups[String(c.name || '').trim().toLowerCase()] || []).push(c);
        const dups = Object.values(groups).filter((g) => g.length > 1);
        console.log(`[dup merge] ${u.name}: ${list.length} clients, ${dups.length} names used more than once — ${dups.map((g) => `${g[0].name} ×${g.length}`).join(', ')}`);
        if (!dups.length) continue;
        const spendOf = async () => Object.fromEntries(((await sync.dashboard(owner, from, today)).clients || []).map((x) => [x.id, x.spend || 0]));
        const before = await spendOf(), g = dups[0].slice().sort((a, b) => (before[b.id] || 0) - (before[a.id] || 0) || a.id - b.id), A = g[0], B = g[1];
        const sumBefore = Math.round(((before[A.id] || 0) + (before[B.id] || 0)) * 100) / 100;
        await mergeClients(u, A.id, B.id);
        const after = await spendOf();
        console.log(`[dup merge] ${u.name}: "${B.name}" #${B.id} ($${(before[B.id] || 0).toFixed(2)}) into #${A.id} ($${(before[A.id] || 0).toFixed(2)}) — this month before $${sumBefore.toFixed(2)}, after $${(after[A.id] || 0).toFixed(2)}${Math.abs((after[A.id] || 0) - sumBefore) < 0.01 ? ' ✓ same' : ' ✗ DIFFERENT'}`);
        out.push({ owner, kept: A.id, removed: B.id, name: A.name, before: sumBefore, after: after[A.id] || 0 });
      }
      await db.setSetting('dupMerge1', { at: new Date().toISOString(), out });
    } catch (e) { console.error('[dup merge]', e.message); }
  }, 45e3).unref();
  // One-off (owner's request, 19 Nov 2026): the same for every workspace — after a backup to the owner's Telegram.
  setTimeout(async () => {
    try {
      if (await db.getSetting('dupMergeAll', null)) return;
      await db.setSetting('dupMergeAll', { at: new Date().toISOString(), running: true }); // claim first: never twice
      const todo = []; for (const u of await db.allUsers()) { const n = sameName(await db.listClients(u.fb_id)).length; if (n) todo.push(u); }
      if (!todo.length) { console.log('[dedupe] no workspace has two clients with the same name'); await db.setSetting('dupMergeAll', { at: new Date().toISOString(), out: [] }); return; }
      const bk = process.env.DEDUPE_TEST === 'local-no-backup' ? { sent: true } : await require('./src/backup').run(telegram).catch((e) => ({ sent: false, error: e.message }));
      console.log(`[dedupe] backup before merging duplicates: ${bk.sent ? 'sent to the owner on Telegram' : 'NOT sent (' + (bk.error || 'unknown') + ')'}`);
      if (!bk.sent) { await db.setSetting('dupMergeAll', { at: new Date().toISOString(), stopped: 'no backup' }); return; } // nothing is merged without a backup
      const out = []; for (const u of todo) { try { out.push({ name: u.name, ...(await dedupeClients(u)) }); } catch (e) { console.error('[dedupe]', u.name, e.message); out.push({ name: u.name, error: e.message }); } }
      await db.setSetting('dupMergeAll', { at: new Date().toISOString(), out });
    } catch (e) { console.error('[dedupe]', e.message); }
  }, 60e3).unref();
  // One-off (20 Nov 2026): the first auto Boost plan lines took the campaign's start on Meta, which counted older posts against them.
  setTimeout(async () => { try { if (await db.getSetting('autoPlanFix1', null)) return; await db.setSetting('autoPlanFix1', { at: new Date().toISOString(), running: true }); const n = await require('./src/autoplan').fixPastStarts(); await db.setSetting('autoPlanFix1', { at: new Date().toISOString(), lines: n }); console.log(`[autoplan] one-off: ${n} lines now start today`); } catch (e) { console.error('[autoplan] one-off', e.message); } }, 20e3).unref();
  setTimeout(() => require('./src/announce').run().catch((e) => console.error('[announce]', e.message)), 30e3).unref(); // one-off announcement of 19 Nov 2026
  setTimeout(() => require('./src/announce').runConnect().catch((e) => console.error('[announce]', e.message)), 45e3).unref(); // one-off of 20 Nov 2026 13:42: PMs connect client Pages (daytime only)
  setInterval(require('./src/runOnce').once('Announce guide', () => require('./src/announce').runGuide().catch((e) => console.error('[announce]', e.message)), 5 * 60e3), 5 * 60e3).unref(); // one-off guide of 20 Nov 2026: goes out once, from 08:10
  // One time: recount saved days with the newer live/post rule (and keep campaign IDs for "Move to Post/Live").
  (async () => {
    for (const u of await db.allUsers()) {
      if (await db.getUserSetting(u.fb_id, 'kindsV5', false)) continue;
      try { if (!(await sync.exclusive(u.fb_id, () => sync.rematch(u)))) continue; await db.setUserSetting(u.fb_id, 'kindsV5', true); console.log('[startup] recounted live/post for', u.name); }
      catch (e) { console.error('[startup] recount failed for', u.name, e.message); }
    }
  })();
}).catch((e) => { console.error('Database setup failed:', e.message); process.exit(1); });
