// Restore a Boost Desk backup (boost-desk-backup-YYYY-MM-DD.json.gz, or .json.gz.enc) into an EMPTY or replaceable database.
//   DATABASE_URL=postgres://… node scripts/restore.js boost-desk-backup-2026-10-23.json.gz
//   DATABASE_URL=postgres://… BACKUP_KEY=… node scripts/restore.js boost-desk-backup-2026-10-23.json.gz.enc
// It starts the app's own table setup, then for each table in the file: deletes what is there and inserts the
// backed-up rows, and finally moves id counters past the highest id. Run it with the app stopped.
const fs = require('fs');
const zlib = require('zlib');
const { Pool } = require('pg');

(async () => {
  const file = process.argv[2];
  if (!file || !process.env.DATABASE_URL) { console.error('Usage: DATABASE_URL=… node scripts/restore.js <backup.json.gz>'); process.exit(1); }
  // .enc files (BACKUP_KEY set when the backup was made) are decrypted first; BACKUP_KEY must be the same key
  let raw = fs.readFileSync(file);
  if (raw.subarray(0, 4).toString() === 'BDB1') {
    const k = Buffer.from((process.env.BACKUP_KEY || '').trim(), 'hex');
    if (k.length !== 32) { console.error('This backup is encrypted. Run with BACKUP_KEY=<the 64 hex characters it was made with>.'); process.exit(1); }
    const d = require('crypto').createDecipheriv('aes-256-gcm', k, raw.subarray(4, 16)); d.setAuthTag(raw.subarray(16, 32));
    raw = Buffer.concat([d.update(raw.subarray(32)), d.final()]);
  }
  const data = JSON.parse(zlib.gunzipSync(raw).toString('utf8'));
  if (data.app !== 'boost-desk') throw new Error('This is not a Boost Desk backup.');
  // Make the tables first, so a brand-new empty database works too (needs the app's usual environment variables).
  try { const db = require('../src/db'); await db.init(); try { await require('../src/profit').init(); } catch (_) {} await db.pool.end(); console.log('Tables are ready.'); }
  catch (e) { console.log('Could not create the tables here (' + e.message + '). Start the app once on this database, then run restore again if tables were skipped.'); }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false } });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const here = new Set((await c.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public'`)).rows.map((r) => r.table_name));
    const names = Object.keys(data.tables).filter((t) => { if (here.has(t)) return true; console.log(`- ${t}: table not in this database, skipped`); return false; });
    names.sort((a, b) => (a === 'clients' ? -1 : b === 'clients' ? 1 : 0)); // clients first: day_entries points at them
    if (names.length) await c.query(`TRUNCATE ${names.map((t) => `"${t}"`).join(', ')} CASCADE`);
    for (const t of names) {
      const rows = data.tables[t];
      // backups made before 19 Nov 2026 stored pictures as {"type":"Buffer","data":[…]}; Postgres wants hex text
      for (const r of rows) for (const k of Object.keys(r)) { const v = r[k]; if (v && typeof v === 'object' && v.type === 'Buffer' && Array.isArray(v.data)) r[k] = '\\x' + Buffer.from(v.data).toString('hex'); }
      // A JSON column that must not be empty can hold the JSON value null (e.g. a setting that was switched off); read
      // those straight from the row so they stay JSON null instead of becoming an empty (NULL) cell.
      const cols = (await c.query(`SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`, [t])).rows;
      const expr = cols.map((x) => (/^jsonb?$/.test(x.data_type) && x.is_nullable === 'NO' ? `COALESCE(e->'${x.column_name}', 'null'::jsonb)${x.data_type === 'json' ? '::json' : ''}` : `r."${x.column_name}"`)).join(', ');
      for (let i = 0; i < rows.length; i += 500) await c.query(`INSERT INTO "${t}" (${cols.map((x) => `"${x.column_name}"`).join(', ')}) SELECT ${expr} FROM jsonb_array_elements($1::jsonb) e, jsonb_populate_record(null::"${t}", e) r`, [JSON.stringify(rows.slice(i, i + 500))]);
      const seq = (await c.query(`SELECT column_name, pg_get_serial_sequence($1, column_name) AS s FROM information_schema.columns WHERE table_name=$1 AND column_default LIKE 'nextval%'`, [t])).rows;
      for (const x of seq) if (x.s) await c.query(`SELECT setval($1, GREATEST((SELECT COALESCE(MAX("${x.column_name}"), 0) FROM "${t}"), 1))`, [x.s]);
      console.log(`✓ ${t}: ${rows.length} rows`);
    }
    await c.query('COMMIT');
    console.log(`Restored backup from ${data.at}.`);
  } catch (e) { await c.query('ROLLBACK'); console.error('Restore failed, nothing changed:', e.message); process.exitCode = 1; }
  finally { c.release(); await pool.end(); }
})();
