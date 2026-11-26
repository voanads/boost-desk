// AI calls with a fake fetch (no real API call): usage per month, refusals, the Gemini model fallback.
// Needs TEST_DATABASE_URL (see tenant.test.js).
if (!process.env.TEST_DATABASE_URL) { console.log('ai: skipped (set TEST_DATABASE_URL to run)'); process.exit(0); }
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.SESSION_SECRET ||= 'x'; process.env.ENCRYPTION_KEY ||= '0'.repeat(64); process.env.FB_APP_ID ||= '1'; process.env.FB_APP_SECRET ||= 'x';
delete process.env.ANTHROPIC_MODEL; delete process.env.GEMINI_MODEL;
const assert = require('assert');
const db = require('../src/db');
const sync = require('../src/sync');

const calls = []; let next = [];
global.fetch = async (url, opts) => { calls.push({ url: String(url), body: JSON.parse(opts.body) }); const r = next.shift(); return { status: r.status || 200, ok: (r.status || 200) < 400, json: async () => r.body }; };

(async () => {
  await db.init();
  const ym = sync.todayIn().slice(0, 7);
  await db.pool.query('DELETE FROM settings WHERE key=$1', [`aiUsage:${ym}`]);
  const ai = require('../src/ai');
  await ai.saveKey('sk-ant-' + 'a'.repeat(40), 'test');

  // KPI suggestions go through callClaude; answer with usage, then a refusal
  next = [{ body: { content: [{ type: 'text', text: '[]' }], stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 200 } } }];
  try { await ai.kpiSuggest('4000000001', { name: 'Reports sent', target: 10, unit: 'reports', fresh: true }); } catch (_) { /* the answer itself is not the point here */ }
  assert.ok(calls[0] && calls[0].url.includes('api.anthropic.com'), 'Claude was called');
  let u = (await ai.publicConfig()).usage;
  assert.deepStrictEqual([u.calls, u.input, u.output], [1, 1000, 200], 'usage recorded');
  assert.strictEqual(u.cost, 0, '$0.004 rounds to $0.00');
  assert.strictEqual(u.priced, true);

  next = [{ body: { content: [], stop_reason: 'refusal', usage: { input_tokens: 10, output_tokens: 0 } } }];
  await assert.rejects(() => ai.kpiSuggest('4000000001', { name: 'Reports sent', target: 10, unit: 'reports', fresh: true }), /declined/, 'a refusal is a clear error, not an empty answer');
  u = (await ai.publicConfig()).usage;
  assert.strictEqual(u.calls, 2, 'a refused request still counts');

  // Gemini: a retired model name falls back to gemini-flash-latest once
  await ai.saveKey('AIza' + 'b'.repeat(35), 'test'); calls.length = 0;
  next = [{ status: 404, body: { error: { message: 'not found' } } }, { body: { candidates: [{ content: { parts: [{ text: '[]' }] } }], usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 5 } } }];
  try { await ai.kpiSuggest('4000000001', { name: 'Reports sent', target: 10, unit: 'reports', fresh: true }); } catch (_) {}
  assert.ok(calls[1] && calls[1].url.includes('gemini-flash-latest'), 'fell back to gemini-flash-latest');
  u = (await ai.publicConfig()).usage;
  assert.strictEqual(u.calls, 3); assert.strictEqual(u.priced, false, 'Gemini has no price in the table: tokens only');

  await ai.saveKey(null, 'test');
  console.log('ai: usage, refusal and Gemini fallback pass');
  await db.pool.end();
})().catch(async (e) => { console.error(e); try { await db.pool.end(); } catch (_) {} process.exit(1); });
