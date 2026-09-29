// Postgres access. Tables are created on startup.
// Every admin (Facebook login) has their own workspace: clients, ad accounts, synced days and
// settings all carry an `owner` (the admin's Facebook ID) and are only ever read for that owner.
const { Pool, types } = require('pg');
const cfg = require('./config');

types.setTypeParser(1082, (v) => v); // keep DATE as 'YYYY-MM-DD' strings (no timezone shifts)

const pool = new Pool({ connectionString: cfg.databaseUrl, ssl: cfg.pgSsl ? { rejectUnauthorized: false } : false });
const q = (text, params) => pool.query(text, params);

async function init() {
  await q(`
    CREATE TABLE IF NOT EXISTS users (
      fb_id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      token_enc TEXT NOT NULL,
      token_expires TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS clients (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      match TEXT NOT NULL DEFAULT '',             -- (legacy) single alternate name
      pages JSONB NOT NULL DEFAULT '[]',          -- Facebook Page names / IDs this client owns
      type TEXT NOT NULL DEFAULT 'live',          -- live | post | both
      budget NUMERIC(12,2) NOT NULL DEFAULT 0,    -- (unused)
      lives INT NOT NULL DEFAULT 2,               -- (unused)
      account TEXT NOT NULL DEFAULT '',           -- (unused) ad account fallback
      archived BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS ad_accounts (
      id TEXT NOT NULL,                           -- act_123
      name TEXT NOT NULL DEFAULT '',
      enabled BOOLEAN NOT NULL DEFAULT true,      -- included in spend sync
      info JSONB NOT NULL DEFAULT '{}',           -- last snapshot (status, balance, …)
      seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS day_entries (
      day DATE NOT NULL,
      client_id INT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      data JSONB NOT NULL DEFAULT '{}',
      PRIMARY KEY (day, client_id)
    );
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS pages JSONB NOT NULL DEFAULT '[]';
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS telegram TEXT NOT NULL DEFAULT '';          -- client's own Telegram group chat id
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS telegram_title TEXT NOT NULL DEFAULT '';
    CREATE TABLE IF NOT EXISTS pages_seen (
      name TEXT NOT NULL,                         -- Facebook Page names seen in synced campaigns
      last_seen DATE NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS day_meta (
      day DATE NOT NULL,
      synced_at TIMESTAMPTZ,
      synced_by TEXT,
      unmatched JSONB NOT NULL DEFAULT '[]'
    );
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS owner TEXT NOT NULL DEFAULT '';
    ALTER TABLE ad_accounts ADD COLUMN IF NOT EXISTS owner TEXT NOT NULL DEFAULT '';
    ALTER TABLE day_meta ADD COLUMN IF NOT EXISTS owner TEXT NOT NULL DEFAULT '';
    ALTER TABLE pages_seen ADD COLUMN IF NOT EXISTS owner TEXT NOT NULL DEFAULT '';
    CREATE INDEX IF NOT EXISTS clients_owner_idx ON clients (owner);
    CREATE TABLE IF NOT EXISTS raw_rows (           -- every campaign row a sync downloaded, matched or not
      owner TEXT NOT NULL,
      day DATE NOT NULL,
      rows JSONB NOT NULL DEFAULT '[]',
      PRIMARY KEY (owner, day)
    );
  `);
  await migrateToWorkspaces();
}

