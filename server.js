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
// ---- Username + password sign-in (src/logins.js) (src/routes/auth-logins.js) ----
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
require('./src/routes/admin-panel')(null, api, { LEAD, ROLES, adminOnly, adminViewers, fullAdmins, getTeams, isFull, linkCode, ownerOnly, roleMap, roleOf, sha, wrap });
// ---- Every ad account of every person (Admin → Ad accounts) (src/routes/admin-ad-accounts.js) ----
require('./src/routes/admin-ad-accounts')(null, api, { adminOnly, getTeams, ownerOnly, wrap });
// ---- Admin website access, security, backups, blocked accounts, auto sync control (src/routes/admin-security.js) ----
const { cleanClient } = require('./src/routes/admin-security')(null, api, { adminOnly, dedupeClients, googleRedirect, isFull, normEmail, ownerOnly, siteCfg, wrap });
// ---- Clients, post pictures, day checklist and Sync from Meta (src/routes/clients.js) ----
const { deepMerge } = require('./src/routes/clients')(null, api, { cleanClient, isDay, wrap });
// ---- Payments: service fees and invoices (src/routes/invoices.js) ----
require('./src/routes/invoices')(api, { wrap, isDay, isFull });

// ---- Live videos, live setups, Dashboard and Page names (src/routes/lives-dashboard.js) ----
const { accountsWithToday } = require('./src/routes/lives-dashboard')(null, api, { isDay, sha, wrap, get rangeOk() { return rangeOk; } });
api.get('/accounts', wrap(async (req, res) => res.json(await accountsWithToday(req.user.fb_id))));
api.post('/accounts/refresh', wrap(async (req, res) => {
  const me = req.user.fb_id;
  // Pull today's spend for the ticked accounts (updates Home too); unticked ones get a quick total.
  const r = await sync.exclusive(me, () => sync.syncDay(sync.todayIn(), req.user));
  if (r === null) return res.status(409).json({ error: 'A sync is running right now. Try again in a moment.' });
  res.json(await accountsWithToday(me)); // syncDay already refreshed the unticked accounts' totals
}));
// Tick / untick: an unticked account stops syncing and its past spend drops out of every page (a rematch runs in the background).
api.patch('/accounts/:id', wrap(async (req, res) => { await db.setAccountEnabled(req.user.fb_id, req.params.id, req.body?.enabled); res.json({ ok: true }); sync.exclusive(req.user.fb_id, () => sync.rematch(req.user)).catch((e) => console.error('[accounts] rematch:', e.message)); }));

