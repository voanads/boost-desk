// Backup → encrypted file → off-site upload (a local fake S3) → restore into a second database.
// Needs TEST_DATABASE_URL (see tenant.test.js); runs after tenant.test.js, which leaves two admins' data behind.
if (!process.env.TEST_DATABASE_URL) { console.log('backup: skipped (set TEST_DATABASE_URL to run)'); process.exit(0); }
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.SESSION_SECRET ||= 'x'; process.env.ENCRYPTION_KEY ||= '0'.repeat(64); process.env.FB_APP_ID ||= '1'; process.env.FB_APP_SECRET ||= 'x';
const assert = require('assert'), http = require('http'), fs = require('fs'), os = require('os'), path = require('path'), { execFileSync } = require('child_process');
const db = require('../src/db');

(async () => {
  const puts = [];
  const srv = http.createServer((req, res) => { const b = []; req.on('data', (c) => b.push(c)); req.on('end', () => { puts.push({ url: req.url, auth: req.headers.authorization || '', body: Buffer.concat(b) }); res.end('ok'); }); });
  await new Promise((r) => srv.listen(0, r));
  Object.assign(process.env, { BACKUP_KEY: 'ab'.repeat(32), BACKUP_S3_ENDPOINT: `http://127.0.0.1:${srv.address().port}`, BACKUP_S3_BUCKET: 'bk', BACKUP_S3_ACCESS_KEY: 'AK', BACKUP_S3_SECRET_KEY: 'SK' });
  await db.init();
  const owner = '2000000001'; await db.upsertUser(owner, 'Backup admin', 'enc', null);
  const c = await db.createClient(owner, { name: 'Backup Shop', pages: ['P'] });
  await db.putEntry(owner, '2026-11-21', c.id, { post: { spend: 12.5 } });
  await db.setSetting('alertChat', { id: '-1001' });

  const notes = [];
  const fakeTg = { send: async (t) => notes.push(t), sendDocument: async () => { throw new Error('file should not go to Telegram'); } };
  const B = require('../src/backup');
  const r = await B.run(fakeTg);
  assert.strictEqual(r.sent, true, 'stored off-site'); assert.strictEqual(r.encrypted, true); assert.strictEqual(r.telegram, false);
  assert.strictEqual(puts.length, 1); assert.match(puts[0].url, /^\/bk\/boost-desk\/boost-desk-backup-.*\.json\.gz\.enc$/);
  assert.match(puts[0].auth, /^AWS4-HMAC-SHA256 Credential=AK\//, 'upload is signed');
  assert.ok(puts[0].body.subarray(0, 4).equals(Buffer.from('BDB1')), 'file is encrypted');
  assert.ok(!puts[0].body.includes(Buffer.from('Backup Shop')), 'client names are not readable in the file');
  assert.match(notes[0], /Stored in bk\/boost-desk\//, 'owner gets a short note on Telegram');
  await db.pool.end(); srv.close();

  // restore into a fresh database
  const u = new URL(process.env.TEST_DATABASE_URL), adminUrl = new URL(u); adminUrl.pathname = '/postgres';
  const { Pool } = require('pg'), admin = new Pool({ connectionString: adminUrl.toString() });
  await admin.query('DROP DATABASE IF EXISTS bd_restore_test'); await admin.query('CREATE DATABASE bd_restore_test');
  const target = new URL(u); target.pathname = '/bd_restore_test';
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bd-')), 'b.json.gz.enc'); fs.writeFileSync(file, puts[0].body);
  execFileSync(process.execPath, [path.join(__dirname, '../scripts/restore.js'), file], { env: { ...process.env, DATABASE_URL: target.toString() }, stdio: 'pipe' });
  const t = new Pool({ connectionString: target.toString() });
  const row = (await t.query(`SELECT e.data FROM day_entries e JOIN clients c ON c.id=e.client_id WHERE c.name='Backup Shop'`)).rows[0];
  assert.strictEqual(row && row.data.post.spend, 12.5, 'restored day entry matches');
  assert.throws(() => B.open(puts[0].body, Buffer.alloc(32)), 'a wrong key does not open the file');
  await t.end(); await admin.query('DROP DATABASE bd_restore_test'); await admin.end();
  console.log('backup: encrypted off-site backup and restore pass');
})().catch((e) => { console.error(e); process.exit(1); });
