// Client link: one private, read-only page per client (/r/<token>) with their own boost results — spend, lives, posts,
// orders and cost per order by day, and their service invoices. No login: the link is the key, like a shared document.
//   setting clientLinks = { '<token>': { owner, clientId, at, by } }   (one token per client; a new one replaces the old)
// The page shows only this client's numbers. Nothing about other clients, the team, or the client's own customers.
const crypto = require('crypto');
const cfg = require('./config');
const db = require('./db');
const sync = require('./sync');

const KEY = 'clientLinks';
const all = async () => (await db.getSetting(KEY, {})) || {};
const urlOf = (token) => `${cfg.baseUrl}/r/${token}`;
const tokenOf = (links, owner, clientId) => Object.keys(links).find((t) => links[t].owner === owner && Number(links[t].clientId) === Number(clientId)) || null;

async function get(owner, clientId) { const t = tokenOf(await all(), owner, clientId); return t ? { url: urlOf(t), at: (await all())[t].at } : null; }
async function make(owner, clientId, by) {
  const links = await all(), old = tokenOf(links, owner, clientId); if (old) delete links[old];
  const t = crypto.randomBytes(16).toString('hex');
  links[t] = { owner, clientId: Number(clientId), at: new Date().toISOString(), by: by || '' };
  await db.setSetting(KEY, links);
  return { url: urlOf(t), at: links[t].at };
}
async function revoke(owner, clientId) { const links = await all(), t = tokenOf(links, owner, clientId); if (t) { delete links[t]; await db.setSetting(KEY, links); } return { ok: true }; }
async function find(token) { if (!/^[a-f0-9]{32}$/.test(String(token))) return null; return (await all())[token] || null; }

// ---- the numbers on the page (pure parts kept small so they can be tested) ----
const hasLive = (c) => c.type === 'live' || c.type === 'both', hasPost = (c) => c.type === 'post' || c.type === 'both';
function days(c, rows, daily = {}) {
  const out = [];
  for (const r of rows) {
    const e = r.data || {}; let live = 0, lives = 0;
    if (hasLive(c)) for (const l of Object.values(e.lives || {})) { const v = Number(l && l.spend) || 0; if (v > 0) { live += v; lives++; } }
    const post = hasPost(c) ? Number((e.post || {}).spend) || 0 : 0;
    if (!(live + post > 0)) continue;
    out.push({ day: r.day, spend: Math.round((live + post) * 100) / 100, live: Math.round(live * 100) / 100, lives, post: Math.round(post * 100) / 100, orders: daily[r.day] || 0 });
  }
  return out.sort((a, b) => b.day.localeCompare(a.day));
}
function totals(list, orders) {
  const t = list.reduce((a, d) => ({ spend: a.spend + d.spend, live: a.live + d.live, lives: a.lives + d.lives, post: a.post + d.post }), { spend: 0, live: 0, lives: 0, post: 0 });
  const r2 = (x) => Math.round(x * 100) / 100;
  return { spend: r2(t.spend), withTax: r2(t.spend * (1 + (sync.TAX_RATE || 0) / 100)), live: r2(t.live), lives: t.lives, post: r2(t.post), days: list.length, orders: orders || 0, cpo: orders > 0 && t.spend > 0 ? r2(t.spend / orders) : null };
}
const lastOf = (ym) => { const [y, m] = ym.split('-').map(Number); return `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`; };
const prevMonth = (ym) => { const [y, m] = ym.split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; };

async function data(link, ym) {
  const today = sync.todayIn(), thisMonth = today.slice(0, 7);
  const month = /^\d{4}-\d{2}$/.test(ym || '') && ym <= thisMonth && ym >= prevMonth(prevMonth(thisMonth)) ? ym : thisMonth; // this month and the two before
  const from = month + '-01', to = month === thisMonth ? today : lastOf(month);
  const c = (await db.listClients(link.owner)).find((x) => x.id === Number(link.clientId)); if (!c) return null;
  const rows = (await db.monthEntries(link.owner, from, to)).filter((r) => r.client_id === c.id).map((r) => ({ ...r, day: String(r.day instanceof Date ? sync.todayIn(undefined, r.day) : r.day).slice(0, 10) }));
  let od = null; try { od = ((await require('./orders').byClient(link.owner, from, to)).clients || {})[c.id] || null; } catch (_) {}
  const list = days(c, rows, (od && od.daily) || {});
  const invs = (await db.listInvoices(link.owner, sync.addDays(today, -180), today)).filter((v) => v.clientId === c.id).map((v) => ({ number: v.number, date: v.date, total: Number(v.total) || 0, paid: !!v.paidAt }));
  const pm = ((await db.getUser(link.owner)) || {}).name || '';
  return { client: c.name, type: c.type, pm, month, from, to, months: [thisMonth, prevMonth(thisMonth), prevMonth(prevMonth(thisMonth))], days: list, totals: totals(list, od && od.orders), invoices: invs, tax: sync.TAX_RATE || 0, updated: new Date().toISOString() };
}

// ---- the page ----
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const money = (n) => '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const KM_M = ['មករា', 'កុម្ភៈ', 'មីនា', 'មេសា', 'ឧសភា', 'មិថុនា', 'កក្កដា', 'សីហា', 'កញ្ញា', 'តុលា', 'វិច្ឆិកា', 'ធ្នូ'];
const monthName = (ym) => `${KM_M[Number(ym.slice(5)) - 1]} ${ym.slice(0, 4)}`;
const dayName = (d) => `${Number(d.slice(8))}/${Number(d.slice(5, 7))}`;

