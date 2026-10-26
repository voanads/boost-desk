// Profit tab (was the separate "Ads & Profit Tracker" app): monthly ad account balances, client
// balances and profit split.
// Every person has their own Profit book (months), like their own Boost Desk workspace. Profit admins
// (the app owner, plus anyone set to admin on the Access page) can switch to anyone's book to look at
// it, and they alone change the split rules and the people list, which are shared by every book.
// Access per person (setting profitAccess): 'admin' | 'none' | 'member' (own book). Facebook accounts
// are members by default; Google-only admin-website people need to be made admins.
// Stored in profit_docs: (book, 'months', 'YYYY-MM') per person and ('', 'settings', 'main') shared.
const express = require('express');
const db = require('./db');

const ACCESS = ['admin', 'member', 'none'];
const VALID_ID = /^[A-Za-z0-9_-]{1,40}$/;
const VALID_BOOK = /^(g:)?[A-Za-z0-9_.@+-]{1,120}$/;
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const q = (text, params) => db.pool.query(text, params);

async function init() {
  await q(`CREATE TABLE IF NOT EXISTS profit_docs (
    col TEXT NOT NULL, id TEXT NOT NULL, data JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (col, id))`);
  // One book per person: add the book column and make it part of the key.
  await q("ALTER TABLE profit_docs ADD COLUMN IF NOT EXISTS book TEXT NOT NULL DEFAULT ''");
  const pk = (await q(`SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum = ANY(i.indkey)
                       WHERE i.indrelid='profit_docs'::regclass AND i.indisprimary`)).rows.map((r) => r.attname);
  if (!pk.includes('book')) { await q('ALTER TABLE profit_docs DROP CONSTRAINT IF EXISTS profit_docs_pkey'); await q('ALTER TABLE profit_docs ADD PRIMARY KEY (book, col, id)'); }
  await importOld().catch((e) => console.log('[profit] import skipped:', e.message));
  await claimShared();
}
// Months made before books existed belong to the app owner's book.
async function claimShared() {
  const owner = await db.ownerId(); if (!owner) return;
  const r = await q("UPDATE profit_docs SET book=$1 WHERE book='' AND col='months' AND NOT EXISTS (SELECT 1 FROM profit_docs d WHERE d.book=$1 AND d.col='months' AND d.id=profit_docs.id)", [owner]);
  if (r.rowCount) console.log(`[profit] moved ${r.rowCount} months into the owner's book`);
}
const put = (book, col, id, data) => q(`INSERT INTO profit_docs (book, col, id, data) VALUES ($1,$2,$3,$4)
  ON CONFLICT (book, col, id) DO UPDATE SET data=$4, updated_at=now()`, [book, col, id, JSON.stringify(data)]);
const del = (book, col, id) => q('DELETE FROM profit_docs WHERE book=$1 AND col=$2 AND id=$3', [book, col, id]);
const getDoc = async (book, col, id) => ((await q('SELECT data FROM profit_docs WHERE book=$1 AND col=$2 AND id=$3', [book, col, id])).rows[0] || {}).data || null;
const LOCKED = 'This month was submitted, so it can’t be changed. Ask a Profit admin to unlock it.';
async function state(book) {
  await claimShared();
  const out = { months: {}, settings: {} };
  for (const r of (await q("SELECT col, id, data FROM profit_docs WHERE (book=$1 AND col='months') OR (book='' AND col='settings')", [book])).rows) out[r.col][r.id] = r.data;
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
  for (const col of ['months', 'settings']) for (const [id, data] of Object.entries(s[col] || {})) if (VALID_ID.test(id)) { await put('', col, id, data); n++; }
  console.log(`[profit] copied ${n} documents from the old tracker`);
}

