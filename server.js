const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieSession = require('cookie-session');
const cfg = require('./src/config');
const db = require('./src/db');
const meta = require('./src/meta');
const sync = require('./src/sync');
const lives = require('./src/lives');
const reportImage = require('./src/reportImage');
const jobs = require('./src/jobs');
const telegram = require('./src/telegram');
const { encrypt } = require('./src/crypto');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '200kb' }));
app.use(cookieSession({
  name: 'bd_session', secret: cfg.sessionSecret, maxAge: 30 * 864e5,
  sameSite: 'lax', secure: cfg.baseUrl.startsWith('https'), httpOnly: true,
}));

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const isDay = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d);

// ---------- Facebook login ----------
// The login "state" is signed by the server and valid for 15 minutes, so it works in any tab
// and doesn't depend on a browser cookie surviving the trip to Facebook and back.
const signState = (nonce, ts) => crypto.createHmac('sha256', cfg.sessionSecret).update(`${nonce}.${ts}`).digest('hex').slice(0, 32);
function newState() {
  const nonce = crypto.randomBytes(12).toString('hex'), ts = Date.now().toString(36);
  return `${nonce}.${ts}.${signState(nonce, ts)}`;
}
function stateOk(state) {
  const [nonce, ts, sig] = String(state || '').split('.');
  if (!nonce || !ts || !sig) return false;
  const good = signState(nonce, ts);
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return false;
  return Date.now() - parseInt(ts, 36) < 15 * 60 * 1000;
}
const loggedIn = async (req) => !!(req.session && req.session.fbId && (await db.getUser(req.session.fbId)));

app.get('/auth/facebook', (req, res) => res.redirect(meta.loginUrl(newState())));

app.get('/auth/facebook/callback', wrap(async (req, res) => {
  const { code, state, error_description } = req.query;
  if (error_description) return res.redirect('/login?error=' + encodeURIComponent(error_description));
  if (!code || !stateOk(state)) {
    // A replayed or old return link: if you're already logged in, just go in.
    if (await loggedIn(req)) return res.redirect('/');
    return res.redirect('/login?error=' + encodeURIComponent('That login link expired. Tap Continue with Facebook again.'));
  }
  let token, expires;
  try { ({ token, expires } = await meta.exchangeCode(String(code))); }
  catch (e) {
    // Facebook codes work once; a second use (back button, restored tab) fails here.
    if (await loggedIn(req)) return res.redirect('/');
    return res.redirect('/login?error=' + encodeURIComponent('Facebook login did not finish (' + e.message + '). Tap Continue with Facebook again.'));
  }
  const profile = await meta.me(token);
  if (cfg.allowedFbIds.length && !cfg.allowedFbIds.includes(profile.id)) {
    return res.redirect('/login?error=' + encodeURIComponent(`${profile.name} is not on this app's team list. Ask the admin to add Facebook ID ${profile.id}.`));
  }
  if ((await db.blockedUsers())[profile.id]) {
    return res.redirect('/login?error=' + encodeURIComponent(`${profile.name}'s access to Boost Desk was removed. Ask the app owner to restore it.`));
  }
  await db.upsertUser(profile.id, profile.name, encrypt(token), expires);
  req.session.fbId = profile.id;
  req.session.name = profile.name;
  // Each admin starts with an empty workspace; nothing is loaded until they tap Sync from Meta.
  res.redirect('/');
}));

app.post('/auth/logout', (req, res) => { req.session = null; res.json({ ok: true }); });

app.get('/login', wrap(async (req, res) => {
  if (await loggedIn(req)) return res.redirect('/'); // already logged in: go straight to the app
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
}));
// Always revalidate so a new deploy shows up on the next refresh.
app.use('/assets', express.static(path.join(__dirname, 'public', 'assets'), { maxAge: 0, etag: true, setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));

// Everything below needs a logged-in user.
app.use(wrap(async (req, res, next) => {
  const user = req.session.fbId && (await db.getUser(req.session.fbId));
  if (!user) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Please log in with Facebook.', needsLogin: true });
    return res.redirect('/login');
  }
  req.user = user;
  next();
}));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ---------- API ----------
const api = express.Router();

