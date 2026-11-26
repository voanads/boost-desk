// Tenant isolation: one admin's workspace must never read or change another admin's data.
// Needs a real, empty Postgres database (its tables are dropped first):
//   TEST_DATABASE_URL=postgres://user@host/bd_test npm test
// Without TEST_DATABASE_URL this test is skipped.
if (!process.env.TEST_DATABASE_URL) { console.log('tenant: skipped (set TEST_DATABASE_URL to run)'); process.exit(0); }
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.SESSION_SECRET ||= 'x';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.FB_APP_ID ||= '1';
process.env.FB_APP_SECRET ||= 'x';
const assert = require('assert');
const db = require('../src/db');

const A = '1000000001', B = '1000000002', DAY = '2026-11-20';

(async () => {
  // start clean
  const { rows } = await db.pool.query(`SELECT tablename FROM pg_tables WHERE schemaname='public'`);
  if (rows.length) await db.pool.query(`DROP TABLE ${rows.map((r) => `"${r.tablename}"`).join(', ')} CASCADE`);
  await db.init();

  await db.upsertUser(A, 'Admin A', 'enc', null);
  await db.upsertUser(B, 'Admin B', 'enc', null);
  const ca = await db.createClient(A, { name: 'Shop A', pages: ['Page A'], type: 'live' });
  const cb = await db.createClient(B, { name: 'Shop B', pages: ['Page B'], type: 'post' });

  // clients
  assert.deepStrictEqual((await db.listClients(A)).map((c) => c.id), [ca.id], 'A lists only its own clients');
  assert.deepStrictEqual((await db.listClients(B)).map((c) => c.id), [cb.id], 'B lists only its own clients');
  assert.strictEqual(await db.ownsClient(A, cb.id), false, 'A does not own B\'s client');
  assert.strictEqual(await db.updateClient(A, cb.id, { name: 'hacked' }), null, 'A cannot rename B\'s client');
  assert.strictEqual((await db.listClients(B))[0].name, 'Shop B');
  await db.deleteClient(A, cb.id);
  assert.strictEqual((await db.listClients(B)).length, 1, 'A cannot delete B\'s client');

  // day entries
  await db.putEntry(B, DAY, cb.id, { post: { spend: 10 } });
  assert.deepStrictEqual(await db.getEntry(A, DAY, cb.id), {}, 'A reads nothing from B\'s day entry');
  await db.putEntry(A, DAY, cb.id, { post: { spend: 999 } });
  assert.strictEqual((await db.getEntry(B, DAY, cb.id)).post.spend, 10, 'A cannot overwrite B\'s day entry');
  await db.putEntry(A, DAY, ca.id, { lives: { l1: { spend: 5 } } });
  assert.strictEqual((await db.getEntry(A, DAY, ca.id)).lives.l1.spend, 5, 'A writes its own entry');
  assert.deepStrictEqual(Object.keys((await db.getDay(A, DAY)).entries).map(Number), [ca.id], 'getDay shows only A\'s entries');
  assert.deepStrictEqual((await db.monthEntries(A, '2026-11-01', '2026-11-30')).map((r) => r.client_id), [ca.id], 'monthEntries shows only A\'s');
  await assert.rejects(() => db.getEntry('', DAY, ca.id), /owner/, 'getEntry without an owner is refused');
  await assert.rejects(() => db.putEntry(undefined, DAY, ca.id, {}), /owner/, 'putEntry without an owner is refused');

  // ad accounts, raw rows, day meta, pages
  await db.saveAccounts(A, [{ id: 'act_1', name: 'Acc A' }]);
  await db.saveAccounts(B, [{ id: 'act_1', name: 'Acc B (same id)' }]);
  assert.strictEqual((await db.listAccounts(A))[0].name, 'Acc A', 'same ad account id is kept apart per owner');
  await db.setAccountEnabled(A, 'act_1', false);
  assert.deepStrictEqual(await db.enabledAccountIds(B), ['act_1'], 'A unticking an account does not untick B\'s');
  await db.putRaw(B, DAY, [{ campaignId: 'c1', spend: 3 }]);
  assert.strictEqual(await db.getRaw(A, DAY), null, 'A cannot read B\'s raw rows');
  await db.putDayMeta(B, DAY, 'B', { unmatched: [] });
  assert.strictEqual((await db.getDay(A, DAY)).meta, null, 'A cannot read B\'s day meta');
  await db.notePages(B, ['Page B'], DAY);
  assert.deepStrictEqual(await db.listPagesSeen(A), [], 'A does not see B\'s Pages');

  // invoices
  const inv = await db.createInvoice(B, { clientId: cb.id, date: DAY, data: { items: [] }, total: 50 }, 'B');
  assert.strictEqual(await db.getInvoice(A, inv.id), undefined, 'A cannot open B\'s invoice');
  assert.deepStrictEqual(await db.listInvoices(A, '2026-01-01', '2026-12-31'), [], 'A lists no invoices of B');
  await db.markInvoice(A, inv.id, { paid: true });
  assert.strictEqual((await db.getInvoice(B, inv.id)).paidAt, null, 'A cannot mark B\'s invoice paid');
  await db.deleteInvoice(A, inv.id);
  assert.ok(await db.getInvoice(B, inv.id), 'A cannot delete B\'s invoice');

  // per-admin settings and pictures
  await db.setUserSetting(B, 'kindOverride', { c1: 'live' });
  assert.strictEqual(await db.getUserSetting(A, 'kindOverride', null), null, 'per-admin settings are kept apart');
  const img = await db.putPostImage(B, 'image/png', Buffer.from('x'));
  assert.strictEqual(await db.getPostImage(A, img), null, 'A cannot load B\'s post picture');

  // removing an account removes only its own workspace
  await db.removeUser(B);
  assert.strictEqual((await db.listClients(A)).length, 1, 'removing B keeps A\'s clients');
  assert.strictEqual((await db.listAccounts(A)).length, 1, 'removing B keeps A\'s ad accounts');

  console.log('tenant: all isolation checks pass');
  await db.pool.end();
})().catch(async (e) => { console.error(e); try { await db.pool.end(); } catch (_) {} process.exit(1); });
