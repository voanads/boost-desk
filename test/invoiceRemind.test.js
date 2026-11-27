// Invoice reminders: which invoices a PM is told about. No database needed.
process.env.DATABASE_URL ||= 'postgres://test/test';
process.env.SESSION_SECRET ||= 'x'; process.env.ENCRYPTION_KEY ||= '0'.repeat(64); process.env.FB_APP_ID ||= '1'; process.env.FB_APP_SECRET ||= 'x';
const assert = require('assert');
const { due, text } = require('../src/invoiceRemind');

const today = '2026-11-26', names = { 1: 'DC Shop', 2: 'LR Shop' };
const inv = (id, date, o = {}) => ({ id, number: 'IN26-' + id, clientId: 1, date, total: 100, sentAt: null, paidAt: null, ...o });
const sent = '2026-11-01T00:00:00Z';

let d = due([
  inv(1, '2026-11-10', { sentAt: sent }),                    // sent 16 days ago, unpaid → remind
  inv(2, '2026-11-22', { sentAt: sent }),                    // sent, only 4 days → not yet
  inv(3, '2026-11-01', { sentAt: sent, paidAt: sent }),      // paid → never
  inv(4, '2026-11-20'),                                      // made 6 days ago, never sent → remind to send
  inv(5, '2026-11-25'),                                      // made yesterday → not yet
  inv(6, '2026-10-20', { sentAt: sent, clientId: 2 }),       // oldest unpaid first
  inv(7, '2026-10-01', { sentAt: sent }),                    // 56 days: past the 45-day stop → not reminded (an admin checks it)
  inv(8, '2026-10-05'),                                      // never sent, 52 days → not reminded either
], names, today);
assert.deepStrictEqual(d.unpaid.map((r) => r.id), [6, 1]);
assert.deepStrictEqual(d.unsent.map((r) => r.id), [4]);
assert.strictEqual(d.unpaid[0].client, 'LR Shop');
assert.strictEqual(d.unpaid[1].days, 16);

// reminded 2 days ago → quiet; 3 days ago → again
d = due([inv(1, '2026-11-10', { sentAt: sent })], names, today, { 1: '2026-11-24' });
assert.strictEqual(d.unpaid.length, 0);
d = due([inv(1, '2026-11-10', { sentAt: sent })], names, today, { 1: '2026-11-23' });
assert.strictEqual(d.unpaid.length, 1);

const t = text('Ni', due([inv(1, '2026-11-10', { sentAt: sent }), inv(4, '2026-11-20')], names, today));
assert.ok(t.includes('IN26-1 · DC Shop · $100.00 · 16 ថ្ងៃ'));
assert.ok(t.includes('មិនទាន់ផ្ញើទៅភ្ញៀវ 1'));
console.log('invoiceRemind ok');