api.get('/me', wrap(async (req, res) => {
  res.json({
    id: req.user.fb_id, name: req.user.name, tokenExpires: req.user.token_expires,
    isOwner: (await db.ownerId()) === req.user.fb_id,
    canAdmin: await canSeeAdmin(req.user.fb_id),
    taxRate: sync.TAX_RATE,
    today: sync.todayIn(), tz: cfg.tz,
    telegram: { configured: telegram.configured(), bot: telegram.hasBot(), time: cfg.reportTime },
  });
}));

// Auto sync control — only the app owner can see or change it, for every account that logged in.
const ownerOnly = wrap(async (req, res, next) => {
  if ((await db.ownerId()) !== req.user.fb_id) return res.status(403).json({ error: 'Only the app owner can manage auto sync.' });
  next();
});
api.get('/auto-sync', ownerOnly, wrap(async (req, res) => res.json({ on: process.env.AUTO_SYNC !== 'off', users: await jobs.statusAll() })));
api.put('/auto-sync/:id', ownerOnly, wrap(async (req, res) => {
  if (!(await db.getUser(req.params.id))) return res.status(404).json({ error: 'Account not found.' });
  await jobs.setEnabled(req.params.id, !!req.body.enabled);
  res.json({ ok: true });
}));
api.put('/auto-sync', ownerOnly, wrap(async (req, res) => {
  for (const u of await db.allUsers()) await jobs.setEnabled(u.fb_id, !!req.body.enabled);
  res.json({ ok: true });
}));
// Admin overview: every account's spend for a period (owner, or people the owner allowed).
const adminViewers = async () => new Set(await db.getSetting('adminViewers', []));
const canSeeAdmin = async (id) => (await db.ownerId()) === id || (await adminViewers()).has(id);
const adminOnly = wrap(async (req, res, next) => {
  if (!(await canSeeAdmin(req.user.fb_id))) return res.status(403).json({ error: 'Only the app owner and people they allow can see the Admin dashboard.' });
  next();
});
api.put('/admin/viewers/:id', ownerOnly, wrap(async (req, res) => {
  const v = await adminViewers();
  if (req.body && req.body.enabled) v.add(req.params.id); else v.delete(req.params.id);
  await db.setSetting('adminViewers', [...v]);
  res.json({ ok: true });
}));
// Teams (groups of accounts shown together on the Admin dashboard). The owner manages them.
const getTeams = () => db.getSetting('teams', []);
const saveTeams = (t) => db.setSetting('teams', t);
api.get('/admin/teams', adminOnly, wrap(async (req, res) => {
  res.json({ teams: await getTeams(), users: (await db.allUsers()).map((u) => ({ id: u.fb_id, name: u.name })), canEdit: (await db.ownerId()) === req.user.fb_id });
}));
api.post('/admin/teams', ownerOnly, wrap(async (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: 'Give the team a name.' });
  const teams = await getTeams();
  const t = { id: 't' + Date.now().toString(36), name, members: [] };
  teams.push(t); await saveTeams(teams); res.json(t);
}));
api.patch('/admin/teams/:id', ownerOnly, wrap(async (req, res) => {
  const teams = await getTeams(), t = teams.find((x) => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'Team not found.' });
  if (req.body?.name != null) { const n = String(req.body.name).trim().slice(0, 60); if (n) t.name = n; }
  if (req.body?.add) { const id = String(req.body.add); for (const x of teams) x.members = x.members.filter((m) => m !== id); t.members.push(id); } // one team per person
  if (req.body?.remove) t.members = t.members.filter((m) => m !== String(req.body.remove));
  await saveTeams(teams); res.json(t);
}));
api.delete('/admin/teams/:id', ownerOnly, wrap(async (req, res) => {
  await saveTeams((await getTeams()).filter((x) => x.id !== req.params.id)); res.json({ ok: true });
}));
api.get('/admin/overview', adminOnly, wrap(async (req, res) => {
  const { from, to } = req.query;
  if (!isDay(from) || !isDay(to) || from > to || (Date.parse(to) - Date.parse(from)) / 864e5 > 366) return res.status(400).json({ error: 'Pick a valid period (at most one year).' });
  const users = await db.allUsers();
  const out = [];
  for (const u of users) {
    const d = await sync.dashboard(u.fb_id, from, to);
    const last = (await db.pool.query('SELECT max(synced_at) AS at FROM day_meta WHERE owner=$1', [u.fb_id])).rows[0];
    out.push({
      id: u.fb_id, name: u.name, you: u.fb_id === req.user.fb_id,
      expired: !!(u.token_expires && new Date(u.token_expires) < new Date()),
      lastSync: last && last.at, totals: d.totals,
      clientCount: d.clients.filter((c) => !c.archived).length,
      clients: d.clients.filter((c) => c.spend > 0 || !c.archived).map((c) => ({ id: c.id, name: c.name, type: c.type, lives: c.lives, liveSpend: c.liveSpend, postSpend: c.postSpend, spend: c.spend, days: c.days })),
    });
  }
  out.sort((a, b) => b.totals.spend - a.totals.spend || a.name.localeCompare(b.name));
  const totals = out.reduce((t, u) => ({ spend: t.spend + u.totals.spend, live: t.live + u.totals.live, post: t.post + u.totals.post, lives: t.lives + u.totals.lives, clients: t.clients + u.totals.active, accounts: t.accounts + (u.totals.spend > 0 ? 1 : 0) }), { spend: 0, live: 0, post: 0, lives: 0, clients: 0, accounts: 0 });
  const teams = await getTeams();
  for (const u of out) { const t = teams.find((x) => x.members.includes(u.id)); u.team = t ? t.id : null; }
  // Team and all-account totals count each Meta campaign once (two people can sync the same ad account).
  const teamTotals = {};
  for (const t of teams) {
    const ids = out.filter((u) => u.team === t.id).map((u) => u.id);
    const sum = out.filter((u) => u.team === t.id).reduce((a, u) => a + u.totals.spend, 0);
    teamTotals[t.id] = { ...(await sync.uniqueTotals(ids, from, to)), added: Math.round(sum * 100) / 100 };
  }
  const uniq = await sync.uniqueTotals(out.map((u) => u.id), from, to);
  const allTotals = { ...totals, spend: uniq.spend, live: uniq.live, post: uniq.post, lives: uniq.lives, clients: uniq.clients, added: Math.round(totals.spend * 100) / 100 };
  res.json({ from, to, users: out, totals: allTotals, teams, teamTotals, taxRate: sync.TAX_RATE });
}));
api.get('/blocked', ownerOnly, wrap(async (req, res) => res.json(await db.blockedUsers())));
api.delete('/users/:id', ownerOnly, wrap(async (req, res) => {
  const id = req.params.id;
  if (id === req.user.fb_id) return res.status(400).json({ error: "You can't remove your own account." });
  const u = await db.getUser(id);
  if (!u) return res.status(404).json({ error: 'Account not found.' });
  if (sync.isBusy(id)) return res.status(409).json({ error: `${u.name} is syncing right now. Try again in a minute.` });
  await db.setBlocked(id, u.name, true);
  await db.removeUser(id);
  res.json({ ok: true });
}));
api.delete('/blocked/:id', ownerOnly, wrap(async (req, res) => { await db.setBlocked(req.params.id, '', false); res.json({ ok: true }); }));
api.post('/auto-sync/:id/run', ownerOnly, wrap(async (req, res) => { await jobs.runNow(req.params.id); res.json({ ok: true }); }));