function page(d, token) {
  const t = d.totals, L = d.type !== 'post', P = d.type !== 'live';
  const tile = (lab, big, sub = '') => `<div class="t"><span>${lab}</span><b>${big}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
  const max = Math.max(1, ...d.days.map((x) => x.spend));
  return `<!doctype html><html lang="km"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>${esc(d.client)} · ADS BOX</title><style>
:root{--ink:#14122A;--mut:#6b6880;--line:#e7e5ef;--bg:#f6f5fa;--acc:#4f46e5;--ok:#0f8a4b;--bad:#c2410c}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,-apple-system,"Segoe UI","Noto Sans Khmer","Khmer OS",sans-serif;color:var(--ink);background:var(--bg)}
main{max-width:760px;margin:0 auto;padding:20px 16px 40px}header{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:14px}
h1{font-size:22px;margin:0}.sub{color:var(--mut);font-size:13px}.brand{font-weight:700;letter-spacing:.5px;color:var(--acc);font-size:13px}
nav{display:flex;gap:6px;flex-wrap:wrap;margin:10px 0 16px}nav a{padding:6px 12px;border:1px solid var(--line);border-radius:99px;color:var(--ink);text-decoration:none;background:#fff;font-size:13px}nav a.on{background:var(--ink);color:#fff;border-color:var(--ink)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:16px}.t{background:#fff;border:1px solid var(--line);border-radius:12px;padding:12px}.t span{display:block;color:var(--mut);font-size:12px}.t b{font-size:20px;font-variant-numeric:tabular-nums}.t small{display:block;color:var(--mut);font-size:12px}
section{background:#fff;border:1px solid var(--line);border-radius:12px;padding:14px;margin-bottom:16px}h2{font-size:15px;margin:0 0 10px}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{padding:7px 6px;border-bottom:1px solid var(--line);text-align:left}th{color:var(--mut);font-weight:500;font-size:12px}td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
.bar{height:6px;background:#eef;border-radius:3px;margin-top:3px}.bar i{display:block;height:100%;background:var(--acc);border-radius:3px}
.ok{color:var(--ok)}.bad{color:var(--bad)}.empty{color:var(--mut);padding:8px 0}footer{color:var(--mut);font-size:12px;text-align:center;margin-top:20px}
</style></head><body><main>
<header><div><div class="brand">ADS BOX · Boost report</div><h1>${esc(d.client)}</h1><div class="sub">${esc(dayName(d.from))} – ${esc(dayName(d.to))} · ${esc(monthName(d.month))}${d.pm ? ' · PM ' + esc(d.pm) : ''}</div></div></header>
<nav>${d.months.map((m) => `<a href="/r/${token}${m === d.months[0] ? '' : '?m=' + m}" class="${m === d.month ? 'on' : ''}">${esc(monthName(m))}</a>`).join('')}</nav>
<div class="tiles">${tile('ចំណាយ Boost', money(t.spend), d.tax ? `+ពន្ធ ${d.tax}% = ${money(t.withTax)}` : '')}${t.orders ? tile('ការបញ្ជាទិញ (orders)', t.orders.toLocaleString('en-US'), t.cpo != null ? `${money(t.cpo)} ក្នុងមួយ order` : '') : ''}${L ? tile('Live', `${t.lives}`, money(t.live)) : ''}${P ? tile('Boost post', money(t.post)) : ''}${tile('ថ្ងៃដែលមាន Boost', `${t.days}`)}</div>
<section><h2>ប្រចាំថ្ងៃ</h2>${d.days.length ? `<table><thead><tr><th>ថ្ងៃ</th><th class="n">ចំណាយ</th>${L ? '<th class="n">Live</th>' : ''}${t.orders ? '<th class="n">Orders</th>' : ''}</tr></thead><tbody>${d.days.map((x) => `<tr><td>${esc(dayName(x.day))}<div class="bar"><i style="width:${Math.round(x.spend / max * 100)}%"></i></div></td><td class="n">${money(x.spend)}</td>${L ? `<td class="n">${x.lives || '–'}</td>` : ''}${t.orders ? `<td class="n">${x.orders || '–'}</td>` : ''}</tr>`).join('')}</tbody></table>` : '<div class="empty">មិនទាន់មានការ Boost នៅខែនេះទេ។</div>'}</section>
<section><h2>វិក្កយបត្រសេវា</h2>${d.invoices.length ? `<table><thead><tr><th>លេខ</th><th>ថ្ងៃ</th><th class="n">ចំនួន</th><th>ស្ថានភាព</th></tr></thead><tbody>${d.invoices.map((v) => `<tr><td>${esc(v.number)}</td><td>${esc(dayName(v.date))}/${esc(v.date.slice(2, 4))}</td><td class="n">${money(v.total)}</td><td class="${v.paid ? 'ok' : 'bad'}">${v.paid ? 'បានបង់' : 'មិនទាន់បង់'}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">គ្មានវិក្កយបត្រក្នុង 6 ខែចុងក្រោយ។</div>'}</section>
<footer>លេខចំណាយពី Facebook Ads Manager · ធ្វើបច្ចុប្បន្នភាពរៀងរាល់ម៉ោង · ADS BOX<br>Link នេះសម្រាប់តែអ្នក — សូមកុំចែករំលែក។</footer>
</main></body></html>`;
}

module.exports = { get, make, revoke, find, data, page, days, totals, urlOf, KEY };
