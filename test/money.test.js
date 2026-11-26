// Money: client report tax, invoice totals and the Profit split. No database needed.
process.env.DATABASE_URL ||= 'postgres://test/test';
process.env.SESSION_SECRET ||= 'x'; process.env.ENCRYPTION_KEY ||= '0'.repeat(64); process.env.FB_APP_ID ||= '1'; process.env.FB_APP_SECRET ||= 'x';
delete process.env.TAX_RATE; // default 10 %
const assert = require('assert');
const { totalWithTax } = require('../src/sync');
const invoice = require('../src/invoice');
const { calc } = require('../src/profitCalc');

// ---- tax line in client reports (README example) ----
assert.strictEqual(totalWithTax(211.95), '💰 Total: $211.95 +Tax 10% = $233.15');
assert.strictEqual(totalWithTax(0.1 + 0.2), '💰 Total: $0.30 +Tax 10% = $0.33', 'float noise does not leak into cents');
assert.strictEqual(totalWithTax(1234.5), '💰 Total: $1,234.50 +Tax 10% = $1,357.95');
assert.strictEqual(totalWithTax(0.05), '💰 Total: $0.05 +Tax 10% = $0.06', 'half a cent rounds up');
assert.strictEqual(totalWithTax(0), '💰 Total: $0.00', 'no tax line on nothing');
assert.ok(!totalWithTax(-5).includes('Tax'), 'no tax on a negative total');

// ---- invoice totals ----
let t = invoice.totals({ items: [{ description: 'Boost', qty: 3, price: 19.99 }, { description: 'Fee', qty: '2', price: '0.1' }], discount: 5 });
assert.deepStrictEqual([t.subtotal, t.discount, t.total], [60.17, 5, 55.17]);
assert.strictEqual(t.items[0].amount, 59.97);
t = invoice.totals({ items: [{ qty: 1, price: 10 }], discount: 50 });
assert.deepStrictEqual([t.discount, t.total], [10, 0], 'discount never makes a negative invoice');
t = invoice.totals({ items: [{ qty: 1, price: 10 }], discount: -3 });
assert.deepStrictEqual([t.discount, t.total], [0, 10], 'a negative discount is ignored');
t = invoice.totals({ items: Array.from({ length: 8 }, () => ({ qty: 1, price: 1 })) });
assert.deepStrictEqual([t.items.length, t.total], [6, 6], 'at most 6 lines, like the paper form');
t = invoice.totals({ items: [{ qty: 'abc', price: 'x' }] });
assert.strictEqual(t.total, 0, 'bad numbers count as 0');

// ---- Profit split ----
const services = [{ name: 'Buy TH', pct: [7, 8, 25, 10, 50] }, { name: 'VAT + TH', pct: [0, 0, 30, 10, 60] }];
const month = {
  aba: 1000,
  accounts: [{ platform: 'Facebook', status: 'Active', balance: 120 }, { platform: 'TikTok', status: 'Active', balance: 999 }, { platform: 'Facebook', status: 'Disabled', balance: 50 }],
  clients: [{ receive: 300, deposit: 0 }, { receive: 0, deposit: 80 }],
  transactions: [
    { service: 'Buy TH', profit: 100, amount: 1000, developer: 'Dara', doer: 'Sok', spender: 'Sok', supporter: 'Another', company: '' },
    { service: 'VAT + TH', profit: 50, amount: 400, developer: '', doer: '', spender: 'Lina', supporter: 'Dara', company: '' },
    { service: 'Unknown', profit: 10, amount: 10 },
  ],
};
let p = calc(month, services);
assert.strictEqual(p.profit, 160); assert.strictEqual(p.split, 160, 'empty split = the deals\' profit');
assert.strictEqual(p.fbDebt, 120, 'only active Facebook accounts are debt (not TikTok, not disabled)');
assert.strictEqual(p.increase, 1100, 'increase = ABA + to receive − deposits − FB debt');
assert.strictEqual(p.carry, 940, 'carry over = increase − split');
assert.deepStrictEqual(p.roles, { developer: 7, doer: 8, spender: 40, supporter: 15, company: 90 });
assert.strictEqual(Object.values(p.roles).reduce((a, b) => a + b, 0), p.profit, 'roles add up to the profit');
assert.deepStrictEqual(p.people, { Dara: 12, Sok: 33, Company: 100, Lina: 15, Unassigned: 0 }, '“Another” and unknown services go to the company');
assert.strictEqual(Object.values(p.people).reduce((a, b) => a + b, 0), p.profit, 'people add up to the profit');
p = calc({ ...month, split: 0 }, services);
assert.strictEqual(p.split, 0, 'a typed 0 is kept (not replaced by the profit)'); assert.strictEqual(p.carry, 1100);
p = calc({ ...month, split: '120.5' }, services);
assert.strictEqual(p.split, 120.5);
p = calc({}, services);
assert.deepStrictEqual([p.profit, p.increase, p.carry, p.deals], [0, 0, 0, 0], 'an empty month is all zero');

console.log('money: tax, invoice and profit checks pass');
