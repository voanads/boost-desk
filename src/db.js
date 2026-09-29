// Postgres access. Tables are created on startup.
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
      pages JSONB NOT NULL DEFAULT '[]',          -- Facebook Page names this client owns
      type TEXT NOT NULL DEFAULT 'live',          -- live | post | both
      budget NUMERIC(12,2) NOT NULL DEFAULT 0,    -- USD per day
      lives INT NOT NULL DEFAULT 2,               -- usual lives per day
      account TEXT NOT NULL DEFAULT '',           -- ad account id or name for auto-named "Post:" boosts
      archived BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS ad_accounts (
      id TEXT PRIMARY KEY,                        -- act_123
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
      name TEXT PRIMARY KEY,                      -- Facebook Page names seen in synced campaigns
      last_seen DATE NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS day_meta (
      day DATE PRIMARY KEY,
      synced_at TIMESTAMPTZ,
      synced_by TEXT,
      unmatched JSONB NOT NULL DEFAULT '[]'
    );
  `);
}

// ---- users ----
const upsertUser = (fbId, name, tokenEnc, expires) =>
  q(`INSERT INTO users (fb_id, name, token_enc, token_expires, updated_at) VALUES ($1,$2,$3,$4,now())
     ON CONFLICT (fb_id) DO UPDATE SET name=$2, token_enc=$3, token_expires=$4, updated_at=now()`, [fbId, name, tokenEnc, expires]);
const getUser = async (fbId) => (await q('SELECT * FROM users WHERE fb_id=$1', [fbId])).rows[0] || null;
// Newest valid token — used by scheduled jobs.
const latestUser = async () =>
  (await q(`SELECT * FROM users WHERE token_expires IS NULL OR token_expires > now() ORDER BY updated_at DESC LIMIT 1`)).rows[0] || null;
const listUsers = async () => (await q('SELECT fb_id, name, token_expires, updated_at FROM users ORDER BY updated_at DESC')).rows;

// ---- clients ----
const clientRow = (r) => ({ ...r, budget: Number(r.budget), pages: Array.isArray(r.pages) ? r.pages : [] });
const listClients = async () => (await q('SELECT * FROM clients ORDER BY archived, lower(name)')).rows.map(clientRow);
async function createClient(c) {
  const r = await q(`INSERT INTO clients (name, match, pages, type, budget, lives, account) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [c.name, c.match || '', JSON.stringify(c.pages || []), c.type || 'live', c.budget || 0, c.lives || 2, c.account || '']);
  return clientRow(r.rows[0]);
}
async function updateClient(id, c) {
  const allowed = ['name', 'match', 'pages', 'type', 'budget', 'lives', 'account', 'archived', 'telegram', 'telegram_title'];
  const keys = Object.keys(c).filter((k) => allowed.includes(k));
  if (!keys.length) return null;
  const sets = keys.map((k, i) => `${k}=$${i + 2}`).join(', ');
  const r = await q(`UPDATE clients SET ${sets} WHERE id=$1 RETURNING *`, [id, ...keys.map((k) => (k === 'pages' ? JSON.stringify(c[k]) : c[k]))]);
  return r.rows[0] ? clientRow(r.rows[0]) : null;
}
const deleteClient = (id) => q('DELETE FROM clients WHERE id=$1', [id]);

// ---- ad accounts ----
async function saveAccounts(list) {
  for (const a of list) {
    await q(`INSERT INTO ad_accounts (id, name, info, seen_at) VALUES ($1,$2,$3,now())
             ON CONFLICT (id) DO UPDATE SET name=$2, info=$3, seen_at=now()`, [a.id, a.name, a]);
  }
}
const listAccounts = async () => (await q('SELECT * FROM ad_accounts ORDER BY enabled DESC, lower(name)')).rows;
const setAccountEnabled = (id, enabled) => q('UPDATE ad_accounts SET enabled=$2 WHERE id=$1', [id, !!enabled]);
const enabledAccountIds = async () => (await q('SELECT id FROM ad_accounts WHERE enabled')).rows.map((r) => r.id);

// ---- Facebook Pages seen in campaigns (for the "add Page" picker) ----
async function notePages(names, day) {
  for (const n of new Set(names.filter(Boolean))) {
    await q(`INSERT INTO pages_seen (name, last_seen) VALUES ($1,$2)
             ON CONFLICT (name) DO UPDATE SET last_seen=GREATEST(pages_seen.last_seen, $2)`, [n, day]);
  }
}
const listPagesSeen = async () => (await q('SELECT name, to_char(last_seen,\'YYYY-MM-DD\') AS last_seen FROM pages_seen ORDER BY last_seen DESC, name')).rows;

// ---- settings ----
async function getSetting(key, fallback) {
  const r = (await q('SELECT value FROM settings WHERE key=$1', [key])).rows[0];
  return r ? r.value : fallback;
}
const setSetting = (key, value) =>
  q(`INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2`, [key, JSON.stringify(value)]);

// ---- days ----
async function getDay(day) {
  const rows = (await q('SELECT client_id, data FROM day_entries WHERE day=$1', [day])).rows;
  const meta = (await q('SELECT * FROM day_meta WHERE day=$1', [day])).rows[0] || null;
  const entries = {};
  for (const r of rows) entries[r.client_id] = r.data;
  return { day, entries, meta };
}
async function getEntry(day, clientId) {
  return (await q('SELECT data FROM day_entries WHERE day=$1 AND client_id=$2', [day, clientId])).rows[0]?.data || {};
}
const putEntry = (day, clientId, data) =>
  q(`INSERT INTO day_entries (day, client_id, data) VALUES ($1,$2,$3)
     ON CONFLICT (day, client_id) DO UPDATE SET data=$3`, [day, clientId, data]);
const putDayMeta = (day, syncedBy, unmatched) =>
  q(`INSERT INTO day_meta (day, synced_at, synced_by, unmatched) VALUES ($1, now(), $2, $3)
     ON CONFLICT (day) DO UPDATE SET synced_at=now(), synced_by=$2, unmatched=$3`, [day, syncedBy, JSON.stringify(unmatched)]);
const monthEntries = async (from, to) =>
  (await q(`SELECT to_char(day,'YYYY-MM-DD') AS day, client_id, data FROM day_entries WHERE day BETWEEN $1 AND $2`, [from, to])).rows;

module.exports = {
  pool, init,
  upsertUser, getUser, latestUser, listUsers,
  listClients, createClient, updateClient, deleteClient,
  notePages, listPagesSeen, getSetting, setSetting,
  saveAccounts, listAccounts, setAccountEnabled, enabledAccountIds,
  getDay, getEntry, putEntry, putDayMeta, monthEntries,
};
