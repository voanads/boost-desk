// Ad Doctor rules (adDoctor.diagnose): which ads are weak and why, against the client's own ads. No database or Meta.
process.env.DATABASE_URL ||= 'postgres://test/test';
process.env.SESSION_SECRET ||= 'x'; process.env.ENCRYPTION_KEY ||= '0'.repeat(64); process.env.FB_APP_ID ||= '1'; process.env.FB_APP_SECRET ||= 'x';
const assert = require('assert');
const { diagnose } = require('../src/adDoctor');

const ad = (id, o) => ({ adId: id, name: 'Ad ' + id, campaign: 'C', spend: 10, impressions: 5000, reach: 3000, frequency: 1.6, cpm: 2, ctr: 1.5, results: 10, resultType: 'message', ...o });
const d = diagnose([
  ad('good', { spend: 20, results: 20 }),                       // $1.00 per message — the best
  ad('ok2', { spend: 15, results: 12 }),                        // $1.25
  ad('pricey', { spend: 30, results: 8 }),                      // $3.75, more than 2× the average → bad
  ad('dead', { spend: 8, results: 0, resultType: '' }),         // spent, nothing back → bad
  ad('tired', { frequency: 4.2 }),                              // audience saw it too often → warn
  ad('dull', { ctr: 0.4 }),                                     // nobody taps → warn
  ad('dear', { cpm: 5 }),                                       // expensive to show → warn
  ad('tiny', { spend: 0.5, results: 0 }),                       // under $1 → ignored
  ad('views', { spend: 5, results: 1000, resultType: 'ThruPlay' }), // another result type: not compared with messages
]);
const by = Object.fromEntries(d.ads.map((a) => [a.adId, a]));
assert.ok(!by.tiny, 'under $1 is left out');
assert.strictEqual(by.pricey.level, 'bad'); assert.ok(by.pricey.flags.some((f) => f.kind === 'cpr'));
assert.strictEqual(by.dead.level, 'bad'); assert.deepStrictEqual(by.dead.flags.map((f) => f.kind), ['noresult']);
assert.deepStrictEqual(by.tired.flags.map((f) => f.kind), ['freq']);
assert.deepStrictEqual(by.dull.flags.map((f) => f.kind), ['ctr']);
assert.deepStrictEqual(by.dear.flags.map((f) => f.kind), ['cpm']);
assert.strictEqual(by.good.level, 'ok'); assert.strictEqual(by.views.level, 'ok', 'only one ThruPlay ad: nothing to compare it with');
assert.ok(d.best.includes('good') && !d.best.includes('pricey'));
assert.deepStrictEqual(d.ads.slice(0, 2).map((a) => a.level), ['bad', 'bad'], 'worst first');
assert.strictEqual(d.totals.weak, 5); assert.strictEqual(d.totals.weakSpend, 68);
assert.ok(by.pricey.flags[0].fix.length > 10, 'every reason comes with a fix');
console.log('adDoctor ok');
