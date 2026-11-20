// Boost Desk counts orders itself (Nov 2026) instead of reading them from adsbox.biz.
//
// How: a team member connects the Facebook Pages they manage (Orders → Connect Pages). Boost Desk keeps each Page's
// token encrypted and subscribes the Page to this app, so Facebook sends every new Messenger message and comment to
// /hooks/meta. During a Live, the Live's comments are also read every minute (Facebook does not always send those).
//
// Rule (same as adsbox.biz): no phone = no order. One order per customer per Page per calendar day (Phnom Penh time):
// the same Facebook person, or the same phone, on the same day is one order; tomorrow is a new order.
//
// Only counts are kept. Never names, phones, addresses or message text: a customer is stored as a keyed hash of their
// phone (and of their Facebook id), so "new / old customer" and same-day duplicates can be told apart without
// keeping the number. Daily counts go into page_orders (source 'own'), so the Orders page, client pages, the Dashboard
// and cost per order keep working unchanged.
const crypto = require('crypto');
const cfg = require('./config');
const db = require('./db');
const meta = require('./meta');
const { encrypt, decrypt } = require('./crypto');
const { extractPhone } = require('./orderDetect');

const q = (text, params) => db.pool.query(text, params);
const GRAPH = `https://graph.facebook.com/${cfg.graphVersion}`;
const PAGE_SCOPES = 'pages_show_list,pages_messaging,pages_read_engagement,pages_manage_metadata,pages_read_user_content,business_management';
const FIELDS = 'messages,feed';

async function init() {
  await q(`
    CREATE TABLE IF NOT EXISTS page_links (          -- Facebook Pages connected for order counting
      page_id TEXT PRIMARY KEY,
      page_name TEXT NOT NULL DEFAULT '',
      token_enc TEXT NOT NULL,
      connected_by TEXT NOT NULL DEFAULT '',
      connected_name TEXT NOT NULL DEFAULT '',
      connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      subscribed BOOLEAN NOT NULL DEFAULT false,
      last_event_at TIMESTAMPTZ,
      last_order_at TIMESTAMPTZ,
      last_error TEXT NOT NULL DEFAULT '',
      live_id TEXT NOT NULL DEFAULT '',
      live_since BIGINT NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS page_order_hits (     -- one row = one order; no customer data, only keyed hashes
      page_id TEXT NOT NULL,
      day DATE NOT NULL,
      cust_key TEXT NOT NULL,                        -- hash of the phone
      sender_key TEXT NOT NULL DEFAULT '',           -- hash of the Facebook person ('' when Facebook hides who commented)
      src TEXT NOT NULL,                             -- 'messenger' | 'comment'
      first_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (page_id, day, cust_key)
    );
    CREATE INDEX IF NOT EXISTS page_order_hits_sender ON page_order_hits (page_id, day, sender_key);
    CREATE TABLE IF NOT EXISTS page_customers (      -- first day each customer ordered on a Page (for new / old)
      page_id TEXT NOT NULL,
      cust_key TEXT NOT NULL,
      first_day DATE NOT NULL,
      PRIMARY KEY (page_id, cust_key)
    );
  `);
  // Switched on at release (Owner's choice, 20 Nov 2026): from today, orders come from Boost Desk, not adsbox.biz.
  // Days before this keep adsbox.biz's numbers. An owner can switch back on the Orders page.
  if (!(await db.getSetting('ordersOwn', null))) await db.setSetting('ordersOwn', { on: true, since: today(), at: new Date().toISOString(), by: 'release' });
}

const today = () => require('./sync').todayIn();
const dayOf = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: cfg.tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
async function mode() { return (await db.getSetting('ordersOwn', null)) || { on: false }; }
async function setMode(on, by) { const cur = await mode(); const next = { ...cur, on: !!on, at: new Date().toISOString(), by }; if (on && !cur.since) next.since = today(); await db.setSetting('ordersOwn', next); return next; }

