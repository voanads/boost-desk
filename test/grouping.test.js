// Checks live grouping and client matching with real campaign names from 29 Sep 2026.
// Run: npm test   (no database or Meta access needed)
process.env.DATABASE_URL ||= 'postgres://test/test';
process.env.SESSION_SECRET ||= 'x';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.FB_APP_ID ||= '1';
process.env.FB_APP_SECRET ||= 'x';
const assert = require('assert');
const { buildPlan, todayIn } = require('../src/sync');
const { encrypt, decrypt } = require('../src/crypto');

const t = (s) => Date.parse(s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
const A = 'Nhean Sovorn (08) (Live)';
const items = [
  [A, 'DC Shop | 29', '2026-09-29T06:28:04+0000', 98.02],
  [A, 'CosMe | 29', '2026-09-29T05:18:44+0000', 69.83],
  [A, 'LR Shop | 29', '2026-09-29T01:42:13+0000', 60],
  [A, 'CosMe | 29', '2026-09-29T05:20:26+0000', 59.89],
  [A, 'DC Shop | 29', '2026-09-29T06:28:53+0000', 49.3],
  [A, 'LR Shop | 29', '2026-09-29T01:44:11+0000', 30],
  [A, 'LyLy pich shop | 29', '2026-09-29T06:18:45+0000', 29.51],
  [A, 'DC Shop | 29', '2026-09-29T05:04:45+0000', 27.6],
  [A, 'DC Shop | 29', '2026-09-29T05:06:42+0000', 26.44],
  [A, 'CosMe | 29', '2026-09-29T05:21:18+0000', 19.98],
  [A, 'DC Shop | 29', '2026-09-29T05:07:46+0000', 6.87],
  ['IP 003 ( Din )', 'Post: "🙀1ដុំ200ដប9.5$"', '2026-09-29T03:20:03+0000', 2.72],
  ['IP 001', 'Post: "x"', '2026-09-19T09:08:26+0000', 16.23],
  ['IP 001', 'Post: "grapes"', '2026-09-15T05:05:57+0000', 6.02, 'Pin Pin Shop'],
  ['IP 001', 'Post: "coffee"', '2026-09-23T12:00:26+0700', 8.23, 'Some Other Page'],
  ['Nhean Sovorn (04)', 'Post: "promo"', '2026-09-23T12:00:26+0700', 4.5, 'DC Shop'],
  ['IP 003 ( Din )', 'Post: "a"', '2026-09-24T04:04:02+0000', 7, 'ផ្ទះ បង្អែមព្រិលត្រចៀកកាំ'],
  ['IP 003 ( Din )', 'Post: "b"', '2026-09-24T04:05:06+0000', 3, 'RD បង្អែមព្រិលត្រចៀកកំា'],
].map(([account, name, start, spend, page = '']) => ({ account, accountId: 'act_x', name, start: t(start), spend, page }));

const clients = [
  { id: 1, name: 'DC Shop', match: '', type: 'live', lives: 2, account: '' },
  { id: 2, name: 'CosMe', match: '', type: 'live', lives: 2, account: '' },
  { id: 3, name: 'LR', match: 'LR Shop', type: 'live', lives: 2, account: '' },
  { id: 4, name: 'Fruit shop', match: '', type: 'post', lives: 1, account: 'IP 003 ( Din )' },
  { id: 5, name: 'Pin Pin Shop', match: '', type: 'post', lives: 1, account: '' },
  { id: 6, name: 'Dessert shop', match: '', type: 'post', lives: 1, account: '', pages: ['ផ្ទះ បង្អែមព្រិលត្រចៀកកាំ', 'RD បង្អែមព្រិលត្រចៀកកំា'] },
];
clients[0].type = 'both'; // DC Shop does lives and boosted posts

const plan = buildPlan(items, clients, 30 * 60000);
const byId = Object.fromEntries(plan.targets.map((x) => [x.clientId, x]));

assert.deepStrictEqual(byId[1].slots.map((s) => [s.count, s.spend]), [[3, 60.91], [2, 147.32]], 'DC Shop = 2 lives');
assert.deepStrictEqual((({ spend, count }) => ({ spend, count }))(byId[1].post), { spend: 4.5, count: 1 }, 'DC Shop post boost matched by Page');
assert.deepStrictEqual(byId[2].slots.map((s) => [s.count, s.spend]), [[3, 149.7]], 'CosMe = 1 live');
assert.deepStrictEqual(byId[3].slots.map((s) => [s.count, s.spend]), [[2, 90]], 'LR Shop matched via page name');
assert.strictEqual(byId[4].post.spend, 2.72, 'post boost matched via ad account');
assert.strictEqual(byId[5].post.spend, 6.02, 'post boost matched via Page name');
assert.deepStrictEqual((({ spend, count }) => ({ spend, count }))(byId[6].post), { spend: 10, count: 2 }, 'two Pages add up for one client');
assert.deepStrictEqual(plan.unmatched.map((u) => u.label).sort(), ['LyLy pich shop · ' + A, 'Post boosts (Page unknown) · IP 001', 'Post boosts for Page "Some Other Page" · IP 001'].sort());
assert.strictEqual(decrypt(encrypt('token-123')), 'token-123');
assert.match(todayIn('Asia/Phnom_Penh', new Date('2026-09-29T20:00:00Z')), /^2026-09-30$/);

console.log('All checks passed:');
for (const x of plan.targets) {
  const parts = x.slots.map((s) => `live $${s.spend} (${s.count})`);
  if (x.post) parts.push(`posts $${x.post.spend} (${x.post.count})`);
  console.log(' ', clients.find((c) => c.id === x.clientId).name + ':', parts.join(' + '));
}

// Results: the action that matches the ad set's optimisation goal (like Ads Manager's "Results").
const { campaignResult } = require('../src/meta');
const row = { reach: '900', actions: [{ action_type: 'post_engagement', value: '310' }, { action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '42' }] };
assert.deepStrictEqual(campaignResult(row, 'CONVERSATIONS'), { results: 42, resultType: 'message' });
assert.deepStrictEqual(campaignResult(row, 'POST_ENGAGEMENT'), { results: 310, resultType: 'engagement' });
assert.deepStrictEqual(campaignResult(row, 'REACH'), { results: 900, resultType: 'person reached' });
assert.deepStrictEqual(campaignResult(row, ''), { results: 42, resultType: 'message' }, 'unknown goal falls back to messages');
const rp = buildPlan([
  { name: 'DC Shop | 30', account: A, spend: 20, start: 1000, results: 30, resultType: 'message' },
  { name: 'DC Shop | 30', account: A, spend: 10, start: 2000, results: 10, resultType: 'message' },
], clients);
const dcSlot = rp.targets[0].slots[0];
assert.strictEqual(dcSlot.results, 40, 'results add up within one live');
assert.strictEqual(dcSlot.resultType, 'message');
console.log('Results checks passed.');

// Live vs post for clients that do both.
const { isPostFor } = require('../src/sync');
const both = { type: 'both' };
assert.strictEqual(isPostFor(both, { name: 'Post: "Sale"' }), true, 'Meta auto name = post');
assert.strictEqual(isPostFor(both, { name: 'Kabas Home | 1' }), false, 'Ads Box live name = live');
assert.strictEqual(isPostFor(both, { name: 'Kabas Home | 1', creative: 'PHOTO' }), true, 'photo creative = post even with a live-style name');
assert.strictEqual(isPostFor(both, { name: 'New sofa promo' }), true, 'other names = post');
assert.strictEqual(isPostFor(both, { name: 'Kabas live 10am' }), false, '"live" in the name = live');
assert.strictEqual(isPostFor(both, { name: 'Kabas Home | 1', kind: 'post' }), true, 'manual choice wins');
assert.strictEqual(isPostFor({ type: 'live' }, { name: 'Post: x' }), false, 'live-only client');
console.log('Live/post checks passed.');
