// Boost plan: a sent plan can be deleted from the client's group for 48 hours (src/plan.js canUnsend). No database.
process.env.DATABASE_URL ||= 'postgres://test/test';
process.env.SESSION_SECRET ||= 'x'; process.env.ENCRYPTION_KEY ||= '0'.repeat(64); process.env.FB_APP_ID ||= '1'; process.env.FB_APP_SECRET ||= 'x';
const assert = require('assert');
const { canUnsend, DELETE_HOURS } = require('../src/plan');

const now = Date.parse('2026-11-28T03:00:00Z');
const sent = (h, ids = [11, 12]) => ({ sentMsgs: { at: new Date(now - h * 36e5).toISOString(), chat: '-100123', ids } });
assert.strictEqual(DELETE_HOURS, 48);
assert.ok(canUnsend(sent(1), now), 'just sent → can delete');
assert.ok(canUnsend(sent(47.5), now), 'inside 48 h');
assert.ok(!canUnsend(sent(48.5), now), 'past 48 h → Telegram refuses');
assert.ok(!canUnsend(sent(1, []), now), 'no messages kept');
assert.ok(!canUnsend({}, now) && !canUnsend(null, now), 'never sent');
console.log('planUnsend ok');
