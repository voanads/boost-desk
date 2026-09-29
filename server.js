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
app.get('/auth/facebook', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;
  res.redirect(meta.loginUrl(state));
});

app.get('/auth/facebook/callback', wrap(async (req, res) => {
  const { code, state, error_description } = req.query;
  if (error_description) return res.redirect('/login?error=' + encodeURIComponent(error_description));
  if (!code || !state || state !== req.session.oauthState) return res.redirect('/login?error=' + encodeURIComponent('Login expired. Please try again.'));
  req.session.oauthState = null;
  const { token, expires } = await meta.exchangeCode(String(code));
  const profile = await meta.me(token);
  if (cfg.allowedFbIds.length && !cfg.allowedFbIds.includes(profile.id)) {
    return res.redirect('/login?error=' + encodeURIComponent(`${profile.name} is not on this app's team list. Ask the admin to add Facebook ID ${profile.id}.`));
  }
  await db.upsertUser(profile.id, profile.name, encrypt(token), expires);
  req.session.fbId = profile.id;
  req.session.name = profile.name;
  // First login: load ad accounts and backfill this month so past days aren't empty.
  if (!(await db.listAccounts()).length) {
    const user = await db.getUser(profile.id);
    try { await sync.refreshAccounts(user); } catch (e) { console.error('initial account load failed:', e.message); }
    const today = sync.todayIn();
    sync.syncRange(today.slice(0, 8) + '01', today, user).catch((e) => console.error('initial backfill failed:', e.message));
  }
  res.redirect('/');
}));

app.post('/auth/logout', (req, res) => { req.session = null; res.json({ ok: true }); });

app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
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
    today: sync.todayIn(), tz: cfg.tz,
    telegram: { configured: telegram.configured(), time: cfg.reportTime },
    team: await db.listUsers(),
  });
}));

// Clients
const cleanClient = (b) => {
  const c = {};
  if (b.name != null) c.name = String(b.name).trim().slice(0, 120);
  if (b.match != null) c.match = String(b.match).trim().slice(0, 120);
  if (b.type != null) c.type = ['live', 'post', 'both'].includes(b.type) ? b.type : 'live';
  if (b.budget != null) c.budget = Math.max(0, Number(b.budget) || 0);
  if (b.lives != null) c.lives = Math.min(6, Math.max(1, parseInt(b.lives, 10) || 2));
  if (b.account != null) c.account = String(b.account).trim().slice(0, 120);
  if (Array.isArray(b.pages)) c.pages = [...new Set(b.pages.map((x) => String(x).trim().slice(0, 150)).filter(Boolean))].slice(0, 20);
  if (b.archived != null) c.archived = !!b.archived;
  return c;
};
api.get('/pages', wrap(async (req, res) => res.json(await db.listPagesSeen())));
api.get('/clients', wrap(async (req, res) => res.json(await db.listClients())));
api.post('/clients', wrap(async (req, res) => {
  const c = cleanClient(req.body || {});
  if (!c.name) return res.status(400).json({ error: 'Client name is required.' });
  res.json(await db.createClient(c));
}));
api.patch('/clients/:id', wrap(async (req, res) => {
  const c = await db.updateClient(Number(req.params.id), cleanClient(req.body || {}));
  c ? res.json(c) : res.status(404).json({ error: 'Client not found.' });
}));
api.delete('/clients/:id', wrap(async (req, res) => { await db.deleteClient(Number(req.params.id)); res.json({ ok: true }); }));

// Days
api.get('/day/:day', wrap(async (req, res) => {
  if (!isDay(req.params.day)) return res.status(400).json({ error: 'Bad date.' });
  res.json(await db.getDay(req.params.day));
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
  const e = deepMerge(await db.getEntry(day, Number(clientId)), req.body || {});
  await db.putEntry(day, Number(clientId), e);
  res.json(e);
}));
api.post('/sync/:day', wrap(async (req, res) => {
  if (!isDay(req.params.day)) return res.status(400).json({ error: 'Bad date.' });
  res.json(await sync.syncDay(req.params.day, req.user));
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
  res.json(await db.monthEntries(`${m[1]}-${m[2]}-01`, `${m[1]}-${m[2]}-${last}`));
}));

// Auto sync setting
api.get('/auto-sync', wrap(async (req, res) => res.json(await jobs.getAuto())));
api.put('/auto-sync', wrap(async (req, res) => {
  const cur = await jobs.getAuto();
  const b = req.body || {};
  const next = { ...cur };
  if (b.enabled != null) next.enabled = !!b.enabled;
  if (b.everyMinutes != null) next.everyMinutes = [15, 30, 60, 120, 240].includes(Number(b.everyMinutes)) ? Number(b.everyMinutes) : 60;
  if (b.from != null) next.from = Math.min(23, Math.max(0, parseInt(b.from, 10) || 0));
  if (b.to != null) next.to = Math.min(23, Math.max(0, parseInt(b.to, 10) || 23));
  await db.setSetting('autoSync', next);
  res.json(next);
}));

// Dashboard: per-client totals for a day or a month (?from=YYYY-MM-DD&to=YYYY-MM-DD, max 93 days)
api.get('/dashboard', wrap(async (req, res) => {
  const { from, to } = req.query;
  if (!isDay(from) || !isDay(to) || from > to) return res.status(400).json({ error: 'Pick a valid date or month.' });
  if ((Date.parse(to) - Date.parse(from)) / 864e5 > 92) return res.status(400).json({ error: 'Pick at most 3 months.' });
  res.json(await sync.dashboard(from, to));
}));

// Ad accounts
api.get('/accounts', wrap(async (req, res) => res.json(await db.listAccounts())));
api.post('/accounts/refresh', wrap(async (req, res) => {
  const list = await sync.refreshAccounts(req.user);
  const token = await sync.tokenFor(req.user);
  const day = sync.todayIn();
  for (const a of list) {
    if (![1, 9, 201].includes(a.statusCode)) continue; // only accounts that can spend
    try { a.todaySpend = await meta.accountSpend(token, a.id, day); } catch (e) { a.todayError = e.message; if (e.rateLimited) break; }
  }
  await db.saveAccounts(list);
  res.json(await db.listAccounts());
}));
api.patch('/accounts/:id', wrap(async (req, res) => { await db.setAccountEnabled(req.params.id, req.body?.enabled); res.json({ ok: true }); }));

// Reports
api.get('/report/:day', wrap(async (req, res) => {
  if (!isDay(req.params.day)) return res.status(400).json({ error: 'Bad date.' });
  res.json({ text: await sync.buildReport(req.params.day) });
}));
api.post('/report/:day/send', wrap(async (req, res) => {
  if (!isDay(req.params.day)) return res.status(400).json({ error: 'Bad date.' });
  const text = await sync.buildReport(req.params.day);
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
  res.status(500).json({ error: err.message || 'Something went wrong.' });
});

db.init().then(() => {
  app.listen(cfg.port, () => console.log(`Boost Desk running on ${cfg.baseUrl} (port ${cfg.port})`));
  jobs.start();
}).catch((e) => { console.error('Database setup failed:', e.message); process.exit(1); });
