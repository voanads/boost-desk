// Urgent escalations go to the COO; the old leaders only when no COO has linked Telegram. No database needed.
process.env.DATABASE_URL ||= 'postgres://test/test';
process.env.SESSION_SECRET ||= 'x'; process.env.ENCRYPTION_KEY ||= '0'.repeat(64); process.env.FB_APP_ID ||= '1'; process.env.FB_APP_SECRET ||= 'x';
const assert = require('assert');
const { pick, roleFor } = require('../src/escalation');

const ctx = { owner: 'own', roles: { ceo1: 'ceo', cmo1: 'cmo', pm1: 'pm' }, viewers: new Set(['coo1', 'ceo1']) };
assert.strictEqual(roleFor('own', ctx), 'ceo');
assert.strictEqual(roleFor('coo1', ctx), 'coo', 'an admin viewer with no role is the COO');
assert.strictEqual(roleFor('ceo1', ctx), 'ceo', 'a set role wins over admin viewer');
assert.strictEqual(roleFor('pm2', ctx), 'pm');

const people = (cooChat) => [
  { id: 'own', name: 'Owner', chat: 'c-own' }, { id: 'ceo1', name: 'CEO', chat: 'c-ceo' }, { id: 'cmo1', name: 'CMO', chat: 'c-cmo' },
  { id: 'coo1', name: 'COO', chat: cooChat }, { id: 'pm1', name: 'PM', chat: 'c-pm' },
];
let r = pick(people('c-coo'), ctx, 'group');
assert.deepStrictEqual(r.chats, ['c-coo'], 'only the COO'); assert.strictEqual(r.fallback, false);
r = pick(people(null), ctx, 'group'); // COO has no Telegram → old leaders + alert group, never a PM
assert.strictEqual(r.fallback, true);
assert.deepStrictEqual(r.chats.sort(), ['c-ceo', 'c-cmo', 'c-own', 'group']);
assert.ok(!r.chats.includes('c-pm'));
assert.deepStrictEqual(r.coo.map((p) => p.name), ['COO']);
console.log('escalation ok');
