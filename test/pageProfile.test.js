// Page profile (src/pageProfile.js): what reaches the AI. No database.
const assert = require('assert');
const p = require('../src/pageProfile');

assert.strictEqual(p.forAI(null), null);
assert.strictEqual(p.forAI({ sells: '', price: '', points: '' }), null, 'an empty profile sends nothing');
const o = p.forAI({ sells: 'អាវឈុត', price: '$8', points: '', avoid: 'កុំចុះតម្លៃ', at: 'x', by: 'Voan' });
assert.deepStrictEqual(o, { whatThePageSells: 'អាវឈុត', price: '$8', doNotSay: 'កុំចុះតម្លៃ' }, 'only filled fields, no who/when');
assert.ok(p.filled({ notes: 'x' }) && !p.filled({}));
assert.ok(/pageProfile/.test(p.RULE) && /doNotSay/.test(p.RULE));
console.log('pageProfile ok');