// Clients
const cleanClient = (b) => {
  const c = {};
  if (b.name != null) c.name = String(b.name).trim().slice(0, 120);
  if (b.match != null) c.match = String(b.match).trim().slice(0, 120);
  if (b.type != null) c.type = ['live', 'post', 'both'].includes(b.type) ? b.type : 'live';
  if (b.budget != null) c.budget = Math.max(0, Number(b.budget) || 0);
  if (b.lives != null) c.lives = Math.min(6, Math.max(1, parseInt(b.lives, 10) || 2));
  if (b.account != null) c.account = String(b.account).trim().slice(0, 120);
  if (b.telegram != null) c.telegram = String(b.telegram).trim().slice(0, 40);
  if (b.telegram_title != null) c.telegram_title = String(b.telegram_title).trim().slice(0, 150);
  if (Array.isArray(b.pages)) c.pages = [...new Set(b.pages.map((x) => String(x).trim().slice(0, 150)).filter(Boolean))].slice(0, 20);
  if (b.archived != null) c.archived = !!b.archived;
  return c;
};
api.get('/pages', wrap(async (req, res) => res.json(await db.listPagesSeen(req.user.fb_id))));
api.get('/clients', wrap(async (req, res) => res.json(await db.listClients(req.user.fb_id))));
const groupAllowed = async (fbId, chatId) => !chatId || (await db.getSetting('telegramChats', [])).some((c) => c.id === chatId && (c.owners || [c.owner]).includes(fbId)) || (await db.listClients(fbId)).some((c) => c.telegram === chatId);
api.post('/clients', wrap(async (req, res) => {
  const c = cleanClient(req.body || {});
  if (!c.name) return res.status(400).json({ error: 'Client name is required.' });
  if (!(await groupAllowed(req.user.fb_id, c.telegram))) return res.status(403).json({ error: 'That Telegram group is linked to another account.' });
  const created = await db.createClient(req.user.fb_id, c);
  await sync.rematch(req.user);
  res.json(created);
}));
api.patch('/clients/:id', wrap(async (req, res) => {
  const body = cleanClient(req.body || {});
  if (body.telegram && !(await groupAllowed(req.user.fb_id, body.telegram))) return res.status(403).json({ error: 'That Telegram group is linked to another account.' });
  const c = await db.updateClient(req.user.fb_id, Number(req.params.id), body);
  if (!c) return res.status(404).json({ error: 'Client not found.' });
  // Only changes that affect matching need a re-match (not e.g. the Telegram group).
  if (['name', 'match', 'pages', 'type', 'archived'].some((k) => k in body)) await sync.rematch(req.user);
  res.json(c);
}));
api.delete('/clients/:id', wrap(async (req, res) => { await db.deleteClient(req.user.fb_id, Number(req.params.id)); await sync.rematch(req.user); res.json({ ok: true }); }));

