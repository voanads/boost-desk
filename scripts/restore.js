// Restore a Boost Desk backup (boost-desk-backup-YYYY-MM-DD.json.gz) into an EMPTY or replaceable database.
//   DATABASE_URL=postgres://… node scripts/restore.js boost-desk-backup-2026-10-23.json.gz
// It starts the app's own table setup, then for each table in the file: deletes what is there and inserts the
// backed-up rows, and finally moves id counters past the highest id. Run it with the app stopped.
const fs = require('fs');
const zlib = require('zlib');
const { Pool } = require('pg');

(async () => {
  const file = process.argv[2];
  if (!file || !process.env.DATABASE_URL) { console.error('Usage: DATABASE_URL=… node scripts/restore.js <backup.json.gz>'); process.exit(1); }
  const data = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
  if (data.app !== 'boost-desk') throw new Error('This is not a Boost Desk backup.');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false } });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const here = new Set((await c.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public'`)).rows.map((r) => r.table_name));
    const names = Object.keys(data.tables).filter((t) => here.has(t) || !console.log(`- ${t}: table not in this database, skipped`));
    names.sort((a, b) => (a === 'clients' ? -1 : b === 'clients' ? 1 : 0)); // clients first: day_entries points at them
    if (names.length) await c.query(`TRUNCATE ${names.map((t) => `"${t}"`).join(', ')} CASCADE`);
    for (const t of names) {
      const rows = data.tables[t];
      for (let i = 0; i < rows.length; i += 500) await c.query(`INSERT INTO "${t}" SELECT * FROM json_populate_recordset(null::"${t}", $1)`, [JSON.stringify(rows.slice(i, i + 500))]);
      const seq = (await c.query(`SELECT column_name, pg_get_serial_sequence($1, column_name) AS s FROM information_schema.columns WHERE table_name=$1 AND column_default LIKE 'nextval%'`, [t])).rows;
      for (const x of seq) if (x.s) await c.query(`SELECT setval($1, GREATEST((SELECT COALESCE(MAX("${x.column_name}"), 0) FROM "${t}"), 1))`, [x.s]);
      console.log(`✓ ${t}: ${rows.length} rows`);
    }
    await c.query('COMMIT');
    console.log(`Restored backup from ${data.at}.`);
  } catch (e) { await c.query('ROLLBACK'); console.error('Restore failed, nothing changed:', e.message); process.exitCode = 1; }
  finally { c.release(); await pool.end(); }
})();
