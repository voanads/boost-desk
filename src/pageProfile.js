// 📄 Page profile: what the PM knows about the client's Page — what it sells, price, its strong points, who buys,
// offer / delivery, what not to say, and background notes. Every AI feature (advice, daily plan, weekly strategy,
// Ad Doctor, competitors) gets it with the numbers, so the AI writes for THIS Page instead of guessing.
//   user setting profile:<clientId> = { sells, price, points, audience, offer, avoid, notes, at, by }
const db = { getUserSetting: (...a) => require('./db').getUserSetting(...a), setUserSetting: (...a) => require('./db').setUserSetting(...a) }; // lazy: the rules load without a database

const FIELDS = { sells: 300, price: 200, points: 1500, audience: 600, offer: 800, avoid: 600, notes: 2000 };
const key = (clientId) => 'profile:' + Number(clientId);
const clean = (s, n) => String(s == null ? '' : s).replace(/\u0000/g, '').trim().slice(0, n);
const empty = () => Object.fromEntries(Object.keys(FIELDS).map((k) => [k, '']));

async function get(owner, clientId) {
  const v = (await db.getUserSetting(owner, key(clientId), null)) || {};
  const out = empty(); for (const k of Object.keys(FIELDS)) out[k] = clean(v[k], FIELDS[k]);
  return { ...out, at: v.at || null, by: v.by || '' };
}
async function save(owner, clientId, body, by) {
  const b = body || {}, next = empty();
  for (const k of Object.keys(FIELDS)) next[k] = clean(b[k], FIELDS[k]);
  const v = { ...next, at: new Date().toISOString(), by: clean(by, 80) };
  await db.setUserSetting(owner, key(clientId), v);
  return v;
}
const filled = (p) => !!p && Object.keys(FIELDS).some((k) => p[k]);
// The block the AI gets: only the filled fields, null when nothing is written yet.
function forAI(p) {
  if (!filled(p)) return null;
  const names = { sells: 'whatThePageSells', price: 'price', points: 'strongPoints', audience: 'whoBuys', offer: 'offerAndDelivery', avoid: 'doNotSay', notes: 'background' };
  const o = {}; for (const k of Object.keys(FIELDS)) if (p[k]) o[names[k]] = p[k];
  return o;
}
async function forClient(owner, clientId) { try { return forAI(await get(owner, clientId)); } catch (_) { return null; } }

// Added to every AI system prompt that reads one client.
const RULE = `\n\nThe data may carry client.pageProfile: what the Project Manager wrote about this Page (what it sells, price, strong points, who buys, offer and delivery, what NOT to say, background). Use it: build advice, hooks and actions on its strong points and offer, speak to who buys, and never suggest anything listed under doNotSay. When the profile and the numbers disagree, trust the numbers and say so in one line. When there is no profile, do not invent the product or the price.`;

module.exports = { get, save, forAI, forClient, filled, RULE, FIELDS };
