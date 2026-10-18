// Insights: which Pages sell the most for their boost money, and why — from the synced boosts (spend, live/post,
// start time, video/photo, messages) next to the orders kept from adsbox.biz, per Page per day.
// Fixed rules, no AI: each finding is a comparison of days, shown only when there is enough data behind it.
const db = require('./db');
const sync = require('./sync');

const q = (t, p) => db.pool.query(t, p);
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const money = (n) => '$' + r2(n).toFixed(2);
const pct = (a, b) => (b ? Math.round((a - b) / b * 100) : null);
const WD = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const hourOf = (ms) => (ms == null ? null : Number(new Intl.DateTimeFormat('en-GB', { timeZone: require('./config').tz, hour: '2-digit', hour12: false }).format(new Date(ms))) % 24);
const slotOf = (h) => (h == null ? null : h < 11 ? 'morning (before 11:00)' : h < 15 ? 'midday (11:00–15:00)' : h < 18 ? 'afternoon (15:00–18:00)' : h < 21 ? 'evening (18:00–21:00)' : 'night (after 21:00)');
const wdOf = (d) => new Date(d + 'T12:00:00Z').getUTCDay();

// One period of boosts + orders, per Page per day.
async function collect(owner, from, to) {
  const raw = (await db.listRaw(owner, from, to)).flatMap((d) => (d.rows || []).map((r) => ({ ...r, day: r.day || d.day })));
  const clients = await sync.clientsWithLearnedPages(owner, raw, { save: false });
  const names = { ...(await db.getSetting('pageNames', {})) };
  for (const r of raw) if (r.page && r.pageId && !names[r.pageId]) names[r.pageId] = r.page;
  const pages = new Map(); const seen = new Set();
  const P = (key, r, c) => {
    if (!pages.has(key)) pages.set(key, { key, pageId: r.pageId || '', name: names[r.pageId] || r.page || (r.pageId ? 'Page …' + String(r.pageId).slice(-6) : 'Unknown Page'), clientId: c ? c.id : null, client: c ? c.name : '', days: {} });
    return pages.get(key);
  };
  for (const r of raw) {
    const spend = Number(r.spend) || 0; if (!(spend > 0)) continue;
    const c = sync.matchClient(r, clients); if (!c) continue;            // only this person's clients
    const ck = `${r.day}|${r.accountId}|${r.campaignId || r.name}`; if (seen.has(ck)) continue; seen.add(ck);
    const key = r.pageId || 'name:' + (r.page || c.name);
    const p = P(key, r, c);
    const d = p.days[r.day] = p.days[r.day] || { spend: 0, live: 0, post: 0, video: 0, photo: 0, messages: 0, comments: 0, campaigns: 0, starts: [], orders: null };
    const live = !sync.isPostFor(c, r);
    d.spend += spend; d.campaigns++;
    if (live) { d.live += spend; if (r.start != null) d.starts.push({ start: r.start, spend }); } else d.post += spend;
    if (/VIDEO/i.test(r.creative || '')) d.video += spend; else if (r.creative) d.photo += spend;
    d.messages += Number(r.messages) || 0; d.comments += Number(r.comments) || 0;
  }
  // Orders kept per Page per day (see orders.js) — also the days without any boost.
  const ids = [...pages.values()].map((p) => p.pageId).filter(Boolean);
  if (ids.length) {
    const rows = (await q(`SELECT day::text AS day, page_id, orders FROM page_orders WHERE day BETWEEN $1 AND $2 AND page_id = ANY($3)`, [from, to, ids])).rows;
    const byId = new Map([...pages.values()].map((p) => [p.pageId, p]));
    for (const o of rows) {
      const p = byId.get(o.page_id); if (!p) continue;
      const d = p.days[o.day] = p.days[o.day] || { spend: 0, live: 0, post: 0, video: 0, photo: 0, messages: 0, comments: 0, campaigns: 0, starts: [], orders: null };
      d.orders = (d.orders || 0) + o.orders;
    }
  }
  return [...pages.values()];
}

function totals(p) {
  const days = Object.entries(p.days);
  const t = { spend: 0, live: 0, post: 0, orders: 0, messages: 0, boostDays: 0, orderDays: 0, days: days.length };
  for (const [, d] of days) { t.spend += d.spend; t.live += d.live; t.post += d.post; t.messages += d.messages; if (d.spend > 0) t.boostDays++; if (d.orders != null) { t.orders += d.orders; t.orderDays++; } }
  t.cpo = t.orders ? t.spend / t.orders : null;
  return t;
}

