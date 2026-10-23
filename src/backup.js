// Database backup: every table as JSON, gzipped into one file, sent every night to the owner's Telegram
// (the chat set with /alerts) and downloadable from Admin → Settings. Restore with scripts/restore.js.
const zlib = require('zlib');
const db = require('./db');
const sync = require('./sync');

const MAX_TG = 45 * 1024 * 1024; // Telegram bots can send files up to 50 MB

async function tables() {
  return (await db.pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`)).rows.map((r) => r.table_name);
}
// skip: tables to leave out (raw_rows can be downloaded from Meta again, so it is the first to drop if too big)
async function make({ skip = [] } = {}) {
  const out = { app: 'boost-desk', version: 1, at: new Date().toISOString(), tables: {} }, counts = {};
  for (const t of await tables()) {
    if (skip.includes(t)) { counts[t] = 'skipped'; continue; }
    const rows = (await db.pool.query(`SELECT * FROM "${t}"`)).rows;
    out.tables[t] = rows; counts[t] = rows.length;
  }
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(out)), { level: 9 });
  return { gz, counts, at: out.at, name: `boost-desk-backup-${sync.todayIn()}.json.gz` };
}
async function run(telegram, { send = true } = {}) {
  let b = await make();
  if (b.gz.length > MAX_TG) b = await make({ skip: ['raw_rows'] });
  const info = { at: b.at, sizeMb: Math.round(b.gz.length / 1048576 * 10) / 10, counts: b.counts, sent: false, error: '' };
  if (send) {
    const chat = await db.getSetting('alertChat', null);
    if (!chat || !chat.id) info.error = 'No Telegram chat for the owner yet — send /alerts CODE to the bot (Admin → Health) so backups can be sent.';
    else if (b.gz.length > MAX_TG) info.error = 'Backup is bigger than Telegram allows — download it from Admin → Settings.';
    else {
      const rows = Object.entries(b.counts).filter(([, v]) => typeof v === 'number').reduce((t, [, v]) => t + v, 0);
      try { await telegram.sendDocument(b.gz, b.name, `🗄 Boost Desk backup ${b.at.slice(0, 16).replace('T', ' ')} UTC · ${info.sizeMb} MB · ${rows.toLocaleString('en-US')} rows${b.counts.raw_rows === 'skipped' ? ' (raw Meta rows left out — they can be synced again)' : ''}.\nKeep this file private: it holds your clients and invoices.`, chat.id, 'application/gzip'); info.sent = true; }
      catch (e) { info.error = e.message; }
    }
  }
  await db.setSetting('lastBackup', info);
  return { ...info, gz: b.gz, name: b.name };
}
module.exports = { make, run };
