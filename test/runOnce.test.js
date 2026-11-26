// Two copies of the app claiming the same job slot: only one runs it. Needs TEST_DATABASE_URL (see tenant.test.js).
if (!process.env.TEST_DATABASE_URL) { console.log('runOnce: skipped (set TEST_DATABASE_URL to run)'); process.exit(0); }
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.SESSION_SECRET ||= 'x'; process.env.ENCRYPTION_KEY ||= '0'.repeat(64); process.env.FB_APP_ID ||= '1'; process.env.FB_APP_SECRET ||= 'x';
const assert = require('assert');
const db = require('../src/db');
const { claim, once } = require('../src/runOnce');

(async () => {
  await db.pool.query('DROP TABLE IF EXISTS job_runs');
  const t = Date.UTC(2026, 10, 26, 3, 20, 5);
  const both = await Promise.all([claim('Backup test', 60e3, t), claim('Backup test', 60e3, t + 2000)]);
  assert.deepStrictEqual(both.sort(), [false, true], 'one of two copies wins the same minute');
  assert.strictEqual(await claim('Backup test', 60e3, t + 60e3), true, 'the next minute is a new slot');
  assert.strictEqual(await claim('Other job', 60e3, t), true, 'slots are per job');
  let runs = 0; const job = once('Once test', async () => { runs++; }, 3600e3);
  await Promise.all([job(), job(), job()]);
  assert.strictEqual(runs, 1, 'once() runs the job in one copy only');
  console.log('runOnce: all checks pass');
  await db.pool.end();
})().catch(async (e) => { console.error(e); try { await db.pool.end(); } catch (_) {} process.exit(1); });