// Findings for one Page: compare groups of days. Each needs at least 3 days on both sides.
function pageFindings(p) {
  const f = [];
  const days = Object.entries(p.days).filter(([, d]) => d.orders != null).map(([day, d]) => ({ day, ...d }));
  if (days.length < 5) return f;
  const boost = days.filter((d) => d.spend > 0), none = days.filter((d) => d.spend === 0);
  const cmp = (a, b) => ({ oa: avg(a.map((d) => d.orders)), ob: avg(b.map((d) => d.orders)), ca: a.reduce((s, d) => s + d.spend, 0) / Math.max(1, a.reduce((s, d) => s + d.orders, 0)), cb: b.reduce((s, d) => s + d.spend, 0) / Math.max(1, b.reduce((s, d) => s + d.orders, 0)) });

  // 1) Does boosting add orders? (boost days vs days with no boost)
  if (boost.length >= 3 && none.length >= 3) {
    const a = avg(boost.map((d) => d.orders)), b = avg(none.map((d) => d.orders));
    const lift = a - b, perDay = avg(boost.map((d) => d.spend));
    if (lift > 0) f.push({ kind: 'boost', good: true, text: `Boost works: ${Math.round(a)} orders on boost days vs ${Math.round(b)} without a boost — about ${Math.round(lift)} extra orders for ${money(perDay)} a day (${money(perDay / lift)} per extra order).` });
    else f.push({ kind: 'boost', good: false, text: `Days without a boost sold about the same (${Math.round(b)} vs ${Math.round(a)} orders) — most orders here come without the boost. Try a different post/video or audience before spending more.` });
  }
  // 2) Live vs boost post
  const liveDays = boost.filter((d) => d.live >= d.spend * 0.6), postDays = boost.filter((d) => d.post >= d.spend * 0.6);
  if (liveDays.length >= 3 && postDays.length >= 3) {
    const c = cmp(liveDays, postDays);
    const better = c.ca < c.cb ? 'live' : 'post', diff = Math.round(Math.abs(c.ca - c.cb) / Math.max(c.ca, c.cb) * 100);
    if (diff >= 15) f.push({ kind: 'type', good: true, text: `${better === 'live' ? 'Boosted lives' : 'Boosted posts'} sell cheaper: ${money(better === 'live' ? c.ca : c.cb)} per order vs ${money(better === 'live' ? c.cb : c.ca)} on ${better === 'live' ? 'post' : 'live'} days (${diff}% cheaper). Put more of the budget into ${better === 'live' ? 'lives' : 'posts'}.` });
    else f.push({ kind: 'type', good: null, text: `Lives and posts cost about the same per order here (${money(c.ca)} vs ${money(c.cb)}).` });
  }
  // 3) Spend level: do bigger days still pay?
  if (boost.length >= 6) {
    const m = median(boost.map((d) => d.spend)), hi = boost.filter((d) => d.spend > m), lo = boost.filter((d) => d.spend <= m);
    if (hi.length >= 3 && lo.length >= 3) {
      const sH = avg(hi.map((d) => d.spend)), sL = avg(lo.map((d) => d.spend)), oH = avg(hi.map((d) => d.orders)), oL = avg(lo.map((d) => d.orders));
      const extra = oH - oL, cost = sH - sL;
      if (extra <= 0) f.push({ kind: 'budget', good: false, text: `Spending more didn't bring more orders: ${money(sH)} days sold ${Math.round(oH)} vs ${Math.round(oL)} on ${money(sL)} days. Keep the budget near ${money(sL)} a day.` });
      else {
        const marginal = cost / extra, base = (sL * lo.length + sH * hi.length) / Math.max(1, lo.reduce((s, d) => s + d.orders, 0) + hi.reduce((s, d) => s + d.orders, 0));
        if (marginal > base * 2) f.push({ kind: 'budget', good: false, text: `Bigger days get expensive: the extra spend on ${money(sH)} days costs ${money(marginal)} per extra order (vs ${money(base)} on average). Around ${money(sL)}–${money(m)} a day works best.` });
        else f.push({ kind: 'budget', good: true, text: `More budget still pays: ${money(sH)} days sold ${Math.round(oH)} orders vs ${Math.round(oL)} on ${money(sL)} days — ${money(marginal)} per extra order. Room to spend more.` });
      }
    }
  }
  // 4) Live start time (days with lives, by the slot of their first live)
  const slots = {};
  for (const d of liveDays) { const first = d.starts.sort((a, b) => a.start - b.start)[0]; const s = first && slotOf(hourOf(first.start)); if (s) (slots[s] = slots[s] || []).push(d); }
  const slotList = Object.entries(slots).filter(([, a]) => a.length >= 3).map(([s, a]) => ({ s, n: a.length, cpo: a.reduce((x, d) => x + d.spend, 0) / Math.max(1, a.reduce((x, d) => x + d.orders, 0)), orders: avg(a.map((d) => d.orders)) })).sort((a, b) => a.cpo - b.cpo);
  if (slotList.length >= 2) f.push({ kind: 'time', good: true, text: `Best live time: ${slotList[0].s} — ${money(slotList[0].cpo)} per order (${slotList[0].n} days) vs ${money(slotList[slotList.length - 1].cpo)} in the ${slotList[slotList.length - 1].s.split(' (')[0]}.` });
  // 5) Weekday
  const wd = {}; for (const d of days) if (/^\d{4}-\d{2}-\d{2}$/.test(d.day)) (wd[wdOf(d.day)] = wd[wdOf(d.day)] || []).push(d.orders);
  const wdl = Object.entries(wd).filter(([, a]) => a.length >= 2).map(([k, a]) => ({ k: Number(k), o: avg(a) })).sort((a, b) => b.o - a.o);
  if (wdl.length >= 5 && wdl[0].o > wdl[wdl.length - 1].o * 1.3) f.push({ kind: 'day', good: null, text: `Sells most on ${WD[wdl[0].k]} (${Math.round(wdl[0].o)} orders on average) and least on ${WD[wdl[wdl.length - 1].k]} (${Math.round(wdl[wdl.length - 1].o)}). Plan the bigger lives for ${WD[wdl[0].k]}.` });
  // 6) Video vs photo posts
  const vid = postDays.filter((d) => d.video >= d.post * 0.6), pho = postDays.filter((d) => d.photo >= d.post * 0.6);
  if (vid.length >= 3 && pho.length >= 3) {
    const c = cmp(vid, pho), better = c.ca < c.cb ? 'Video' : 'Photo';
    f.push({ kind: 'creative', good: true, text: `${better} posts sell cheaper: ${money(Math.min(c.ca, c.cb))} vs ${money(Math.max(c.ca, c.cb))} per order.` });
  }
  // 7) Messages → orders
  const msgs = boost.reduce((s, d) => s + d.messages, 0), ords = boost.reduce((s, d) => s + d.orders, 0);
  if (msgs >= 30 && ords > 0) {
    const rate = Math.round(ords / msgs * 100);
    f.push({ kind: 'chat', good: rate >= 30, text: `${rate}% of new chats from the boosts became orders (${ords} orders from ${msgs} chats).${rate < 30 ? ' Many people message but don’t order — check reply speed and prices in the chat.' : ''}` });
  }
  return f;
}

