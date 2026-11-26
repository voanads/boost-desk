// Database backup: every table as JSON, gzipped into one file, every night at 03:20, and downloadable from
// Admin → Settings. Restore with scripts/restore.js.
// Where it goes:
//   - BACKUP_S3_* set (Cloudflare R2, Backblaze B2, S3…): the file is stored there, and the owner's Telegram gets a
//     short "backup OK" note only (BACKUP_TELEGRAM_FILE=on sends the file to Telegram as well).
//   - otherwise: the file is sent to the owner's Telegram (the chat set with /alerts), as before.
// BACKUP_KEY (64 hex characters) encrypts the whole file (AES-256-GCM, name ends in .enc). Keep that key outside
// Railway too: without it the backup cannot be read.
const crypto = require('crypto');
const zlib = require('zlib');
const db = require('./db');
const sync = require('./sync');

const MAX_TG = 45 * 1024 * 1024; // Telegram bots can send files up to 50 MB
const MAGIC = Buffer.from('BDB1'); // encrypted backup: MAGIC, iv (12), tag (16), ciphertext

function backupKey() {
  const k = (process.env.BACKUP_KEY || '').trim(); if (!k) return null;
  const b = Buffer.from(k, 'hex'); if (b.length !== 32) throw new Error('BACKUP_KEY must be 64 hex characters (openssl rand -hex 32).');
  return b;
}
function seal(buf, key) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv), body = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), body]);
}
function open(buf, key) {
  if (!buf.subarray(0, 4).equals(MAGIC)) return buf; // not encrypted
  if (!key) throw new Error('This backup is encrypted: set BACKUP_KEY to the key it was made with.');
  const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(4, 16)); d.setAuthTag(buf.subarray(16, 32));
  return Buffer.concat([d.update(buf.subarray(32)), d.final()]);
}

async function tables() {
  return (await db.pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`)).rows.map((r) => r.table_name);
}
// skip: tables to leave out (raw_rows can be downloaded from Meta again, so it is the first to drop if too big)
async function make({ skip = [] } = {}) {
  const out = { app: 'boost-desk', version: 1, at: new Date().toISOString(), tables: {} }, counts = {};
  for (const t of await tables()) {
    if (t === 'job_runs') continue; // run bookkeeping only (runOnce.js)
    if (skip.includes(t)) { counts[t] = 'skipped'; continue; }
    const rows = (await db.pool.query(`SELECT * FROM "${t}"`)).rows;
    for (const r of rows) for (const k of Object.keys(r)) if (Buffer.isBuffer(r[k])) r[k] = '\\x' + r[k].toString('hex'); // pictures (bytea) as Postgres hex text, so restore can read them
    out.tables[t] = rows; counts[t] = rows.length;
  }
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(out)), { level: 9 });
  return { gz, counts, at: out.at, name: `boost-desk-backup-${sync.todayIn()}.json.gz` };
}
// info.sent: the backup is stored somewhere safe (off-site storage or the owner's Telegram).
async function run(telegram, { send = true } = {}) {
  const key = backupKey(), store = require('./s3').config(), tgFile = !store || process.env.BACKUP_TELEGRAM_FILE === 'on';
  let b = await make();
  if (!store && b.gz.length > MAX_TG) b = await make({ skip: ['raw_rows'] }); // off-site storage has no 50 MB limit
  const file = key ? seal(b.gz, key) : b.gz, name = b.name + (key ? '.enc' : '');
  const info = { at: b.at, sizeMb: Math.round(file.length / 1048576 * 10) / 10, counts: b.counts, encrypted: !!key, sent: false, stored: '', telegram: false, error: '' };
  if (send) {
    const errors = [];
    if (store) {
      try { await require('./s3').put(`boost-desk/${name}`, file, key ? 'application/octet-stream' : 'application/gzip', store); info.stored = `${store.bucket}/boost-desk/${name}`; info.sent = true; }
      catch (e) { errors.push('off-site: ' + e.message); }
    }
    const chat = await db.getSetting('alertChat', null);
    const rows = Object.entries(b.counts).filter(([, v]) => typeof v === 'number').reduce((t, [, v]) => t + v, 0);
    const line = `🗄 Boost Desk backup ${b.at.slice(0, 16).replace('T', ' ')} UTC · ${info.sizeMb} MB · ${rows.toLocaleString('en-US')} rows${b.counts.raw_rows === 'skipped' ? ' (raw Meta rows left out — they can be synced again)' : ''}${key ? ' · encrypted' : ''}`;
    if (!chat || !chat.id) { if (!info.sent) errors.push('No Telegram chat for the owner yet — send /alerts CODE to the bot (Admin → Health) so backups can be sent.'); }
    else if (tgFile && file.length > MAX_TG) { if (!info.sent) errors.push('Backup is bigger than Telegram allows — set up off-site storage (BACKUP_S3_*) or download it from Admin → Settings.'); }
    else if (tgFile) {
      try { await telegram.sendDocument(file, name, `${line}${info.stored ? `\nAlso stored in ${info.stored}.` : ''}\n${key ? 'It opens only with BACKUP_KEY.' : 'Keep this file private: it holds your clients and invoices.'}`, chat.id, key ? 'application/octet-stream' : 'application/gzip'); info.telegram = true; info.sent = true; }
      catch (e) { errors.push('Telegram: ' + e.message); }
    } else if (info.stored) {
      try { await telegram.send(`${line}\n✅ Stored in ${info.stored}.`, chat.id); } catch (_) { /* the note is only a convenience */ }
    } else {
      try { await telegram.send(`${line}\n⚠️ Backup could NOT be stored: ${errors.join('; ')}`, chat.id); } catch (_) { /* reported in info.error */ }
    }
    info.error = info.sent ? '' : errors.join('; ');
    if (info.sent && errors.length) info.warn = errors.join('; ');
  }
  await db.setSetting('lastBackup', info);
  return { ...info, gz: b.gz, name: b.name };
}
module.exports = { make, run, seal, open, backupKey };