// A random secret kept in the database, so hashes can't be turned back into phone numbers by trying every number.
let salt = null;
async function hashKey(kind, value) {
  if (!salt) {
    let s = await db.getSetting('ordersHashSalt', null);
    if (!s) { s = crypto.randomBytes(32).toString('hex'); await db.setSetting('ordersHashSalt', s); }
    salt = s;
  }
  return crypto.createHmac('sha256', salt).update(kind + ':' + value).digest('base64url').slice(0, 32);
}
async function verifyToken() {
  let t = await db.getSetting('metaHookToken', null);
  if (!t) { t = 'bdv_' + crypto.randomBytes(16).toString('base64url'); await db.setSetting('metaHookToken', t); }
  return t;
}

// ---------- counting ----------
const dirty = new Set(); let flushTimer = null;
// One message or comment. Returns true when it became a new order.
async function record({ pageId, senderId, text, src, at }) {
  pageId = String(pageId || ''); senderId = String(senderId || '');
  if (!pageId || !text || (senderId && senderId === pageId)) return false; // the Page's own replies never count
  const phone = extractPhone(text); if (!phone) return false;
  const link = (await q('SELECT page_id FROM page_links WHERE page_id=$1', [pageId])).rows[0]; if (!link) return false;
  const day = dayOf(at || Date.now()), m = await mode();
  if (!m.on || (m.since && day < m.since)) return false;
  const cust = await hashKey('phone', phone), sender = senderId ? await hashKey('fb', pageId + ':' + senderId) : '';
  // Same Facebook person already ordered on this Page today (maybe with another phone) → still one order.
  if (sender && (await q('SELECT 1 FROM page_order_hits WHERE page_id=$1 AND day=$2 AND sender_key=$3 LIMIT 1', [pageId, day, sender])).rowCount) return false;
  const ins = await q(`INSERT INTO page_order_hits (page_id, day, cust_key, sender_key, src) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [pageId, day, cust, sender, src === 'comment' ? 'comment' : 'messenger']);
  if (!ins.rowCount) return false;
  await q('INSERT INTO page_customers (page_id, cust_key, first_day) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [pageId, cust, day]);
  await q('UPDATE page_links SET last_order_at=now() WHERE page_id=$1', [pageId]);
  dirty.add(pageId + '|' + day);
  if (!flushTimer) flushTimer = setTimeout(() => { flushTimer = null; flush().catch((e) => console.error('[own orders] count:', e.message)); }, 3000);
  return true;
}
// Re-count the touched Page-days into page_orders (the table every screen reads).
async function flush() {
  const list = [...dirty]; dirty.clear();
  for (const k of list) { const [pageId, day] = k.split('|'); await rollup(pageId, day); }
  if (list.length) await db.setSetting('ordersLastImport', { at: new Date().toISOString(), rows: list.length, source: 'own' });
}
async function rollup(pageId, day) {
  const r = (await q(`SELECT count(*)::int AS orders,
      count(*) FILTER (WHERE c.first_day = h.day)::int AS new_c,
      count(*) FILTER (WHERE h.src = 'comment')::int AS oc,
      count(*) FILTER (WHERE h.src = 'messenger')::int AS om
    FROM page_order_hits h LEFT JOIN page_customers c ON c.page_id = h.page_id AND c.cust_key = h.cust_key
    WHERE h.page_id = $1 AND h.day = $2`, [pageId, day])).rows[0];
  const name = ((await q('SELECT page_name FROM page_links WHERE page_id=$1', [pageId])).rows[0] || {}).page_name || '';
  await q(`INSERT INTO page_orders (day, page_id, page_name, orders, new_c, old_c, total, source, o_comment, o_messenger, o_ad, customers, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,0,'own',$7,$8,0,$4,now())
           ON CONFLICT (day, page_id) DO UPDATE SET page_name=COALESCE(NULLIF($3,''), page_orders.page_name), orders=$4, new_c=$5, old_c=$6, total=0, source='own', o_comment=$7, o_messenger=$8, o_ad=0, customers=$4, updated_at=now()`,
    [day, pageId, name, r.orders, r.new_c, r.orders - r.new_c, r.oc, r.om]);
  const st = (await db.getSetting('ordersDayState', {})) || {}; if (st[day] !== 'fresh') { st[day] = 'fresh'; await db.setSetting('ordersDayState', st); }
}
// When counting starts on a Page today, today's old adsbox.biz number for it is replaced by Boost Desk's own count.
async function startPageDay(pageId) { const m = await mode(); if (m.on) await rollup(pageId, today()); }

// ---------- Facebook webhook (/hooks/meta) ----------
function signatureOk(raw, header) {
  if (!raw || !header || !String(header).startsWith('sha256=')) return false;
  const want = 'sha256=' + crypto.createHmac('sha256', cfg.fbAppSecret).update(raw).digest('hex');
  return want.length === String(header).length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(String(header)));
}
async function handleHook(body) {
  if (!body || body.object !== 'page') return 0;
  let n = 0;
  for (const e of body.entry || []) {
    const pageId = String(e.id || '');
    if (pageId) await q('UPDATE page_links SET last_event_at=now() WHERE page_id=$1', [pageId]).catch(() => {});
    for (const m of e.messaging || []) {
      if (!m.message || m.message.is_echo || !m.message.text) continue;
      if (await record({ pageId: (m.recipient && m.recipient.id) || pageId, senderId: m.sender && m.sender.id, text: m.message.text, src: 'messenger', at: m.timestamp })) n++;
    }
    for (const c of e.changes || []) {
      const v = c.value || {};
      if (c.field !== 'feed' || v.item !== 'comment' || v.verb !== 'add' || !v.message) continue;
      if (await record({ pageId, senderId: v.from && v.from.id, text: v.message, src: 'comment', at: v.created_time ? Number(v.created_time) * 1000 : Date.now() })) n++;
    }
  }
  return n;
}

// ---------- Live comments (every minute) ----------
// For each connected Page with a Live running now, read the comments since the last check.
async function pollLives() {
  const m = await mode(); if (!m.on) return 0;
  let n = 0;
  for (const p of (await q('SELECT * FROM page_links WHERE subscribed')).rows) {
    let token; try { token = decrypt(p.token_enc); } catch (_) { continue; }
    try {
      const lives = await meta.get(`/${p.page_id}/live_videos`, { broadcast_status: ['LIVE'], fields: 'id', limit: 3 }, token);
      const live = (lives.data || [])[0];
      if (!live) { if (p.live_id) await q(`UPDATE page_links SET live_id='', live_since=0 WHERE page_id=$1`, [p.page_id]); continue; }
      const since = p.live_id === live.id ? Number(p.live_since) || 0 : 0;
      let newest = since, url = null, pages = 0;
      do {
        const body = url ? await meta.get(url, {}, token) : await meta.get(`/${live.id}/comments`, { fields: 'id,from{id},message,created_time', order: 'reverse_chronological', limit: 100, filter: 'stream' }, token);
        let older = false;
        for (const c of body.data || []) {
          const t = Date.parse(c.created_time) || 0;
          if (t <= since) { older = true; break; }
          newest = Math.max(newest, t);
          if (await record({ pageId: p.page_id, senderId: c.from && c.from.id, text: c.message, src: 'comment', at: t })) n++;
        }
        url = !older && body.paging && body.paging.next ? (() => { const u = new URL(body.paging.next); u.searchParams.delete('access_token'); u.searchParams.delete('appsecret_proof'); return u.toString(); })() : null;
      } while (url && ++pages < 10);
      await q(`UPDATE page_links SET live_id=$2, live_since=$3, last_error='' WHERE page_id=$1`, [p.page_id, live.id, newest]);
    } catch (e) {
      await q('UPDATE page_links SET last_error=$2 WHERE page_id=$1', [p.page_id, String(e.message).slice(0, 300)]);
    }
  }
  return n;
}

// ---------- connecting Pages ----------
function connectUrl(state) {
  const qs = [['client_id', cfg.fbAppId], ['redirect_uri', `${cfg.baseUrl}/auth/facebook/callback`], ['response_type', 'code'], ['scope', PAGE_SCOPES], ['state', state]]
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  return `https://www.facebook.com/${cfg.graphVersion}/dialog/oauth?${qs}`;
}
async function post(path, params, token) {
  const body = new URLSearchParams({ ...params, access_token: token, appsecret_proof: crypto.createHmac('sha256', cfg.fbAppSecret).update(token).digest('hex') });
  const res = await fetch(GRAPH + path, { method: 'POST', body });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.error) throw new Error((j.error && (j.error.error_user_msg || j.error.message)) || 'Facebook answered HTTP ' + res.status);
  return j;
}
async function del(path, token) {
  const res = await fetch(`${GRAPH}${path}?access_token=${encodeURIComponent(token)}&appsecret_proof=${crypto.createHmac('sha256', cfg.fbAppSecret).update(token).digest('hex')}`, { method: 'DELETE' });
  return res.ok;
}
// After the person allowed the Page permissions: every Page they manage is saved and subscribed.
async function connectFromUserToken(userToken, person) {
  const granted = ((await meta.get('/me/permissions', {}, userToken)).data || []).filter((p) => p.status === 'granted').map((p) => p.permission);
  const missing = ['pages_messaging', 'pages_read_engagement', 'pages_manage_metadata'].filter((p) => !granted.includes(p));
  const pages = [];
  let after = '';
  for (let i = 0; i < 20; i++) {
    const b = await meta.get('/me/accounts', { fields: 'id,name,access_token,tasks', limit: 100, ...(after ? { after } : {}) }, userToken);
    pages.push(...(b.data || []));
    after = b.paging && b.paging.next && b.paging.cursors ? b.paging.cursors.after : ''; if (!after) break;
  }
  const out = { connected: [], failed: [], missing };
  for (const p of pages) {
    if (!p.access_token) continue;
    let subscribed = false, err = '';
    try { await post(`/${p.id}/subscribed_apps`, { subscribed_fields: FIELDS }, p.access_token); subscribed = true; } catch (e) { err = e.message; }
    await q(`INSERT INTO page_links (page_id, page_name, token_enc, connected_by, connected_name, connected_at, subscribed, last_error)
             VALUES ($1,$2,$3,$4,$5,now(),$6,$7)
             ON CONFLICT (page_id) DO UPDATE SET page_name=$2, token_enc=$3, connected_by=$4, connected_name=$5, connected_at=now(), subscribed=$6, last_error=$7`,
      [p.id, String(p.name || '').slice(0, 150), encrypt(p.access_token), person.id, String(person.name || '').slice(0, 100), subscribed, err.slice(0, 300)]);
    (subscribed ? out.connected : out.failed).push({ id: p.id, name: p.name, error: err });
    if (subscribed) await startPageDay(p.id).catch(() => {});
  }
  return out;
}
async function disconnect(pageId) {
  const p = (await q('SELECT token_enc FROM page_links WHERE page_id=$1', [pageId])).rows[0]; if (!p) return false;
  try { await del(`/${pageId}/subscribed_apps`, decrypt(p.token_enc)); } catch (_) { /* still forget it here */ }
  await q('DELETE FROM page_links WHERE page_id=$1', [pageId]);
  return true;
}
// Pages for the Orders page. Admins see all; others see the Pages they connected.
async function list(fbId, all) {
  const rows = (await q(`SELECT l.page_id, l.page_name, l.connected_name, l.connected_by, l.connected_at, l.subscribed, l.last_event_at, l.last_order_at, l.last_error, (l.live_id <> '') AS live,
      coalesce((SELECT count(*) FROM page_order_hits h WHERE h.page_id = l.page_id AND h.day = $1), 0)::int AS today
    FROM page_links l ${all ? '' : 'WHERE l.connected_by = $2'} ORDER BY l.page_name`, all ? [today()] : [today(), fbId])).rows;
  return { mode: await mode(), pages: rows, hookUrl: `${cfg.baseUrl}/hooks/meta`, verifyToken: all ? await verifyToken() : undefined };
}

module.exports = { init, mode, setMode, record, flush, handleHook, signatureOk, verifyToken, pollLives, connectUrl, connectFromUserToken, disconnect, list, PAGE_SCOPES };
