const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieSession = require('cookie-session');
const cfg = require('./src/config');
const db = require('./src/db');
const meta = require('./src/meta');
const sync = require('./src/sync');
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
api.post('/clients', wrap(async (req, res) => {
  const c = cleanClient(req.body || {});
  if (!c.name) return res.status(400).json({ error: 'Client name is required.' });
  const created = await db.createClient(req.user.fb_id, c);
  await sync.rematch(req.user);
  res.json(created);
}));
api.patch('/clients/:id', wrap(async (req, res) => {
  const body = cleanClient(req.body || {});
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
  if (around < from30) { // looking at an older day: sync that whole month
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
api.get('/month/:ym', wrap(async (req, res) => {
  const m = String(req.params.ym).match(/^(\d{4})-(\d{2})$/);
  if (!m) return res.status(400).json({ error: 'Bad month.' });
  const last = new Date(Number(m[1]), Number(m[2]), 0).getDate();
  res.json(await db.monthEntries(req.user.fb_id, `${m[1]}-${m[2]}-01`, `${m[1]}-${m[2]}-${last}`));
}));

// Result of the last sync's completeness check (per ad account: Meta total vs found)
api.get('/sync-check', wrap(async (req, res) => res.json(await db.getUserSetting(req.user.fb_id, 'lastSyncCheck', null))));

// Dashboard: per-client totals for a day or a month (?from=YYYY-MM-DD&to=YYYY-MM-DD, max 93 days)
api.get('/dashboard', wrap(async (req, res) => {
  const { from, to } = req.query;
  if (!isDay(from) || !isDay(to) || from > to) return res.status(400).json({ error: 'Pick a valid date or month.' });
  if ((Date.parse(to) - Date.parse(from)) / 864e5 > 92) return res.status(400).json({ error: 'Pick at most 3 months.' });
  res.json(await sync.dashboard(req.user.fb_id, from, to));
}));

// Ad accounts
api.get('/accounts', wrap(async (req, res) => res.json(await db.listAccounts(req.user.fb_id))));
api.post('/accounts/refresh', wrap(async (req, res) => {
  const list = await sync.refreshAccounts(req.user);
  const token = await sync.tokenFor(req.user);
  const day = sync.todayIn();
  for (const a of list) {
    if (![1, 9, 201].includes(a.statusCode)) continue; // only accounts that can spend
    try { a.todaySpend = await meta.accountSpend(token, a.id, day); } catch (e) { a.todayError = e.message; if (e.rateLimited) break; }
  }
  await db.saveAccounts(req.user.fb_id, list);
  res.json(await db.listAccounts(req.user.fb_id));
}));
api.patch('/accounts/:id', wrap(async (req, res) => { await db.setAccountEnabled(req.user.fb_id, req.params.id, req.body?.enabled); res.json({ ok: true }); }));

// Reports
const rangeOk = (from, to) => isDay(from) && isDay(to) && from <= to && (Date.parse(to) - Date.parse(from)) / 864e5 <= 92;
api.get('/telegram/chats', wrap(async (req, res) => {
  const saved = await db.getSetting('telegramChats', []);
  const byId = new Map(saved.map((c) => [c.id, c]));
  for (const c of await telegram.listChats()) byId.set(c.id, c);
  const all = [...byId.values()].sort((a, b) => a.title.localeCompare(b.title));
  await db.setSetting('telegramChats', all);
  res.json(all);
}));
api.get('/client-report/:id', wrap(async (req, res) => {
  const { from, to } = req.query;
  if (!rangeOk(from, to)) return res.status(400).json({ error: 'Pick a valid date or month.' });
  res.json(await sync.clientReport(req.user.fb_id, req.params.id, from, to));
}));
api.post('/client-report/:id/send', wrap(async (req, res) => {
  const { from, to, text } = req.body || {};
  if (!rangeOk(from, to)) return res.status(400).json({ error: 'Pick a valid date or month.' });
  const r = await sync.clientReport(req.user.fb_id, req.params.id, from, to);
  if (!r.client.telegram) return res.status(400).json({ error: `${r.client.name} has no Telegram group yet. Pick one in the Clients tab.` });
  await telegram.send(typeof text === 'string' && text.trim() ? text.slice(0, 12000) : r.text, r.client.telegram);
  res.json({ ok: true, sentTo: r.client.telegramTitle || r.client.telegram });
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
}).catch((e) => { console.error('Database setup failed:', e.message); process.exit(1); });