// Days
api.get('/day/:day', wrap(async (req, res) => {
  if (!isDay(req.params.day)) return res.status(400).json({ error: 'Bad date.' });
  res.json(await db.getDay(req.user.fb_id, req.params.day));
}));
function deepMerge(t, s) {
  for (const k of Object.keys(s)) {
    if (s[k] && typeof s[k] === 'object' && !Array.isArray(s[k])) { t[k] = t[k] && typeof t[k] === 'object' ? t[k] : {}; deepMerge(t[k], s[k]); }
    else t[k] = s[k];
  }
  return t;
}
api.patch('/day/:day/:clientId', wrap(async (req, res) => {
  const { day, clientId } = req.params;
  if (!isDay(day)) return res.status(400).json({ error: 'Bad date.' });
  if (!(await db.ownsClient(req.user.fb_id, Number(clientId)))) return res.status(404).json({ error: 'Client not found.' });
  const e = deepMerge(await db.getEntry(day, Number(clientId)), req.body || {});
  await db.putEntry(day, Number(clientId), e);
  res.json(e);
}));
api.post('/sync/:day', wrap(async (req, res) => {
  if (!isDay(req.params.day)) return res.status(400).json({ error: 'Bad date.' });
  res.json(await sync.syncDay(req.params.day, req.user));
}));
// Main sync: the last 30 days (or the month containing ?around= when that's older), in one pass.
// Live progress of each admin's running sync (one at a time per admin; admins don't block each other).
const progressByUser = new Map();
const getProg = (id) => progressByUser.get(id) || { running: false };
api.get('/sync-progress', (req, res) => {
  const p = getProg(req.user.fb_id);
  res.json({ ...p, elapsed: p.startedAt ? Math.round((Date.now() - p.startedAt) / 1000) : 0 });
});
api.post('/sync-recent', wrap(async (req, res) => {
  const me = req.user.fb_id;
  if (getProg(me).running || sync.isBusy(me)) return res.status(409).json({ error: 'A sync is already running for you (another tab or an automatic refresh). Try again in a moment.', busy: true });
  const today = sync.todayIn();
  const from30 = sync.addDays(today, -29);
  const around = isDay(req.body?.around) ? req.body.around : today;
  let from = from30, to = today;
  const rf = req.body?.from, rt = req.body?.to;
  if (isDay(rf) && isDay(rt) && rf <= rt && rf < from30) {
    // Looking at an older period on the Dashboard: sync exactly that period (up to ~3 months at a time).
    from = rf; to = rt > today ? today : rt;
    if ((Date.parse(to) - Date.parse(from)) / 864e5 > 92) from = sync.addDays(to, -92);
  } else if (around < from30) { // looking at an older day: sync that whole month
    from = around.slice(0, 8) + '01';
    const last = new Date(Date.UTC(Number(around.slice(0, 4)), Number(around.slice(5, 7)), 0)).getUTCDate();
    to = around.slice(0, 8) + String(last).padStart(2, '0');
  }
  const startedAt = Date.now();
  progressByUser.set(me, { running: true, phase: 'starting', done: 0, total: 0, account: '', from, to, startedAt });
  let r;
  try {
    r = await sync.exclusive(me, () => sync.syncRange(from, to, req.user, (p) => progressByUser.set(me, { ...getProg(me), ...p })));
    if (!r) return res.status(409).json({ error: 'An automatic refresh is running right now. Try again in a moment.', busy: true });
  }
  finally { progressByUser.set(me, { running: false, lastSeconds: Math.round((Date.now() - startedAt) / 1000) }); }
  res.json({ ...r, from, to });
}));
// Backfill past days, e.g. the whole month: { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' } (max 93 days).
api.post('/sync-range', wrap(async (req, res) => {
  const { from, to } = req.body || {};
  if (!isDay(from) || !isDay(to) || from > to) return res.status(400).json({ error: 'Pick a valid date range.' });
  const today = sync.todayIn();
  const until = to > today ? today : to;
  if ((Date.parse(until) - Date.parse(from)) / 864e5 > 92) return res.status(400).json({ error: 'Sync at most 3 months at a time.' });
  res.json(await sync.syncRange(from, until, req.user));
}));
// Day entries for any range (the dashboard's per-client breakdown).
api.get('/entries', wrap(async (req, res) => {
  const { from, to } = req.query;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '') || from > to) return res.status(400).json({ error: 'Pick a valid date range.' });
  res.json(await db.monthEntries(req.user.fb_id, from, to));
}));
api.get('/month/:ym', wrap(async (req, res) => {
  const m = String(req.params.ym).match(/^(\d{4})-(\d{2})$/);
  if (!m) return res.status(400).json({ error: 'Bad month.' });
  const last = new Date(Number(m[1]), Number(m[2]), 0).getDate();
  res.json(await db.monthEntries(req.user.fb_id, `${m[1]}-${m[2]}-01`, `${m[1]}-${m[2]}-${last}`));
}));

