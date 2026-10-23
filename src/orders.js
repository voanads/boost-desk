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
    await q(`INSERT INTO page_orders (day, page_id, page_name, orders, new_c, old_c, total, source, o_comment, o_messenger, o_ad, customers, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())
             ON CONFLICT (day, page_id) DO UPDATE SET page_name=COALESCE(NULLIF($3,''), page_orders.page_name), orders=$4, new_c=$5, old_c=$6, total=$7, source=$8, o_comment=$9, o_messenger=$10, o_ad=$11, customers=$12, updated_at=now()`,
      [r.day, pageId || 'name:' + norm(name), name, int(r.orders), int(r.newC), int(r.oldC), Math.max(0, Number(r.total) || 0), source, int(r.oc), int(r.om), int(r.oa), int(r.cust)]);
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

// ---------- adsbox.biz API ----------
// The address and key are entered on the Orders page and saved encrypted (Railway variables also work).
const { encrypt, decrypt } = require('./crypto');
async function apiConfig() {
  const c = (await db.getSetting('adsboxApi', null)) || {};
  let key = '';
  try { key = c.keyEnc ? decrypt(c.keyEnc) : ''; } catch (_) { key = ''; }
  return { url: c.url || process.env.ADSBOX_API_URL || '', key: key || process.env.ADSBOX_API_KEY || '', hint: c.keyHint || (process.env.ADSBOX_API_KEY ? '…' + process.env.ADSBOX_API_KEY.slice(-4) : ''), by: c.by || '', at: c.at || '', listUrl: c.listUrl || process.env.ADSBOX_LIST_URL || '' };
}
async function saveApiConfig({ url, key, listUrl }, by) {
  const cur = (await db.getSetting('adsboxApi', null)) || {};
  const next = { ...cur, url: String(url || '').trim().slice(0, 300), by, at: new Date().toISOString() };
  if (listUrl !== undefined) {
    next.listUrl = String(listUrl || '').trim().slice(0, 300);
    if (next.listUrl && !/^https:\/\//i.test(next.listUrl)) throw Object.assign(new Error('The order list address must start with https://'), { status: 400 });
  }
  if (key && String(key).trim()) { next.keyEnc = encrypt(String(key).trim()); next.keyHint = '…' + String(key).trim().slice(-4); }
  if (key === null) { delete next.keyEnc; delete next.keyHint; }
  if (next.url && !/^https:\/\//i.test(next.url) && !/^http:\/\/(localhost|127\.0\.0\.1)[:/]/i.test(next.url)) throw Object.assign(new Error('The API address must start with https://'), { status: 400 });
  await db.setSetting('adsboxApi', next);
  return publicConfig();
}
async function publicConfig() {
  const c = await apiConfig();
  return { url: c.url, listUrl: c.listUrl, hasKey: !!c.key, keyHint: c.hint, savedBy: c.by, savedAt: c.at, last: await db.getSetting('ordersLastImport', null), lastError: await db.getSetting('ordersLastError', null) };
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
    orders: isOrderRow(x) ? 1 : (x.orders ?? x.count ?? x.total_orders ?? x.order_count ?? 1), ...splitOf(x), total: x.total ?? x.amount ?? x.revenue ?? 0, oc: x.orders_from_comment ?? 0, om: x.orders_from_messenger ?? 0, oa: x.orders_from_ad ?? 0, cust: typeof x.customers === 'number' ? x.customers : 0,
  }));
}
// The period under every common name, so whichever the API reads, it gets the right days.
const dateParams = (from, to) => ['from', 'to', 'date_from', 'date_to', 'start_date', 'end_date', 'start', 'end', 'since', 'until']
  .map((k, i) => `${k}=${i % 2 ? to : from}`).join('&');
