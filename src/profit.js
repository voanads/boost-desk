// Profit tab (was the separate "Ads & Profit Tracker" app): the company's monthly ad account
// balances, client balances and profit split. One shared book for the whole company — not per
// workspace. The app owner is always its admin and decides who else can see or edit it:
//   admin  = everything, including split rules and who has access
//   editor = enters monthly data
//   viewer = looks only
// Stored as JSON documents in profit_docs: months/<YYYY-MM> and settings/main.
const express = require('express');
const db = require('./db');

const ROLES = ['admin', 'editor', 'viewer'];
const COLS = new Set(['months', 'settings']);
const VALID_ID = /^[A-Za-z0-9_-]{1,40}$/;
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const q = (text, params) => db.pool.query(text, params);

async function init() {
  await q(`CREATE TABLE IF NOT EXISTS profit_docs (
    col TEXT NOT NULL, id TEXT NOT NULL, data JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (col, id))`);
  await importOld().catch((e) => console.log('[profit] import skipped:', e.message));
}
const put = (col, id, data) => q(`INSERT INTO profit_docs (col, id, data) VALUES ($1,$2,$3)
  ON CONFLICT (col, id) DO UPDATE SET data=$3, updated_at=now()`, [col, id, JSON.stringify(data)]);
const del = (col, id) => q('DELETE FROM profit_docs WHERE col=$1 AND id=$2', [col, id]);
async function state() {
  const out = { months: {}, settings: {} };
  for (const r of (await q('SELECT col, id, data FROM profit_docs')).rows) if (out[r.col]) out[r.col][r.id] = r.data;
  return out;
}

// One time: copy the months and split rules from the old tracker app, only while the Profit tab is
// still empty. TRACKER_URL plus either TRACKER_EXPORT_KEY (its /api/export) or TRACKER_PASSWORD (admin login).
async function importOld() {
  const url = String(process.env.TRACKER_URL || '').trim().replace(/\/+$/, ''), key = process.env.TRACKER_EXPORT_KEY || '', pw = process.env.TRACKER_PASSWORD || '';
  if (!url || !(key || pw)) return;
  if ((await q('SELECT count(*)::int AS n FROM profit_docs')).rows[0].n > 0) return;
  let r;
  if (key) r = await fetch(url + '/api/export', { headers: { 'x-export-key': key } });
  else {
    const login = await fetch(url + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: pw }) });
    if (!login.ok) throw new Error('old tracker login failed (' + login.status + ')');
    r = await fetch(url + '/api/state', { headers: { cookie: (login.headers.get('set-cookie') || '').split(';')[0] } });
  }
  if (!r.ok) throw new Error('old tracker export failed (' + r.status + ')');
  const s = await r.json();
  let n = 0;
  for (const col of COLS) for (const [id, data] of Object.entries(s[col] || {})) if (VALID_ID.test(id)) { await put(col, id, data); n++; }
  console.log(`[profit] copied ${n} documents from the old tracker`);
}

// ---- who can use it ----
const accessMap = async () => (await db.getSetting('profitAccess', {})) || {};
async function roleOf(id) {
  if (!id) return null;
  if ((await db.ownerId()) === id) return 'admin';
  const r = (await accessMap())[id];
  return ROLES.includes(r) ? r : null;
}

// ---- ad accounts for "Fill from Meta": the ones the logged-in person's own Facebook login can open
// (the same list as their Ad accounts tab), with the thresholds their browser extension pushed ----
async function metaAccounts(owner) {
  if (!owner || String(owner).startsWith('g:')) return []; // Google-only people have no ad accounts
  const rows = (await q('SELECT owner, id, name, enabled, info, seen_at FROM ad_accounts WHERE owner = $1', [owner])).rows;
  const ext = (await db.getUserSetting(owner, 'extThresholds', {})) || {};
  const map = new Map();
  for (const r of rows) {
    const i = r.info || {}, a = map.get(r.id) || { id: r.id, name: r.name, statusCode: null, status: '', balance: 0, threshold: null, synced: false, seenAt: null };
    if (!a.seenAt || new Date(r.seen_at) > new Date(a.seenAt)) Object.assign(a, { name: r.name, statusCode: i.statusCode ?? null, status: i.status || '', balance: Number(i.balance) || 0, seenAt: r.seen_at, threshold: i.threshold ?? a.threshold });
    if (a.threshold == null && ext[r.id] && ext[r.id].v != null) a.threshold = ext[r.id].v;
    if (r.enabled) a.synced = true;
    map.set(r.id, a);
  }
  return [...map.values()].sort((x, y) => String(x.name).localeCompare(String(y.name)));
}

function router({ sitePeople }) {
  const r = express.Router();
  // Everything needs a role; req.user is set by the app's login middleware.
  r.use(wrap(async (req, res, next) => {
    req.profitRole = await roleOf(req.user && req.user.fb_id);
    if (!req.profitRole) return res.status(403).json({ error: 'You do not have access to Profit. Ask the app owner.' });
    next();
  }));
  const editor = (req, res, next) => (req.profitRole === 'viewer' ? res.status(403).json({ error: 'Your access to Profit is view only.' }) : next());
  const admin = (req, res, next) => (req.profitRole !== 'admin' ? res.status(403).json({ error: 'Only Profit admins can do this.' }) : next());

  r.get('/state', wrap(async (req, res) => res.json({ ...(await state()), role: req.profitRole })));
  r.put('/:col(months|settings)/:id', editor, wrap(async (req, res) => {
    const { col, id } = req.params;
    if (!COLS.has(col) || !VALID_ID.test(id)) return res.status(400).json({ error: 'Bad path' });
    if (col === 'settings' && req.profitRole !== 'admin') return res.status(403).json({ error: 'Only admins can change the split rules' });
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ error: 'Body must be an object' });
    body._by = req.user.name; body._at = new Date().toISOString();
    await put(col, id, body);
    res.json({ ok: true, _by: body._by, _at: body._at });
  }));
  r.delete('/months/:id', editor, wrap(async (req, res) => {
    if (!VALID_ID.test(req.params.id)) return res.status(400).json({ error: 'Bad path' });
    await del('months', req.params.id); res.json({ ok: true });
  }));
  r.get('/meta-accounts', editor, wrap(async (req, res) => res.json({ accounts: await metaAccounts(req.user.fb_id) })));

  // Access list: every Boost Desk account plus the Google admin-website people.
  r.get('/access', admin, wrap(async (req, res) => {
    const owner = await db.ownerId(), map = await accessMap();
    const people = (await db.allUsers()).map((u) => ({ id: u.fb_id, name: u.name, kind: 'Facebook' }));
    for (const p of await sitePeople()) if (!p.linkTo) people.push({ id: 'g:' + p.email, name: p.name || p.email, kind: 'Google', email: p.email });
    res.json({ people: people.map((p) => ({ ...p, owner: p.id === owner, role: p.id === owner ? 'admin' : (ROLES.includes(map[p.id]) ? map[p.id] : '') })) });
  }));
  r.put('/access/:id', admin, wrap(async (req, res) => {
    const id = String(req.params.id), role = String((req.body || {}).role || '');
    if (id === (await db.ownerId())) return res.status(400).json({ error: 'The app owner is always a Profit admin.' });
    if (role && !ROLES.includes(role)) return res.status(400).json({ error: 'Bad role' });
    const map = await accessMap();
    if (role) map[id] = role; else delete map[id];
    await db.setSetting('profitAccess', map);
    res.json({ ok: true });
  }));
  return r;
}

module.exports = { init, router, roleOf };
