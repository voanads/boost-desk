// Orders counted per Facebook Page per day (page_orders), matched to clients by Page ID (or Page name), so the app can
// show cost per order = boost spend ÷ orders. Since 20 Nov 2026 Boost Desk counts orders itself (src/pageOrders.js); days
// before that keep the numbers adsbox.biz sent then. adsbox.biz is no longer called (removed 26 Nov 2026).
// Only counts are stored here — never customer names, phones or addresses.
const cfg = require('./config');
const db = require('./db');
const sync = require('./sync');

const q = (text, params) => db.pool.query(text, params);
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const int = (n) => Math.max(0, Math.round(Number(n) || 0));

async function status() {
  const r = (await q(`SELECT min(day)::text AS first, max(day)::text AS last, count(DISTINCT page_id)::int AS pages, coalesce(sum(orders),0)::int AS orders FROM page_orders`)).rows[0];
  return { ...r, last_import: await db.getSetting('ordersLastImport', null) };
}

// Orders per client (and per Page) for one admin's clients over a period.
const SRC = { all: 'orders', messenger: 'o_messenger', comment: 'o_comment', ad: 'o_ad', customers: 'customers' };
async function byClient(owner, from, to, src = 'all', given = null) {
  const col = SRC[src] || 'orders';
  const rows = given || (await q(`SELECT day::text AS day, page_id, page_name, ${col} AS orders, new_c, old_c, total FROM page_orders WHERE day BETWEEN $1 AND $2`, [from, to])).rows;
  if (!rows.length) return { clients: {}, any: false };
  // Which client owns which Page: Page IDs seen in this admin's synced campaigns, plus Page IDs / names typed on clients.
  const raw = (await db.listRaw(owner, sync.addDays(from, -30), to)).flatMap((d) => d.rows || []);
  const clients = await sync.clientsWithLearnedPages(owner, raw, { save: false });
  const byId = {}, byName = {};
  for (const r of raw) {
    const c = sync.matchClient(r, clients); if (!c) continue;
    if (r.pageId) byId[r.pageId] = c.id;
    if (r.page) byName[norm(r.page)] = c.id;
  }
  for (const c of clients) {
    if (c.archived) continue;
    for (const p of c.pages || []) { if (/^\d{5,}$/.test(p)) byId[p] = c.id; else byName[norm(p)] = c.id; }
    byName[norm(c.name)] = byName[norm(c.name)] || c.id;
  }
  const out = {};
  for (const r of rows) {
    const cid = byId[r.page_id] || byName[norm(r.page_name)]; if (!cid) continue;
    const o = (out[cid] = out[cid] || { orders: 0, newC: 0, oldC: 0, total: 0, pages: {}, daily: {} });
    o.orders += r.orders; o.newC += r.new_c; o.oldC += r.old_c; o.total += Number(r.total);
    const pk = r.page_id.startsWith('name:') ? 'name:' + norm(r.page_name) : r.page_id;
    o.pages[pk] = (o.pages[pk] || 0) + r.orders;
    if (r.page_name) o.pages['name:' + norm(r.page_name)] = (o.pages['name:' + norm(r.page_name)] || 0) + (pk.startsWith('name:') ? 0 : r.orders);
    o.daily[r.day] = (o.daily[r.day] || 0) + r.orders;
  }
  return { clients: out, any: true };
}

async function dayStates() { return (await db.getSetting('ordersDayState', {})) || {}; }
// How trustworthy a period's order numbers are: days kept from when they were recent vs. estimates.
async function periodQuality(from, to) {
  const state = await dayStates(), today = sync.todayIn();
  let kept = 0, estimate = 0, missing = 0;
  for (let d = from; d <= to && d <= today; d = sync.addDays(d, 1)) { const st = state[d]; if (st === 'locked' || st === 'fresh') kept++; else if (st === 'backfill') estimate++; else missing++; }
  return { kept, estimate, missing };
}
// What the Orders page and Admin need to know: Boost Desk counts orders itself, always.
async function publicConfig() {
  const own = { ...((await db.getSetting('ordersOwn', null)) || {}), on: true };
  return { own, hasKey: false, last: await db.getSetting('ordersLastImport', null) };
}

