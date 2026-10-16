// Orders from adsbox.biz (detected from Page Messenger chats), counted per Facebook Page per day,
// matched to clients by Page ID (or Page name) so the app can show cost per order = boost spend ÷ orders.
// Only counts are stored here — never customer names, phones or addresses.
const cfg = require('./config');
const db = require('./db');
const sync = require('./sync');

const q = (text, params) => db.pool.query(text, params);
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const int = (n) => Math.max(0, Math.round(Number(n) || 0));

// rows: [{ day, pageId, pageName, orders, newC, oldC, total }] — replaces those days/Pages.
async function importRows(rows, source = 'upload') {
  let n = 0;
  for (const r of rows.slice(0, 50000)) {
    const pageId = String(r.pageId || '').trim().slice(0, 40), name = String(r.pageName || '').trim().slice(0, 150);
    if (!isDay(r.day) || (!pageId && !name)) continue;
    await q(`INSERT INTO page_orders (day, page_id, page_name, orders, new_c, old_c, total, source, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
             ON CONFLICT (day, page_id) DO UPDATE SET page_name=COALESCE(NULLIF($3,''), page_orders.page_name), orders=$4, new_c=$5, old_c=$6, total=$7, source=$8, updated_at=now()`,
      [r.day, pageId || 'name:' + norm(name), name, int(r.orders), int(r.newC), int(r.oldC), Math.max(0, Number(r.total) || 0), source]);
    n++;
  }
  await db.setSetting('ordersLastImport', { at: new Date().toISOString(), rows: n, source });
  return n;
}

async function status() {
  const r = (await q(`SELECT min(day)::text AS first, max(day)::text AS last, count(DISTINCT page_id)::int AS pages, coalesce(sum(orders),0)::int AS orders FROM page_orders`)).rows[0];
  return { ...r, last_import: await db.getSetting('ordersLastImport', null), api: !!(process.env.ADSBOX_API_URL && process.env.ADSBOX_API_KEY) };
}

// Orders per client (and per Page) for one admin's clients over a period.
async function byClient(owner, from, to) {
  const rows = (await q(`SELECT day::text AS day, page_id, page_name, orders, new_c, old_c, total FROM page_orders WHERE day BETWEEN $1 AND $2`, [from, to])).rows;
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

// adsbox.biz API (when ADSBOX_API_URL + ADSBOX_API_KEY are set): pull the last few days of counts.
async function pullApi(days = 3) {
  const url = process.env.ADSBOX_API_URL, key = process.env.ADSBOX_API_KEY;
  if (!url || !key) return null;
  const to = sync.todayIn(), from = sync.addDays(to, -(days - 1));
  const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}from=${from}&to=${to}`, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`adsbox.biz API: HTTP ${res.status}`);
  const body = await res.json();
  const list = Array.isArray(body) ? body : body.data || body.rows || [];
  const rows = list.map((x) => ({ day: String(x.date || x.day || '').slice(0, 10), pageId: x.page_id || x.pageId, pageName: x.page_name || x.pageName, orders: x.orders ?? x.count, newC: x.new_customers ?? x.new, oldC: x.old_customers ?? x.old, total: x.total ?? x.amount }));
  return importRows(rows, 'api');
}

module.exports = { importRows, status, byClient, pullApi, tz: cfg.tz };
