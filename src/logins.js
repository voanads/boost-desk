// Username + password logins. A login is a key to a workspace that already exists the Facebook way:
//   pm  → fbId  = the Facebook account whose workspace this person works in (set by the owner, or by "Connect Facebook" on first login)
//   mb  → mbId  = the media buyer entry (they work inside their PM's workspace, as with the Telegram link)
// Stored in the settings table under login:<username> — no schema change. Passwords are salted scrypt hashes.
const crypto = require('crypto');
const db = require('./db');

const KEY = (u) => 'login:' + u;
const norm = (u) => String(u || '').trim().toLowerCase();
const USER_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const MAX_FAILS = 5, LOCK_MS = 15 * 60e3, MIN_LEN = 8;
const hash = (pw, salt) => crypto.scryptSync(String(pw), salt, 64).toString('hex');
const tempPassword = () => { const A = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s = ''; for (const b of crypto.randomBytes(10)) s += A[b % A.length]; return s; };
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

const get = async (u) => { u = norm(u); return u ? await db.getSetting(KEY(u), null) : null; };
const save = (rec) => db.setSetting(KEY(rec.username), rec);
const list = async () => (await db.pool.query(`SELECT value FROM settings WHERE key LIKE 'login:%'`)).rows.map((r) => r.value).filter((v) => v && v.username).sort((a, b) => a.username.localeCompare(b.username));
const pub = (r) => r && ({ username: r.username, name: r.name || '', role: r.role, fbId: r.fbId || '', mbId: r.mbId || '', must: !!r.must, createdAt: r.createdAt, createdBy: r.createdBy || '', lastLogin: r.lastLogin || null, locked: !!(r.lockedUntil && r.lockedUntil > Date.now()) });
const checkPassword = (pw) => { if (String(pw || '').length < MIN_LEN) throw bad(`Use at least ${MIN_LEN} characters for the password.`); if (String(pw).length > 200) throw bad('That password is too long.'); };

async function create({ username, name = '', role = 'pm', fbId = '', mbId = '', by = '', password = null }) {
  const u = norm(username);
  if (!USER_RE.test(u)) throw bad('Username: 3–32 characters — letters, numbers, dot, dash or underscore.');
  if (await get(u)) throw bad(`The username "${u}" is taken. Pick another.`);
  if (!['pm', 'mb'].includes(role)) throw bad('Pick a role.');
  if (role === 'mb' && !mbId) throw bad('Pick the media buyer.');
  const all = await list();
  if (fbId && all.some((x) => x.fbId === fbId)) throw bad('That workspace already has a username.');
  if (mbId && all.some((x) => x.mbId === mbId)) throw bad('That media buyer already has a username.');
  const own = password != null; if (own) checkPassword(password);
  const pw = own ? String(password) : tempPassword(), salt = crypto.randomBytes(16).toString('hex');
  const rec = { username: u, name: String(name || '').trim().slice(0, 80), role, fbId: String(fbId || ''), mbId: String(mbId || ''), salt, hash: hash(pw, salt), must: !own, createdAt: new Date().toISOString(), createdBy: by, fails: 0 };
  await save(rec);
  return { login: pub(rec), password: own ? null : pw };
}
// Right username + password → the record. Five wrong tries lock the username for 15 minutes.
async function verify(username, password) {
  const rec = await get(username), wrong = () => bad('Wrong username or password.', 401);
  if (!rec) { hash(String(password || ''), 'x'.repeat(32)); throw wrong(); } // same work either way
  if (rec.lockedUntil && rec.lockedUntil > Date.now()) throw bad(`Too many wrong tries. Try again in ${Math.ceil((rec.lockedUntil - Date.now()) / 60e3)} minutes, or ask for a new password.`, 429);
  const ok = crypto.timingSafeEqual(Buffer.from(hash(String(password || ''), rec.salt), 'hex'), Buffer.from(rec.hash, 'hex'));
  if (!ok) { rec.fails = (rec.fails || 0) + 1; if (rec.fails >= MAX_FAILS) { rec.lockedUntil = Date.now() + LOCK_MS; rec.fails = 0; } await save(rec); throw wrong(); }
  rec.fails = 0; rec.lockedUntil = null; rec.lastLogin = new Date().toISOString(); await save(rec);
  return rec;
}
async function setPassword(username, pw, { must = false } = {}) {
  const rec = await get(username); if (!rec) throw bad('No such username.', 404);
  checkPassword(pw); rec.salt = crypto.randomBytes(16).toString('hex'); rec.hash = hash(pw, rec.salt); rec.must = must; rec.fails = 0; rec.lockedUntil = null;
  await save(rec); return pub(rec);
}
async function reset(username) { const pw = tempPassword(); return { login: await setPassword(username, pw, { must: true }), password: pw }; }
async function remove(username) { const u = norm(username); if (!(await get(u))) throw bad('No such username.', 404); await db.pool.query('DELETE FROM settings WHERE key=$1', [KEY(u)]); }
const forFb = async (fbId) => (fbId ? (await list()).find((x) => x.fbId === String(fbId)) || null : null);
const forMb = async (mbId) => (mbId ? (await list()).find((x) => x.mbId === String(mbId)) || null : null);

module.exports = { get, save, list, pub, create, verify, setPassword, reset, remove, forFb, forMb, norm, MIN_LEN };