// Result of the last sync's completeness check (per ad account: Meta total vs found)
api.get('/sync-check', wrap(async (req, res) => res.json(await db.getUserSetting(req.user.fb_id, 'lastSyncCheck', null))));

// Dashboard: per-client totals for a day or a month (?from=YYYY-MM-DD&to=YYYY-MM-DD, max 93 days)
// ---- Live videos ----
api.get('/lives', wrap(async (req, res) => {
  const { from, to } = req.query;
  if (!rangeOk(from, to)) return res.status(400).json({ error: 'Pick a valid period (at most one year).' });
  const list = await lives.listLives(req.user.fb_id, from, to);
  const setups = await lives.setupsFor(req.user, list.flatMap((l) => l.campaigns), { fetch: false });
  res.json({ lives: list, setups, saved: await db.getUserSetting(req.user.fb_id, 'liveSetups', []) });
}));
api.post('/lives/setups', wrap(async (req, res) => {
  const camps = (Array.isArray(req.body?.campaigns) ? req.body.campaigns : []).slice(0, 200)
    .filter((c) => c && /^\d+$/.test(String(c.id)) && /^act_\d+$/.test(String(c.accountId))).map((c) => ({ id: String(c.id), accountId: String(c.accountId) }));
  res.json(await lives.setupsFor(req.user, camps));
}));
api.post('/live-setups', wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.setup || typeof b.sig !== 'string') return res.status(400).json({ error: 'Nothing to save.' });
  const list = await db.getUserSetting(req.user.fb_id, 'liveSetups', []);
  if (list.some((x) => x.sig === b.sig)) return res.json(list);
  list.unshift({ id: Date.now().toString(36), name: String(b.name || 'Saved setup').slice(0, 80), sig: b.sig, setup: b.setup, from: b.from || null, savedAt: new Date().toISOString() });
  await db.setUserSetting(req.user.fb_id, 'liveSetups', list.slice(0, 50));
  res.json(list.slice(0, 50));
}));
api.patch('/live-setups/:id', wrap(async (req, res) => {
  const list = await db.getUserSetting(req.user.fb_id, 'liveSetups', []);
  const x = list.find((y) => y.id === req.params.id); if (!x) return res.status(404).json({ error: 'Not found.' });
  if (req.body?.name) x.name = String(req.body.name).slice(0, 80);
  await db.setUserSetting(req.user.fb_id, 'liveSetups', list); res.json(list);
}));
api.delete('/live-setups/:id', wrap(async (req, res) => {
  const list = (await db.getUserSetting(req.user.fb_id, 'liveSetups', [])).filter((x) => x.id !== req.params.id);
  await db.setUserSetting(req.user.fb_id, 'liveSetups', list); res.json(list);
}));

