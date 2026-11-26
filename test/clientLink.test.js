// Client link page: per-day numbers and totals, and the HTML escapes names. No database needed.
process.env.DATABASE_URL ||= 'postgres://test/test';
process.env.SESSION_SECRET ||= 'x'; process.env.ENCRYPTION_KEY ||= '0'.repeat(64); process.env.FB_APP_ID ||= '1'; process.env.FB_APP_SECRET ||= 'x';
delete process.env.TAX_RATE; // default 10 %
const assert = require('assert');
const CL = require('../src/clientLink');

const both = { type: 'both' }, live = { type: 'live' };
const rows = [
  { day: '2026-11-01', data: { lives: { L1: { spend: 10 }, L2: { spend: 5.5 } }, post: { spend: 4 } } },
  { day: '2026-11-02', data: { lives: {}, post: { spend: 0 } } },               // nothing spent → left out
  { day: '2026-11-03', data: { lives: { L1: { spend: 20 } }, post: { spend: 3 } } },
];
let d = CL.days(both, rows, { '2026-11-01': 7 });
assert.deepStrictEqual(d.map((x) => x.day), ['2026-11-03', '2026-11-01'], 'newest first, empty days dropped');
assert.deepStrictEqual(d[1], { day: '2026-11-01', spend: 19.5, live: 15.5, lives: 2, post: 4, orders: 7 });
d = CL.days(live, rows); assert.strictEqual(d[0].spend, 20, 'a live-only client does not count post spend');

const t = CL.totals(CL.days(both, rows), 13);
assert.strictEqual(t.spend, 42.5); assert.strictEqual(t.withTax, 46.75); assert.strictEqual(t.lives, 3); assert.strictEqual(t.days, 2);
assert.strictEqual(t.cpo, 3.27, '42.5 / 13');
assert.strictEqual(CL.totals([], 0).cpo, null);

const html = CL.page({ client: '<b>DC</b>', type: 'both', pm: 'Ni', month: '2026-11', from: '2026-11-01', to: '2026-11-26', months: ['2026-11', '2026-10', '2026-09'], days: [], totals: CL.totals([], 0), invoices: [{ number: 'IN26-1', date: '2026-11-05', total: 120, paid: false }], tax: 10 }, 'a'.repeat(32));
assert.ok(html.includes('&lt;b&gt;DC&lt;/b&gt;') && !html.includes('<b>DC</b>'), 'client name is escaped');
assert.ok(html.includes('noindex') && html.includes('IN26-1') && html.includes('មិនទាន់បង់'));
console.log('clientLink ok');
