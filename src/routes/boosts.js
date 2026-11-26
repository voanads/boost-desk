// Boosts: one row per post in a boost plan, and Live boosts
// Moved out of server.js unchanged; server.js mounts it at the same place, so route order is kept.
const db = require('../db');
const lives = require('../lives');
const sync = require('../sync');

module.exports = function mountBoosts(app, api, deps) {
  const { wrap } = deps;
  // ---- Boosts (20 Nov 2026): one row per post in a boost plan, across every client — the team's old status sheet, filled by itself ----
  // A row's state comes from its dates (new / active / ended); "no spend" is the client's status finding (plan runs, nothing spent).
  // Spend is known per client, not per post, so the plan's progress is the client's and is the same on each of its rows.
  api.get('/boosts', wrap(async (req, res) => {
    const owner = req.user.fb_id, today = sync.todayIn(), st = await deps.STATUS().forOwner({ fb_id: owner, name: req.user.name }), by = Object.fromEntries(st.clients.map((x) => [x.id, x])), rows = [];
    // today's campaigns from Meta (as synced): a post linked to its campaign gets its own spend, and post campaigns that are in
    // no plan yet are offered as "found on Meta" so a plan line can be added in one step
    const raw = {}; try { for (const r of (await db.getRaw(owner, today)) || []) if (r.campaignId) raw[String(r.campaignId)] = r; } catch (_) {}
    const all = (await db.listClients(owner)).filter((x) => !x.archived), linked = new Set(all.flatMap((c) => ((c.plan && c.plan.lines) || []).map((l) => l.camp).filter(Boolean))), found = [];
    for (const c of all) {
      const x = by[c.id] || {}, lines = (c.plan && c.plan.lines) || [];
      try { const e = await db.getEntry(owner, today, c.id); for (const id of ((e && e.post && e.post.ids) || []).map(String)) { const r = raw[id]; if (r && !linked.has(id) && Number(r.spend) > 0) found.push({ clientId: c.id, client: c.name, camp: id, name: r.name || '', account: r.accountId || '', accountName: r.account || '', spend: Math.round(Number(r.spend) * 100) / 100 }); } } catch (_) {}
      lines.forEach((l, i) => {
        const end = l.start ? sync.addDays(l.start, Math.max(1, Number(l.days) || 1) - 1) : '', state = !l.start ? 'nodate' : l.start > today ? 'new' : end < today ? 'ended' : 'active';
        rows.push({ clientId: c.id, client: c.name, i, post: l.post || `Post ${i + 1}`, link: l.link || '', daily: Number(l.daily) || 0, days: Number(l.days) || 0, budget: Math.round((Number(l.daily) || 0) * (Number(l.days) || 0) * 100) / 100,
          account: l.accountName || l.account || '', start: l.start || '', end, left: end ? Math.round((Date.parse(end) - Date.parse(today)) / 864e5) : null, state,
          noSpend: state === 'active' && (x.reasons || []).some((r) => r.kind === 'noboost'), sent: l.sent || (c.plan.sentAt && !lines.some((y) => y.sent) ? c.plan.sentAt : ''),
          camp: l.camp || '', auto: l.auto || '', campSpend: l.camp && raw[l.camp] ? Math.round(Number(raw[l.camp].spend) * 100) / 100 : null, postToday: x.postToday || 0, level: x.level || 'ok', planPct: x.plan ? x.plan.pct : null, planSpent: x.plan ? x.plan.spent : null, planBudget: x.plan ? x.plan.budget : null, telegram: !!c.telegram });
      });
    }
    // only clients that boost posts: a client that spends on Live only today has its own table (Live boosts) and needs no plan
    const noPlan = st.clients.filter((x) => x.level !== 'idle' && !(x.spend > 0 && !(x.postToday > 0)) && !(rows.some((r) => r.clientId === x.id && (r.state === 'active' || r.state === 'new')))).map((x) => ({ id: x.id, name: x.name, spend: x.spend }));
    res.json({ today, rows, noPlan, found: found.sort((a, b) => b.spend - a.spend) });
  }));
  // Live boosts (20 Nov 2026): one row per boosted Live of the last 7 days, next to the post table. A Live has no plan, no end
  // date and no $ per day, so it gets its own columns: start time, budget on Meta, spend, comments, messages, report sent.
  api.get('/boosts/lives', wrap(async (req, res) => {
    const owner = req.user.fb_id, today = sync.todayIn(), from = sync.addDays(today, -6), now = Date.now();
    const list = await lives.listLives(owner, from, today);
    let setups = {}; try { setups = await lives.setupsFor({ fb_id: owner }, list.flatMap((l) => l.campaigns), { fetch: false }); } catch (_) {}
    const acc = {}; try { for (const a of await db.listAccounts(owner)) acc[String(a.id).replace(/^act_/, '')] = a; } catch (_) {}
    const sentOf = {}, rows = [];
    // Orders in one Live (20 Nov 2026): orders Boost Desk counted itself on the Live's Page from its start until one hour after
    // the boost stops (or until the Page's next Live). Only for connected Pages and days since own counting began; else null.
    // An order from a post boosted on the same Page in those hours is counted too — the Page and the time are all that is known.
    let linked = new Set(), ownSince = null;
    try { const m = await require('../pageOrders').mode(); if (m.on) { ownSince = m.since || today; linked = new Set((await db.pool.query('SELECT page_id FROM page_links')).rows.map((r) => String(r.page_id))); } } catch (_) {}
    const ordersIn = async (l) => {
      if (!ownSince || l.day < ownSince || !l.pageId || !linked.has(l.pageId) || l.start == null) return null;
      const next = list.filter((x) => x.pageId === l.pageId && x.start != null && x.start > l.start).map((x) => x.start).sort((a, b) => a - b)[0];
      const to = Math.min((l.end != null ? l.end : l.start + 3 * 3600e3) + 3600e3, next || Infinity);
      try { return (await db.pool.query('SELECT count(*)::int AS n FROM page_order_hits WHERE page_id=$1 AND first_at >= $2 AND first_at < $3', [l.pageId, new Date(l.start), new Date(to)])).rows[0].n; } catch (_) { return null; }
    };
    for (const l of list) {
      const k = l.clientId + '|' + l.day;
      if (!(k in sentOf)) { try { const e = await db.getEntry(owner, l.day, l.clientId); sentOf[k] = (e && e.reportSent && e.reportSent.at) || ''; } catch (_) { sentOf[k] = ''; } }
      const ids = [...new Set(l.campaigns.map((c) => String(c.accountId || '').replace(/^act_/, '')).filter(Boolean))];
      // the budget is only shown when every campaign of the Live has one on Meta and the account is in USD
      const bs = l.campaigns.map((c) => { const s = setups[c.id], a = acc[String(c.accountId || '').replace(/^act_/, '')]; const usd = a && ((a.info || {}).currency || a.currency || '') === 'USD'; return s && usd ? Number(s.lifetimeBudget) || Number(s.dailyBudget) || 0 : 0; });
      rows.push({ key: l.key, clientId: l.clientId, client: l.client, page: l.page, day: l.day, time: l.time, start: l.start, spend: l.spend, comments: l.comments, messages: l.messages, perComment: l.perComment,
        camps: l.campaigns.length, account: ids.map((id) => (acc[id] && acc[id].name) || 'act_' + id).join(', '), budget: bs.length && bs.every((b) => b > 0) ? Math.round(bs.reduce((a, b) => a + b, 0) * 100) / 100 : null,
        orders: await ordersIn(l), state: l.day !== today || (l.end != null && l.end <= now) ? 'ended' : l.end != null ? 'on' : '', sent: sentOf[k] });
    }
    rows.sort((a, b) => String(b.day).localeCompare(String(a.day)) || (b.start || 0) - (a.start || 0));
    res.json({ today, yesterday: sync.addDays(today, -1), rows });
  }));
};