api.get('/dashboard/pages', wrap(async (req, res) => {
  const { from, to } = req.query;
  if (!rangeOk(from, to)) return res.status(400).json({ error: 'Pick a valid date or month.' });
  res.json(await sync.pageSpend(req.user.fb_id, from, to));
}));
// Name a Page that Meta won't name (client Pages you don't manage). Saved for everyone, used by every sync.
api.put('/page-names/:id', wrap(async (req, res) => {
  const id = String(req.params.id), name = String((req.body || {}).name || '').trim().slice(0, 120);
  if (!/^\d{5,25}$/.test(id)) return res.status(400).json({ error: 'Not a Page ID.' });
  const names = await db.getSetting('pageNames', {});
  if (name) names[id] = name; else delete names[id];
  await db.setSetting('pageNames', names);
  if (name) meta.rememberPageNames({ [id]: name }, true);
  res.json({ ok: true });
}));
// Move campaigns between Live and Post for this account ("auto" = let the app decide again).
api.post('/campaign-kind', wrap(async (req, res) => {
  const { ids, kind } = req.body || {};
  const list = (Array.isArray(ids) ? ids : []).map(String).filter((x) => /^\d{1,25}$/.test(x)).slice(0, 200);
  if (!list.length || !['post', 'live', 'auto'].includes(kind)) return res.status(400).json({ error: 'Nothing to move.' });
  const k = await db.getUserSetting(req.user.fb_id, 'kindOverrides', {});
  for (const id of list) { if (kind === 'auto') delete k[id]; else k[id] = kind; }
  await db.setUserSetting(req.user.fb_id, 'kindOverrides', k);
  const r = await sync.exclusive(req.user.fb_id, () => sync.rematch(req.user));
  if (!r) return res.status(409).json({ error: 'A sync is running. Try again in a moment.' });
  res.json({ ok: true });
}));
api.get('/dashboard', wrap(async (req, res) => {
  const { from, to } = req.query;
  if (!isDay(from) || !isDay(to) || from > to) return res.status(400).json({ error: 'Pick a valid date or month.' });
  if ((Date.parse(to) - Date.parse(from)) / 864e5 > 366) return res.status(400).json({ error: 'Pick at most one year.' });
  res.json(await sync.dashboard(req.user.fb_id, from, to));
}));

