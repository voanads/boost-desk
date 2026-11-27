// Extension data on Admin › All ad accounts: the newest reading among the people who have the account; demo cards dropped.
const assert = require('assert');
const { newest, cleanCard } = require('../src/extCards');
const ext = { ni: { act_1: { v: 250, at: '2026-11-27T05:00:00Z', card: 'Visa •••• 1234' } }, sokhy: { act_1: { v: 500, at: '2026-11-27T06:00:00Z' } } };
const people = [{ id: 'ni', name: 'Ni' }, { id: 'sokhy', name: 'Sokhy' }, { id: 'x', name: 'X' }];
let h = newest('act_1', people, ext); assert.strictEqual(h.by, 'Sokhy'); assert.strictEqual(h.rec.v, 500, 'newest wins');
assert.strictEqual(newest('act_2', people, ext), null);
h = newest('act_1', [people[0]], ext); assert.strictEqual(h.by, 'Ni');
assert.strictEqual(cleanCard('Visa •••• 4829'), null, 'demo card dropped'); assert.strictEqual(cleanCard(' Visa •••• 1234 '), 'Visa •••• 1234');
console.log('extCards ok');
