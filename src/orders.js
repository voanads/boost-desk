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

// ---------- adsbox.biz API ----------
// The address and key are entered on the Orders page and saved encrypted (Railway variables also work).
const { encrypt, decrypt } = require('./crypto');
async function apiConfig() {
  const c = (await db.getSetting('adsboxApi', null)) || {};
  let key = '';
  try { key = c.keyEnc ? decrypt(c.keyEnc) : ''; } catch (_) { key = ''; }
  return { url: c.url || process.env.ADSBOX_API_URL || '', key: key || process.env.ADSBOX_API_KEY || '', hint: c.keyHint || (process.env.ADSBOX_API_KEY ? '…' + process.env.ADSBOX_API_KEY.slice(-4) : ''), by: c.by || '', at: c.at || '' };
}
async function saveApiConfig({ url, key }, by) {
  const cur = (await db.getSetting('adsboxApi', null)) || {};
  const next = { ...cur, url: String(url || '').trim().slice(0, 300), by, at: new Date().toISOString() };
  if (key && String(key).trim()) { next.keyEnc = encrypt(String(key).trim()); next.keyHint = '…' + String(key).trim().slice(-4); }
  if (key === null) { delete next.keyEnc; delete next.keyHint; }
  if (next.url && !/^https:\/\//i.test(next.url) && !/^http:\/\/(localhost|127\.0\.0\.1)[:/]/i.test(next.url)) throw Object.assign(new Error('The API address must start with https://'), { status: 400 });
  await db.setSetting('adsboxApi', next);
  return publicConfig();
}
async function publicConfig() {
  const c = await apiConfig();
  return { url: c.url, hasKey: !!c.key, keyHint: c.hint, savedBy: c.by, savedAt: c.at, last: await db.getSetting('ordersLastImport', null), lastError: await db.getSetting('ordersLastError', null) };
}
// DM · NEW / DM · OLD: either counts on a summary row (dm_new, new_dm, dmNew, new_customers…) or, on a
// per-order row, a type field saying "new" / "old" (or is_new true/false).
const isOrderRow = (x) => !!x && ['phone', 'customer', 'customer_name', 'customer_phone', 'address', 'status', 'order_id', 'orderId', 'order_code', 'psid', 'customer_id'].some((k) => k in x);
function splitOf(x) {
  const keys = Object.keys(x || {}), num = (k) => Number(x[k]) || 0;
  const kNew = keys.find((k) => /(^|[^a-z])(dm.?new|new.?dm|new.?customers?|new.?c|new)$/i.test(k) || /^dm.?new|^newdm|^dmnew/i.test(k));
  const kOld = keys.find((k) => /(^|[^a-z])(dm.?old|old.?dm|old.?customers?|old.?c|old|returning)$/i.test(k) || /^dm.?old|^olddm|^dmold/i.test(k));
  if ((kNew && typeof x[kNew] !== 'boolean') || kOld) return { newC: kNew ? num(kNew) : 0, oldC: kOld ? num(kOld) : 0 };
  const flag = x.is_new ?? x.isNew ?? x.new_customer;
  if (typeof flag === 'boolean' || flag === 0 || flag === 1) return flag ? { newC: 1, oldC: 0 } : { newC: 0, oldC: 1 };
  const t = String(x.dm_type ?? x.dmType ?? x.customer_type ?? x.customerType ?? x.type ?? x.dm ?? x.customer_status ?? '').toLowerCase();
  if (/new|ថ្មី/.test(t)) return { newC: 1, oldC: 0 };
  if (/old|return|ចាស់/.test(t)) return { newC: 0, oldC: 1 };
  return { newC: 0, oldC: 0 };
}
// Read rows from whatever shape the API returns: [..], {data:[..]}, {rows:[..]}, {orders:[..]}.
function mapRows(body) {
  const list = Array.isArray(body) ? body : body && (body.data || body.rows || body.orders || body.items || body.result) || [];
  // One row per order (it has a customer, phone, status or order id) counts as 1 order, whatever its own
  // "orders"/"count" field says (on a per-order row that can be the customer's order history).
  // The same order seen twice (pages overlapping) is counted once.
  const seen = new Set();
  return list.filter((x) => {
    const id = x && (x.order_id ?? x.orderId ?? x.order_code ?? x.code ?? x.id ?? x._id);
    if (id == null || id === '') return true;
    const k = String(id); if (seen.has(k)) return false; seen.add(k); return true;
  }).map((x) => ({
    day: String(x.date || x.day || x.order_date || x.created_at || '').slice(0, 10),
    pageId: x.page_id ?? x.pageId ?? x.fb_page_id ?? '', pageName: x.page_name ?? x.pageName ?? x.page ?? '',
    orders: isOrderRow(x) ? 1 : (x.orders ?? x.count ?? x.total_orders ?? x.order_count ?? 1), ...splitOf(x), total: x.total ?? x.amount ?? 0,
  }));
}
async function callApi(from, to) {
  const { url, key } = await apiConfig();
  if (!url || !key) return null;
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000);
  let res;
  try { res = await fetch(`${url}${url.includes('?') ? '&' : '?'}from=${from}&to=${to}`, { headers: { Authorization: `Bearer ${key}`, 'X-API-Key': key, Accept: 'application/json' }, signal: ctl.signal }); }
  catch (e) { throw new Error(`Could not reach adsbox.biz (${e.name === 'AbortError' ? 'timed out' : e.message})`); }
  finally { clearTimeout(t); }
  const text = await res.text();
  if (res.status === 401 || res.status === 403) throw new Error('adsbox.biz refused the API key (check the key).');
  if (!res.ok) throw new Error(`adsbox.biz API answered HTTP ${res.status}`);
  try { return JSON.parse(text); } catch (_) { throw new Error('adsbox.biz did not answer with JSON — check the API address.'); }
}
// Pull the last few days of counts into the database.
// Any period, asked in pieces of up to 31 days (older months can be fetched whenever they're opened).
async function pullRange(from, to) {
  let n = 0, start = from;
  while (start <= to) {
    const end = sync.addDays(start, 30) < to ? sync.addDays(start, 30) : to;
    const r = await pullApi(0, start, end); if (r === null) return null;
    n += r; start = sync.addDays(end, 1);
  }
  return n;
}
async function pullApi(days = 3, fromDay, toDay) {
  const to = toDay || sync.todayIn(), from = fromDay || sync.addDays(to, -(days - 1));
  try {
    const body = await callApi(from, to);
    if (body === null) return null;
    const rows = mapRows(body);
    // Per-order rows (one row per order) are counted here; summary rows already carry counts.
    const agg = new Map();
    for (const r of rows) {
      const k = r.day + '|' + r.pageId + '|' + r.pageName, a = agg.get(k) || { day: r.day, pageId: r.pageId, pageName: r.pageName, orders: 0, newC: 0, oldC: 0, total: 0 };
      a.orders += Number(r.orders) || 0; a.newC += Number(r.newC) || 0; a.oldC += Number(r.oldC) || 0; a.total += Number(r.total) || 0; agg.set(k, a);
    }
    await q(`DELETE FROM page_orders WHERE source='api' AND day BETWEEN $1 AND $2`, [from, to]); // re-counted from scratch for these days
    const n = await importRows([...agg.values()], 'api');
    await db.setSetting('ordersLastError', null);
    return n;
  } catch (e) { await db.setSetting('ordersLastError', { at: new Date().toISOString(), message: e.message }); throw e; }
}
// "Test connection": one call for yesterday + today, report what came back (field names only, no values).
async function testApi() {
  const to = sync.todayIn(), from = sync.addDays(to, -1);
  const body = await callApi(from, to);
  if (body === null) throw Object.assign(new Error('Enter the API address and key first.'), { status: 400 });
  const rows = mapRows(body), raw = Array.isArray(body) ? body : body && (body.data || body.rows || body.orders || body.items || body.result) || [];
  const fields = raw[0] && typeof raw[0] === 'object' ? Object.keys(raw[0]) : [];
  const sumField = raw.reduce((t, x) => t + (Number(x && (x.orders ?? x.count)) || 0), 0);
  return { rows: rows.length, rawRows: raw.length, sumField, perOrder: raw.some(isOrderRow), fields, hasPage: rows.some((r) => r.pageId || r.pageName), hasDate: rows.some((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.day)) };
}