// The API says which period it answered for; if that isn't the one asked, its numbers can't be used.
function checkPeriod(body, from, to) {
  if (!body || Array.isArray(body) || !body.from || !body.to) return;
  const f = String(body.from).slice(0, 10), t = String(body.to).slice(0, 10);
  const off = (x, y) => Math.abs(Date.parse(x) - Date.parse(y)) > 36 * 3600e3; // a UTC-written date may be a day off
  if (/^\d{4}-\d{2}-\d{2}$/.test(f) && /^\d{4}-\d{2}-\d{2}$/.test(t) && (off(f, from) || off(t, to))) throw new Error(`adsbox.biz answered for ${f} – ${t} instead of ${from} – ${to}, so its numbers were not used.`);
}
async function callApi(from, to, page = 1, extra = '', base = '') {
  const cfgx = await apiConfig(), key = cfgx.key, url = base || cfgx.url;
  if (!url || !key) return null;
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000), t0 = Date.now();
  let res;
  try { res = await fetch(`${url}${url.includes('?') ? '&' : '?'}${dateParams(from, to)}${extra}${page > 1 ? `&page=${page}` : ''}`, { headers: { Authorization: `Bearer ${key}`, 'X-API-Key': key, Accept: 'application/json' }, signal: ctl.signal }); }
  catch (e) { require('./health').noteService('adsbox.biz', false, 20000, e.message); throw new Error(`Could not reach adsbox.biz (${e.name === 'AbortError' ? 'timed out' : e.message})`); }
  finally { clearTimeout(t); }
  if (base && res.status === 401) { try { res = await fetch(`${url}${url.includes('?') ? '&' : '?'}${dateParams(from, to)}${extra}${page > 1 ? `&page=${page}` : ''}&api_key=${encodeURIComponent(key)}&key=${encodeURIComponent(key)}&token=${encodeURIComponent(key)}`, { headers: { Accept: 'application/json' } }); } catch (_) { /* keep the first answer */ } }
  if (base && res.status === 401) throw new Error('The adsbox.biz order list needs a login and does not accept the API key yet — ask the developer to allow the API key on it.');
  require('./health').noteService('adsbox.biz', res.ok, Date.now() - t0, res.ok ? '' : 'HTTP ' + res.status);
  const text = await res.text();
  if (res.status === 401 || res.status === 403) throw new Error('adsbox.biz refused the API key (check the key).');
  if (!res.ok) throw new Error(`adsbox.biz API answered HTTP ${res.status}`);
  let body; try { body = JSON.parse(text); } catch (_) { throw new Error('adsbox.biz did not answer with JSON — check the API address.'); }
  if (!base) checkPeriod(body, from, to);
  return body;
}
const listOf = (body) => (Array.isArray(body) ? body : body && (body.data || body.rows || body.orders || body.items || body.result) || []);
// All rows for a period, following the API's pages (Laravel-style current_page/last_page, next links,
// or a total), so a long list is never cut off at the first page.
async function fetchAll(from, to, extra = '', base = '') {
  const first = await callApi(from, to, 1, extra, base); if (first === null) return null;
  const all = [...listOf(first)];
  const meta = (first && !Array.isArray(first) && (first.meta || first.pagination || first)) || {};
  const total = Number(meta.total ?? meta.total_count ?? meta.count) || 0;
  const last = Number(meta.last_page ?? meta.total_pages ?? meta.pages) || 0;
  const hasNext = (b) => !!(b && !Array.isArray(b) && (b.next_page_url || (b.links && typeof b.links === 'object' && !Array.isArray(b.links) && b.links.next) || (b.meta && b.meta.next) || b.next || b.has_more));
  let page = 1, body = first, pages = 1;
  while (page < 200) {
    const more = (last && page < last) || hasNext(body) || (total && all.length < total);
    if (!more) break;
    page++; body = await callApi(from, to, page, extra, base); const list = listOf(body);
    if (!list.length) break;
    all.push(...list); pages++;
  }
  return { totals: first && !Array.isArray(first) && first.totals && typeof first.totals === 'object' ? first.totals : null, groupBy: first && first.group_by, list: all, total, pages, keys: first && !Array.isArray(first) ? Object.keys(first) : [], echo: first && !Array.isArray(first) ? Object.fromEntries(['from', 'to', 'timezone', 'group_by', 'count'].filter((k) => k in first).map((k) => [k, typeof first[k] === 'object' ? JSON.stringify(first[k]) : String(first[k])])) : {} };
}
// ---------- counting from adsbox's order list (the same list as its Order page) ----------
// Each order counts once (by its id); its date is turned into a Phnom Penh day; DM · NEW / DM · OLD and
// comment / Messenger / ad come from its own fields. Only the counts are kept — never names or phones.
function localDay(v) {
  const s = String(v || '');
  if (/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:?\d{2})$/.test(s) || /^\d{10,13}$/.test(s)) {
    const d = /^\d+$/.test(s) ? new Date(Number(s) * (s.length === 10 ? 1000 : 1)) : new Date(s);
    if (!isNaN(d)) return new Intl.DateTimeFormat('en-CA', { timeZone: cfg.tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  }
  return s.slice(0, 10);
}
const DEAD = /cancel|delet|spam|reject|void|trash|remove/i;
function orderOf(x) {
  const status = String(x.status ?? x.order_status ?? x.state ?? '');
  if (DEAD.test(status) || x.deleted_at || x.is_deleted === true) return null;
  const blob = [x.source, x.channel, x.from, x.origin, x.type, x.order_type, x.kind, x.dm_type].filter((v) => v != null).join(' ').toLowerCase();
  const src = /comment|live/.test(blob) ? 'oc' : /\bad\b|ads|advert/.test(blob) ? 'oa' : /dm|messenger|inbox|message|chat/.test(blob) ? 'om' : '';
  return {
    id: x.order_id ?? x.orderId ?? x.order_code ?? x.code ?? x.id ?? x._id ?? null,
    day: localDay(x.created_at ?? x.createdAt ?? x.order_date ?? x.date ?? x.ordered_at ?? x.time),
    pageId: String(x.page_id ?? x.pageId ?? x.fb_page_id ?? (x.page && typeof x.page === 'object' ? x.page.id : '') ?? ''),
    pageName: String(x.page_name ?? x.pageName ?? (x.page && typeof x.page === 'object' ? x.page.name : x.page) ?? ''),
    ...splitOf(typeof x.is_new === 'boolean' || x.is_new === 0 || x.is_new === 1 ? { is_new: x.is_new } : { type: x.dm_type ?? x.customer_type ?? x.type ?? '' }),
    src, total: Number(x.total ?? x.amount ?? x.grand_total) || 0,
  };
}
// Orders between two days, as rows per Page per day (same shape as the summary's rows).
async function listOrders(from, to, pageIds = []) {
  const { listUrl } = await apiConfig(); if (!listUrl) return null;
  const extra = '&per_page=500&limit=500&page_size=500';
  let got = await fetchAll(from, to, extra, listUrl); if (got === null) return null;
  let orders = got.list.map(orderOf).filter(Boolean);
  // A list without Page IDs on each order: ask for each Page separately.
  if (orders.length && orders.every((o) => !o.pageId) && pageIds.length) {
    orders = [];
    for (const pid of pageIds) {
      const g = await fetchAll(from, to, `${extra}&page_id=${encodeURIComponent(pid)}&fb_page_id=${encodeURIComponent(pid)}`, listUrl);
      for (const o of (g ? g.list : []).map(orderOf).filter(Boolean)) orders.push({ ...o, pageId: o.pageId || pid });
    }
  }
  const seen = new Set(), agg = new Map();
  for (const o of orders) {
    if (o.id != null && o.id !== '') { const k = String(o.id); if (seen.has(k)) continue; seen.add(k); }
    if (!o.day || o.day < from || o.day > to) continue;
    const k = o.day + '|' + (o.pageId || 'name:' + norm(o.pageName));
    const a = agg.get(k) || { day: o.day, pageId: o.pageId, pageName: o.pageName, orders: 0, newC: 0, oldC: 0, total: 0, oc: 0, om: 0, oa: 0, cust: 0 };
    a.orders++; a.newC += o.newC; a.oldC += o.oldC; a.total += o.total; if (o.src) a[o.src]++; if (!a.pageName) a.pageName = o.pageName;
    agg.set(k, a);
  }
  return { rows: [...agg.values()], count: seen.size || orders.length, raw: got.list.length };
}
// Page IDs to ask about when the order list needs one Page at a time: Pages seen in the summary lately.
async function knownPageIds(from, to) {
  try { const g = await fetchAll(from, to, '&group_by=page'); return [...new Set(mapRows(g ? g.list : []).map((r) => String(r.pageId || '')).filter(Boolean))]; } catch (_) { return []; }
}
// Count one period into the database, day by day (each day re-counted from scratch). One pull at a time,
// so pulls started by the timer, the button and the page never mix.
let pullChain = Promise.resolve();
function pullRange(from, to, { force = true } = {}) {
  const run = pullChain.then(() => pullRangeNow(from, to, force)); pullChain = run.catch(() => {}); return run;
}
async function pullApi(days = 3) {
  const to = sync.todayIn(); return pullRange(sync.addDays(to, -(days - 1)), to);
}
// Each day's count is kept the way adsbox.biz showed it while the day was today/yesterday (when it matches
// the adsbox Order page). Once a day is older than yesterday it is LOCKED and never fetched again, so later
// changes in adsbox's totals can't make old days wrong. Days from before this was set up are "backfill":
// fetched once from the API (may be too high) and marked as estimates.
//   dayState: { 'YYYY-MM-DD': 'fresh' | 'locked' | 'backfill' }
async function dayStates() { return (await db.getSetting('ordersDayState', {})) || {}; }
async function pullRangeNow(from, to, force) {
  let n = 0;
  const done = (await db.getSetting('ordersPulled', {})) || {}, state = await dayStates();
  const today = sync.todayIn(), yest = sync.addDays(today, -1);
  const plan = []; // days to fetch now
  for (let day = from; day <= to && day <= today; day = sync.addDays(day, 1)) {
    if (day >= yest) { plan.push(day); continue; }               // today / yesterday: always refresh
    if (state[day] === 'locked') continue;                        // kept as it was — never changes again
    if (state[day] === 'fresh') { state[day] = 'locked'; continue; } // captured while recent → lock it
    if (!force && done[day] && Date.now() - done[day] < 24 * 3600e3) continue; // backfill fetched lately
    plan.push(day);
  }
  const store = async (day, rowsOfDay) => {
    await q(`DELETE FROM page_orders WHERE source='api' AND day=$1`, [day]);
    n += await importRows(rowsOfDay, 'api');
    done[day] = Date.now(); state[day] = day >= yest ? 'fresh' : 'backfill';
  };
  try {
    if (plan.length && (await apiConfig()).listUrl) {
      const lst = await listOrders(plan[0], plan[plan.length - 1], await knownPageIds(plan[0], plan[plan.length - 1])); if (lst === null) return null;
      for (const day of plan) await store(day, lst.rows.filter((r) => r.day === day));
    } else for (const day of plan) {
      const rows = await summaryDayRows(day); if (rows === null) return null;
      await store(day, rows);
    }
    for (const d of Object.keys(done)) if (d < sync.addDays(today, -800)) delete done[d];
    for (const d of Object.keys(state)) if (d < sync.addDays(today, -800)) delete state[d];
    await db.setSetting('ordersPulled', done);
    await db.setSetting('ordersDayState', state);
    liveCache.clear();
    await db.setSetting('ordersLastError', null);
    return n;
  } catch (e) { await db.setSetting('ordersDayState', state).catch(() => {}); await db.setSetting('ordersLastError', { at: new Date().toISOString(), message: e.message }); throw e; }
}
// One day from the summary API, one row per Page.
async function summaryDayRows(day) {
  const got = await fetchAll(day, day); if (got === null) return null;
  const agg = new Map(), rows = mapRows(got.list);
  // The API filters by day: everything it sends belongs to that day (its times may be in UTC, a day off).
  // If it sends rows far from that day, it ignored the filter — then keep only rows dated that day.
  const far = rows.some((r) => r.day && (r.day < sync.addDays(day, -1) || r.day > sync.addDays(day, 1)));
  for (const r of rows) {
    if (far && r.day !== day) continue;
    r.day = day;
    const k = r.pageId + '|' + (r.pageId ? '' : r.pageName), a = agg.get(k) || { day, pageId: r.pageId, pageName: r.pageName, orders: 0, newC: 0, oldC: 0, total: 0 };
    for (const f of ['orders', 'newC', 'oldC', 'total', 'oc', 'om', 'oa', 'cust']) a[f] = (a[f] || 0) + (Number(r[f]) || 0); if (!a.pageName) a.pageName = r.pageName; agg.set(k, a);
  }
  return [...agg.values()];
}
// Compare one day: what Boost Desk kept vs what adsbox.biz's API says right now, per Page.
async function compareDay(day) {
  const cfgx = await apiConfig(); if (!cfgx.url || !cfgx.key) return null;
  let live;
  if (cfgx.listUrl) { const l = await listOrders(day, day, await knownPageIds(day, day)); live = l ? l.rows : []; }
  else live = (await summaryDayRows(day)) || [];
  const kept = (await q(`SELECT page_id, max(page_name) AS page_name, sum(orders)::int AS orders FROM page_orders WHERE day=$1 GROUP BY page_id`, [day])).rows;
  const m = new Map();
  const key = (id, name) => (id ? String(id) : 'name:' + norm(name));
  for (const r of kept) { const k = key(r.page_id.startsWith('name:') ? '' : r.page_id, r.page_name); m.set(k, { pageId: r.page_id.startsWith('name:') ? '' : r.page_id, page: r.page_name || '', kept: r.orders, live: 0 }); }
  for (const r of live) { const k = key(r.pageId, r.pageName), x = m.get(k) || { pageId: String(r.pageId || ''), page: r.pageName || '', kept: 0, live: 0 }; x.live += Number(r.orders) || 0; if (!x.page) x.page = r.pageName || ''; m.set(k, x); }
  const pages = [...m.values()].map((x) => ({ ...x, diff: x.live - x.kept })).sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff) || b.live - a.live);
  const state = (await dayStates())[day] || 'missing';
  return { day, state, kept: pages.reduce((t, x) => t + x.kept, 0), live: pages.reduce((t, x) => t + x.live, 0), pages };
}
// Take adsbox.biz's numbers as they are now for these days and keep them (the admin checked they match
// the adsbox Sales Overview). Old days are then locked again.
async function useLive(from, to) {
  const today = sync.todayIn(), yest = sync.addDays(today, -1);
  const st = await dayStates();
  for (let d = from; d <= to && d <= today; d = sync.addDays(d, 1)) delete st[d];
  await db.setSetting('ordersDayState', st);
  const n = await pullRange(from, to, { force: true });
  const st2 = await dayStates();
  for (let d = from; d <= to && d < yest; d = sync.addDays(d, 1)) if (st2[d]) st2[d] = 'locked';
  await db.setSetting('ordersDayState', st2);
  liveCache.clear();
  return n;
}
// How trustworthy a period's order numbers are: days kept from when they were recent vs. estimates.
async function periodQuality(from, to) {
  const state = await dayStates(), today = sync.todayIn();
  let kept = 0, estimate = 0, missing = 0;
  for (let d = from; d <= to && d <= today; d = sync.addDays(d, 1)) { const st = state[d]; if (st === 'locked' || st === 'fresh') kept++; else if (st === 'backfill') estimate++; else missing++; }
  return { kept, estimate, missing };
}
// Look for an order-list endpoint next to the summary one (like the Order page uses), and say what it
// returns — the status, the field names and how many rows. Never the rows themselves.
async function probeLists(from, to, pageId) {
  const { url, key } = await apiConfig(); if (!url || !key) return [];
  let origin; try { origin = new URL(url).origin; } catch (_) { return []; }
  const paths = ['/api/orders', '/api/orders/list', '/api/orders/index', '/api/v1/orders', '/api/order'];
  const out = [];
  for (const pth of paths) {
    const u = `${origin}${pth}?${dateParams(from, to)}&page_id=${encodeURIComponent(pageId)}&fb_page_id=${encodeURIComponent(pageId)}&limit=1&per_page=1`;
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 12000);
    try {
      let r = await fetch(u, { headers: { Authorization: `Bearer ${key}`, 'X-API-Key': key, Accept: 'application/json' }, signal: ctl.signal });
      // Some APIs want the key in the address instead of a header.
      if (r.status === 401) { const r2 = await fetch(`${u}&api_key=${encodeURIComponent(key)}&key=${encodeURIComponent(key)}&token=${encodeURIComponent(key)}`, { headers: { Accept: 'application/json' }, signal: ctl.signal }).catch(() => null); if (r2 && r2.status !== 401 && r2.status !== 404) { r = r2; out.keyInUrl = true; } }
      let body = null; try { body = JSON.parse(await r.text()); } catch (_) { body = null; }
      const list = body ? listOf(body) : [];
      const meta = body && !Array.isArray(body) ? (body.meta || body.pagination || body) : {};
      out.push({ path: pth, status: r.status, json: !!body, keys: body && !Array.isArray(body) ? Object.keys(body).slice(0, 12) : [], rowKeys: list[0] && typeof list[0] === 'object' ? Object.keys(list[0]).slice(0, 20) : [], total: Number(meta.total ?? meta.total_count ?? meta.count) || null });
    } catch (e) { out.push({ path: pth, status: 0, error: e.name === 'AbortError' ? 'timed out' : e.message }); }
    finally { clearTimeout(t); }
  }
  return out;
}
// "Test connection": one call for yesterday + today, report what came back (field names only, no values).
async function testApi() {
  const to = sync.addDays(sync.todayIn(), -1), from = to;
  const got = await fetchAll(from, to);
  if (got === null) throw Object.assign(new Error('Enter the API address and key first.'), { status: 400 });
  const raw = got.list, rows = mapRows(raw);
  const days = {}; for (const r of rows) days[r.day] = (days[r.day] || 0) + 1;
  const fields = raw[0] && typeof raw[0] === 'object' ? Object.keys(raw[0]) : [];
  // How the rows split by their type / status / source fields (only those short labels, never customer data).
  const breakdown = {};
  for (const x of raw) for (const [k, v] of Object.entries(x || {})) {
    if (!/type|status|source|channel|kind|state|deleted|cancel/i.test(k) || v == null || typeof v === 'object' || String(v).length > 30) continue;
    const b = (breakdown[k] = breakdown[k] || {}); b[String(v)] = (b[String(v)] || 0) + 1;
  }
  const sumField = raw.reduce((t, x) => t + (Number(x && (x.orders ?? x.count)) || 0), 0);
  // Last month two ways: rows per Page per day added up, and one total per Page for the whole month.
  let month = null;
  try {
    const t = sync.todayIn(), m1 = sync.addDays(t.slice(0, 8) + '01', -1).slice(0, 8) + '01', m2 = sync.addDays(t.slice(0, 8) + '01', -1);
    const [byDay, byPage] = await Promise.all([fetchAll(m1, m2, '&group_by=page_day'), fetchAll(m1, m2, '&group_by=page')]);
    const sum = (g) => mapRows(g.list).reduce((a, r) => a + int(r.orders), 0);
    month = { from: m1, to: m2, byDay: sum(byDay), byDayRows: byDay.list.length, byPage: sum(byPage), byPageRows: byPage.list.length, byPageGroup: byPage.groupBy, totals: byPage.totals };
    // The busiest Page, three ways: added-up days, one month total, and (if adsbox has one) its order list.
    const top = mapRows(byPage.list).sort((x, y) => int(y.orders) - int(x.orders))[0];
    if (top && top.pageId) {
      const dayRows = mapRows(byDay.list).filter((r) => String(r.pageId) === String(top.pageId));
      month.page = { id: String(top.pageId), name: top.pageName, byPage: int(top.orders), byDay: dayRows.reduce((t, r) => t + int(r.orders), 0), days: dayRows.length, messenger: int(top.om), customers: int(top.cust) };
      month.lists = await probeLists(m1, m2, String(top.pageId));
      // A working order list found and none set yet → use it from now on.
      const c = await apiConfig();
      if (!c.listUrl) {
        const ok = month.lists.find((l) => l.status === 200 && l.json && l.rowKeys && l.rowKeys.some((k) => /date|created|time/i.test(k)));
        if (ok) { const o = new URL(c.url).origin + ok.path; const cur = (await db.getSetting('adsboxApi', null)) || {}; await db.setSetting('adsboxApi', { ...cur, listUrl: o }); month.listChosen = o; liveCache.clear(); }
      }
      const c2 = await apiConfig();
      if (c2.listUrl) { try { const lst = await listOrders(m1, m2, [String(top.pageId)]); month.listUrl = c2.listUrl; month.listPage = lst ? lst.rows.filter((r) => String(r.pageId) === String(top.pageId)).reduce((t, r) => t + r.orders, 0) : null; month.listAll = lst ? lst.count : null; } catch (e) { month.listError = e.message; } }
    }
  } catch (e) { month = { error: e.message }; }
  return { month, echo: got.echo, asked: from + ' – ' + to, breakdown, pages: got.pages, total: got.total, keys: got.keys, days, rows: rows.length, rawRows: raw.length, sumField, perOrder: raw.some(isOrderRow), fields, hasPage: rows.some((r) => r.pageId || r.pageName), hasDate: rows.some((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.day)) };
}

