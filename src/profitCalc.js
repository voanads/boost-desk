// Profit overview (admin): every person's Profit book side by side, month by month — who submitted,
// the profit to split, and how it splits between the company and the people. Same formulas as the
// Profit tab (public/assets/profit.js → calc), so the numbers match what each person sees.
const db = require('./db');

const ROLES = ['developer', 'doer', 'spender', 'supporter', 'company'];
const DEFAULT_SERVICES = [{ name: 'Buy TH', pct: [7, 8, 25, 10, 50] }, { name: 'Request Up', pct: [7, 8, 25, 10, 50] }, { name: 'Refund', pct: [10, 20, 15, 5, 50] }, { name: 'Reset', pct: [5, 10, 25, 10, 50] }, { name: 'Pay Debt', pct: [15, 5, 25, 5, 50] }, { name: 'VAT + TH', pct: [0, 0, 30, 10, 60] }, { name: 'Another', pct: [0, 0, 30, 10, 60] }, { name: 'TikTok Credit', pct: [7, 8, 25, 10, 50] }];
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const r2 = (x) => Math.round(x * 100) / 100 || 0;

function servicesFrom(data) {
  if (data && Array.isArray(data.services)) return data.services.map((s) => ({ name: String(s.name || ''), pct: ROLES.map((_, i) => num((s.pct || [])[i])) }));
  if (data && data.rules && typeof data.rules === 'object') return Object.keys(data.rules).map((n) => ({ name: n, pct: ROLES.map((_, i) => num(data.rules[n][i])) }));
  return DEFAULT_SERVICES;
}

function calc(d, services) {
  const acc = Array.isArray(d.accounts) ? d.accounts : [], cl = Array.isArray(d.clients) ? d.clients : [], tx = Array.isArray(d.transactions) ? d.transactions : [];
  const ruleFor = (name) => { const s = services.find((x) => x.name === name); return s ? s.pct : [0, 0, 0, 0, 100]; };
  const fbDebt = acc.filter((a) => a.platform !== 'TikTok' && a.status === 'Active').reduce((s, a) => s + num(a.balance), 0);
  const toReceive = cl.reduce((s, c) => s + num(c.receive), 0), deposit = cl.reduce((s, c) => s + num(c.deposit), 0);
  const profit = tx.reduce((s, t) => s + num(t.profit), 0), amount = tx.reduce((s, t) => s + num(t.amount), 0);
  const roles = { developer: 0, doer: 0, spender: 0, supporter: 0, company: 0 }, people = {}, svc = {};
  for (const t of tx) {
    const p = num(t.profit), r = ruleFor(t.service), key = t.service || '—';
    svc[key] = svc[key] || { total: 0, count: 0 }; svc[key].total += p; svc[key].count++;
    ROLES.forEach((rl, i) => {
      const amt = p * num(r[i]) / 100; roles[rl] += amt;
      const name = String(t[rl] || '').trim(), who = rl === 'company' || name.toLowerCase() === 'another' ? 'Company' : (name || 'Unassigned');
      people[who] = (people[who] || 0) + amt;
    });
  }
  const splitTyped = d.split !== undefined && d.split !== null && d.split !== '';
  const split = splitTyped ? num(d.split) : profit;
  const increase = r2(num(d.aba) + toReceive - deposit - fbDebt), carry = r2(increase - split);
  for (const k of Object.keys(roles)) roles[k] = r2(roles[k]);
  for (const k of Object.keys(people)) people[k] = r2(people[k]);
  for (const k of Object.keys(svc)) svc[k].total = r2(svc[k].total);
  return { deals: tx.length, amount: r2(amount), profit: r2(profit), split: r2(split), splitTyped, increase, carry, fbDebt: r2(fbDebt), toReceive: r2(toReceive), deposit: r2(deposit), aba: r2(num(d.aba)), roles, people, svc };
}

// people(): the same list the Profit tab's book picker uses (id, name, kind, access, months).
async function overview({ people, monthsBack = 12 }) {
  const services = servicesFrom(((await db.pool.query("SELECT data FROM profit_docs WHERE book='' AND col='settings' AND id='main'")).rows[0] || {}).data);
  const rows = (await db.pool.query("SELECT book, id, data, updated_at FROM profit_docs WHERE col='months' AND id ~ '^[0-9]{4}-[0-9]{2}$' ORDER BY id")).rows;
  const now = new Date(), first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (monthsBack - 1), 1)).toISOString().slice(0, 7);
  const months = [...new Set(rows.map((r) => r.id).filter((m) => m >= first))].sort();
  const named = Object.fromEntries((await people()).map((p) => [p.id, p]));
  const books = {};
  for (const r of rows) {
    if (r.id < first) continue;
    const b = books[r.book] = books[r.book] || { id: r.book, name: (named[r.book] || {}).name || (r.book.startsWith('g:') ? r.book.slice(2) : 'Unknown'), kind: (named[r.book] || {}).kind || '', access: (named[r.book] || {}).access || '', months: {} };
    const d = r.data || {}, c = calc(d, services);
    b.months[r.id] = { ...c, submitted: d.submitted ? { by: d.submitted.by || '', at: d.submitted.at || '' } : null, by: d._by || '', at: d._at || r.updated_at };
  }
  // People with Profit access but no month in range still show, as "no month".
  for (const p of await people()) if (!books[p.id] && p.access !== 'none') books[p.id] = { id: p.id, name: p.name, kind: p.kind, access: p.access, months: {} };
  return { months, books: Object.values(books).sort((a, b) => a.name.localeCompare(b.name)), services: services.map((s) => s.name), roles: ROLES };
}

module.exports = { overview, calc };
