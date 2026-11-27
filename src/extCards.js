// What the AdsCheck Connect browser extension sends per ad account (billing threshold, card, daily limit, next bill
// date) — kept per person in the setting extThresholds = { act_…: { v, cur, card, dailyLimit, business, role, nextBillDate, at } }.
// Shared by the PM's own Ad accounts page (routes/lives-dashboard.js) and Admin › All ad accounts (routes/admin-ad-accounts.js).
const FAKE_DEMO_CARDS = new Set(['Visa •••• 4829', 'Mastercard •••• 7741', 'Visa •••• 3104', 'Mastercard •••• 9912', 'Amex •••• 1008', 'Visa •••• 6590']);
const cleanCard = (c) => { const s = String(c || '').trim().slice(0, 80); return s && !FAKE_DEMO_CARDS.has(s) ? s : null; };
// The newest extension record for one account among the people who have it: { rec, by } or null.
function newest(accountId, people, extByUser) {
  let best = null;
  for (const p of people) { const r = (extByUser[p.id] || {})[accountId]; if (r && (!best || String(r.at || '') > String(best.rec.at || ''))) best = { rec: r, by: p.name }; }
  return best;
}
module.exports = { FAKE_DEMO_CARDS, cleanCard, newest };