// Boost spend per Page per day for every account: each campaign counted once (two people may sync the
// same ad account), then added up. Campaigns without a Page are counted in noPage and left out.
async function spendRows(from, to) {
  const seen = new Set(), rows = new Map(); let noPage = 0;
  for (const u of await db.allUsers()) {
    for (const d of await db.listRaw(u.fb_id, from, to)) for (const r of d.rows || []) {
      const day = r.day || d.day, spend = Number(r.spend) || 0;
      if (!day || !(spend > 0)) continue;
      const ck = `${day}|${r.accountId}|${r.campaignId || r.name}`;
      if (seen.has(ck)) continue; seen.add(ck);
      const pid = String(r.pageId || '');
      if (!pid) { noPage++; continue; } // without a Page adsbox can't match it to orders
      const k = day + '|' + pid, a = rows.get(k) || { date: day, page_id: pid, spend: 0 };
      a.spend += spend; rows.set(k, a);
    }
  }
  const list = [...rows.values()].map((r) => ({ ...r, spend: Math.round(r.spend * 100) / 100 }));
  return { list, noPage };
}
// ---------- send boost spend to adsbox.biz (POST /api/adspend/import, scope adspend.write) ----------
// Every campaign's spend per day, with its Page and ad account, so adsbox.biz can show cost per order too.
// Re-sending a day corrects it (adsbox upserts on date + page + ad account + ad id), so the last 7 days go
// out every 30 minutes. Campaigns synced by two people are sent once.
async function pushSpend(days = 7) {
  const c = await apiConfig();
  const on = await db.getSetting('adspendPush', false);
  if (!on || !c.url || !c.key) return null;
  const to = sync.todayIn(), from = sync.addDays(to, -(days - 1));
  const { list, noPage } = await spendRows(from, to);
  const out = { at: new Date().toISOString(), from, to, received: 0, saved: 0, errors: [], noPage, error: '' };
  const endpoint = new URL(c.url).origin + '/api/adspend/import';
  try {
    for (let i = 0; i < list.length; i += 1000) {
      const batch = list.slice(i, i + 1000);
      let res, body = {};
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          res = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${c.key}`, 'X-API-Key': c.key, Accept: 'application/json' }, body: JSON.stringify({ rows: batch }) });
          body = await res.json().catch(() => ({}));
          if (res.status < 500) break;
        } catch (e) { if (attempt === 2) throw new Error('Could not reach adsbox.biz: ' + e.message); }
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      }
      if (res.status === 401) throw new Error('adsbox.biz refused the API key.');
      if (res.status === 403) throw new Error('The API key cannot send spend — in adsbox.biz give it the "adspend.write" permission (Two-way).');
      if (!res.ok || body.ok === false) throw new Error(body.error || `adsbox.biz answered HTTP ${res.status}`);
      out.received += Number(body.received) || batch.length; out.saved += Number(body.saved) || 0;
      for (const e of body.errors || []) if (out.errors.length < 10) out.errors.push({ row: (Number(e.row) || 0) + i, error: String(e.error || '').slice(0, 120) });
    }
  } catch (e) { out.error = e.message; }
  await db.setSetting('adspendLastPush', out);
  if (out.error) throw new Error(out.error);
  return out;
}
async function pushStatus() { return { on: !!(await db.getSetting('adspendPush', false)), last: await db.getSetting('adspendLastPush', null) }; }
async function setPush(on) { await db.setSetting('adspendPush', !!on); return pushStatus(); }

// Orders page: per client spend (from the synced ads) next to orders, per Page; plus Pages with orders but no client.
// The period's totals straight from adsbox.biz (one call for the whole period, exactly what adsbox shows),
// kept 5 minutes. Falls back to the saved daily counts when the API can't be reached.
const liveCache = new Map();
async function liveTotals(from, to) {
  const k = from + '|' + to, hit = liveCache.get(k);
  if (hit && Date.now() - hit.at < 5 * 60e3) return hit.rows;
  let src;
  if ((await apiConfig()).listUrl) { const lst = await listOrders(from, to, await knownPageIds(from, to)); if (lst === null) return null; src = lst.rows; }
  else { const got = await fetchAll(from, to); if (got === null) return null; src = mapRows(got.list); }
  const by = new Map();
  for (const r of src) {
    const pid = String(r.pageId || '').trim() || 'name:' + norm(r.pageName);
    const a = by.get(pid) || { day: from, page_id: pid, page_name: r.pageName || '', all: 0, messenger: 0, comment: 0, ad: 0, customers: 0, new_c: 0, old_c: 0, total: 0 };
    a.all += int(r.orders); a.customers += int(r.cust); a.messenger += int(r.om); a.comment += int(r.oc); a.ad += int(r.oa); a.new_c += int(r.newC); a.old_c += int(r.oldC); a.total += Number(r.total) || 0;
    by.set(pid, a);
  }
  const rows = [...by.values()];
  liveCache.set(k, { at: Date.now(), rows }); if (liveCache.size > 50) liveCache.delete(liveCache.keys().next().value);
  return rows;
}
async function report(owner, from, to, src = 'all') {
  const col = SRC[src] || 'orders', key = SRC[src] ? src : 'all';
  // Today and yesterday are refreshed from adsbox (if not done in the last 5 minutes); everything is then read
  // from the kept daily counts.
  const today = sync.todayIn(), yest = sync.addDays(today, -1), done = (await db.getSetting('ordersPulled', {})) || {};
  if (to >= yest && (await apiConfig()).key && !(done[today] && Date.now() - done[today] < 5 * 60e3)) { try { await pullRange(yest, today, { force: false }); } catch (_) { /* show what is kept */ } }
  const live = null, given = null;
  const [d, pages, oc] = await Promise.all([sync.dashboard(owner, from, to), sync.pageSpend(owner, from, to), byClient(owner, from, to, src, given && given.length ? given : null)]);
  const split = live ? { m: live.reduce((t, r) => t + r.messenger, 0), c: live.reduce((t, r) => t + r.comment, 0), a: live.reduce((t, r) => t + r.ad, 0) }
    : (await q(`SELECT coalesce(sum(o_messenger),0)::int AS m, coalesce(sum(o_comment),0)::int AS c, coalesce(sum(o_ad),0)::int AS a FROM page_orders WHERE day BETWEEN $1 AND $2`, [from, to])).rows[0];
  const rows = given && given.length ? given : (await q(`SELECT page_id, max(page_name) AS page_name, sum(${col})::int AS orders, sum(new_c)::int AS new_c FROM page_orders WHERE day BETWEEN $1 AND $2 GROUP BY page_id`, [from, to])).rows;
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
  // The same length of time just before, for "cheaper / more expensive than before".
  let prev = null;
  try {
    const len = Math.round((Date.parse(to) - Date.parse(from)) / 864e5) + 1, pf = sync.addDays(from, -len), pt = sync.addDays(from, -1);
    const [pd, po] = await Promise.all([sync.dashboard(owner, pf, pt), byClient(owner, pf, pt, src)]);
    let ps = 0, pn = 0; for (const c of pd.clients) { const o = po.clients[c.id]; if (o && o.orders) { ps += c.spend; pn += o.orders; } }
    prev = { from: pf, to: pt, spend: Math.round(ps * 100) / 100, orders: pn };
  } catch (_) { prev = null; }
  return { from, to, live: false, prev, quality: await periodQuality(from, to), src: key, hasSplit: split.m + split.c + split.a > 0, clients, unmatched, hasData: rows.length > 0 };
}

module.exports = { compareDay, useLive, periodQuality, spendRows, pushSpend, pushStatus, setPush, liveTotals, importRows, status, byClient, pullApi, pullRange, testApi, report, publicConfig, saveApiConfig, apiConfig };