// Orders page: per client spend (from the synced ads) next to orders, per Page; plus Pages with orders but no client.
async function report(owner, from, to) {
  const [d, pages, oc] = await Promise.all([sync.dashboard(owner, from, to), sync.pageSpend(owner, from, to), byClient(owner, from, to)]);
  const rows = (await q(`SELECT page_id, max(page_name) AS page_name, sum(orders)::int AS orders, sum(new_c)::int AS new_c FROM page_orders WHERE day BETWEEN $1 AND $2 GROUP BY page_id`, [from, to])).rows;
  const clients = d.clients.filter((c) => !c.archived || c.spend > 0).map((c) => {
    const o = oc.clients[c.id] || { orders: 0, newC: 0, oldC: 0, pages: {} };
    const pg = (pages[c.id] || []).map((p) => ({ page: p.page, pageId: p.pageId, named: p.named, spend: p.spend, live: p.live, post: p.post, orders: o.pages[p.pageId] || o.pages['name:' + norm(p.page)] || 0 }));
    return { id: c.id, name: c.name, type: c.type, spend: c.spend, live: c.liveSpend, post: c.postSpend, orders: o.orders, newC: o.newC, oldC: o.oldC, pages: pg };
  });
  const matched = new Set(); for (const c of Object.values(oc.clients)) for (const k of Object.keys(c.pages)) matched.add(k);
  // Only Pages this person actually boosts (seen in their synced ads) — other teams' Pages stay private.
  const mine = new Set(), mineNames = new Set();
  for (const d of await db.listRaw(owner, sync.addDays(from, -30), to)) for (const r of d.rows || []) { if (r.pageId) mine.add(r.pageId); if (r.page) mineNames.add(norm(r.page)); }
  const unmatched = rows.filter((r) => (mine.has(r.page_id) || mineNames.has(norm(r.page_name))) && !matched.has(r.page_id) && !matched.has('name:' + norm(r.page_name)) && r.orders > 0).map((r) => ({ pageId: r.page_id.startsWith('name:') ? '' : r.page_id, page: r.page_name, orders: r.orders })).sort((a, b) => b.orders - a.orders);
  return { from, to, clients, unmatched, hasData: rows.length > 0 };
}

module.exports = { importRows, status, byClient, pullApi, pullRange, testApi, report, publicConfig, saveApiConfig, apiConfig };