async function analyze(owner, from, to) {
  const len = Math.round((Date.parse(to) - Date.parse(from)) / 864e5) + 1;
  const pf = sync.addDays(from, -len), pt = sync.addDays(from, -1);
  const [now, prev, state] = await Promise.all([collect(owner, from, to), collect(owner, pf, pt), db.getSetting('ordersDayState', {})]);
  const prevBy = new Map(prev.map((p) => [p.key, totals(p)]));
  const list = now.map((p) => {
    const t = totals(p), pv = prevBy.get(p.key);
    return { key: p.key, pageId: p.pageId, name: p.name, client: p.client, clientId: p.clientId, ...t, prev: pv ? { orders: pv.orders, spend: r2(pv.spend), cpo: pv.cpo } : null,
      trend: pv && pv.orders ? pct(t.orders, pv.orders) : null, cpoTrend: pv && pv.cpo && t.cpo ? pct(t.cpo, pv.cpo) : null, findings: pageFindings(p) };
  }).filter((p) => p.spend > 0 || p.orders > 0);
  // Labels against the middle of all Pages
  const withO = list.filter((p) => p.orders > 0 && p.spend > 0), mCpo = median(withO.map((p) => p.cpo)), mOrd = median(withO.map((p) => p.orders)), mSp = median(list.map((p) => p.spend));
  for (const p of list) {
    if (!p.orders || !p.spend) p.label = p.spend > 0 ? (p.orderDays ? 'no-orders' : 'no-data') : 'organic';
    else if (p.cpo <= mCpo && p.orders >= mOrd) p.label = 'star';
    else if (p.cpo <= mCpo) p.label = 'grow';
    else if (p.cpo > mCpo * 1.5 && p.spend >= mSp) p.label = 'fix';
    else p.label = 'ok';
    for (const k of ['spend', 'live', 'post']) p[k] = r2(p[k]);
    p.cpo = p.cpo != null ? r2(p.cpo) : null;
  }
  list.sort((a, b) => b.orders - a.orders || b.spend - a.spend);

  // Findings across all Pages (same comparisons, all Page-days together)
  const all = { key: 'all', days: {} }; let i = 0;
  for (const p of now) for (const [day, d] of Object.entries(p.days)) all.days[day + '#' + (i++)] = d;
  const overall = pageFindings(all).filter((x) => x.kind !== 'day'); // weekday needs one Page's own dates
  const tot = list.reduce((a, p) => ({ spend: a.spend + p.spend, orders: a.orders + p.orders }), { spend: 0, orders: 0 });
  let kept = 0, est = 0; for (let d = from; d <= to && d <= sync.todayIn(); d = sync.addDays(d, 1)) { const s = (state || {})[d]; if (s === 'locked' || s === 'fresh') kept++; else est++; }
  const best = withO.length ? [...withO].sort((a, b) => a.cpo - b.cpo)[0] : null;
  return { from, to, prevFrom: pf, prevTo: pt, pages: list, overall, medianCpo: r2(mCpo), totals: { spend: r2(tot.spend), orders: tot.orders, cpo: tot.orders ? r2(tot.spend / tot.orders) : null },
    best: best ? { name: best.name, cpo: r2(best.cpo) } : null, quality: { kept, estimate: est } };
}

module.exports = { analyze };