// Ad accounts
// Today's spend per ad account comes from the campaign rows the last sync saved for today
// (Sync, auto sync every hour / on new campaigns), so it stays current without extra Meta calls.
async function accountsWithToday(owner) {
  const list = await db.listAccounts(owner);
  const day = sync.todayIn();
  const rows = await db.getRaw(owner, day);
  const meta0 = (await db.getDay(owner, day)).meta;
  const byAcct = {};
  for (const r of rows || []) byAcct[r.accountId] = (byAcct[r.accountId] || 0) + (Number(r.spend) || 0);
  for (const a of list) {
    const i = a.info || (a.info = {});
    if (rows && a.enabled) { i.todaySpend = Math.round((byAcct[a.id] || 0) * 100) / 100; i.todayAt = meta0?.synced_at || null; delete i.todayError; }
  }
  return list;
}
api.get('/accounts', wrap(async (req, res) => res.json(await accountsWithToday(req.user.fb_id))));
api.post('/accounts/refresh', wrap(async (req, res) => {
  const me = req.user.fb_id;
  // Pull today's spend for the ticked accounts (updates Home too); unticked ones get a quick total.
  const r = await sync.exclusive(me, () => sync.syncDay(sync.todayIn(), req.user));
  if (r === null) return res.status(409).json({ error: 'A sync is running right now. Try again in a moment.' });
  const enabled = new Set(await db.enabledAccountIds(me));
  const list = (await db.listAccounts(me)).map((row) => ({ ...(row.info || {}), id: row.id, name: row.name }));
  const token = await sync.tokenFor(req.user);
  const day = sync.todayIn();
  for (const a of list) {
    if (enabled.has(a.id)) continue;
    try { a.todaySpend = await meta.accountSpend(token, a.id, day); a.todayAt = new Date().toISOString(); } catch (e) { a.todayError = e.message; if (e.rateLimited) break; }
  }
  await db.saveAccounts(me, list.filter((a) => !enabled.has(a.id)));
  res.json(await accountsWithToday(me));
}));
api.patch('/accounts/:id', wrap(async (req, res) => { await db.setAccountEnabled(req.user.fb_id, req.params.id, req.body?.enabled); res.json({ ok: true }); }));