// One-time move from the shared setup to per-admin workspaces: everything that existed before
// belongs to the admin who had been using the app (the one who synced it).
async function migrateToWorkspaces() {
  const legacy = (await q(`SELECT
      (SELECT count(*) FROM clients WHERE owner='')::int +
      (SELECT count(*) FROM ad_accounts WHERE owner='')::int +
      (SELECT count(*) FROM day_meta WHERE owner='')::int +
      (SELECT count(*) FROM pages_seen WHERE owner='')::int AS n`)).rows[0].n;
  if (legacy > 0) {
    const users = (await q('SELECT fb_id, name FROM users ORDER BY updated_at ASC')).rows;
    const syncer = (await q(`SELECT synced_by, count(*) AS n FROM day_meta WHERE owner='' AND synced_by IS NOT NULL GROUP BY synced_by ORDER BY n DESC LIMIT 1`)).rows[0];
    const owner = (syncer && users.find((u) => u.name === syncer.synced_by)) || users[0];
    if (owner) {
      for (const t of ['clients', 'ad_accounts', 'day_meta', 'pages_seen']) await q(`UPDATE ${t} SET owner=$1 WHERE owner=''`, [owner.fb_id]);
      for (const key of ['pageOwners', 'lastSyncCheck']) {
        const r = (await q('SELECT value FROM settings WHERE key=$1', [key])).rows[0];
        if (r) {
          await q(`INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING`, [`${owner.fb_id}:${key}`, JSON.stringify(r.value)]);
          await q('DELETE FROM settings WHERE key=$1', [key]);
        }
      }
      console.log(`[db] existing data moved into ${owner.name}'s workspace`);
    }
  }
  // Primary keys that include the owner (so two admins can both have act_123 or the same day).
  const keys = { ad_accounts: ['owner', 'id'], day_meta: ['owner', 'day'], pages_seen: ['owner', 'name'] };
  for (const [table, cols] of Object.entries(keys)) {
    const cur = (await q(`SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum = ANY(i.indkey)
                          WHERE i.indrelid=$1::regclass AND i.indisprimary`, [table])).rows.map((r) => r.attname);
    if (cur.length !== cols.length || !cols.every((c) => cur.includes(c))) {
      await q(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${table}_pkey`);
      await q(`ALTER TABLE ${table} ADD PRIMARY KEY (${cols.join(', ')})`);
    }
  }
}

// ---- users ----
const upsertUser = (fbId, name, tokenEnc, expires) =>
  q(`INSERT INTO users (fb_id, name, token_enc, token_expires, updated_at) VALUES ($1,$2,$3,$4,now())
     ON CONFLICT (fb_id) DO UPDATE SET name=$2, token_enc=$3, token_expires=$4, updated_at=now()`, [fbId, name, tokenEnc, expires]);
const getUser = async (fbId) => (await q('SELECT * FROM users WHERE fb_id=$1', [fbId])).rows[0] || null;
// Admins whose login is still valid — scheduled jobs run once per admin, each on their own data.
const activeUsers = async () =>
  (await q(`SELECT * FROM users WHERE token_expires IS NULL OR token_expires > now() ORDER BY updated_at DESC`)).rows;

// ---- clients ----
const clientRow = (r) => ({ ...r, budget: Number(r.budget), pages: Array.isArray(r.pages) ? r.pages : [] });
const listClients = async (owner) => (await q('SELECT * FROM clients WHERE owner=$1 ORDER BY archived, lower(name)', [owner])).rows.map(clientRow);
async function createClient(owner, c) {
  const r = await q(`INSERT INTO clients (owner, name, match, pages, type, telegram, telegram_title) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [owner, c.name, c.match || '', JSON.stringify(c.pages || []), c.type || 'live', c.telegram || '', c.telegram_title || '']);
  return clientRow(r.rows[0]);
}
async function updateClient(owner, id, c) {
  const allowed = ['name', 'match', 'pages', 'type', 'archived', 'telegram', 'telegram_title'];
  const keys = Object.keys(c).filter((k) => allowed.includes(k));
  if (!keys.length) return null;
  const sets = keys.map((k, i) => `${k}=$${i + 3}`).join(', ');
  const r = await q(`UPDATE clients SET ${sets} WHERE id=$1 AND owner=$2 RETURNING *`, [id, owner, ...keys.map((k) => (k === 'pages' ? JSON.stringify(c[k]) : c[k]))]);
  return r.rows[0] ? clientRow(r.rows[0]) : null;
}
const deleteClient = (owner, id) => q('DELETE FROM clients WHERE id=$1 AND owner=$2', [id, owner]);
const ownsClient = async (owner, id) => (await q('SELECT 1 FROM clients WHERE id=$1 AND owner=$2', [id, owner])).rowCount > 0;

// ---- ad accounts ----
async function saveAccounts(owner, list) {
  for (const a of list) {
    await q(`INSERT INTO ad_accounts (owner, id, name, info, seen_at) VALUES ($1,$2,$3,$4,now())
             ON CONFLICT (owner, id) DO UPDATE SET name=$3, info=$4, seen_at=now()`, [owner, a.id, a.name, a]);
  }
}
const listAccounts = async (owner) => (await q('SELECT * FROM ad_accounts WHERE owner=$1 ORDER BY enabled DESC, lower(name)', [owner])).rows;
const setAccountEnabled = (owner, id, enabled) => q('UPDATE ad_accounts SET enabled=$3 WHERE owner=$1 AND id=$2', [owner, id, !!enabled]);
const enabledAccountIds = async (owner) => (await q('SELECT id FROM ad_accounts WHERE owner=$1 AND enabled', [owner])).rows.map((r) => r.id);

// ---- Facebook Pages seen in campaigns (for the "add Page" picker) ----
async function notePages(owner, names, day) {
  for (const n of new Set(names.filter(Boolean))) {
    await q(`INSERT INTO pages_seen (owner, name, last_seen) VALUES ($1,$2,$3)
             ON CONFLICT (owner, name) DO UPDATE SET last_seen=GREATEST(pages_seen.last_seen, $3)`, [owner, n, day]);
  }
}
const listPagesSeen = async (owner) =>
  (await q(`SELECT name, to_char(last_seen,'YYYY-MM-DD') AS last_seen FROM pages_seen WHERE owner=$1 ORDER BY last_seen DESC, name`, [owner])).rows;

// ---- settings (global) and per-admin settings ----
async function getSetting(key, fallback) {
  const r = (await q('SELECT value FROM settings WHERE key=$1', [key])).rows[0];
  return r ? r.value : fallback;
}
const setSetting = (key, value) =>
  q(`INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2`, [key, JSON.stringify(value)]);
const getUserSetting = (owner, key, fallback) => getSetting(`${owner}:${key}`, fallback);
const setUserSetting = (owner, key, value) => setSetting(`${owner}:${key}`, value);

// ---- days (always through the owner's clients) ----
async function getDay(owner, day) {
  const rows = (await q(`SELECT e.client_id, e.data FROM day_entries e JOIN clients c ON c.id=e.client_id
                         WHERE e.day=$1 AND c.owner=$2`, [day, owner])).rows;
  const meta = (await q('SELECT * FROM day_meta WHERE day=$1 AND owner=$2', [day, owner])).rows[0] || null;
  const entries = {};
  for (const r of rows) entries[r.client_id] = r.data;
  return { day, entries, meta };
}
// Callers must have checked the client belongs to the admin (ownsClient) or got it from listClients(owner).
async function getEntry(day, clientId) {
  return (await q('SELECT data FROM day_entries WHERE day=$1 AND client_id=$2', [day, clientId])).rows[0]?.data || {};
}
const putEntry = (day, clientId, data) =>
  q(`INSERT INTO day_entries (day, client_id, data) VALUES ($1,$2,$3)
     ON CONFLICT (day, client_id) DO UPDATE SET data=$3`, [day, clientId, data]);
const putDayMeta = (owner, day, syncedBy, unmatched) =>
  q(`INSERT INTO day_meta (owner, day, synced_at, synced_by, unmatched) VALUES ($1, $2, now(), $3, $4)
     ON CONFLICT (owner, day) DO UPDATE SET synced_at=now(), synced_by=$3, unmatched=$4`, [owner, day, syncedBy, JSON.stringify(unmatched)]);
// Saved campaign rows, so matching can be re-run when clients change (no Meta call needed).
const getRaw = async (owner, day) => (await q('SELECT rows FROM raw_rows WHERE owner=$1 AND day=$2', [owner, day])).rows[0]?.rows || null;
const putRaw = (owner, day, rows) =>
  q(`INSERT INTO raw_rows (owner, day, rows) VALUES ($1,$2,$3) ON CONFLICT (owner, day) DO UPDATE SET rows=$3`, [owner, day, JSON.stringify(rows)]);
const listRaw = async (owner, from = '2000-01-01', to = '2999-12-31') =>
  (await q(`SELECT to_char(day,'YYYY-MM-DD') AS day, rows FROM raw_rows WHERE owner=$1 AND day BETWEEN $2 AND $3 ORDER BY day`, [owner, from, to])).rows;
const setDayUnmatched = (owner, day, unmatched) =>
  q(`UPDATE day_meta SET unmatched=$3 WHERE owner=$1 AND day=$2`, [owner, day, JSON.stringify(unmatched)]);
const monthEntries = async (owner, from, to) =>
  (await q(`SELECT to_char(e.day,'YYYY-MM-DD') AS day, e.client_id, e.data FROM day_entries e JOIN clients c ON c.id=e.client_id
            WHERE c.owner=$1 AND e.day BETWEEN $2 AND $3`, [owner, from, to])).rows;

module.exports = {
  pool, init,
  upsertUser, getUser, activeUsers,
  listClients, createClient, updateClient, deleteClient, ownsClient,
  notePages, listPagesSeen, getSetting, setSetting, getUserSetting, setUserSetting,
  saveAccounts, listAccounts, setAccountEnabled, enabledAccountIds,
  getDay, getEntry, putEntry, putDayMeta, monthEntries, getRaw, putRaw, listRaw, setDayUnmatched,
};