// ---- who can use it ----
const accessMap = async () => (await db.getSetting('profitAccess', {})) || {};
// 'admin' | 'member' | null (no access). Old 'editor' / 'viewer' entries count as members.
async function roleOf(id) {
  if (!id) return null;
  if ((await db.ownerId()) === id) return 'admin';
  const r = (await accessMap())[id];
  if (r === 'admin') return 'admin';
  if (r === 'none') return null;
  if (String(id).startsWith('g:')) return r === 'member' || r === 'editor' || r === 'viewer' ? 'member' : null;
  return 'member';
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

let peopleFn = null; // set by router(), used by the admin Profit overview
function router({ sitePeople }) {
  const r = express.Router();
  // Everything needs access; req.user is set by the app's login middleware.
  r.use(wrap(async (req, res, next) => {
    req.profitRole = await roleOf(req.user && req.user.fb_id);
    if (!req.profitRole) return res.status(403).json({ error: 'You do not have access to Profit. Ask the app owner.' });
    next();
  }));
  const admin = (req, res, next) => (req.profitRole !== 'admin' ? res.status(403).json({ error: 'Only Profit admins can do this.' }) : next());
  const me = (req) => req.user.fb_id;

  // Everyone who has (or could have) a book, for the admins' book picker.
  async function people() {
    const map = await accessMap(), owner = await db.ownerId();
    const list = (await db.allUsers()).map((u) => ({ id: u.fb_id, name: u.name, kind: 'Facebook' }));
    for (const p of await sitePeople()) if (!p.linkTo) list.push({ id: 'g:' + p.email, name: p.name || p.email, kind: 'Google', email: p.email });
    const counts = Object.fromEntries((await q("SELECT book, count(*)::int AS n FROM profit_docs WHERE col='months' GROUP BY book")).rows.map((x) => [x.book, x.n]));
    return list.map((p) => {
      const raw = map[p.id], access = p.id === owner ? 'admin' : raw === 'admin' ? 'admin' : raw === 'none' ? 'none' : p.kind === 'Google' && !['member', 'editor', 'viewer'].includes(raw) ? 'none' : 'member';
      return { ...p, owner: p.id === owner, access, months: counts[p.id] || 0 };
    });
  }

  peopleFn = people;
  // ?book=<id> lets admins look at someone else's book (read only).
  r.get('/state', wrap(async (req, res) => {
    let book = String(req.query.book || me(req));
    if (!VALID_BOOK.test(book)) return res.status(400).json({ error: 'Bad book' });
    if (book !== me(req) && req.profitRole !== 'admin') return res.status(403).json({ error: 'You can only see your own Profit book.' });
    const out = { ...(await state(book)), role: req.profitRole, book, mine: book === me(req), me: me(req) };
    if (req.profitRole === 'admin') out.books = (await people()).filter((p) => p.access !== 'none' || p.months);
    // How many deals use each service type, across every book (so a used one can't be removed).
    out.serviceUse = Object.fromEntries((await q("SELECT t->>'service' AS s, count(*)::int AS n FROM profit_docs, jsonb_array_elements(CASE WHEN jsonb_typeof(data->'transactions')='array' THEN data->'transactions' ELSE '[]'::jsonb END) t WHERE col='months' GROUP BY 1")).rows.map((x) => [x.s, x.n]));
    res.json(out);
  }));
  // Writes always go to your own book; split rules and the people list are admins only.
  r.put('/:col(months|settings)/:id', wrap(async (req, res) => {
    const { col, id } = req.params;
    if (!VALID_ID.test(id)) return res.status(400).json({ error: 'Bad path' });
    if (col === 'settings' && req.profitRole !== 'admin') return res.status(403).json({ error: 'Only admins can change the split rules' });
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ error: 'Body must be an object' });
    if (col === 'months') { // a submitted month is locked; "submitted" is only set by /submit
      const cur = await getDoc(me(req), 'months', id);
      if (cur && cur.submitted) return res.status(423).json({ error: LOCKED, locked: true });
      delete body.submitted;
    }
    body._by = req.user.name; body._at = new Date().toISOString();
    await put(col === 'settings' ? '' : me(req), col, id, body);
    res.json({ ok: true, _by: body._by, _at: body._at });
  }));
  r.delete('/months/:id', wrap(async (req, res) => {
    if (!VALID_ID.test(req.params.id)) return res.status(400).json({ error: 'Bad path' });
    const cur = await getDoc(me(req), 'months', req.params.id);
    if (cur && cur.submitted) return res.status(423).json({ error: LOCKED, locked: true });
    await del(me(req), 'months', req.params.id); res.json({ ok: true });
  }));
  // Submit: lock your own month. Unlock: Profit admins, on anyone's book (?book=).
  r.post('/months/:id/submit', wrap(async (req, res) => {
    const cur = VALID_ID.test(req.params.id) && await getDoc(me(req), 'months', req.params.id);
    if (!cur) return res.status(404).json({ error: 'Save the month first.' });
    if (cur.submitted) return res.json({ ok: true, submitted: cur.submitted });
    cur.submitted = { by: req.user.name, at: new Date().toISOString() };
    await put(me(req), 'months', req.params.id, cur);
    res.json({ ok: true, submitted: cur.submitted });
  }));
  r.post('/months/:id/unlock', admin, wrap(async (req, res) => {
    const book = String(req.query.book || me(req));
    if (!VALID_BOOK.test(book) || !VALID_ID.test(req.params.id)) return res.status(400).json({ error: 'Bad path' });
    const cur = await getDoc(book, 'months', req.params.id);
    if (!cur) return res.status(404).json({ error: 'Month not found.' });
    delete cur.submitted; cur.unlockedBy = req.user.name; cur.unlockedAt = new Date().toISOString();
    await put(book, 'months', req.params.id, cur);
    res.json({ ok: true });
  }));
  r.get('/meta-accounts', wrap(async (req, res) => res.json({ accounts: await metaAccounts(me(req)) })));

  // Rename a service type in every person's deals (split rules are shared by all books).
  r.post('/rename-service', admin, wrap(async (req, res) => {
    const from = String((req.body || {}).from || ''), to = String((req.body || {}).to || '').trim().slice(0, 60);
    if (!from || !to) return res.status(400).json({ error: 'Give the old and new name.' });
    let n = 0;
    for (const row of (await q("SELECT book, id, data FROM profit_docs WHERE col='months'")).rows) {
      const tx = Array.isArray(row.data.transactions) ? row.data.transactions : [];
      if (!tx.some((t) => t && t.service === from)) continue;
      tx.forEach((t) => { if (t && t.service === from) t.service = to; });
      await put(row.book, 'months', row.id, row.data); n++;
    }
    res.json({ ok: true, months: n });
  }));
  r.get('/access', admin, wrap(async (req, res) => res.json({ people: await people() })));
  r.put('/access/:id', admin, wrap(async (req, res) => {
    const id = String(req.params.id), access = String((req.body || {}).access || '');
    if (id === (await db.ownerId())) return res.status(400).json({ error: 'The app owner is always a Profit admin.' });
    if (!ACCESS.includes(access)) return res.status(400).json({ error: 'Bad access' });
    const map = await accessMap();
    map[id] = access;
    await db.setSetting('profitAccess', map);
    res.json({ ok: true });
  }));
  return r;
}

module.exports = { init, router, roleOf, people: (...a) => peopleFn(...a) };