// Reports
const rangeOk = (from, to) => isDay(from) && isDay(to) && from <= to && (Date.parse(to) - Date.parse(from)) / 864e5 <= 366;
// Telegram groups are private per account: a group belongs to the account whose link code was sent
// in it ("/link CODE"), or to the account that already uses it for one of its clients.
const newCode = () => Array.from({ length: 6 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');
async function linkCode(fbId) {
  let c = await db.getUserSetting(fbId, 'tgCode', null);
  if (!c) { c = newCode(); await db.setUserSetting(fbId, 'tgCode', c); }
  return c;
}
// One refresh at a time, so two requests never handle the same /link message twice.
let chatsBusy = Promise.resolve();
function refreshChats() { const run = chatsBusy.then(refreshChatsNow, refreshChatsNow); chatsBusy = run.catch(() => {}); return run; }
async function refreshChatsNow() {
  const saved = await db.getSetting('telegramChats', []);
  const byId = new Map(saved.map((c) => [c.id, c]));
  let fresh = { chats: [], links: [] };
  try { fresh = await telegram.listChats(); } catch (e) { if (!saved.length) throw e; }
  for (const c of fresh.chats) byId.set(c.id, { ...(byId.get(c.id) || {}), ...c });
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
      if (l.unlink && has) {
        c.owners = c.owners.filter((x) => x !== u.fb_id);
        telegram.send(`👋 ${u.name} is no longer linked to this group in Boost Desk.`, c.id).catch(() => {});
      } else if (!l.unlink && !has) {
        c.owners.push(u.fb_id);
        const others = c.owners.filter((x) => x !== u.fb_id).map((x) => users.find((y) => y.fb_id === x)?.name).filter(Boolean);
        telegram.send(`✅ This group is now linked to ${u.name} in Boost Desk${others.length ? ` (also linked: ${others.join(', ')})` : ''}. Reports for their clients can be sent here.`, c.id).catch(() => {});
      }
    }
  }
  for (const c of byId.values()) c.owner = c.owners[0] || '';
  // Groups with no owner yet: give them to the account whose clients already use them.
  const unowned = [...byId.values()].filter((c) => !c.owner);
  if (unowned.length) {
    const rows = (await db.pool.query("SELECT DISTINCT owner, telegram FROM clients WHERE telegram <> ''")).rows;
    for (const c of unowned) { const users = [...new Set(rows.filter((r) => r.telegram === c.id).map((r) => r.owner))]; if (users.length) { c.owners = users; c.owner = users[0]; } }
  }
  const all = [...byId.values()].sort((a, b) => a.title.localeCompare(b.title));
  await db.setSetting('telegramChats', all);
  return all;
}
async function myChats(fbId) {
  const all = await refreshChats();
  const used = new Set((await db.listClients(fbId)).map((c) => c.telegram).filter(Boolean));
  return all.filter((c) => (c.owners || [c.owner]).includes(fbId) || used.has(c.id)).map(({ id, title, type }) => ({ id, title, type }));
}
api.get('/telegram/chats', wrap(async (req, res) => {
  res.json({ chats: await myChats(req.user.fb_id), code: await linkCode(req.user.fb_id), bot: await telegram.username() });
}));
api.get('/client-report/:id', wrap(async (req, res) => {
  const { from, to } = req.query;
  if (!rangeOk(from, to)) return res.status(400).json({ error: 'Pick a valid date or month.' });
  res.json(await sync.clientReport(req.user.fb_id, req.params.id, from, to));
}));
// The ads picture for a client's report (PNG). 204 = no ads with spend in the period.
const imgCache = new Map(); // short-lived, so the preview and the send use the same picture
async function reportPng(user, id, from, to) {
  const k = `${user.fb_id}|${id}|${from}|${to}`, hit = imgCache.get(k);
  if (hit && Date.now() - hit.at < 5 * 60000) return hit.png;
  const png = await reportImage.clientReportImage(user, id, from, to);
  imgCache.set(k, { png, at: Date.now() });
  for (const [kk, v] of imgCache) if (Date.now() - v.at > 5 * 60000) imgCache.delete(kk);
  return png;
}
api.get('/client-report/:id/image', wrap(async (req, res) => {
  const { from, to } = req.query;
  if (!rangeOk(from, to)) return res.status(400).json({ error: 'Pick a valid date or month.' });
  if (req.query.fresh) imgCache.delete(`${req.user.fb_id}|${req.params.id}|${from}|${to}`);
  const png = await reportPng(req.user, req.params.id, from, to);
  if (!png) return res.status(204).end();
  res.set('content-type', 'image/png').set('cache-control', 'no-store').send(png);
}));
api.post('/client-report/:id/send', wrap(async (req, res) => {
  const { from, to, text, withImage } = req.body || {};
  if (!rangeOk(from, to)) return res.status(400).json({ error: 'Pick a valid date or month.' });
  const r = await sync.clientReport(req.user.fb_id, req.params.id, from, to);
  if (!r.client.telegram) return res.status(400).json({ error: `${r.client.name} has no Telegram group yet. Pick one in the Clients tab.` });
  const body = typeof text === 'string' && text.trim() ? text.slice(0, 12000) : r.text;
  let png = null;
  if (withImage !== false) { try { png = await reportPng(req.user, req.params.id, from, to); } catch (e) { if (e.needsLogin) throw e; console.error('[report image]', e.message); } }
  if (png) await telegram.sendPhoto(png, body, r.client.telegram);
  else await telegram.send(body, r.client.telegram);
  const sentAt = new Date().toISOString();
  // A one-day report is remembered on that day's checklist ("Sent 21:05").
  if (from === to && isDay(from)) {
    const id = Number(req.params.id);
    await db.putEntry(from, id, deepMerge(await db.getEntry(from, id), { reportSent: { at: sentAt, by: req.user.name } }));
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

app.use('/api', api);

// Errors → JSON with a clear message.
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(err);
  if (err instanceof meta.MetaError) {
    return res.status(err.needsLogin ? 401 : 502).json({
      error: err.needsLogin ? 'Your Facebook login has expired. Log in again.' : err.rateLimited ? 'Meta is limiting requests right now. Wait a few minutes and try again.' : 'Meta: ' + err.message,
      needsLogin: err.needsLogin,
    });
  }
  res.status(err.status || 500).json({ error: err.message || 'Something went wrong.' });
});

db.init().then(() => {
  app.listen(cfg.port, () => console.log(`Boost Desk running on ${cfg.baseUrl} (port ${cfg.port})`));
  jobs.start();
  // One time: recount saved days with the newer live/post rule (and keep campaign IDs for "Move to Post/Live").
  (async () => {
    for (const u of await db.allUsers()) {
      if (await db.getUserSetting(u.fb_id, 'kindsV2', false)) continue;
      try { if (!(await sync.exclusive(u.fb_id, () => sync.rematch(u)))) continue; await db.setUserSetting(u.fb_id, 'kindsV2', true); console.log('[startup] recounted live/post for', u.name); }
      catch (e) { console.error('[startup] recount failed for', u.name, e.message); }
    }
  })();
}).catch((e) => { console.error('Database setup failed:', e.message); process.exit(1); });