// Orders page: per client spend (from the synced ads) next to orders, per Page; plus Pages with orders but no client.
async function report(owner, from, to, src = 'all') {
  const col = SRC[src] || 'orders', key = SRC[src] ? src : 'all';
  const live = null, given = null;
  const [d, pages, oc] = await Promise.all([sync.dashboard(owner, from, to), sync.pageSpend(owner, from, to), byClient(owner, from, to, src, given && given.length ? given : null)]);
  const split = live ? { m: live.reduce((t, r) => t + r.messenger, 0), c: live.reduce((t, r) => t + r.comment, 0), a: live.reduce((t, r) => t + r.ad, 0) }
    : (await q(`SELECT coalesce(sum(o_messenger),0)::int AS m, coalesce(sum(o_comment),0)::int AS c, coalesce(sum(o_ad),0)::int AS a FROM page_orders WHERE day BETWEEN $1 AND $2`, [from, to])).rows[0];
  const rows = given && given.length ? given : (await q(`SELECT page_id, max(page_name) AS page_name, sum(${col})::int AS orders, sum(new_c)::int AS new_c FROM page_orders WHERE day BETWEEN $1 AND $2 GROUP BY page_id`, [from, to])).rows;
  const clients = d.clients.filter((c) => !c.archived || c.spend > 0).map((c) => {
    const o = oc.clients[c.id] || { orders: 0, newC: 0, oldC: 0, pages: {} };
    const pg = sync.scalePages(pages[c.id] || [], c.spend).map((p) => ({ page: p.page, pageId: p.pageId, named: p.named, spend: p.spend, live: p.live, post: p.post, orders: o.pages[p.pageId] || o.pages['name:' + norm(p.page)] || 0 }));
    return { id: c.id, name: c.name, type: c.type, spend: c.spend, live: c.liveSpend, post: c.postSpend, orders: o.orders, ordSpend: sync.orderSpend(pg, o.orders, c.spend), newC: o.newC, oldC: o.oldC, pages: pg };
  });
  const matched = new Set(); for (const c of Object.values(oc.clients)) for (const k of Object.keys(c.pages)) matched.add(k);
  // Only Pages this person actually boosts (seen in their synced ads) — other teams' Pages stay private.
  const mine = new Set(), mineNames = new Set();
  for (const d of await db.listRaw(owner, sync.addDays(from, -30), to)) for (const r of d.rows || []) { if (r.pageId) mine.add(r.pageId); if (r.page) mineNames.add(norm(r.page)); }
  const unmatched = rows.filter((r) => (mine.has(r.page_id) || mineNames.has(norm(r.page_name))) && !matched.has(r.page_id) && !matched.has('name:' + norm(r.page_name)) && r.orders > 0).map((r) => ({ pageId: r.page_id.startsWith('name:') ? '' : r.page_id, page: r.page_name, orders: r.orders })).sort((a, b) => b.orders - a.orders);
  // The same length of time just before, for "cheaper / more expensive than before".
  let prev = null;
  try {
    const len = Math.round((Date.parse(to) - Date.parse(from)) / 864e5) + 1, pf = sync.addDays(from, -len), pt = sync.addDays(from, -1);
    const [pd, po, pp] = await Promise.all([sync.dashboard(owner, pf, pt), byClient(owner, pf, pt, src), sync.pageSpend(owner, pf, pt)]);
    let ps = 0, pn = 0;
    for (const c of pd.clients) {
      const o = po.clients[c.id]; if (!o || !o.orders) continue;
      const pg = sync.scalePages(pp[c.id] || [], c.spend).map((p) => ({ spend: p.spend, orders: o.pages[p.pageId] || o.pages['name:' + norm(p.page)] || 0 }));
      ps += sync.orderSpend(pg, o.orders, c.spend); pn += o.orders;
    }
    prev = { from: pf, to: pt, spend: Math.round(ps * 100) / 100, orders: pn };
  } catch (_) { prev = null; }
  return { from, to, live: false, prev, quality: await periodQuality(from, to), src: key, hasSplit: split.m + split.c + split.a > 0, clients, unmatched, hasData: rows.length > 0 };
}

module.exports = { periodQuality, status, byClient, report, publicConfig };