// Reports
const rangeOk = (from, to) => isDay(from) && isDay(to) && from <= to && (Date.parse(to) - Date.parse(from)) / 864e5 <= 366;
// Telegram groups are private per account: a group belongs to the account whose link code was sent
// in it ("/link CODE"), or to the account that already uses it for one of its clients.
const newCode = () => { const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', r = require('crypto').randomBytes(8); return Array.from(r.subarray(0, 8), (b) => A[b % 32]).join(''); }; // 8 chars, crypto RNG
async function linkCode(fbId) {
  let c = await db.getUserSetting(fbId, 'tgCode', null);
  if (!c) { c = newCode(); await db.setUserSetting(fbId, 'tgCode', c); }
  return c;
}
// One refresh at a time, so two requests never handle the same /link message twice.
let chatsBusy = Promise.resolve();
// Read new Telegram messages every minute, so /link works without opening the website and nothing expires.
if (telegram.hasBot()) { health.register('Telegram check', 1, 'every minute'); setInterval(require('./src/runOnce').once('Telegram check', () => health.track('Telegram check', () => refreshChats()).catch((e) => console.error('[telegram] refresh:', e.message)), 15000), 15000).unref(); } // every 15 s so "Done" taps show quickly
let chatsAt = 0; // when Telegram was last read
function refreshChats() { const run = chatsBusy.then(refreshChatsNow, refreshChatsNow).then((r) => { chatsAt = Date.now(); return r; }); chatsBusy = run.catch(() => {}); return run; }
// The saved list is at most ~15 s old (background check), so pages use it instead of waiting 3 s on Telegram every time.
const chatsNow = async () => (Date.now() - chatsAt < 25000 ? db.getSetting('telegramChats', []) : refreshChats());
async function refreshChatsNow() {
  const saved = await db.getSetting('telegramChats', []);
  const byId = new Map(saved.map((c) => [c.id, c]));
  let fresh = { chats: [], links: [], moved: [] };
  const offset = await db.getSetting('telegramOffset', 0);
  try { fresh = await telegram.listChats(offset); } catch (e) { if (!saved.length) throw e; }
  // Groups that became supergroups: move the saved group, its topics and every client to the new id.
  for (const mv of fresh.moved || []) {
    for (const c of [...byId.values()]) {
      const [g, th] = String(c.id).split(':'); if (g !== mv.from) continue;
      const id = th ? `${mv.to}:${th}` : mv.to; byId.delete(c.id); byId.set(id, { ...c, id, ...(c.chat ? { chat: mv.to } : {}) });
    }
    await db.pool.query(`UPDATE clients SET telegram = $2 || substr(telegram, length($1) + 1) WHERE telegram = $1 OR telegram LIKE $1 || ':%'`, [mv.from, mv.to]);
    await db.pool.query(`UPDATE clients SET topics = replace(topics::text, '"' || $1 || ':', '"' || $2 || ':')::jsonb WHERE topics::text LIKE '%"' || $1 || ':%'`, [mv.from, mv.to]);
    console.log('[telegram] group moved', mv.from, '→', mv.to);
  }
  for (const c of fresh.chats) {
    const old = byId.get(c.id) || {};
    // A topic seen without its name (e.g. "Topic 45") keeps the name found earlier.
    byId.set(c.id, { ...old, ...c, ...(c.type === 'topic' && !c.topic && old.topic ? { topic: old.topic, title: old.title } : {}) });
  }
  // A group can be linked to several accounts: everyone who sent "/link CODE" there, until "/unlink CODE".
  // Each /link message is handled once (by its time), so nothing repeats or flips between people.
  for (const c of byId.values()) { if (!c.owners) c.owners = c.owner ? [c.owner] : []; if (!c.seen) c.seen = {}; }
  if (fresh.links.length) {
    const users = await db.allUsers(), byCode = {};
    for (const u of users) byCode[await linkCode(u.fb_id)] = u;
    for (const l of fresh.links) {
      const u = byCode[l.code], c = byId.get(l.id); if (!u || !c) continue;
      if ((c.seen[u.fb_id] || 0) >= l.at) continue; // this message was already handled
      c.seen[u.fb_id] = l.at;
      const has = c.owners.includes(u.fb_id);
      // The group belongs to the client too, so the bot's reply is short, names no one, and is cleaned up
      // (with the /link command) after a minute.
      const where = c.type === 'topic' ? 'Topic' : 'ក្រុម';
      let text = '';
      if (l.unlink && has) {
        c.owners = c.owners.filter((x) => x !== u.fb_id);
        if (!c.owners.length) text = `🔕 ${where}នេះ នឹងលែងទទួលរបាយការណ៍ Boost ទៀតហើយ។\nThis ${c.type === 'topic' ? 'topic' : 'group'} will no longer receive boost reports.`;
      } else if (!l.unlink && !has) {
        c.owners.push(u.fb_id);
        text = `✅ ${where}នេះ ត្រូវបានភ្ជាប់ ដើម្បីទទួលរបាយការណ៍ Boost ប្រចាំថ្ងៃពី Ads Box។\nThis ${c.type === 'topic' ? 'topic' : 'group'} is set up to receive daily boost reports from Ads Box.`;
      }
      const tidy = async (botMsg) => setTimeout(() => { telegram.remove(c.id, botMsg); telegram.remove(c.id, l.msgId); }, 60000);
      if (text) telegram.send(text, c.id).then(tidy).catch(() => {});
      else tidy(null);
    }
  }
  for (const c of byId.values()) c.owner = c.owners[0] || '';
  // Groups with no owner yet: give them to the account whose clients already use them.
  const unowned = [...byId.values()].filter((c) => !c.owner);
  if (unowned.length) {
    const rows = (await db.pool.query("SELECT DISTINCT owner, telegram FROM clients WHERE telegram <> ''")).rows;
    for (const c of unowned) { const users = [...new Set(rows.filter((r) => r.telegram === c.id).map((r) => r.owner))]; if (users.length) { c.owners = users; c.owner = users[0]; } }
  }
  // "/alerts CODE" sent to the bot in a private chat by the owner: system alerts go to that chat.
  if ((fresh.alerts || []).length) {
    const owner = await db.ownerId(), code = owner && (await linkCode(owner));
    for (const al of fresh.alerts) if (code && al.code === code) {
      await db.setSetting('alertChat', { id: al.id, name: al.name, at: new Date().toISOString() });
      telegram.send('✅ Boost Desk system alerts will come to this chat. Send /alerts again from another chat to move them.', al.id).catch(() => {});
    }
  }
  try { await require('./src/status').onTelegram(fresh); } catch (e) { console.error('[telegram] client status:', e.message); }
  try { await require('./src/buyers').onTelegram(fresh, AI); } catch (e) { console.error('[telegram] media buyers:', e.message); }
  try { await require('./src/handoff').onTelegram(fresh); } catch (e) { console.error('[telegram] handoff:', e.message); }
  // PMs / owner connecting their own Telegram (t.me/<bot>?start=pm_CODE) for plan / result alerts from their media buyers.
  for (const st of fresh.pmStarts || []) {
    try {
      const users = await db.allUsers(); let hit = null;
      for (const x of users) { const c = String(await db.getUserSetting(x.fb_id, 'tgCode', '') || '').toUpperCase(); if (c && c === String(st.code).toUpperCase()) { hit = x; break; } }
      if (!hit) continue;
      await db.setUserSetting(hit.fb_id, 'tgChat', { id: st.id, name: st.name, at: new Date().toISOString() });
      const known = await db.getSetting('tgPmChats', {}); known[st.id] = hit.fb_id; await db.setSetting('tgPmChats', known);
      telegram.send(`✅ Hi ${hit.name}! Boost Desk alerts come here now: when your media buyers submit their plan in the morning and their result in the evening.`, st.id).catch(() => {});
    } catch (e) { console.error('[telegram] pm link:', e.message); }
  }
  // /password in a private chat: a new temporary password for the username that belongs to this Telegram (a PM's linked chat, or a media buyer's).
  for (const ask of fresh.pwAsks || []) {
    try {
      const L = LOGINS(), last = (await db.getSetting('pwAskAt', {})) || {};
      if (last[ask.id] && Date.now() - last[ask.id] < 10 * 60e3) { telegram.send('A new password was sent a few minutes ago. Wait 10 minutes before asking again.', ask.id).catch(() => {}); continue; }
      const mb = (await MB().list()).find((x) => x.chat === ask.id), pmId = !mb && ((await db.getSetting('tgPmChats', {})) || {})[ask.id];
      const stillPm = pmId && String(((await db.getUserSetting(pmId, 'tgChat', null)) || {}).id || '') === ask.id; // the link may have been removed since
      const rec = mb ? await L.forMb(mb.id) : stillPm ? await L.forFb(pmId) : null;
      if (!rec) { telegram.send(mb || stillPm ? 'You have no Boost Desk username yet. ' + (mb ? 'Ask your PM to make one (Settings → My media buyers → 🔑 Username).' : 'Make one in Boost Desk → Settings → Username & password.') : 'This Telegram is not linked to a Boost Desk person, so I can\'t send a password here.', ask.id).catch(() => {}); continue; }
      const r = await L.reset(rec.username); last[ask.id] = Date.now(); await db.setSetting('pwAskAt', last);
      await telegram.send(`🔑 Boost Desk\nUsername: ${r.login.username}\nNew password: ${r.password}\n\nLog in at ${cfg.baseUrl}/login and choose your own password in Settings. Delete this message afterwards.`, ask.id);
    } catch (e) { console.error('[telegram] password ask:', e.message); }
  }
  const all = [...byId.values()].sort((a, b) => String(a.title).localeCompare(String(b.title)));
  await db.setSetting('telegramChats', all);
  if (fresh.next && fresh.next !== offset) await db.setSetting('telegramOffset', fresh.next); // only after everything above is saved
  return all;
}
async function myChats(fbId) {
  const all = await chatsNow();
  const used = new Set((await db.listClients(fbId)).map((c) => c.telegram).filter(Boolean));
  for (const c of await db.listClients(fbId)) for (const v of Object.values(c.topics || {})) used.add(v.id);
  return all.filter((c) => (c.owners || [c.owner]).includes(fbId) || used.has(c.id)).map(({ id, title, type, chat, topic }) => ({ id, title, type, chat, topic }));
}
api.get('/telegram/chats', wrap(async (req, res) => {
  res.json({ chats: await myChats(req.user.fb_id), code: await linkCode(req.user.fb_id), bot: await telegram.username() });
}));
// skip: Pages left out of the report (JSON list of Page IDs / names), unticked on the Dashboard.
function skipOf(v) {
  let a = v; if (typeof v === 'string') { try { a = JSON.parse(v); } catch (_) { a = []; } }
  return Array.isArray(a) ? a.map((x) => String(x || '').trim().slice(0, 150)).filter(Boolean).slice(0, 50) : [];
}
const skipScope = (skip) => (skip.length ? { exclude: skip } : null);
api.get('/client-report/:id', wrap(async (req, res) => {
  const { from, to } = req.query;
  if (!rangeOk(from, to)) return res.status(400).json({ error: 'Pick a valid date or month.' });
  const kind = kindOf(req.query.kind), parts = partsOf(req.query.parts), skip = skipOf(req.query.skip), orders = req.query.orders !== '0';
  const c = (await db.listClients(req.user.fb_id)).find((x) => x.id === Number(req.params.id));
  if (c && to === sync.todayIn()) { try { await sync.freshenToday(req.user, c.id, to); } catch (e) { console.error('[report] fresh spend:', e.message); } } // today's numbers straight from Meta, like the picture
  // does the client have both Lives and posts in this period? Then the dialog offers "All · Live · Post" (20 Nov 2026)
  let mix = null; if (c) { try { const m = await reportImage.clientCampaigns(req.user.fb_id, c.id, from, to); mix = { live: m.lives > 0, post: m.posts > 0 }; } catch (_) {} }
  const rts = c ? reports.routes(c) : [];
  if (rts.length > 1) { // Pages that report to their own topics: one text per Page
    const list = await reports.preview(req.user.fb_id, c, from, to, { kind, parts, skip, orders });
    const r = await sync.clientReport(req.user.fb_id, req.params.id, from, to, kind, parts, skipScope(skip), { orders });
    return res.json({ ...r, routes: list, mix });
  }
  res.json({ ...(await sync.clientReport(req.user.fb_id, req.params.id, from, to, kind, parts, skipScope(skip), { orders })), mix });
}));
// The ads picture for a client's report (PNG). 204 = no ads with spend in the period.
const imgCache = new Map(); // short-lived, so the preview and the send use the same picture
async function reportPng(user, id, from, to, kind = '', parts = null, skip = []) {
  const k = `${user.fb_id}|${id}|${from}|${to}|${kind}|${(parts || []).join(',')}|${skip.join('¦')}`, hit = imgCache.get(k);
  if (hit && Date.now() - hit.at < 5 * 60000) return hit.png;
  const png = await reportImage.clientReportImage(user, id, from, to, kind, parts, skipScope(skip));
  imgCache.set(k, { png, at: Date.now() });
  for (const [kk, v] of imgCache) if (Date.now() - v.at > 5 * 60000) imgCache.delete(kk);
  return png;
}
api.get('/client-report/:id/image', wrap(async (req, res) => {
  const { from, to } = req.query;
  if (!rangeOk(from, to)) return res.status(400).json({ error: 'Pick a valid date or month.' });
  const kind = kindOf(req.query.kind), parts = partsOf(req.query.parts), skip = skipOf(req.query.skip);
  if (req.query.page != null && req.query.page !== '') { // one Page's picture
    const c = (await db.listClients(req.user.fb_id)).find((x) => x.id === Number(req.params.id));
    const r = c && reports.routes(c, skip).find((x) => x.key === String(req.query.page));
    if (!r) return res.status(404).json({ error: 'That Page has no topic.' });
    const png = await reportImage.clientReportImage(req.user, req.params.id, from, to, kind, parts, r.scope);
    if (!png) return res.status(204).end();
    return res.set('content-type', 'image/png').set('cache-control', 'no-store').send(png);
  }
  if (req.query.fresh) imgCache.delete(`${req.user.fb_id}|${req.params.id}|${from}|${to}|${kind}|${(parts || []).join(',')}|${skip.join('¦')}`);
  const png = await reportPng(req.user, req.params.id, from, to, kind, parts, skip);
  if (!png) return res.status(204).end();
  res.set('content-type', 'image/png').set('cache-control', 'no-store').send(png);
}));
// Reports sent in the last 48 hours (Telegram lets a bot delete its own messages only that long),
// so they can be deleted from the group. Per user: { 'clientId|from|to': { at, by, to, msgs: [{ chat, id }] } }.
const SENT_KEEP = 48 * 3600e3;
async function sentReports(owner) {
  const all = (await db.getUserSetting(owner, 'sentReports', {})) || {}, out = {};
  for (const [k, v] of Object.entries(all)) if (v && Date.now() - Date.parse(v.at) < SENT_KEEP) out[k] = v;
  return out;
}
async function rememberSent(user, id, from, to, msgs, sentTo) {
  if (!msgs.length) return;
  const all = await sentReports(user.fb_id), k = `${Number(id)}|${from}|${to}`;
  const old = all[k] ? all[k].msgs : []; // sent again: Delete removes every copy
  all[k] = { at: new Date().toISOString(), by: user.name, to: sentTo, msgs: [...old, ...msgs].slice(-40) };
  await db.setUserSetting(user.fb_id, 'sentReports', all);
}
api.get('/sent-reports', wrap(async (req, res) => {
  const all = await sentReports(req.user.fb_id);
  res.json(Object.fromEntries(Object.entries(all).map(([k, v]) => [k, { at: v.at, by: v.by, to: v.to, count: v.msgs.length }])));
}));
api.post('/client-report/:id/delete', wrap(async (req, res) => {
  const { from, to } = req.body || {};
  if (!rangeOk(from, to)) return res.status(400).json({ error: 'Pick a valid date or month.' });
  const all = await sentReports(req.user.fb_id), k = `${Number(req.params.id)}|${from}|${to}`, rec = all[k];
  if (!rec) return res.status(404).json({ error: 'No report sent in the last 48 hours for this period — delete it in Telegram instead (group admins can).' });
  let ok = 0;
  for (const m of rec.msgs) if (await telegram.remove(m.chat, m.id)) ok++;
  delete all[k]; await db.setUserSetting(req.user.fb_id, 'sentReports', all);
  if (from === to && isDay(from)) { const id = Number(req.params.id); await db.putEntry(req.user.fb_id, from, id, deepMerge(await db.getEntry(req.user.fb_id, from, id), { reportSent: null })); }
  res.json({ ok: true, deleted: ok, failed: rec.msgs.length - ok });
}));
api.post('/client-report/:id/send', wrap(async (req, res) => {
  const { from, to, text, withImage } = req.body || {}, kind = kindOf((req.body || {}).kind), parts = partsOf((req.body || {}).parts), skip = skipOf((req.body || {}).skip), orders = (req.body || {}).orders !== false;
  if (!rangeOk(from, to)) return res.status(400).json({ error: 'Pick a valid date or month.' });
  const cl = (await db.listClients(req.user.fb_id)).find((x) => x.id === Number(req.params.id));
  if (cl && reports.routes(cl).length > 1) { // each Page to its own topic (or just the one picked in the dialog)
    const page = (req.body || {}).page;
    const track = [];
    const done = await reports.send(req.user, cl, from, to, { kind, parts, withImage: withImage !== false, only: page != null && page !== '' ? String(page) : null, text, skip, track, orders });
    if (!done.length) return res.status(400).json({ error: 'No boost spend to report for these Pages.' });
    await rememberSent(req.user, cl.id, from, to, track, done.map((d) => d.to).join(', '));
    const sentAt = new Date().toISOString();
    if (from === to && isDay(from) && (page == null || page === '')) await db.putEntry(req.user.fb_id, from, cl.id, deepMerge(await db.getEntry(req.user.fb_id, from, cl.id), { reportSent: { at: sentAt, by: req.user.name } }));
    return res.json({ ok: true, sentTo: done.map((d) => d.to).join(', '), sent: done, sentAt, withImage: done.some((d) => d.withImage) });
  }
  const r = await sync.clientReport(req.user.fb_id, req.params.id, from, to, kind, parts, skipScope(skip), { orders });
  if (!r.client.telegram) return res.status(400).json({ error: `${r.client.name} has no Telegram group yet. Pick one in the Clients tab.` });
  const body = typeof text === 'string' && text.trim() ? text.slice(0, 12000) : r.text;
  let png = null;
  if (withImage !== false) { try { png = await reportPng(req.user, req.params.id, from, to, kind, parts, skip); } catch (e) { if (e.needsLogin) throw e; console.error('[report image]', e.message); } }
  const track = [];
  if (png) await telegram.sendPhoto(png, body, r.client.telegram, track);
  else await telegram.send(body, r.client.telegram, track);
  await rememberSent(req.user, req.params.id, from, to, track, r.client.telegramTitle || r.client.telegram);
  const sentAt = new Date().toISOString();
  // A one-day report is remembered on that day's checklist ("Sent 21:05").
  if (from === to && isDay(from)) {
    const id = Number(req.params.id);
    await db.putEntry(req.user.fb_id, from, id, deepMerge(await db.getEntry(req.user.fb_id, from, id), { reportSent: { at: sentAt, by: req.user.name } }));
  }
  res.json({ ok: true, sentTo: r.client.telegramTitle || r.client.telegram, sentAt, withImage: !!png });
}));
api.get('/summary', wrap(async (req, res) => {
  const { from, to } = req.query;
  if (!rangeOk(from, to)) return res.status(400).json({ error: 'Pick a valid date or month.' });
  res.json({ text: await sync.summaryReport(req.user.fb_id, from, to) });
}));
api.post('/summary/send', wrap(async (req, res) => {
  const { from, to, text } = req.body || {};
  if (!rangeOk(from, to)) return res.status(400).json({ error: 'Pick a valid date or month.' });
  await telegram.send(typeof text === 'string' && text.trim() ? text.slice(0, 12000) : await sync.summaryReport(req.user.fb_id, from, to));
  res.json({ ok: true });
}));
api.get('/report/:day', wrap(async (req, res) => {
  if (!isDay(req.params.day)) return res.status(400).json({ error: 'Bad date.' });
  res.json({ text: await sync.buildReport(req.user.fb_id, req.params.day) });
}));
api.post('/report/:day/send', wrap(async (req, res) => {
  if (!isDay(req.params.day)) return res.status(400).json({ error: 'Bad date.' });
  const text = await sync.buildReport(req.user.fb_id, req.params.day);
  await telegram.send(text);
  res.json({ ok: true });
}));

// ---------- auto daily report ----------
api.get('/auto-report', wrap(async (req, res) => res.json({ ...(await extras.autoSettings(req.user.fb_id)), last: await db.getUserSetting(req.user.fb_id, 'autoReportLast', null), bot: telegram.hasBot(), tz: cfg.tz })));
api.put('/auto-report', wrap(async (req, res) => res.json({ ...(await extras.saveAutoSettings(req.user.fb_id, req.body || {})), last: await db.getUserSetting(req.user.fb_id, 'autoReportLast', null) })));
// One workspace's clients for one day: spend, orders, and whether each report went out.
async function reportStatus(owner, day) {
  const clients = (await db.listClients(owner)).filter((c) => !c.archived), set = await extras.autoSettings(owner);
  let oc = { clients: {} }; try { oc = await require('./src/orders').byClient(owner, day, day); } catch (_) { /* orders not connected */ }
  const live = (c) => c.type === 'live' || c.type === 'both', post = (c) => c.type === 'post' || c.type === 'both' || !c.type;
  const rows = [];
  for (const c of clients) {
    const e = await db.getEntry(owner, day, c.id), lives = live(c) ? Object.values(e.lives || {}).filter((l) => Number(l && l.spend) > 0) : [];
    const liveSpend = lives.reduce((t, l) => t + Number(l.spend), 0), postSpend = post(c) ? Number((e.post || {}).spend) || 0 : 0, spend = Math.round((liveSpend + postSpend) * 100) / 100;
    const routes = reports.routes(c), chat = routes.find((r) => r.chat), o = (oc.clients || {})[c.id], orders = o ? o.orders : null;
    const sent = e.reportSent && e.reportSent.at ? { at: e.reportSent.at, by: e.reportSent.by || '' } : null;
    rows.push({ id: c.id, name: c.name, type: c.type || 'post', page: (c.pages || []).find((p) => /^\d{5,20}$/.test(String(p))) || '', group: chat ? (chat.title || c.telegram_title || 'Telegram group') : '', hasGroup: !!chat,
      spend, lives: lives.length, orders, cpo: orders > 0 && spend > 0 ? Math.round(spend / orders * 100) / 100 : null, sent, auto: !set.skip.includes(c.id),
      status: sent ? 'sent' : !chat ? 'nogroup' : spend > 0 ? 'unsent' : 'nospend' });
  }
  const rank = { unsent: 0, nogroup: 1, sent: 2, nospend: 3 }; rows.sort((a, b) => rank[a.status] - rank[b.status] || b.spend - a.spend || a.name.localeCompare(b.name));
  return { rows, auto: { on: !!set.on, time: set.time }, anyOrders: rows.some((r) => r.orders != null), totals: reportTotals(rows) };
}
function reportTotals(rows) {
  const cnt = (k) => rows.filter((r) => r.status === k).length, tot = (k) => rows.reduce((t, r) => t + (Number(r[k]) || 0), 0), spend = Math.round(tot('spend') * 100) / 100, orders = tot('orders');
  return { clients: rows.length, spend, orders, cpo: orders > 0 && spend > 0 ? Math.round(spend / orders * 100) / 100 : null, sent: cnt('sent'), unsent: cnt('unsent'), nogroup: cnt('nogroup'), nospend: cnt('nospend') };
}
// Reports page: every client of this account for one day.
api.get('/reports/status', wrap(async (req, res) => {
  const today = sync.todayIn(), day = isDay(req.query.day) && req.query.day <= today ? req.query.day : today;
  res.json({ day, today, bot: telegram.hasBot(), ...(await reportStatus(req.user.fb_id, day)) });
}));
// Team reports (leaders): the same day for every team, one group per Project Manager. Read only.
api.get('/admin/reports', adminOnly, wrap(async (req, res) => {
  const today = sync.todayIn(), day = isDay(req.query.day) && req.query.day <= today ? req.query.day : today;
  const users = await db.allUsers(), tms = await getTeams(), teamOf = {}; for (const t of tms) for (const m of t.members) teamOf[m] = t.name;
  let buyers = []; try { buyers = await MB().all(); } catch (_) { /* no media buyers yet */ }
  const teams = [];
  for (const u of users) {
    const r = await reportStatus(u.fb_id, day); if (!r.rows.length) continue;
    teams.push({ owner: u.fb_id, name: u.name, team: teamOf[u.fb_id] || '', buyers: buyers.filter((b) => b.addedById === u.fb_id).map((b) => b.name), ...r });
  }
  teams.sort((a, b) => b.totals.unsent - a.totals.unsent || b.totals.nogroup - a.totals.nogroup || b.totals.spend - a.totals.spend || a.name.localeCompare(b.name));
  const all = teams.flatMap((t) => t.rows);
  res.json({ day, today, bot: telegram.hasBot(), teams, anyOrders: teams.some((t) => t.anyOrders), totals: { ...reportTotals(all), teams: teams.length, teamsDone: teams.filter((t) => !t.totals.unsent).length } });
}));
// ---------- Handoff: notes between the media buyer (morning) and the PM (evening), and the Telegram brief / digest ----------
const HANDOFF_DEPS = { reportStatus, dayTasks };
api.get('/handoff', wrap(async (req, res) => res.json(await require('./src/handoff').card(req.user, HANDOFF_DEPS))));
api.post('/handoff', wrap(async (req, res) => {
  const HO = require('./src/handoff'), b = req.user.buyer;
  const note = await HO.addNote(req.user.fb_id, { kind: b ? 'mb' : 'pm', by: b ? b.name : req.user.name, byId: b ? b.id : req.user.fb_id, text: (req.body || {}).text });
  if (b) HO.pingPm(req.user.fb_id, note); // the PM hears about it on Telegram straight away
  res.json(await HO.card(req.user, HANDOFF_DEPS));
}));
api.get('/handoff/preview', wrap(async (req, res) => res.json(await require('./src/handoff').preview(req.user, HANDOFF_DEPS))));
api.put('/handoff/prefs', wrap(async (req, res) => { if (req.user.buyer) return res.status(403).json({ error: 'Your PM switches these messages on or off.' }); res.json(await require('./src/handoff').savePrefs(req.user.fb_id, req.body || {})); }));
api.post('/auto-report/run', wrap(async (req, res) => {
  if (!telegram.hasBot()) return res.status(400).json({ error: 'Telegram is not set up. Add TELEGRAM_BOT_TOKEN in Railway.' });
  const today = sync.todayIn(), pick = (req.body || {}).day;
  if (isDay(pick) && pick < today) return res.json(await extras.sendClientReports(req.user, pick, { refresh: false })); // an earlier day from the Reports page: send what is saved, keep "last auto run" as it was
  const r = await extras.sendClientReports(req.user, today);
  await db.setUserSetting(req.user.fb_id, 'autoReportLast', r);
  res.json(r);
}));
// ---------- today's to-do ----------
api.get('/todo', wrap(async (req, res) => res.json(await pm.todo(req.user))));

// ---------- Orders page (adsbox.biz API) ----------
api.get('/orders/api', wrap(async (req, res) => { const c = await orders.publicConfig(); if (!(await canSeeAdmin(req.user.fb_id))) { delete c.keyHint; delete c.url; delete c.savedBy; c.url = c.hasKey ? 'set' : ''; } res.json(c); })); // non-admins only learn whether it is connected
api.put('/orders/api', adminOnly, wrap(async (req, res) => res.json(await orders.saveApiConfig(req.body || {}, req.user.name))));
api.get('/orders/hook', adminOnly, wrap(async (req, res) => res.json({ url: `${req.protocol}://${req.get('host')}/hooks/adsbox`, secret: await orders.hookSecret(), last: ((await db.getSetting('adsboxApi', null)) || {}).hookLast || null })));
api.post('/orders/hook/renew', adminOnly, wrap(async (req, res) => res.json({ secret: await orders.hookSecret(true) })));
api.get('/orders/push', adminOnly, wrap(async (req, res) => res.json(await orders.pushStatus())));
api.put('/orders/push', adminOnly, wrap(async (req, res) => res.json(await orders.setPush(!!(req.body || {}).on))));
api.post('/orders/push', adminOnly, wrap(async (req, res) => { await orders.setPush(true); res.json(await orders.pushSpend(Math.min(31, Number((req.body || {}).days) || 7))); }));
// AI advice for one client (Claude API). The owner adds the key in Admin → Settings.
api.post('/ai/client/:id', wrap(async (req, res) => {
  const b = req.body || {};
  if (!isDay(b.from) || !isDay(b.to) || b.from > b.to || (Date.parse(b.to) - Date.parse(b.from)) / 864e5 > 185) return res.status(400).json({ error: 'Pick a period of up to 6 months.' });
  try { res.json(await require('./src/ai').clientAdvice(req.user.fb_id, req.params.id, { from: b.from, to: b.to, lang: b.lang === 'km' ? 'km' : 'en', question: String(b.question || ''), fresh: !!b.fresh })); }
  catch (e) { if (e.status) return res.status(e.status).json({ error: e.message, notSetUp: !!e.notSetUp }); throw e; }
}));
// Client workbook: today's AI plan (per Page + tasks), the user's notes and tasks, and ticks on today's work.
const AI = () => require('./src/ai');
const ownClient = async (req) => (await db.listClients(req.user.fb_id)).find((x) => x.id === Number(req.params.id));
// Open tasks and today's ticks for every client (for the badges in the Clients list).
// Monthly KPIs (per person or media buyer). person = a user id, or mb:<media buyer id>.
const KPI = () => require('./src/kpi');
// A media buyer of mine (I added them), or any media buyer for leaders. A media buyer session is never "mine".
const ownsBuyer = async (req, id) => { if (req.user.buyer) return false; if (await canSeeAdmin(req.user.fb_id)) return true; const b = await MB().get(String(id)); return !!b && (b.addedById === req.user.fb_id || (!b.addedById && b.addedBy === req.user.name)); };
// Whose KPIs: a media buyer sees only their own; a PM their own and their media buyers'; leaders anyone's.
const kpiPerson = async (req, raw) => {
  if (req.user.buyer) { const own = 'mb:' + req.user.buyer.id; if (raw && String(raw) !== own) return null; return { id: own, name: req.user.buyer.name, buyer: true, canEdit: false }; }
  const p = String(raw || req.user.fb_id);
  if (p.startsWith('mb:')) { if (!(await ownsBuyer(req, p.slice(3)))) return null; const b = await require('./src/buyers').get(p.slice(3)); return b ? { id: p, name: b.name, buyer: true, canEdit: true } : null; }
  if (p === req.user.fb_id) return { id: p, name: req.user.name, buyer: false, canEdit: true };
  if (!(await canSeeAdmin(req.user.fb_id))) return null;
  const u = await db.getUser(p); return u ? { id: p, name: u.name, buyer: false, canEdit: true } : null;
};
api.get('/kpis', wrap(async (req, res) => {
  const who = await kpiPerson(req, req.query.person); if (!who) return res.status(404).json({ error: 'Person not found.' });
  const month = /^\d{4}-\d{2}$/.test(req.query.month) ? req.query.month : sync.todayIn().slice(0, 7);
  const K = KPI(), kpis = await K.results(who.buyer ? who.id.slice(3) : who.id, month, who.buyer), ms = await K.months(who.buyer ? who.id.slice(3) : who.id);
  const prev = ms.filter((m) => m < month).pop() || '';
  res.json({ person: who, month, kpis, months: ms, prev, today: sync.todayIn() });
}));
api.put('/kpis', wrap(async (req, res) => {
  const who = await kpiPerson(req, (req.body || {}).person); if (!who) return res.status(404).json({ error: 'Person not found.' });
  const month = /^\d{4}-\d{2}$/.test((req.body || {}).month) ? req.body.month : sync.todayIn().slice(0, 7);
  await KPI().putList(who.buyer ? who.id.slice(3) : who.id, month, (req.body || {}).kpis);
  res.json({ ok: true });
}));
// 💡 Suggested daily actions for one KPI (AI). The person's menu and other KPIs give it context.
api.post('/kpis/suggest', wrap(async (req, res) => {
  const b = req.body || {}, who = await kpiPerson(req, b.person); if (!who) return res.status(404).json({ error: 'Person not found.' });
  const k = b.kpi || {}; if (!String(k.name || '').trim()) return res.status(400).json({ error: 'Which KPI?' });
  const month = /^\d{4}-\d{2}$/.test(b.month) ? b.month : sync.todayIn().slice(0, 7);
  const pid = who.buyer ? who.id.slice(3) : who.id, role = who.buyer ? 'mb' : 'pm';
  let menu = [], others = [];
  try { menu = (await MENU().listOf(pid, role)).map((x) => x.text); } catch (_) {}
  try { others = (await KPI().getList(pid, month)).filter((x) => x.id !== k.id).map((x) => `${x.name} (${x.target} ${x.unit})`); } catch (_) {}
  try { res.json(await AI().kpiSuggest(req.user.fb_id, { name: String(k.name).slice(0, 120), target: Number(k.target) || 0, unit: String(k.unit || '').slice(0, 12), role, menu, others, lang: b.lang === 'en' ? 'en' : 'km', fresh: !!b.fresh })); }
  catch (e) { res.status(e.status || 500).json({ error: e.message, notSetUp: !!e.notSetUp }); }
}));
// People whose KPIs an admin can open: every user and every media buyer.
api.get('/kpis/people', adminOnly, wrap(async (req, res) => {
  const users = (await db.allUsers()).map((u) => ({ id: u.fb_id, name: u.name, kind: 'PM' }));
  const byName = Object.fromEntries(users.map((u) => [u.name, u.id]));
  const buyers = (await require('./src/buyers').all()).map((b) => ({ id: 'mb:' + b.id, name: b.name, kind: 'Media buyer', pm: b.addedById || byName[b.addedBy] || null }));
  res.json({ people: [...users, ...buyers] });
}));
// Admin My Task page: every person with today's task counts and this month's KPI score (users and media buyers).
api.get('/admin/people-today', adminOnly, wrap(async (req, res) => {
  const today = sync.todayIn(), ym = today.slice(0, 7), owner = await db.ownerId(), roles = await roleMap(), av = await adminViewers();
  const users = await db.allUsers(), byName = Object.fromEntries(users.map((u) => [u.name, u.fb_id]));
  const bl = await MB().all(), teams = await getTeams(), teamOf = {}; for (const t of teams) for (const m of t.members) teamOf[m] = t.name;
  const dt = await dayTasks(today), K = KPI();
  const kpiAvg = async (id, buyer) => { try { const rs = (await K.results(id, ym, buyer)).filter((k) => k.target > 0); return rs.length ? Math.round(rs.reduce((t, k) => t + Math.min(k.score, 100), 0) / rs.length) : null; } catch (_) { return null; } };
  const count = (list) => ({ done: list.filter((t) => t.done).length, open: list.filter((t) => !t.done).length, late: list.filter((t) => !t.done && t.late).length });
  const people = [];
  for (const u of users) {
    const ts = ((dt.users[u.fb_id] || {}).tasks || []).filter((t) => t.from !== 'work' && t.from !== 'ai');
    const RN = { ceo: 'CEO', coo: 'COO', cmo: 'CMO', pm: 'Project Manager', mb: 'Media buyer' }, role = u.fb_id === owner ? 'CEO · Owner' : RN[ROLES.includes(roles[u.fb_id]) ? roles[u.fb_id] : av.has(u.fb_id) ? 'coo' : 'pm'];
    const isMb = ROLES.includes(roles[u.fb_id]) && roles[u.fb_id] === 'mb', mn = await MENU().dayOf(u.fb_id, isMb ? 'mb' : 'pm', today);
    people.push({ id: u.fb_id, name: u.name, kind: isMb ? 'Media buyer' : 'PM', role, team: teamOf[u.fb_id] || '', done: mn.done, open: mn.total - mn.done, late: 0, pct: mn.pct, planAt: mn.plan ? mn.plan.at : null, resultAt: mn.result ? mn.result.at : null, tasks: count(ts), kpi: await kpiAvg(u.fb_id, false), buyers: bl.filter((b) => (b.addedById || byName[b.addedBy]) === u.fb_id).length });
  }
  for (const b of bl) {
    const pm = b.addedById || byName[b.addedBy] || null, ts = pm ? ((dt.users[pm] || {}).tasks || []).filter((t) => t.to && t.to.id === b.id) : [];
    const mn = await MENU().dayOf(b.id, 'mb', today);
    people.push({ id: 'mb:' + b.id, name: b.name, kind: 'Media buyer', role: 'Media buyer', pm, pmName: pm ? (users.find((u) => u.fb_id === pm) || {}).name || '' : '', team: pm ? teamOf[pm] || '' : '', linked: !!(b.linked || b.chat), photo: !!b.photo, done: mn.done, open: mn.total - mn.done, late: 0, pct: mn.pct, planAt: mn.plan ? mn.plan.at : null, resultAt: mn.result ? mn.result.at : null, tasks: count(ts), kpi: await kpiAvg(b.id, true) });
  }
  // yesterday's menu result of the same people, for the calm "before the working day" view
  const yd = sync.addDays(today, -1), yest = { done: 0, total: 0 };
  for (const p of people) { if (p.role !== 'Project Manager' && p.kind !== 'Media buyer') continue; try { const d = await MENU().dayOf(p.id.startsWith('mb:') ? p.id.slice(3) : p.id, p.kind === 'Media buyer' ? 'mb' : 'pm', yd); yest.done += d.done; yest.total += d.total; } catch (_) {} }
  res.json({ today, month: ym, people, teams: teams.map((t) => t.name), hour: hourNow(), shift: SHIFT, yesterday: yest });
}));
// Leader's "This month" board: every Project Manager and media buyer with each KPI's score, and how many days
// they sent a plan and a result and how much of the daily menu they ticked. Read only; no personal data of clients.
api.get('/admin/people-month', adminOnly, wrap(async (req, res) => {
  const today = sync.todayIn(), month = /^\d{4}-\d{2}$/.test(req.query.month) && req.query.month <= today.slice(0, 7) ? req.query.month : today.slice(0, 7);
  const owner = await db.ownerId(), roles = await roleMap(), av = await adminViewers(), users = await db.allUsers(), byName = Object.fromEntries(users.map((u) => [u.name, u.fb_id]));
  const bl = await MB().all(), teams = await getTeams(), teamOf = {}; for (const t of teams) for (const m of t.members) teamOf[m] = t.name;
  const K = KPI(), [y, m] = month.split('-').map(Number), last = new Date(Date.UTC(y, m, 0)).getUTCDate(), dayNo = month === today.slice(0, 7) ? Number(today.slice(8)) : last;
  const one = async (id, buyer) => {
    let kpis = []; try { kpis = (await K.results(id, month, buyer)).filter((k) => k.target > 0).map((k) => ({ name: k.name, unit: k.unit, target: k.target, result: k.result, score: Math.round(k.score) })); } catch (_) {}
    let days = 0, plans = 0, results = 0, pctSum = 0;
    try { const mo = await MENU().monthOf(id, buyer ? 'mb' : 'pm', month); for (const d of Object.values(mo.days)) { if (!d.total) continue; days++; pctSum += d.pct || 0; if (d.planAt || d.resultAt) plans++; if (d.resultAt) results++; } } catch (_) {}
    return { kpis, avg: kpis.length ? Math.round(kpis.reduce((t, k) => t + Math.min(k.score, 100), 0) / kpis.length) : null, days, plans, results, menuPct: days ? Math.round(pctSum / days) : null };
  };
  const people = [];
  for (const u of users) {
    const r = ROLES.includes(roles[u.fb_id]) ? roles[u.fb_id] : av.has(u.fb_id) ? 'coo' : 'pm';
    if (u.fb_id === owner || LEAD.has(r)) continue; // leaders compare the teams; they are not compared
    people.push({ id: u.fb_id, name: u.name, kind: r === 'mb' ? 'Media buyer' : 'PM', team: teamOf[u.fb_id] || '', ...(await one(u.fb_id, false)) });
  }
  for (const b of bl) { const pm = b.addedById || byName[b.addedBy] || null; people.push({ id: 'mb:' + b.id, name: b.name, kind: 'Media buyer', pm, team: pm ? teamOf[pm] || '' : '', photo: !!b.photo, ...(await one(b.id, true)) }); }
  res.json({ today, month, dayNo, daysInMonth: last, pace: Math.round(dayNo / last * 100), people });
}));
api.get('/admin/audit', adminOnly, wrap(async (req, res) => { await auditFlush(); const log = await db.getSetting('auditLog', []); res.json({ log: (Array.isArray(log) ? log : []).slice(-300).reverse() }); }));
// 🔔 Nudge: a short Telegram reminder with today's progress. A PM nudges their own media buyers; leaders nudge anyone.
// One nudge per person every 10 minutes, so nobody gets flooded.
const nudged = new Map();
// Working day starts (Phnom Penh time): media buyers in the morning, Project Managers in the afternoon.
const SHIFT = { mb: 8, pm: 13 };
const hourNow = () => Number(new Date().toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: cfg.tz || 'Asia/Phnom_Penh' })) % 24;
// Send one reminder. Returns { ok, name } or { ok:false, name, why: 'telegram' | 'wait' | 'missing', wait }.
async function nudgeOne(fromName, p) {
  const today = sync.todayIn(); let chat = null, name = '', day = null, site = '/projectmanager#mytasks';
  if (p.startsWith('mb:')) { const b = await MB().get(p.slice(3)); if (!b) return { ok: false, why: 'missing' }; chat = b.chat || null; name = b.name; day = await MENU().dayOf(b.id, 'mb', today); site = '/mediabuyer#mytasks'; }
  else { const u = await db.getUser(p); if (!u) return { ok: false, why: 'missing' }; chat = (await db.getUserSetting(u.fb_id, 'tgChat', null) || {}).id || null; name = u.name; day = await MENU().dayOf(u.fb_id, (await roleOf(u.fb_id)) === 'mb' ? 'mb' : 'pm', today); }
  if (!chat) return { ok: false, name, why: 'telegram' };
  const wait = Math.ceil(((nudged.get(p) || 0) + 10 * 60e3 - Date.now()) / 60e3); if (wait > 0) return { ok: false, name, why: 'wait', wait };
  const open = day.items.filter((x) => !x.done), lines = [`🔔 ${fromName} សូមរំលឹក`, ''];
  if (!day.total) lines.push('ថ្ងៃនេះមិនទាន់មាន Task menu ទេ។ សូមបើក Boost Desk ហើយរៀបចំ។');
  else {
    lines.push(`Task ថ្ងៃនេះ៖ រួច ${day.done} / ${day.total} (${day.pct}%)`);
    if (!day.plan && !day.result) lines.push('⚠ មិនទាន់ផ្ញើ Plan');
    if (open.length) { lines.push('', 'នៅសល់៖'); for (const x of open.slice(0, 6)) lines.push(`☐ ${x.text}`); if (open.length > 6) lines.push(`… +${open.length - 6} ទៀត`); }
    else if (!day.result) lines.push('Task រួចអស់ហើយ ✅ សូមផ្ញើ Result។');
  }
  lines.push('', `${cfg.baseUrl}${site}`);
  await telegram.send(lines.join('\n'), chat); nudged.set(p, Date.now());
  return { ok: true, name };
}
api.post('/nudge', wrap(async (req, res) => {
  if (TASKS_OFF) return res.status(410).json({ error: 'Daily task reminders were moved to GenZ KPI.' });
  if (req.user.buyer) return res.status(403).json({ error: 'Only a PM or a leader can send a reminder.' });
  if (!telegram.hasBot()) return res.status(400).json({ error: 'Telegram is not set up yet.' });
  const p = String((req.body || {}).person || '');
  if (p.startsWith('mb:')) { if (!(await ownsBuyer(req, p.slice(3)))) return res.status(403).json({ error: 'Only this media buyer\'s PM or a leader can do this.' }); }
  else if (!(await canSeeAdmin(req.user.fb_id))) return res.status(403).json({ error: 'Only a leader can remind a Project Manager.' });
  let r; try { r = await nudgeOne(req.user.name, p); } catch (e) { return res.status(502).json({ error: 'Telegram did not take the message: ' + e.message }); }
  if (r.ok) return res.json(r);
  if (r.why === 'telegram') return res.status(400).json({ error: `${r.name} has not connected Telegram yet.` });
  if (r.why === 'wait') return res.status(429).json({ error: `${r.name} was reminded a moment ago. Try again in ${r.wait} minute${r.wait === 1 ? '' : 's'}.` });
  res.status(404).json({ error: 'Person not found.' });
}));
// Leaders: remind everyone whose working day has started and who has not sent today's plan. ?dry=1 only counts.
api.post('/nudge/no-plan', adminOnly, wrap(async (req, res) => {
  if (TASKS_OFF) return res.status(410).json({ error: 'Daily task reminders were moved to GenZ KPI.' });
  const today = sync.todayIn(), h = hourNow(), owner = await db.ownerId(), roles = await roleMap(), av = await adminViewers(), list = [];
  for (const u of await db.allUsers()) { const r = ROLES.includes(roles[u.fb_id]) ? roles[u.fb_id] : av.has(u.fb_id) ? 'coo' : 'pm'; if (u.fb_id === owner || LEAD.has(r)) continue; list.push({ p: u.fb_id, id: u.fb_id, role: r === 'mb' ? 'mb' : 'pm', name: u.name }); }
  for (const b of await MB().all()) list.push({ p: 'mb:' + b.id, id: b.id, role: 'mb', name: b.name });
  const due = []; let early = 0;
  for (const x of list) { const d = await MENU().dayOf(x.id, x.role, today); if (!d.total || d.plan || d.result) continue; if (h < SHIFT[x.role]) { early++; continue; } due.push(x); }
  if (req.query.dry || (req.body || {}).dry) return res.json({ dry: true, due: due.map((x) => x.name), early });
  if (!telegram.hasBot()) return res.status(400).json({ error: 'Telegram is not set up yet.' });
  const sent = [], noTelegram = [], waiting = [], failed = [];
  for (const x of due) { try { const r = await nudgeOne(req.user.name, x.p); (r.ok ? sent : r.why === 'telegram' ? noTelegram : r.why === 'wait' ? waiting : failed).push(r.name || x.name); } catch (_) { failed.push(x.name); } }
  res.json({ sent, noTelegram, waiting, failed, early });
}));
// Leaders rename a team account (the person's own name, e.g. the PM's — not the Facebook account's name, which is kept).
api.post('/admin/users/:id/rename', ownerOnly, wrap(async (req, res) => {
  const u = await db.getUser(String(req.params.id)); if (!u) return res.status(404).json({ error: 'Account not found.' });
  const name = String((req.body || {}).name || '').trim().replace(/\s+/g, ' ').slice(0, 80); if (!name) return res.status(400).json({ error: 'Type the name.' });
  if (name === u.name) return res.json({ ok: true, name });
  if (!(await db.getUserSetting(u.fb_id, 'fbName', ''))) await db.setUserSetting(u.fb_id, 'fbName', u.name); // remember the Facebook account's own name
  // media buyers that were tied to this account by its old name keep their PM
  const B = MB(), all = await B.list(); let touched = false;
  for (const b of all) if (b.addedById === u.fb_id || (!b.addedById && b.addedBy === u.name)) { b.addedById = u.fb_id; b.addedBy = name; touched = true; }
  if (touched) await B.save(all);
  await db.pool.query('UPDATE users SET name=$2 WHERE fb_id=$1', [u.fb_id, name]);
  const lg = await LOGINS().forFb(u.fb_id); if (lg) { lg.name = name; await LOGINS().save(lg); }
  res.json({ ok: true, name, was: u.name });
}));
// ---- Weekly AI strategy per client (19 Nov 2026): a draft for the team; only a PM can send it to the client ----
const aiErr = (res, e) => { if (e.status) return res.status(e.status).json({ error: e.message, notSetUp: !!e.notSetUp }); throw e; };
const pmOnly = (req, res) => { if (req.user.buyer) { res.status(403).json({ error: 'Only the Project Manager can do this.' }); return false; } return true; };
api.get('/clients/:id/strategy', wrap(async (req, res) => {
  if (!(await ownClient(req))) return res.status(404).json({ error: 'Client not found.' });
  const w = (await AI().workbook(req.user.fb_id, req.params.id)).weekly;
  res.json({ on: (await AI().weeklyPick(req.user.fb_id)).includes(Number(req.params.id)), weekly: w, week: AI().weekRange(), canSend: true });
}));
api.put('/clients/:id/strategy', wrap(async (req, res) => {
  if (!(await ownClient(req))) return res.status(404).json({ error: 'Client not found.' });
  const b = req.body || {};
  if ('on' in b) await AI().setWeeklyPick(req.user.fb_id, req.params.id, !!b.on);
  let weekly = (await AI().workbook(req.user.fb_id, req.params.id)).weekly;
  if (typeof b.text === 'string') { try { weekly = await AI().saveWeeklyText(req.user.fb_id, req.params.id, b.lang === 'en' ? 'en' : 'km', b.text); } catch (e) { return aiErr(res, e); } }
  res.json({ on: (await AI().weeklyPick(req.user.fb_id)).includes(Number(req.params.id)), weekly });
}));
api.post('/clients/:id/strategy/run', wrap(async (req, res) => {
  if (!(await ownClient(req))) return res.status(404).json({ error: 'Client not found.' });
  try { res.json({ weekly: await AI().weeklyStrategy(req.user.fb_id, req.params.id, { force: !!(req.body || {}).force }) }); } catch (e) { return aiErr(res, e); }
}));
// The three actions become Clients Tasks of this client (once).
api.post('/clients/:id/strategy/tasks', wrap(async (req, res) => {
  if (!(await ownClient(req))) return res.status(404).json({ error: 'Client not found.' });
  const w = await AI().workbook(req.user.fb_id, req.params.id), wk = w.weekly; if (!wk) return res.status(400).json({ error: 'There is no weekly strategy yet.' });
  const acts = ((req.body || {}).lang === 'en' ? wk.actionsEn : wk.actionsKm) || []; if (!acts.length) return res.status(400).json({ error: 'This strategy has no actions to add.' });
  const today = sync.todayIn(); let added = 0;
  for (const t of acts) if (!w.tasks.some((x) => x.text === t && !x.done)) { w.tasks.push({ id: crypto.randomBytes(5).toString('hex'), text: t, from: 'weekly', day: today, done: false, by: req.user.name }); added++; }
  wk.tasksAt = new Date().toISOString(); await AI().saveWorkbook(req.user.fb_id, req.params.id, w);
  res.json({ added, weekly: wk });
}));
// Send to the client's Telegram group — the PM's decision, in Khmer, English or both.
api.post('/clients/:id/strategy/send', wrap(async (req, res) => {
  const c = await ownClient(req); if (!c) return res.status(404).json({ error: 'Client not found.' });
  if (!telegram.hasBot()) return res.status(400).json({ error: 'Telegram is not set up yet.' });
  if (!c.telegram) return res.status(400).json({ error: `${c.name} has no Telegram group yet. Pick one in the Clients tab.` });
  const w = await AI().workbook(req.user.fb_id, req.params.id), wk = w.weekly; if (!wk || !wk.km) return res.status(400).json({ error: 'There is no weekly strategy yet.' });
  const lang = ['km', 'en', 'both'].includes((req.body || {}).lang) ? req.body.lang : 'km';
  try { await telegram.send(AI().weeklyMessage(c.name, wk, lang), c.telegram); } catch (e) { return res.status(502).json({ error: 'Telegram did not take the message: ' + e.message }); }
  wk.sent = { at: new Date().toISOString(), by: req.user.name, lang, to: c.telegram_title || '' }; await AI().saveWorkbook(req.user.fb_id, req.params.id, w);
  res.json({ weekly: wk });
}));
// ---- Merge a duplicate client into another (19 Nov 2026): after two accounts were merged the same client can be there twice ----
// The client that stays keeps its name, settings and saved days. From the duplicate it takes: Page names, the Telegram group
// (if it has none), days it has no entry for, invoices, notes, open tasks and boost plans. Then the duplicate is removed and
// every saved day is matched again, so the spend lands on the client that stays.
async function mergeClients(user, aId, bId, { rematch = true } = {}) {
  const owner = user.fb_id, list = await db.listClients(owner), A = list.find((x) => x.id === Number(aId)), B = list.find((x) => x.id === Number(bId));
  if (!A || !B || A.id === B.id) throw Object.assign(new Error('Choose two different clients of yours.'), { status: 400 });
  if (rematch && sync.isBusy(owner)) throw Object.assign(new Error('A sync is running right now. Try again in a minute.'), { status: 409 });
  const low = (x) => String(x || '').trim().toLowerCase(), have = new Set([A.name, A.match, ...(A.pages || [])].map(low));
  const pages = [...(A.pages || [])]; for (const x of [B.name, B.match, ...(B.pages || [])]) { const k = low(x); if (k && !have.has(k)) { have.add(k); pages.push(String(x).trim()); } }
  const planA = A.plan || {}, planB = B.plan || {}, pastB = [...((planB.lines || []).length ? [{ lines: planB.lines, tax: !!planB.tax, sentAt: planB.sentAt || null, at: new Date().toISOString(), by: `merged from ${B.name}` }] : []), ...(planB.past || [])];
  const plan = (planA.lines || []).length || !(planB.lines || []).length ? { ...planA, past: [...(planA.past || []), ...pastB].slice(0, 20) } : { ...planB, past: [...(planA.past || []), ...(planB.past || [])].slice(0, 20) };
  const type = A.type === B.type ? A.type : 'both';
  const c = await db.pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('UPDATE day_entries SET client_id=$1 WHERE client_id=$2 AND day NOT IN (SELECT day FROM day_entries WHERE client_id=$1)', [A.id, B.id]);
    await c.query('UPDATE invoices SET client_id=$1 WHERE client_id=$2 AND owner=$3', [A.id, B.id, owner]);
    const wk = (id) => `${owner}:cwb:${id}`, get = async (k) => ((await c.query('SELECT value FROM settings WHERE key=$1', [k])).rows[0] || {}).value;
    const wa = (await get(wk(A.id))) || {}, wb = await get(wk(B.id));
    if (wb) {
      const notes = [wa.notes, wb.notes].map((x) => String(x || '').trim()).filter(Boolean).join('\n\n').slice(0, 5000);
      const tasks = [...(Array.isArray(wa.tasks) ? wa.tasks : []), ...(Array.isArray(wb.tasks) ? wb.tasks : []).filter((t) => t && !t.done)];
      await c.query('INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2', [wk(A.id), JSON.stringify({ ...wb, ...wa, notes, notesAt: wa.notesAt || wb.notesAt || null, tasks, log: [...(Array.isArray(wa.log) ? wa.log : []), ...(Array.isArray(wb.log) ? wb.log : [])].slice(-400) })]);
      await c.query('DELETE FROM settings WHERE key=$1', [wk(B.id)]);
    }
    await c.query('UPDATE clients SET pages=$3, plan=$4, type=$5, telegram=$6, telegram_title=$7 WHERE id=$1 AND owner=$2', [A.id, owner, JSON.stringify(pages.slice(0, 60)), JSON.stringify(plan), type, A.telegram || B.telegram || '', A.telegram ? A.telegram_title || '' : B.telegram_title || '']);
    await c.query('DELETE FROM clients WHERE id=$1 AND owner=$2', [B.id, owner]);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  console.log(`[client merge] ${user.name}: "${B.name}" (#${B.id}) into "${A.name}" (#${A.id})`);
  if (rematch) { try { await sync.exclusive(owner, () => sync.rematch(user)); } catch (e) { console.error('[client merge] rematch failed:', e.message); } }
  return (await db.listClients(owner)).find((x) => x.id === A.id);
}
// Every group of clients with the same name in one workspace becomes one client (owner's decision, 19 Nov 2026: for every
// team, and from now on after an account merge). The one with the most spend this month stays (an active one before a
// paused one). All spend is matched again once at the end; this month's spend per name is logged before and after.
const sameName = (list) => { const g = {}; for (const c of list) { const k = String(c.name || '').trim().toLowerCase(); if (k) (g[k] = g[k] || []).push(c); } return Object.values(g).filter((x) => x.length > 1); };
async function dedupeClients(user) {
  const owner = user.fb_id, dups = sameName(await db.listClients(owner)); if (!dups.length) return { groups: 0, removed: 0, bad: [] };
  const today = sync.todayIn(), from = today.slice(0, 8) + '01', r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const spendOf = async () => Object.fromEntries(((await sync.dashboard(owner, from, today)).clients || []).map((x) => [x.id, x.spend || 0]));
  const before = await spendOf(), plan = [];
  for (const g of dups) { const o = g.slice().sort((a, b) => (!!a.archived - !!b.archived) || (before[b.id] || 0) - (before[a.id] || 0) || a.id - b.id); plan.push({ keep: o[0], rest: o.slice(1), sum: r2(g.reduce((t, c) => t + (before[c.id] || 0), 0)) }); }
  let removed = 0;
  for (const p of plan) for (const b of p.rest) { try { await mergeClients(user, p.keep.id, b.id, { rematch: false }); removed++; } catch (e) { console.error(`[dedupe] ${user.name}: ${b.name} #${b.id} failed:`, e.message); } }
  let matched = false;
  for (let i = 0; i < 20 && !matched; i++) { const r = await sync.exclusive(owner, async () => { await sync.rematch(user); return true; }).catch((e) => { console.error('[dedupe] rematch failed:', e.message); return true; }); if (r) matched = true; else await new Promise((ok) => setTimeout(ok, 30e3)); }
  const after = await spendOf(), bad = [];
  for (const p of plan) { const a = r2(after[p.keep.id]); const ok = Math.abs(a - p.sum) < 0.01; if (!ok) bad.push(p.keep.name); console.log(`[dedupe] ${user.name}: ${p.keep.name} ×${p.rest.length + 1} → #${p.keep.id} · this month before $${p.sum.toFixed(2)}, after $${a.toFixed(2)} ${ok ? '✓' : '✗ DIFFERENT'}`); }
  console.log(`[dedupe] ${user.name}: ${plan.length} names, ${removed} duplicate clients removed${matched ? '' : ' — spend NOT matched again yet (a sync was running)'}${bad.length ? ` — ${bad.length} with a different total: ${bad.join(', ')}` : ''}`);
  return { groups: plan.length, removed, bad };
}
api.post('/clients/:id/merge-from', wrap(async (req, res) => {
  if (!pmOnly(req, res)) return;
  try { res.json({ ok: true, client: await mergeClients(req.user, req.params.id, (req.body || {}).from) }); } catch (e) { if (e.status) return res.status(e.status).json({ error: e.message }); throw e; }
}));
// ---- Boosts (20 Nov 2026): one row per post in a boost plan, across every client — the team's old status sheet, filled by itself ----
// A row's state comes from its dates (new / active / ended); "no spend" is the client's status finding (plan runs, nothing spent).
// Spend is known per client, not per post, so the plan's progress is the client's and is the same on each of its rows.
api.get('/boosts', wrap(async (req, res) => {
  const owner = req.user.fb_id, today = sync.todayIn(), st = await STATUS().forOwner({ fb_id: owner, name: req.user.name }), by = Object.fromEntries(st.clients.map((x) => [x.id, x])), rows = [];
  // today's campaigns from Meta (as synced): a post linked to its campaign gets its own spend, and post campaigns that are in
  // no plan yet are offered as "found on Meta" so a plan line can be added in one step
  const raw = {}; try { for (const r of (await db.getRaw(owner, today)) || []) if (r.campaignId) raw[String(r.campaignId)] = r; } catch (_) {}
  const all = (await db.listClients(owner)).filter((x) => !x.archived), linked = new Set(all.flatMap((c) => ((c.plan && c.plan.lines) || []).map((l) => l.camp).filter(Boolean))), found = [];
  for (const c of all) {
    const x = by[c.id] || {}, lines = (c.plan && c.plan.lines) || [];
    try { const e = await db.getEntry(owner, today, c.id); for (const id of ((e && e.post && e.post.ids) || []).map(String)) { const r = raw[id]; if (r && !linked.has(id) && Number(r.spend) > 0) found.push({ clientId: c.id, client: c.name, camp: id, name: r.name || '', account: r.accountId || '', accountName: r.account || '', spend: Math.round(Number(r.spend) * 100) / 100 }); } } catch (_) {}
    lines.forEach((l, i) => {
      const end = l.start ? sync.addDays(l.start, Math.max(1, Number(l.days) || 1) - 1) : '', state = !l.start ? 'nodate' : l.start > today ? 'new' : end < today ? 'ended' : 'active';
      rows.push({ clientId: c.id, client: c.name, i, post: l.post || `Post ${i + 1}`, link: l.link || '', daily: Number(l.daily) || 0, days: Number(l.days) || 0, budget: Math.round((Number(l.daily) || 0) * (Number(l.days) || 0) * 100) / 100,
        account: l.accountName || l.account || '', start: l.start || '', end, left: end ? Math.round((Date.parse(end) - Date.parse(today)) / 864e5) : null, state,
        noSpend: state === 'active' && (x.reasons || []).some((r) => r.kind === 'noboost'), sent: l.sent || (c.plan.sentAt && !lines.some((y) => y.sent) ? c.plan.sentAt : ''),
        camp: l.camp || '', auto: l.auto || '', campSpend: l.camp && raw[l.camp] ? Math.round(Number(raw[l.camp].spend) * 100) / 100 : null, postToday: x.postToday || 0, level: x.level || 'ok', planPct: x.plan ? x.plan.pct : null, planSpent: x.plan ? x.plan.spent : null, planBudget: x.plan ? x.plan.budget : null, telegram: !!c.telegram });
    });
  }
  // only clients that boost posts: a client that spends on Live only today has its own table (Live boosts) and needs no plan
  const noPlan = st.clients.filter((x) => x.level !== 'idle' && !(x.spend > 0 && !(x.postToday > 0)) && !(rows.some((r) => r.clientId === x.id && (r.state === 'active' || r.state === 'new')))).map((x) => ({ id: x.id, name: x.name, spend: x.spend }));
  res.json({ today, rows, noPlan, found: found.sort((a, b) => b.spend - a.spend) });
}));
// Live boosts (20 Nov 2026): one row per boosted Live of the last 7 days, next to the post table. A Live has no plan, no end
// date and no $ per day, so it gets its own columns: start time, budget on Meta, spend, comments, messages, report sent.
api.get('/boosts/lives', wrap(async (req, res) => {
  const owner = req.user.fb_id, today = sync.todayIn(), from = sync.addDays(today, -6), now = Date.now();
  const list = await lives.listLives(owner, from, today);
  let setups = {}; try { setups = await lives.setupsFor({ fb_id: owner }, list.flatMap((l) => l.campaigns), { fetch: false }); } catch (_) {}
  const acc = {}; try { for (const a of await db.listAccounts(owner)) acc[String(a.id).replace(/^act_/, '')] = a; } catch (_) {}
  const sentOf = {}, rows = [];
  // Orders in one Live (20 Nov 2026): orders Boost Desk counted itself on the Live's Page from its start until one hour after
  // the boost stops (or until the Page's next Live). Only for connected Pages and days since own counting began; else null.
  // An order from a post boosted on the same Page in those hours is counted too — the Page and the time are all that is known.
  let linked = new Set(), ownSince = null;
  try { const m = await require('./src/pageOrders').mode(); if (m.on) { ownSince = m.since || today; linked = new Set((await db.pool.query('SELECT page_id FROM page_links')).rows.map((r) => String(r.page_id))); } } catch (_) {}
  const ordersIn = async (l) => {
    if (!ownSince || l.day < ownSince || !l.pageId || !linked.has(l.pageId) || l.start == null) return null;
    const next = list.filter((x) => x.pageId === l.pageId && x.start != null && x.start > l.start).map((x) => x.start).sort((a, b) => a - b)[0];
    const to = Math.min((l.end != null ? l.end : l.start + 3 * 3600e3) + 3600e3, next || Infinity);
    try { return (await db.pool.query('SELECT count(*)::int AS n FROM page_order_hits WHERE page_id=$1 AND first_at >= $2 AND first_at < $3', [l.pageId, new Date(l.start), new Date(to)])).rows[0].n; } catch (_) { return null; }
  };
  for (const l of list) {
    const k = l.clientId + '|' + l.day;
    if (!(k in sentOf)) { try { const e = await db.getEntry(owner, l.day, l.clientId); sentOf[k] = (e && e.reportSent && e.reportSent.at) || ''; } catch (_) { sentOf[k] = ''; } }
    const ids = [...new Set(l.campaigns.map((c) => String(c.accountId || '').replace(/^act_/, '')).filter(Boolean))];
    // the budget is only shown when every campaign of the Live has one on Meta and the account is in USD
    const bs = l.campaigns.map((c) => { const s = setups[c.id], a = acc[String(c.accountId || '').replace(/^act_/, '')]; const usd = a && ((a.info || {}).currency || a.currency || '') === 'USD'; return s && usd ? Number(s.lifetimeBudget) || Number(s.dailyBudget) || 0 : 0; });
    rows.push({ key: l.key, clientId: l.clientId, client: l.client, page: l.page, day: l.day, time: l.time, start: l.start, spend: l.spend, comments: l.comments, messages: l.messages, perComment: l.perComment,
      camps: l.campaigns.length, account: ids.map((id) => (acc[id] && acc[id].name) || 'act_' + id).join(', '), budget: bs.length && bs.every((b) => b > 0) ? Math.round(bs.reduce((a, b) => a + b, 0) * 100) / 100 : null,
      orders: await ordersIn(l), state: l.day !== today || (l.end != null && l.end <= now) ? 'ended' : l.end != null ? 'on' : '', sent: sentOf[k] });
  }
  rows.sort((a, b) => String(b.day).localeCompare(String(a.day)) || (b.start || 0) - (a.start || 0));
  res.json({ today, yesterday: sync.addDays(today, -1), rows });
}));
// ---- Client status (19 Nov 2026): fine / watch / problem per client, "checked today", "I'm on it", Telegram alerts ----
const STATUS = () => require('./src/status');
const whoAmI = (req) => (req.user.buyer ? req.user.buyer.name : req.user.name);
// My team's clients with their status (a media buyer sees their PM's clients).
api.get('/clients-status', wrap(async (req, res) => res.json(await STATUS().forOwner({ fb_id: req.user.fb_id, name: req.user.name }))));
api.post('/clients/:id/checked', wrap(async (req, res) => {
  if (!(await ownClient(req))) return res.status(404).json({ error: 'Client not found.' });
  // remember which reasons were there when the person looked: a new one brings the client back to "to watch"
  const id = Number(req.params.id), on = (req.body || {}).on !== false; let kinds;
  if (on) { try { const x = (await STATUS().forOwner({ fb_id: req.user.fb_id, name: req.user.name })).clients.find((k) => k.id === id); if (x) kinds = x.reasons.map((r) => r.kind); } catch (_) {} }
  res.json(await STATUS().mark(req.user.fb_id, id, 'checked', whoAmI(req), on, kinds));
}));
api.post('/clients/:id/on-it', wrap(async (req, res) => {
  if (!(await ownClient(req))) return res.status(404).json({ error: 'Client not found.' });
  res.json(await STATUS().mark(req.user.fb_id, Number(req.params.id), 'onIt', whoAmI(req), (req.body || {}).on !== false));
}));
// Leaders: every team's clients by status.
api.get('/admin/clients-today', adminOnly, wrap(async (req, res) => {
  const teams = await getTeams(), teamOf = {}; for (const t of teams) for (const m of t.members) teamOf[m] = t.name;
  const bl = await MB().all(), out = [];
  for (const u of await db.allUsers()) {
    let s; try { s = await STATUS().forOwner({ fb_id: u.fb_id, name: u.name }); } catch (e) { s = { clients: [], error: e.message }; }
    if (!s.clients.length) continue;
    out.push({ id: u.fb_id, account: u.name, team: teamOf[u.fb_id] || u.name, mbs: bl.filter((b) => (b.addedById || '') === u.fb_id).map((b) => b.name), clients: s.clients });
  }
  res.json({ today: sync.todayIn(), hour: STATUS().hourNow(), teams: out });
}));
// Admin menu (21 Nov 2026): Live boosts and invoices of every team on one page each. Read only.
api.get('/admin/lives', adminOnly, wrap(async (req, res) => {
  const teams = await getTeams(), teamOf = {}; for (const t of teams) for (const m of t.members) teamOf[m] = t.name;
  const today = sync.todayIn(), now = Date.now(), rows = [];
  for (const u of await db.allUsers()) {
    let list = []; try { list = await lives.listLives(u.fb_id, today, today); } catch (_) {}
    const sent = {};
    for (const l of list) {
      if (!(l.clientId in sent)) { try { const e = await db.getEntry(u.fb_id, today, l.clientId); sent[l.clientId] = (e && e.reportSent && e.reportSent.at) || ''; } catch (_) { sent[l.clientId] = ''; } }
      rows.push({ team: teamOf[u.fb_id] || u.name, client: l.client, page: l.page, time: l.time, start: l.start, spend: l.spend, comments: l.comments, messages: l.messages, perComment: l.perComment, camps: l.campaigns.length,
        state: l.end != null && l.end <= now ? 'ended' : l.end != null ? 'on' : '', sent: sent[l.clientId] });
    }
  }
  rows.sort((a, b) => (b.start || 0) - (a.start || 0));
  res.json({ today, rows });
}));
api.get('/admin/invoices', adminOnly, wrap(async (req, res) => {
  const teams = await getTeams(), teamOf = {}; for (const t of teams) for (const m of t.members) teamOf[m] = t.name;
  const today = sync.todayIn(), from = sync.addDays(today, -60), rows = [];
  for (const u of await db.allUsers()) {
    let inv = [], names = {}; try { inv = await db.listInvoices(u.fb_id, from, today); if (inv.length) for (const c of await db.listClients(u.fb_id)) names[c.id] = c.name; } catch (_) {}
    for (const i of inv) rows.push({ team: teamOf[u.fb_id] || u.name, client: names[i.client_id] || '', number: i.number, date: i.date, total: Number(i.total) || 0, sent: !!i.sent_at, paid: !!i.paid_at,
      days: i.paid_at ? 0 : Math.max(0, Math.round((new Date(today) - new Date(i.date)) / 864e5)) });
  }
  rows.sort((a, b) => (a.paid - b.paid) || (b.days - a.days) || String(b.date).localeCompare(String(a.date)));
  res.json({ today, from, rows });
}));
// Telegram for red clients: every 5 minutes (8:00–21:00). Leaders = the alert chat and every CEO / COO / CMO with Telegram.
async function leaderChats() {
  const out = new Set(); const a = await db.getSetting('alertChat', null); if (a && a.id) out.add(String(a.id));
  const roles = await roleMap(), owner = await db.ownerId();
  for (const u of await db.allUsers()) { if (u.fb_id !== owner && !LEAD.has(roles[u.fb_id])) continue; const c = await db.getUserSetting(u.fb_id, 'tgChat', null); if (c && c.id) out.add(String(c.id)); }
  return [...out];
}
if (telegram.hasBot()) {
  health.register('Client status alerts', 5, 'every 5 minutes, 8:00–21:00');
  setInterval(require('./src/runOnce').once('Client status alerts', () => health.track('Client status alerts', () => STATUS().tick({ leaders: leaderChats, log: (...a) => console.log('[status]', ...a) })).then((n) => { if (n) console.log('[status] client alerts sent:', n); }).catch((e) => console.error('[status]', e.message)), 5 * 60e3), 5 * 60e3).unref();
}
// Copy one person's KPI list for a month to others, replacing theirs:
//   scope 'team' — the other Project Managers of the same team (a team's KPI is its PM's KPI)
//   scope 'pms'  — every Project Manager;   scope 'mbs' — every media buyer (from a media buyer's list)
// Only name, target and unit travel. A person who already has a KPI of the same name keeps its id (so the tasks
// linked to it stay linked) and the result they typed; nobody receives someone else's typed result.
const kpiCopy = wrap(async (req, res) => {
  const b = req.body || {}, who = await kpiPerson(req, b.person); if (!who) return res.status(404).json({ error: 'Person not found.' });
  const scope = ['team', 'pms', 'mbs'].includes(b.scope) ? b.scope : 'team';
  const month = /^\d{4}-\d{2}$/.test(b.month) ? b.month : sync.todayIn().slice(0, 7), K = KPI();
  const roles = await roleMap(), owner = await db.ownerId(), users = await db.allUsers();
  const isPm = (id) => id !== owner && !LEAD.has(roles[id]) && roles[id] !== 'mb';
  let to = [], label = '';
  if (scope === 'mbs') {
    if (!who.buyer) return res.status(400).json({ error: 'Open a media buyer first — their KPIs are copied to the other media buyers.' });
    to = (await MB().all()).filter((x) => 'mb:' + x.id !== who.id).map((x) => ({ id: x.id, name: x.name })); label = 'media buyers';
  } else {
    if (who.buyer) return res.status(400).json({ error: 'Choose a Project Manager.' });
    if (scope === 'team') {
      const team = (await getTeams()).find((t) => t.members.includes(who.id)); if (!team) return res.status(400).json({ error: `${who.name} is not in a team yet.` });
      to = team.members.filter((m) => m !== who.id && isPm(m)).map((m) => users.find((u) => u.fb_id === m)).filter(Boolean).map((u) => ({ id: u.fb_id, name: u.name })); label = team.name;
    } else { to = users.filter((u) => u.fb_id !== who.id && isPm(u.fb_id)).map((u) => ({ id: u.fb_id, name: u.name })); label = 'Project Managers'; }
  }
  if (!to.length) return res.status(400).json({ error: 'There is nobody else to copy to.' });
  const src = await K.getList(who.buyer ? who.id.slice(3) : who.id, month);
  if (!src.length) return res.status(400).json({ error: 'Set the KPIs first, then copy them.' });
  const nm = (x) => String(x || '').trim().toLowerCase();
  for (const p of to) {
    const cur = await K.getList(p.id, month);
    await K.putList(p.id, month, src.map((k) => { const old = cur.find((c) => nm(c.name) === nm(k.name)); return { id: old ? old.id : '', name: k.name, target: k.target, unit: k.unit, manual: old ? old.manual : null }; }));
  }
  res.json({ ok: true, scope, label, month, count: src.length, to: to.map((p) => p.name) });
});
api.post('/kpis/copy', adminOnly, kpiCopy);
api.post('/kpis/copy-team', adminOnly, (req, res, next) => { req.body = { ...(req.body || {}), scope: 'team' }; kpiCopy(req, res, next); });
// My target tasks for a day: every task of mine with a target, with what I reached.
api.get('/targets/mine', wrap(async (req, res) => {
  const day = isDay(req.query.day) ? req.query.day : sync.todayIn(), out = [];
  for (const c of await db.listClients(req.user.fb_id)) {
    if (c.archived) continue;
    const w = (await db.getUserSetting(req.user.fb_id, `cwb:${c.id}`, null)) || {};
    for (const t of w.tasks || []) {
      if (!(Number(t.target) > 0)) continue;
      if (t.repeat ? t.day > day : t.day !== day) continue;
      out.push({ id: t.id, clientId: c.id, client: c.name, text: t.text, repeat: !!t.repeat, done: !!t.done, ...tgt(t, t.repeat ? day : t.day) });
    }
  }
  res.json({ day, today: sync.todayIn(), tasks: out });
}));
// My tasks today (every client): the same list each client page shows, in one place.
// ---------- Task menu: fixed daily duties per role (PM / media buyer), ticked day by day ----------
const MENU = () => require('./src/menu');
// Whose menu: a buyer's own, mine (pm), or — admins — anyone's via ?as=<fbId> or ?as=mb:<buyerId>.
async function menuPerson(req, raw) {
  if (req.user.buyer) return { person: req.user.buyer.id, role: 'mb', name: req.user.buyer.name };
  const as = String(raw || '').trim();
  if (as && as !== req.user.fb_id) {
    if (as.startsWith('mb:')) { // a PM may open the menus of the media buyers they added; admins any buyer's
      const b = await MB().get(as.slice(3)); if (!b) return null;
      const mine = b.addedById === req.user.fb_id || (!b.addedById && b.addedBy === req.user.name);
      if (!mine && !(await canSeeAdmin(req.user.fb_id))) return null;
      return { person: b.id, role: 'mb', name: b.name };
    }
    if (!(await canSeeAdmin(req.user.fb_id))) return null;
    const u = (await db.allUsers()).find((x) => x.fb_id === as); return u ? { person: u.fb_id, role: 'pm', name: u.name } : null;
  }
  // The role set in Admin → Users decides the menu: a Facebook login marked "Media buyer" gets the media buyer menu everywhere.
  return { person: req.user.fb_id, role: (await roleOf(req.user.fb_id)) === 'mb' ? 'mb' : 'pm', name: req.user.name };
}
// My profile for the Settings page: who I am, my Facebook login, my Telegram, my team.
api.get('/me/profile', wrap(async (req, res) => {
  const teams = await getTeams();
  if (req.user.buyer) {
    const b = await MB().get(req.user.buyer.id), pm = (await db.allUsers()).find((u) => u.fb_id === req.user.fb_id);
    return res.json({ buyer: true, name: b ? b.name : req.user.buyer.name, alias: b ? b.alias || '' : '', tgName: b ? b.tgName || '' : '', photo: !!(b && b.photo), id: req.user.buyer.id, pm: pm ? pm.name : (b ? b.addedBy : ''),
      team: (teams.find((t) => t.members.includes(req.user.fb_id)) || {}).name || '', telegram: { linked: !!(b && b.chat), bot: telegram.hasBot() ? await telegram.username() : '', link: b && telegram.hasBot() ? `https://t.me/${await telegram.username()}?start=mb_${b.code}` : '' }, roleName: 'Media buyer', site: '/mediabuyer' });
  }
  const me = req.user.fb_id, owner = (await db.ownerId()) === me, role = owner ? 'owner' : await roleOf(me);
  const RN = { owner: 'CEO · Owner', ceo: 'CEO', coo: 'COO', cmo: 'CMO', pm: 'Project Manager', mb: 'Media buyer' }, SITE = { owner: '/owner', ceo: '/admin', coo: '/admin', cmo: '/admin', pm: '/projectmanager', mb: '/mediabuyer' };
  const exp = req.user.token_expires ? Date.parse(req.user.token_expires) : 0, left = exp ? Math.round((exp - Date.now()) / 864e5) : null;
  const accounts = (await db.listAccounts(me)).length, clients = (await db.listClients(me)).filter((c) => !c.archived).length;
  const buyers = (await MB().all()).filter((b) => b.addedById === me || (!b.addedById && b.addedBy === req.user.name)).map((b) => ({ name: b.name, linked: !!(b.linked || b.chat) }));
  let code = await db.getUserSetting(me, 'tgCode', ''); if (!code) { code = newCode(); await db.setUserSetting(me, 'tgCode', code); }
  const chat = await db.getUserSetting(me, 'tgChat', null), bot = telegram.hasBot() ? await telegram.username() : '';
  const picture = req.user.google ? '' : `/api/fb-pic/${me}`; // the browser loads it on its own; the page never waits for Facebook
  const pages = (await db.listPagesSeen(me)).length, myAlerts = require('./src/myalerts');
  res.json({ buyer: false, id: me, name: req.user.name, picture, role, roleName: RN[role] || 'Project Manager', site: SITE[role] || '/projectmanager', team: (teams.find((t) => t.members.includes(me)) || {}).name || '',
    teams: teams.map((t) => t.name), isAdmin: await canSeeAdmin(me),
    username: ((await LOGINS().forFb(me)) || {}).username || '',
    facebook: { id: me, name: await fbNameOf(req.user), expires: req.user.token_expires || null, daysLeft: left, expired: left !== null && left <= 0, accounts, clients, pages, autoSync: (await db.enabledAccountIds(me)).length },
    telegram: { linked: !!(chat && chat.id), name: chat ? chat.name : '', at: chat ? chat.at : null, link: bot ? `https://t.me/${bot}?start=pm_${code}` : '', bot, code }, buyers,
    autoReport: await extras.autoSettings(me), alerts: await myAlerts.prefs(me), ai: { on: (await db.getUserSetting(me, 'aiOn', true)) !== false, lang: (await db.getUserSetting(me, 'aiLang', 'en')) === 'km' ? 'km' : 'en' },
    google: req.session.gEmail ? { email: req.session.gEmail } : null });
}));
// Getting started: what a new Project Manager still has to set up (shown on the Dashboard until every step is done).
api.get('/onboarding', wrap(async (req, res) => {
  if (req.user.buyer || req.user.google) return res.json({ show: false });
  const me = req.user.fb_id, accts = await db.listAccounts(me), clients = (await db.listClients(me)).filter((c) => !c.archived), month = sync.todayIn().slice(0, 7);
  const login = await LOGINS().forFb(me), chat = await db.getUserSetting(me, 'tgChat', null);
  let kpis = 0; try { kpis = (await KPI().getList(me, month)).filter((k) => String(k.name || '').trim()).length; } catch (_) {}
  const steps = [
    { key: 'login', done: !!login && !login.must, title: 'Choose your username and password', hint: 'So you can log in without Facebook.', go: '#settings', cta: 'Open Settings' },
    { key: 'accounts', done: accts.some((a) => a.enabled), title: 'Tick the ad accounts you boost with', hint: `${accts.length} ad account${accts.length === 1 ? '' : 's'} found on your Facebook. Have a second Facebook account? Add it in Settings.`, go: '#accounts', cta: 'Open Ad accounts' },
    { key: 'clients', done: clients.length > 0, title: 'Add your first client', hint: 'A client is matched to spend by its Facebook Page.', go: '#clients', cta: 'Open Clients' },
    { key: 'telegram', done: !!(chat && chat.id), title: 'Link your Telegram', hint: 'For alerts, and so reports can go to your clients\' groups.', go: '#settings', cta: 'Open Settings' },
    { key: 'groups', done: clients.length > 0 && clients.every((c) => reports.routes(c).some((r) => r.chat)), title: 'Give every client a Telegram group', hint: clients.length ? `${clients.filter((c) => !reports.routes(c).some((r) => r.chat)).length} client(s) have no group yet — their report can't be sent.` : 'After you add clients.', go: '#reports', cta: 'Open Reports' },
    ...(TASKS_OFF ? [] : [{ key: 'kpi', done: kpis > 0, title: 'Set this month\'s KPIs and your daily menu', hint: 'My Task → Monthly KPI, then ✨ Suggest from KPI.', go: '#mytasks', cta: 'Open My Task' }]),
  ];
  res.json({ show: steps.some((x) => !x.done), done: steps.filter((x) => x.done).length, total: steps.length, steps });
}));
// ---------- Usernames (logins) ----------
// Who may manage which: a full admin → every login; a PM → the logins of their own media buyers.
const myBuyerIds = async (req) => new Set((await MB().list()).filter((b) => b.addedById === req.user.fb_id || (!b.addedById && b.addedBy === req.user.name)).map((b) => b.id));
async function canManageLogin(req, rec) { if (req.user.buyer || req.user.google && !(await isFull(req))) return false; if (await isFull(req)) return true; return rec.role === 'mb' && (await myBuyerIds(req)).has(rec.mbId); }
const loginErr = (res, e) => res.status(e.status || 400).json({ error: e.message });
api.get('/logins', wrap(async (req, res) => {
  if (req.user.buyer) return res.status(403).json({ error: 'Ask your PM.' });
  const L = LOGINS(), full = await isFull(req), mine = await myBuyerIds(req);
  res.json({ full, logins: (await L.list()).filter((r) => full || (r.role === 'mb' && mine.has(r.mbId))).map(L.pub) });
}));
api.post('/logins', wrap(async (req, res) => {
  const b = req.body || {}, role = b.role === 'mb' ? 'mb' : 'pm';
  if (!(await canManageLogin(req, { role, mbId: String(b.mbId || '') }))) return res.status(403).json({ error: role === 'mb' ? 'You can only make usernames for your own media buyers.' : 'Only the owner (or a full admin) can make a username for a Project Manager.' });
  if (role === 'pm' && b.fbId && !(await db.getUser(String(b.fbId)))) return res.status(400).json({ error: 'That person is not in Boost Desk.' });
  if (role === 'mb' && !(await MB().get(b.mbId))) return res.status(400).json({ error: 'That media buyer is not on the list.' });
  const name = b.name || (role === 'mb' ? (await MB().get(b.mbId)).name : b.fbId ? (await db.getUser(String(b.fbId))).name : '');
  try { res.json(await LOGINS().create({ username: b.username, name, role, fbId: role === 'pm' ? b.fbId : '', mbId: role === 'mb' ? b.mbId : '', by: req.user.name })); } catch (e) { loginErr(res, e); }
}));
api.post('/logins/:u/reset', wrap(async (req, res) => {
  const rec = await LOGINS().get(req.params.u); if (!rec || !(await canManageLogin(req, rec))) return res.status(404).json({ error: 'No such username.' });
  try { res.json(await LOGINS().reset(rec.username)); } catch (e) { loginErr(res, e); }
}));
api.delete('/logins/:u', wrap(async (req, res) => {
  const rec = await LOGINS().get(req.params.u); if (!rec || !(await canManageLogin(req, rec))) return res.status(404).json({ error: 'No such username.' });
  await LOGINS().remove(rec.username); res.json({ ok: true });
}));
// Me: make my own username (I'm logged in with Facebook, so it opens this same workspace), or change my password.
api.post('/me/login', wrap(async (req, res) => {
  if (req.user.buyer || req.user.google) return res.status(403).json({ error: 'Ask your PM for a username.' });
  const b = req.body || {};
  try { const r = await LOGINS().create({ username: b.username, name: req.user.name, role: 'pm', fbId: req.user.fb_id, by: req.user.name, password: String(b.password || '') }); req.session.loginId = r.login.username; res.json(r); } catch (e) { loginErr(res, e); }
}));
api.put('/me/password', wrap(async (req, res) => {
  const L = LOGINS(), rec = req.user.buyer ? await L.forMb(req.user.buyer.id) : await L.forFb(req.user.fb_id), b = req.body || {};
  if (!rec) return res.status(404).json({ error: 'You have no username yet.' });
  try { await L.verify(rec.username, b.current); await L.setPassword(rec.username, b.next); res.json({ ok: true }); } catch (e) { loginErr(res, e.status === 401 ? Object.assign(e, { message: 'The current password is wrong.', status: 400 }) : e); }
}));
// Settings → Facebook accounts: the extra logins connected to my workspace.
// A Facebook account's profile picture (asked with that account's own token), remembered for an hour.
const fbPics = new Map();
async function fbPicture(id, token) {
  const hit = fbPics.get(id); if (hit && Date.now() - hit.at < 3600e3) return hit.url;
  let url = '';
  try { const r = await Promise.race([meta.get(`/${id}/picture`, { redirect: 0, type: 'normal', width: 160, height: 160 }, token), new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), 2500))]); url = (r.data && !r.data.is_silhouette && r.data.url) || ''; } catch (_) { /* no picture: the initials show */ }
  fbPics.set(id, { at: Date.now(), url }); return url;
}
// A connected Facebook account's profile picture: mine or one of my team's extra accounts. Redirects to Facebook's
// picture (cached an hour); 404 when there is none, and the page shows initials instead.
api.get('/fb-pic/:id', wrap(async (req, res) => {
  const me = req.user.fb_id, id = String(req.params.id); let token = '';
  try { if (id === me) token = await sync.tokenFor(req.user); else { const e = (await sync.extraLogins(me)).find((x) => x.id === id); if (e) token = require('./src/crypto').decrypt(e.token_enc); } } catch (_) {}
  const url = token ? await fbPicture(id, token) : '';
  if (!url) return res.status(404).end();
  res.set('Cache-Control', 'private, max-age=3600').redirect(url);
}));
api.get('/fb-accounts', wrap(async (req, res) => {
  const me = req.user.fb_id, accts = await db.listAccounts(me), now = Date.now();
  const exp = req.user.token_expires ? Date.parse(req.user.token_expires) : 0, mine = accts.filter((a) => !(a.info || {}).via);
  const xs = await sync.extraLogins(me), pics = { [me]: `/api/fb-pic/${me}` }; for (const e of xs) pics[e.id] = `/api/fb-pic/${e.id}`; // loaded by the browser, so this list never waits for Facebook
  res.json({ max: require('./src/merge').MAX_FB, main: { id: me, picture: pics[me] || '', name: await fbNameOf(req.user), expires: req.user.token_expires || null, expired: !!(exp && exp < now), daysLeft: exp ? Math.floor((exp - now) / 864e5) : null, accounts: mine.length, syncing: mine.filter((a) => a.enabled).length, pages: (await db.listPagesSeen(me)).length },
    extras: xs.map((e) => ({ id: e.id, picture: pics[e.id] || '', name: e.name, expires: e.expires || null, expired: !!(e.expires && Date.parse(e.expires) < now), addedAt: e.addedAt, error: e.error || '',
    accounts: accts.filter((a) => (a.info || {}).via === e.id).length, syncing: accts.filter((a) => (a.info || {}).via === e.id && a.enabled).length })) });
}));
api.delete('/fb-accounts/:id', wrap(async (req, res) => {
  if (req.user.buyer) return res.status(403).json({ error: 'Ask your PM.' });
  const me = req.user.fb_id, list = await sync.extraLogins(me), next = list.filter((e) => e.id !== String(req.params.id));
  if (next.length === list.length) return res.status(404).json({ error: 'That Facebook account is not connected.' });
  await db.setUserSetting(me, 'fbExtras', next);
  // Its ad accounts leave the workspace (saved spend stays on the clients); the next account refresh would drop them anyway.
  const gone = (await db.pool.query(`DELETE FROM ad_accounts WHERE owner=$1 AND info->>'via'=$2 RETURNING id`, [me, String(req.params.id)])).rows.length;
  res.json({ ok: true, removedAccounts: gone });
}));
// Settings → Profile: my display name and team.
api.put('/me/profile', wrap(async (req, res) => {
  if (req.user.buyer) return res.status(403).json({ error: 'Ask your PM to rename you.' });
  const b = req.body || {}, me = req.user.fb_id, name = String(b.name || '').trim().slice(0, 80);
  if (name && name !== req.user.name) {
    if (!(await db.getUserSetting(me, 'fbName', ''))) await db.setUserSetting(me, 'fbName', req.user.name); // remember the Facebook account's own name
    await db.pool.query('UPDATE users SET name=$2 WHERE fb_id=$1', [me, name]);
    const lg = await LOGINS().forFb(me); if (lg) { lg.name = name; await LOGINS().save(lg); }
  }
  if (b.team !== undefined) { // moving myself between teams (admins may pick any; others only leave or join by name)
    const teams = await getTeams(), want = String(b.team || '').trim();
    for (const t of teams) t.members = t.members.filter((x) => x !== me);
    const t = want ? teams.find((x) => x.name === want) : null; if (want && !t) return res.status(400).json({ error: 'No team with that name.' });
    if (t) t.members.push(me); await db.setSetting('teams', teams);
  }
  res.json({ ok: true, name: name || req.user.name });
}));
// Settings → Telegram: a test message to my own chat.
api.post('/me/telegram/test', wrap(async (req, res) => {
  const chat = req.user.buyer ? ((await MB().get(req.user.buyer.id)) || {}).chat : (await db.getUserSetting(req.user.fb_id, 'tgChat', null) || {}).id;
  if (!chat) return res.status(400).json({ error: 'Telegram is not linked yet.' });
  await telegram.send(`✅ Boost Desk test · ${req.user.name}\nYour Telegram is linked — alerts will arrive here.`, chat); res.json({ ok: true });
}));
// Settings → Alerts to my Telegram, and AI advice on/off.
api.get('/me/alerts', wrap(async (req, res) => res.json(await require('./src/myalerts').prefs(req.user.fb_id))));
api.put('/me/alerts', wrap(async (req, res) => res.json(await require('./src/myalerts').savePrefs(req.user.fb_id, req.body || {}))));
api.put('/me/ai', wrap(async (req, res) => {
  const b = req.body || {}; if (b.on !== undefined) await db.setUserSetting(req.user.fb_id, 'aiOn', !!b.on); if (b.lang) await db.setUserSetting(req.user.fb_id, 'aiLang', b.lang === 'km' ? 'km' : 'en');
  res.json({ on: (await db.getUserSetting(req.user.fb_id, 'aiOn', true)) !== false, lang: (await db.getUserSetting(req.user.fb_id, 'aiLang', 'en')) === 'km' ? 'km' : 'en' });
}));
// My Telegram: a PM / owner connects their own chat to get alerts (plan / result from their media buyers).
api.get('/me/telegram', wrap(async (req, res) => {
  if (req.user.buyer) return res.json({ buyer: true });
  let code = await db.getUserSetting(req.user.fb_id, 'tgCode', ''); if (!code) { code = newCode(); await db.setUserSetting(req.user.fb_id, 'tgCode', code); }
  const chat = await db.getUserSetting(req.user.fb_id, 'tgChat', null), bot = telegram.hasBot() ? await telegram.username() : '';
  res.json({ linked: !!(chat && chat.id), name: chat ? chat.name : '', at: chat ? chat.at : null, link: bot ? `https://t.me/${bot}?start=pm_${code}` : '', bot, code });
}));
api.delete('/me/telegram', wrap(async (req, res) => { if (!req.user.buyer) await db.setUserSetting(req.user.fb_id, 'tgChat', null); res.json({ ok: true }); }));
// A media buyer's menu also lists the client tasks their PM gave them for the day (ticked here or on the client page).
async function buyerClientItems(who, day) {
  if (who.role !== 'mb') return [];
  const b = await MB().get(who.person); if (!b) return [];
  const dt = await dayTasks(day), owner = b.addedById || Object.fromEntries((await db.allUsers()).map((u) => [u.name, u.fb_id]))[b.addedBy];
  return (((dt.users[owner] || {}).tasks || [])).filter((t) => t.to && t.to.id === b.id && t.from !== 'work')
    .map((t) => ({ id: `ct:${t.clientId}:${t.id}`, text: t.text, client: t.client, clientId: t.clientId, pm: true, done: !!t.done, at: t.doneAt || null, by: t.doneBy || null, late: !!t.late, target: t.target || 0, reached: t.reached || 0, unit: t.unit || '' }));
}
const withClientItems = async (who, d) => { const extra = await buyerClientItems(who, d.day); if (!extra.length) return d; const items = [...d.items, ...extra], done = items.filter((x) => x.done).length; return { ...d, items, total: items.length, done, pct: items.length ? Math.round(done / items.length * 100) : null }; };
api.get('/menu', wrap(async (req, res) => {
  const who = await menuPerson(req, req.query.as); if (!who) return res.status(404).json({ error: 'Person not found.' });
  const day = isDay(req.query.day) ? req.query.day : sync.todayIn();
  res.json({ ...(await withClientItems(who, await MENU().dayOf(who.person, who.role, day))), today: sync.todayIn(), name: who.name });
}));
api.post('/menu/tick', wrap(async (req, res) => {
  const b = req.body || {}, who = await menuPerson(req, b.as); if (!who) return res.status(404).json({ error: 'Person not found.' });
  const day = isDay(b.day) ? b.day : sync.todayIn(); if (day > sync.todayIn()) return res.status(400).json({ error: 'That day has not come yet.' });
  const byName = req.user.buyer ? req.user.buyer.name : req.user.name;
  const ct = String(b.id || '').match(/^ct:(\d+):([a-f0-9]{6,20})$/);
  if (ct) { // a client task from the PM: tick it in the client's workbook
    const cid = ct[1], tid = ct[2], owner = ((await db.pool.query('SELECT owner FROM clients WHERE id=$1', [cid])).rows[0] || {}).owner;
    if (!owner) return res.status(404).json({ error: 'Client not found.' });
    const w = await AI().workbook(owner, cid), t = (w.tasks || []).find((x) => x.id === tid); if (!t) return res.status(404).json({ error: 'Task not found.' });
    const lid = 't:' + t.id + ':' + day; w.log = (w.log || []).filter((x) => x.id !== lid);
    if (b.done) { const at = new Date().toISOString(); t.done = true; t.doneAt = at; t.doneBy = byName; w.log.push({ id: lid, day, at, by: byName, text: t.text, kind: t.repeat ? 'repeat' : 'me' }); } else { t.done = false; t.doneAt = null; t.doneBy = null; }
    if (b.reached != null && Number(t.target) > 0) { t.hit = t.hit || {}; t.hit[day] = Math.max(0, Number(b.reached) || 0); }
    await AI().saveWorkbook(owner, cid, w);
    return res.json(await withClientItems(who, await MENU().dayOf(who.person, who.role, day)));
  }
  if (!/^[a-f0-9]{8}$/.test(String(b.id || ''))) return res.status(400).json({ error: 'Which item?' });
  await MENU().tick(who.person, day, b.id, !!b.done, byName, b.amount);
  res.json(await withClientItems(who, await MENU().dayOf(who.person, who.role, day)));
}));
// Top 5 menu tasks from the person's KPIs (AI) — shown when a day's menu is empty, or on demand.
api.post('/menu/suggest', wrap(async (req, res) => {
  const b = req.body || {}, who = await menuPerson(req, b.as); if (!who) return res.status(404).json({ error: 'Person not found.' });
  const month = /^\d{4}-\d{2}$/.test(b.month) ? b.month : sync.todayIn().slice(0, 7);
  let kpis = [], menu = [];
  try { kpis = (await KPI().getList(who.person, month)).filter((k) => String(k.name || '').trim()).map((k) => ({ id: k.id, name: k.name, target: k.target, unit: k.unit })); } catch (_) {}
  try { menu = (await MENU().listOf(who.person, who.role)).map((x) => x.text); } catch (_) {}
  try { res.json(await AI().menuSuggest(req.user.fb_id, { kpis, menu, role: who.role, lang: b.lang === 'en' ? 'en' : 'km', fresh: !!b.fresh })); }
  catch (e) { res.status(e.status || 500).json({ error: e.message, notSetUp: !!e.notSetUp }); }
}));
api.post('/menu/item', wrap(async (req, res) => {
  const b = req.body || {}, who = await menuPerson(req, b.as); if (!who) return res.status(404).json({ error: 'Person not found.' });
  const day = b.once ? (isDay(b.day) ? b.day : sync.todayIn()) : null;
  try { const it = await MENU().addItem(who.person, who.role, b.text, day); if (b.kpi) await MENU().editItem(who.person, who.role, it.id, undefined, b.kpi); res.json(await MENU().dayOf(who.person, who.role, day || sync.todayIn())); } catch (e) { res.status(400).json({ error: e.message }); }
}));
api.put('/menu/item/:id', wrap(async (req, res) => {
  const b = req.body || {}, who = await menuPerson(req, b.as); if (!who) return res.status(404).json({ error: 'Person not found.' });
  try { res.json({ item: await MENU().editItem(who.person, who.role, req.params.id, b.text, b.kpi) }); } catch (e) { res.status(400).json({ error: e.message }); }
}));
api.delete('/menu/item/:id', wrap(async (req, res) => {
  const who = await menuPerson(req, req.query.as); if (!who) return res.status(404).json({ error: 'Person not found.' });
  await MENU().removeItem(who.person, who.role, req.params.id); res.json({ ok: true });
}));
api.post('/menu/reset', wrap(async (req, res) => {
  const who = await menuPerson(req, (req.body || {}).as); if (!who) return res.status(404).json({ error: 'Person not found.' });
  await MENU().resetList(who.person, who.role); res.json(await MENU().dayOf(who.person, who.role, sync.todayIn()));
}));
// Plan / result alerts go to the team Telegram group (TELEGRAM_CHAT_ID); a media buyer without a team group gets it in their own chat.
async function menuAlert(req, who, d, kind) {
  if (TASKS_OFF || !telegram.hasBot()) return;
  const roleName = who.role === 'mb' ? 'Media buyer' : 'Project Manager', when = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: cfg.tz });
  const dayLbl = new Date(d.day + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  let text;
  if (kind === 'plan') text = `📋 ផែនការថ្ងៃនេះ · ${who.name} (${roleName})\n🗓 ${dayLbl} · ${when}\n\n${d.items.map((x, i) => `${i + 1}. ${x.text}`).join('\n')}`;
  else {
    text = `✅ លទ្ធផលថ្ងៃនេះ · ${who.name} (${roleName})\n🗓 ${dayLbl} · ${when} · ${d.done} / ${d.total} (${d.pct}%)\n\n${d.items.map((x) => `${x.done ? '✔' : '✘'} ${x.text}`).join('\n')}`;
    // the Clients Task lines they ticked that day (per client), from the PM's workbooks
    try {
      const dt = await dayTasks(d.day), owner = req.user.fb_id, all = ((dt.users[owner] || {}).tasks || []).filter((t) => t.done);
      const mine = all.filter((t) => (req.user.buyer ? (t.to && t.to.id === who.person) : (!t.to || who.role !== 'mb')));
      if (mine.length) {
        const byClient = {}; for (const t of mine) (byClient[t.client] = byClient[t.client] || []).push(t);
        text += `\n\n📌 Clients Task · ${mine.length} done\n` + Object.entries(byClient).map(([c, ts]) => `${c}\n${ts.map((t) => `  ✔ ${t.text}${t.reached != null && t.target ? ` (${t.reached}/${t.target}${t.unit ? ' ' + t.unit : ''})` : ''}`).join('\n')}`).join('\n');
      }
      const open = ((dt.users[owner] || {}).tasks || []).filter((t) => !t.done && (req.user.buyer ? (t.to && t.to.id === who.person) : (!t.to || who.role !== 'mb')) && t.from !== 'work' && t.from !== 'ai');
      if (open.length) text += `\n\n⏳ Not done yet: ${open.length}\n${open.slice(0, 10).map((t) => `  ✘ ${t.client} — ${t.text}`).join('\n')}${open.length > 10 ? `\n  … +${open.length - 10} more` : ''}`;
    } catch (e) { console.error('[menu] client tasks:', e.message); }
    if (d.result && d.result.note) text += `\n\n📝 ${d.result.note}`;
  }
  const chats = new Set(); if (cfg.telegramChatId) chats.add(String(cfg.telegramChatId));
  if (who.role === 'mb') { // the media buyer's PM gets it in their own chat; without a team group the buyer gets a copy too
    let pmId = null;
    try { const b = await MB().get(who.person); if (b) { const byName = Object.fromEntries((await db.allUsers()).map((u) => [u.name, u.fb_id])); pmId = b.addedById || byName[b.addedBy] || null; if (!cfg.telegramChatId && b.chat) chats.add(String(b.chat)); } } catch (_) {}
    const addChat = async (id) => { const c = await db.getUserSetting(id, 'tgChat', null); if (c && c.id) chats.add(String(c.id)); };
    if (pmId) await addChat(pmId);
    if (req.user && req.user.fb_id) { await addChat(req.user.fb_id); // the submitter's own chat (a Facebook login marked Media buyer), or the PM behind a bot buyer
      if (!req.user.buyer) { const team = (await getTeams()).find((t) => t.members.includes(req.user.fb_id)); for (const m of (team ? team.members : []).filter((x) => x !== req.user.fb_id)) await addChat(m); } // their teammates (the PM)
    }
  }
  for (const chat of chats) { try { await telegram.send(text, chat); } catch (e) { console.error('[menu] telegram:', e.message); } }
}
// Morning: submit the plan (freezes today's list). Evening: submit the result (closes the day). Reopen undoes the result.
api.post('/menu/plan', wrap(async (req, res) => {
  const b = req.body || {}, who = await menuPerson(req, b.as); if (!who) return res.status(404).json({ error: 'Person not found.' });
  const day = isDay(b.day) ? b.day : sync.todayIn(); if (day > sync.todayIn()) return res.status(400).json({ error: 'That day has not come yet.' });
  try { await MENU().submitPlan(who.person, who.role, day, req.user.buyer ? req.user.buyer.name : req.user.name); const d = await MENU().dayOf(who.person, who.role, day); res.json(d); menuAlert(req, who, d, 'plan'); } catch (e) { res.status(400).json({ error: e.message }); }
}));
api.post('/menu/result', wrap(async (req, res) => {
  const b = req.body || {}, who = await menuPerson(req, b.as); if (!who) return res.status(404).json({ error: 'Person not found.' });
  const day = isDay(b.day) ? b.day : sync.todayIn(); if (day > sync.todayIn()) return res.status(400).json({ error: 'That day has not come yet.' });
  await MENU().submitResult(who.person, who.role, day, req.user.buyer ? req.user.buyer.name : req.user.name, b.note); const d = await MENU().dayOf(who.person, who.role, day); res.json(d); menuAlert(req, who, d, 'result');
}));
api.post('/menu/reopen', wrap(async (req, res) => {
  const b = req.body || {}, who = await menuPerson(req, b.as); if (!who) return res.status(404).json({ error: 'Person not found.' });
  const day = isDay(b.day) ? b.day : sync.todayIn(); await MENU().reopen(who.person, day); res.json(await MENU().dayOf(who.person, who.role, day));
}));
api.get('/menu/month', wrap(async (req, res) => {
  const who = await menuPerson(req, req.query.as); if (!who) return res.status(404).json({ error: 'Person not found.' });
  const ym = /^\d{4}-\d{2}$/.test(req.query.month) ? req.query.month : sync.todayIn().slice(0, 7);
  res.json(await MENU().monthOf(who.person, who.role, ym));
}));
api.get('/admin/menu', adminOnly, wrap(async (req, res) => res.json({ menu: await MENU().all(), canEdit: await canSeeAdmin(req.user.fb_id) })));
api.put('/admin/menu', adminOnly, wrap(async (req, res) => res.json({ menu: await MENU().save((req.body || {}).menu, req.user.name) })));
api.get('/admin/menu/defaults', adminOnly, wrap(async (req, res) => res.json({ menu: MENU().DEFAULT })));
// A month of one person's tasks (the ones people created — not the automatic suggestions), day by day, for the calendar.
// Buyers (and admins looking at a buyer: &buyer=<id>) see only the tasks assigned to that buyer.
api.get('/tasks/month', wrap(async (req, res) => {
  const today = sync.todayIn(), ym = /^\d{4}-\d{2}$/.test(req.query.month) ? req.query.month : today.slice(0, 7);
  const owner = req.user.fb_id, buyerId = req.user.buyer ? req.user.buyer.id : (req.query.as && req.query.buyer ? String(req.query.buyer) : '');
  const cl = (await db.pool.query('SELECT id, name FROM clients WHERE owner=$1', [owner])).rows, cName = Object.fromEntries(cl.map((c) => [c.id, c.name]));
  const rows = (await db.pool.query(`SELECT key, value FROM settings WHERE key LIKE $1`, [owner + ':cwb:%'])).rows;
  const localDay = (iso) => { try { return sync.todayIn(undefined, new Date(iso)); } catch (_) { return ''; } };
  const [y, m] = ym.split('-').map(Number), last = new Date(Date.UTC(y, m, 0)).getUTCDate(), days = {};
  for (let d = 1; d <= last; d++) days[`${ym}-${String(d).padStart(2, '0')}`] = [];
  for (const r of rows) {
    const cid = r.key.split(':')[2]; if (!cName[cid]) continue;
    for (const t of (r.value || {}).tasks || []) {
      if (t.from === 'ai') continue;
      if (buyerId && !(t.to && t.to.id === buyerId)) continue;
      const doneDay = t.done && t.doneAt ? localDay(t.doneAt) : '';
      const base = { id: t.id, text: t.text, client: cName[cid], clientId: Number(cid), to: t.to ? t.to.name : '', repeat: !!t.repeat };
      for (const day of Object.keys(days)) {
        if (t.repeat) { if (t.day <= day && day <= today) days[day].push({ ...base, done: doneDay === day, late: false, missed: day < today && doneDay !== day }); continue; }
        if (t.day === day) days[day].push({ ...base, done: !!t.done, late: false, missed: !t.done && day < today && !(doneDay && doneDay > day) });
        else if (t.day < day && ((!t.done && day === today) || doneDay === day)) days[day].push({ ...base, done: doneDay === day, late: true, missed: false, since: t.day });
      }
    }
  }
  const out = {};
  for (const [day, list] of Object.entries(days)) { const done = list.filter((t) => t.done).length; out[day] = { tasks: list, total: list.length, done, pct: list.length ? Math.round(done / list.length * 100) : null }; }
  res.json({ month: ym, today, days: out });
}));
api.get('/tasks/mine', wrap(async (req, res) => {
  const day = isDay(req.query.day) ? req.query.day : sync.todayIn();
  const dt = await dayTasks(day), mine = (dt.users[req.user.fb_id] || { tasks: [] }).tasks;
  res.json({ day, today: dt.today, tasks: mine });
}));
// PM dashboard: my team — media buyers I work with, today's tasks (done / open / overdue), what was sent to Telegram.
api.get('/team/mine', wrap(async (req, res) => {
  const today = sync.todayIn(), me = req.user.fb_id;
  const teams = await getTeams(), team = teams.find((t) => t.members.includes(me)) || null;
  const members = team ? team.members : [me], users = await db.allUsers(), uName = Object.fromEntries(users.map((u) => [u.fb_id, u.name]));
  const byName = Object.fromEntries(users.map((u) => [u.name, u.fb_id]));
  const bl = (await require('./src/buyers').all()).filter((b) => members.includes(b.addedById || byName[b.addedBy] || '') || (!team && !b.addedById && !byName[b.addedBy]));
  const dt = await dayTasks(today);
  const mine = (dt.users[me] || { tasks: [] }).tasks, counts = { done: 0, open: 0, overdue: 0, sent: 0, notSent: 0, buyerDone: 0, buyerOpen: 0 };
  const buyerTasks = [];
  for (const t of mine) {
    if (t.done) counts.done++; else counts.open++;
    if (t.late && !t.done) counts.overdue++;
    if (t.to) { if (t.sentAt) counts.sent++; else counts.notSent++; if (t.done) counts.buyerDone++; else counts.buyerOpen++; buyerTasks.push(t); }
  }
  const perBuyer = bl.map((b) => { const ts = buyerTasks.filter((t) => t.to && t.to.id === b.id); return { ...b, today: ts.length, done: ts.filter((t) => t.done).length, late: ts.filter((t) => t.late && !t.done).length, notSent: ts.filter((t) => !t.sentAt).length }; });
  // the KPI score of each media buyer this month (average of KPIs with a target)
  const K = KPI(); for (const b of perBuyer) { try { const rs = (await K.results(b.id, today.slice(0, 7), true)).filter((k) => k.target > 0); b.kpi = rs.length ? Math.round(rs.reduce((t, k) => t + Math.min(k.score, 150), 0) / rs.length) : null; } catch (_) { b.kpi = null; } }
  const teammates = members.filter((id) => id !== me && uName[id]).map((id) => { const o = dt.users[id] || { tasks: [] }; return { id, name: uName[id], done: o.tasks.filter((t) => t.done).length, open: o.tasks.filter((t) => !t.done).length, clients: o.clients || 0 }; });
  res.json({ today, team: team ? { id: team.id, name: team.name } : null, counts, buyers: perBuyer, teammates, buyerTasks: buyerTasks.slice(0, 30), clients: (dt.users[me] || {}).clients || 0 });
}));
// Admin: every team's target tasks for a day, with totals.
api.get('/admin/targets', adminOnly, wrap(async (req, res) => {
  const day = isDay(req.query.day) ? req.query.day : sync.todayIn();
  const { users } = await dayTasks(day), teams = await getTeams(), teamOf = {};
  for (const t of teams) for (const m of t.members) teamOf[m] = t.name;
  const people = Object.entries(users).map(([id, u]) => { const tasks = u.tasks.filter((t) => t.target > 0); return { id, name: u.name, team: teamOf[id] || '', tasks, target: tasks.reduce((s, t) => s + t.target, 0), reached: tasks.reduce((s, t) => s + Math.min(t.reached, t.target), 0), tasksTotal: u.tasks.filter((t) => t.from !== 'work').length, tasksDone: u.tasks.filter((t) => t.from !== 'work' && t.done).length }; });
  res.json({ day, today: sync.todayIn(), teams: teams.map((t) => t.name), people });
}));
api.get('/clients-work', wrap(async (req, res) => {
  const today = sync.todayIn(), out = {};
  for (const c of await db.listClients(req.user.fb_id)) {
    const w = (await db.getUserSetting(req.user.fb_id, `cwb:${c.id}`, null)) || {};
    out[c.id] = { openTasks: (w.tasks || []).filter((t) => !t.done && (t.day || '') <= today).length, // due today or earlier; tasks planned for later days are not "left" yet
       ticked: Object.keys(w.ticks || {}).filter((k) => k.startsWith(today + ':')).map((k) => k.slice(11)) };
  }
  res.json({ today, clients: out });
}));
api.get('/clients/:id/workbook', wrap(async (req, res) => { if (!(await ownClient(req))) return res.status(404).json({ error: 'Client not found.' }); res.json({ today: sync.todayIn(), ...(await AI().workbook(req.user.fb_id, req.params.id)) }); }));
api.post('/clients/:id/plan', wrap(async (req, res) => {
  if (!(await ownClient(req))) return res.status(404).json({ error: 'Client not found.' });
  const lang = (req.body || {}).lang === 'km' ? 'km' : 'en'; await db.setUserSetting(req.user.fb_id, 'aiLang', lang);
  try { await AI().dailyPlan(req.user.fb_id, req.params.id, { lang, force: !!(req.body || {}).force }); res.json({ today: sync.todayIn(), ...(await AI().workbook(req.user.fb_id, req.params.id)) }); }
  catch (e) { if (e.status) return res.status(e.status).json({ error: e.message, notSetUp: !!e.notSetUp }); throw e; }
}));
api.put('/clients/:id/notes', wrap(async (req, res) => {
  if (!(await ownClient(req))) return res.status(404).json({ error: 'Client not found.' });
  const w = await AI().workbook(req.user.fb_id, req.params.id); w.notes = String((req.body || {}).notes || '').slice(0, 5000); w.notesAt = new Date().toISOString();
  await AI().saveWorkbook(req.user.fb_id, req.params.id, w); res.json({ ok: true, notesAt: w.notesAt });
}));
api.post('/clients/:id/tasks', wrap(async (req, res) => {
  if (!(await ownClient(req))) return res.status(404).json({ error: 'Client not found.' });
  const text = String((req.body || {}).text || '').trim().slice(0, 200); if (!text) return res.status(400).json({ error: 'Type the task.' });
  const w = await AI().workbook(req.user.fb_id, req.params.id);
  const B = require('./src/buyers'), buyer = (req.body || {}).to ? await B.get(req.body.to) : null;
  if ((req.body || {}).to && !buyer) return res.status(400).json({ error: 'That media buyer was removed.' });
  const tg = Math.min(1e6, Math.max(0, Number((req.body || {}).target) || 0));
  const today = sync.todayIn(), askDay = String((req.body || {}).day || ''), day = isDay(askDay) && askDay > today && askDay <= sync.addDays(today, 60) ? askDay : today; // a task can be planned for a later day
  const t = { id: require('crypto').randomBytes(5).toString('hex'), text, from: 'me', day, done: false, by: req.user.name, ...((req.body || {}).repeat ? { repeat: true } : {}), ...(buyer ? { to: { id: buyer.id, name: buyer.name } } : {}), ...(tg ? { target: tg, unit: String((req.body || {}).unit || '').trim().slice(0, 20), hit: {} } : {}), ...(/^[a-f0-9]{8}$/.test(String((req.body || {}).kpi || '')) ? { kpi: req.body.kpi } : {}) };
  let warn = '';
  if (buyer && day === today) { // a later day: the bot sends it that morning
    const c = (await db.listClients(req.user.fb_id)).find((x) => x.id === Number(req.params.id));
    try { await B.notify(buyer, { client: c ? c.name : '', text, from: req.user.name, repeat: !!t.repeat, cid: req.params.id, tid: t.id }); t.sentAt = new Date().toISOString(); }
    catch (e) { warn = e.message; }
  }
  w.tasks.push(t);
  await AI().saveWorkbook(req.user.fb_id, req.params.id, w); res.json({ today: sync.todayIn(), ...w, ...(warn ? { warn } : {}) });
}));
// Media buyers (no login needed: they connect Telegram once from an invite link).
// A PM sees only the media buyers they added; the owner / CEO / COO see everyone's.
api.get('/media-buyers', wrap(async (req, res) => {
  const all = await require('./src/buyers').all(), me = req.user.fb_id, mine = all.filter((b) => b.addedById === me || (!b.addedById && b.addedBy === req.user.name));
  res.json({ buyers: (await canSeeAdmin(me)) ? all : mine, bot: telegram.hasBot() });
}));
// A media buyer's Telegram picture (synced when they connect and once a day).
app.get('/mb-pic/:id', wrap(async (req, res) => {
  const p = await require('./src/buyers').photoOf(req.params.id); if (!p) return res.status(404).end();
  const m = p.match(/^data:(image\/\w+);base64,(.+)$/); if (!m) return res.status(404).end();
  res.set('Content-Type', m[1]).set('Cache-Control', 'private, max-age=3600').send(Buffer.from(m[2], 'base64'));
}));
api.post('/media-buyers/:id/sync', wrap(async (req, res) => { // re-read name + picture from Telegram now
  const B = require('./src/buyers'), all = await B.list(), b = all.find((x) => x.id === req.params.id);
  if (!b) return res.status(404).json({ error: 'Media buyer not found.' });
  if (!(await ownsBuyer(req, b.id))) return res.status(403).json({ error: 'Only this media buyer\'s PM or an admin can do this.' });
  if (!b.chat) return res.status(400).json({ error: 'Not connected to Telegram yet.' });
  if (await B.syncProfile(b, '')) await B.save(all);
  res.json({ ok: true, name: b.name, photo: !!b.photo });
}));
api.post('/media-buyers', wrap(async (req, res) => { try { res.json(await require('./src/buyers').add((req.body || {}).name, req.user.name, req.user.fb_id)); } catch (e) { res.status(400).json({ error: e.message }); } }));
api.delete('/media-buyers/:id', wrap(async (req, res) => {
  if (!(await MB().get(req.params.id))) return res.status(404).json({ error: 'Media buyer not found.' });
  if (!(await ownsBuyer(req, req.params.id))) return res.status(403).json({ error: 'Only this media buyer\'s PM or an admin can remove them.' });
  await require('./src/buyers').remove(req.params.id); res.json({ ok: true });
}));
// "This is the PM": a Project Manager who connected Telegram as a media buyer (the old way in). Their Telegram becomes
// the team's PM chat, the media-buyer entry goes, tasks that were given to it become the PM's own, and a username made
// for it opens the team account as PM.
api.post('/media-buyers/:id/make-pm', wrap(async (req, res) => {
  const B = require('./src/buyers'), b = await B.get(req.params.id); if (!b) return res.status(404).json({ error: 'Media buyer not found.' });
  const users = await db.allUsers(), owner = b.addedById || (users.find((u) => u.name === b.addedBy) || {}).fb_id || '';
  if (!owner || !(await db.getUser(owner))) return res.status(400).json({ error: `${b.name} is not under a team account yet — choose the PM first.` });
  if (req.user.buyer || !((await isFull(req)) || req.user.fb_id === owner)) return res.status(403).json({ error: 'Only this team\'s PM or an admin can do this.' });
  if (!b.chat) return res.status(400).json({ error: `${b.name} has not connected Telegram yet.` });
  const prev = await db.getUserSetting(owner, 'tgChat', null);
  await db.setUserSetting(owner, 'tgChat', { id: String(b.chat), name: b.tgName || b.name, at: new Date().toISOString() });
  let moved = 0;
  for (const r of (await db.pool.query(`SELECT key, value FROM settings WHERE key LIKE $1`, [`${owner}:cwb:%`])).rows) {
    const w = r.value || {}; let ch = false;
    for (const t of w.tasks || []) if (t.to && t.to.id === b.id) { delete t.to; ch = true; moved++; }
    if (ch) await db.setSetting(r.key, w);
  }
  const L = LOGINS(), lg = await L.forMb(b.id); let username = '';
  if (lg) { if (await L.forFb(owner)) await L.remove(lg.username); else { lg.role = 'pm'; lg.fbId = owner; lg.mbId = ''; await L.save(lg); username = lg.username; } }
  await B.remove(b.id);
  console.log('[teams]', b.name, 'is now the PM Telegram of', (users.find((u) => u.fb_id === owner) || {}).name || owner, 'by', req.user.name);
  res.json({ ok: true, name: b.tgName || b.name, replaced: prev && prev.id && String(prev.id) !== String(b.chat) ? prev.name || 'another chat' : '', tasks: moved, username });
}));
// Admin: move a media buyer under another PM (keeps their Telegram link, KPIs and tasks).
api.patch('/media-buyers/:id', adminOnly, wrap(async (req, res) => {
  const B = require('./src/buyers'), pm = String((req.body || {}).pm || '').trim(), users = await db.allUsers(), u = users.find((x) => x.fb_id === pm);
  if (!u) return res.status(400).json({ error: 'Pick the PM.' });
  const all = await B.list(), b = all.find((x) => x.id === String(req.params.id)); if (!b) return res.status(404).json({ error: 'Media buyer not found.' });
  b.addedById = u.fb_id; b.addedBy = u.name; await B.save(all); res.json({ ok: true, pm: { id: u.fb_id, name: u.name } });
}));
api.patch('/clients/:id/tasks/:tid', wrap(async (req, res) => {
  if (!(await ownClient(req))) return res.status(404).json({ error: 'Client not found.' });
  const w = await AI().workbook(req.user.fb_id, req.params.id), t = w.tasks.find((x) => x.id === req.params.tid);
  if (!t) return res.status(404).json({ error: 'Task not found.' });
  if ((req.body || {}).done != null) {
    t.done = !!req.body.done; t.doneAt = t.done ? new Date().toISOString() : null; t.doneBy = t.done ? req.user.name : null;
    const day = sync.todayIn(), lid = 't:' + t.id + ':' + day; w.log = (w.log || []).filter((x) => x.id !== lid);
    if (t.done) w.log.push({ id: lid, day, at: t.doneAt, by: req.user.name, text: t.text, kind: t.repeat ? 'repeat' : t.from === 'ai' ? 'ai' : 'me' });
  }
  if (typeof (req.body || {}).text === 'string' && req.body.text.trim()) t.text = req.body.text.trim().slice(0, 200);
  if ((req.body || {}).repeat != null) { if (req.body.repeat) t.repeat = true; else delete t.repeat; }
  if ((req.body || {}).target != null) { const tg = Math.min(1e6, Math.max(0, Number(req.body.target) || 0)); if (tg) { t.target = tg; t.hit = t.hit || {}; } else { delete t.target; delete t.unit; delete t.hit; } }
  if (typeof (req.body || {}).unit === 'string' && t.target) t.unit = req.body.unit.trim().slice(0, 20);
  if ((req.body || {}).kpi !== undefined) { if (/^[a-f0-9]{8}$/.test(String(req.body.kpi || ''))) t.kpi = req.body.kpi; else delete t.kpi; }
  if ((req.body || {}).reached != null && t.target) { t.hit = t.hit || {}; const k = t.repeat ? sync.todayIn() : t.day; t.hit[k] = Math.min(1e7, Math.max(0, Number(req.body.reached) || 0)); }
  await AI().saveWorkbook(req.user.fb_id, req.params.id, w); res.json({ today: sync.todayIn(), ...w });
}));
api.delete('/clients/:id/tasks/:tid', wrap(async (req, res) => {
  if (!(await ownClient(req))) return res.status(404).json({ error: 'Client not found.' });
  const w = await AI().workbook(req.user.fb_id, req.params.id); w.tasks = w.tasks.filter((x) => x.id !== req.params.tid);
  await AI().saveWorkbook(req.user.fb_id, req.params.id, w); res.json({ today: sync.todayIn(), ...w });
}));
// Tick an item of "Today's work" (report to send, client not boosting…) as done for today.
api.put('/clients/:id/tick', wrap(async (req, res) => {
  if (!(await ownClient(req))) return res.status(404).json({ error: 'Client not found.' });
  const key = sync.todayIn() + ':' + String((req.body || {}).key || '').slice(0, 60);
  const w = await AI().workbook(req.user.fb_id, req.params.id); if ((req.body || {}).done) w.ticks[key] = { at: new Date().toISOString(), by: req.user.name }; else delete w.ticks[key];
  const lid = 'k:' + key; w.log = (w.log || []).filter((x) => x.id !== lid);
  if ((req.body || {}).done) w.log.push({ id: lid, day: sync.todayIn(), at: new Date().toISOString(), by: req.user.name, text: String(req.body.title || req.body.key || '').slice(0, 200), kind: String(req.body.key || '').slice(0, 30) });
  await AI().saveWorkbook(req.user.fb_id, req.params.id, w); res.json({ today: sync.todayIn(), ...w });
}));
api.get('/ai/status', wrap(async (req, res) => { const c = await require('./src/ai').publicConfig(); res.json({ hasKey: c.hasKey }); }));
api.put('/admin/ai', ownerOnly, wrap(async (req, res) => res.json(await require('./src/ai').saveKey((req.body || {}).key === null ? null : String((req.body || {}).key || ''), req.user.name))));
// Check one day against adsbox.biz (admins), and take adsbox's numbers for a period when they match its Sales Overview.
api.get('/orders/compare', adminOnly, wrap(async (req, res) => {
  const day = String(req.query.day || ''); if (!isDay(day)) return res.status(400).json({ error: 'Pick a day.' });
  const r = await orders.compareDay(day); if (!r) return res.status(400).json({ error: 'Connect the adsbox.biz API first.' }); res.json(r);
}));
api.post('/orders/use-live', adminOnly, wrap(async (req, res) => {
  const { from, to } = req.body || {}, today = sync.todayIn();
  if (!isDay(from) || !isDay(to) || from > to || (Date.parse(to) - Date.parse(from)) / 864e5 > 92) return res.status(400).json({ error: 'Pick up to 3 months.' });
  const n = await orders.useLive(from, to > today ? today : to); if (n === null) return res.status(400).json({ error: 'Connect the adsbox.biz API first.' }); res.json({ ok: true, rows: n });
}));
// Boost Desk's own order counting: connected Pages, and the switch between it and adsbox.biz.
api.get('/orders/pages', wrap(async (req, res) => { res.json(await pageOrders.list(req.user.fb_id, await canSeeAdmin(req.user.fb_id))); }));
api.delete('/orders/pages/:id', wrap(async (req, res) => {
  if (req.user.buyer) return res.status(403).json({ error: 'Ask your PM.' });
  const id = String(req.params.id || ''); if (!/^\d{5,30}$/.test(id)) return res.status(400).json({ error: 'Pick a Page.' });
  const row = (await db.pool.query('SELECT connected_by FROM page_links WHERE page_id=$1', [id])).rows[0];
  if (!row) return res.status(404).json({ error: 'That Page is not connected.' });
  if (row.connected_by !== req.user.fb_id && !(await canSeeAdmin(req.user.fb_id))) return res.status(403).json({ error: 'Only the person who connected it or an admin can remove it.' });
  await pageOrders.disconnect(id); res.json({ ok: true });
}));
api.put('/orders/own', ownerOnly, wrap(async (req, res) => res.json(await pageOrders.setMode(!!(req.body || {}).on, req.user.name))));
api.post('/orders/test', adminOnly, wrap(async (req, res) => res.json(await orders.testApi())));
api.post('/orders/pull', wrap(async (req, res) => {
  if ((await pageOrders.mode()).on) { await pageOrders.flush(); return res.json({ ok: true, own: true }); } // counted live by Boost Desk; nothing to fetch
  const b = req.body || {}, today = sync.todayIn();
  let n;
  if (isDay(b.from) && isDay(b.to) && b.from <= b.to && b.from >= sync.addDays(today, -800)) n = await orders.pullRange(b.from, b.to > today ? today : b.to, { force: !!b.force });
  else n = await orders.pullApi(Math.min(62, Number(b.days) || 7)); if (n === null) return res.status(400).json({ error: 'Connect the adsbox.biz API first (Orders page → API settings).' }); res.json({ ok: true, rows: n }); }));
api.get('/orders/report', wrap(async (req, res) => {
  const { from, to } = req.query;
  if (!isDay(from) || !isDay(to) || from > to) return res.status(400).json({ error: 'Pick a valid period.' });
  res.json(await orders.report(req.user.fb_id, from, to, String(req.query.src || 'all')));
}));

// Set a campaign to Live or Post by hand (kind: 'live' | 'post' | null to go back to automatic), then recount.
api.put('/kind-override', wrap(async (req, res) => {
  const id = String((req.body || {}).campaignId || ''), kind = (req.body || {}).kind;
  if (!/^\d{3,30}$/.test(id)) return res.status(400).json({ error: 'Pick a campaign.' });
  const ov = (await db.getUserSetting(req.user.fb_id, 'kindOverride', {})) || {};
  if (kind === 'live' || kind === 'post') ov[id] = kind; else delete ov[id];
  await db.setUserSetting(req.user.fb_id, 'kindOverride', ov);
  // Recount now; if a sync is running, wait for it (the choice is already saved and every sync uses it).
  for (let i = 0; i < 40; i++) {
    if (await sync.exclusive(req.user.fb_id, () => sync.rematch(req.user))) return res.json({ ok: true });
    await new Promise((r) => setTimeout(r, 1500));
  }
  res.json({ ok: true, later: true });
}));
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
