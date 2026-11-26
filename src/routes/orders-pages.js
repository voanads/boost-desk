// AI status, orders compare / Pages / pull / report, and Live or Post by hand
// Moved out of server.js unchanged; server.js mounts it at the same place, so route order is kept.
const db = require('../db');
const orders = require('../orders');
const pageOrders = require('../pageOrders');
const sync = require('../sync');

module.exports = function mountOrdersPages(app, api, deps) {
  const { adminOnly, canSeeAdmin, isDay, ownerOnly, wrap } = deps;
  api.get('/ai/status', wrap(async (req, res) => { const c = await require('../ai').publicConfig(); res.json({ hasKey: c.hasKey }); }));
  api.put('/admin/ai', ownerOnly, wrap(async (req, res) => res.json(await require('../ai').saveKey((req.body || {}).key === null ? null : String((req.body || {}).key || ''), req.user.name))));
  // Check one day against adsbox.biz (admins), and take adsbox's numbers for a period when they match its Sales Overview.
  api.get('/orders/compare', adminOnly, wrap(async (req, res) => {
    const day = String(req.query.day || ''); if (!isDay(day)) return res.status(400).json({ error: 'Pick a day.' });
    const r = await orders.compareDay(day); if (!r) return res.status(400).json({ error: 'Connect the adsbox.biz API first.' }); res.json(r);
  }));
  api.post('/orders/use-live', adminOnly, wrap(async (req, res) => {
    const { from, to } = req.body || {}, today = sync.todayIn();
    if (!isDay(from) || !isDay(to) || from > to || (Date.parse(to) - Date.parse(from)) / 864e5 > 92) return res.status(400).json({ error: 'Pick up to 3 months.' });
    const n = await orders.useLive(from, to > today ? today : to); if (n === null) return res.status(400).json({ error: 'Connect the adsbox.biz API first.' }); res.json({ ok: true, rows: n });
  }));
  // Boost Desk's own order counting: connected Pages, and the switch between it and adsbox.biz.
  api.get('/orders/pages', wrap(async (req, res) => { res.json(await pageOrders.list(req.user.fb_id, await canSeeAdmin(req.user.fb_id))); }));
  api.delete('/orders/pages/:id', wrap(async (req, res) => {
    if (req.user.buyer) return res.status(403).json({ error: 'Ask your PM.' });
    const id = String(req.params.id || ''); if (!/^\d{5,30}$/.test(id)) return res.status(400).json({ error: 'Pick a Page.' });
    const row = (await db.pool.query('SELECT connected_by FROM page_links WHERE page_id=$1', [id])).rows[0];
    if (!row) return res.status(404).json({ error: 'That Page is not connected.' });
    if (row.connected_by !== req.user.fb_id && !(await canSeeAdmin(req.user.fb_id))) return res.status(403).json({ error: 'Only the person who connected it or an admin can remove it.' });
    await pageOrders.disconnect(id); res.json({ ok: true });
  }));
  api.put('/orders/own', ownerOnly, wrap(async (req, res) => res.json(await pageOrders.setMode(!!(req.body || {}).on, req.user.name))));
  api.post('/orders/test', adminOnly, wrap(async (req, res) => res.json(await orders.testApi())));
  api.post('/orders/pull', wrap(async (req, res) => {
    if ((await pageOrders.mode()).on) { await pageOrders.flush(); return res.json({ ok: true, own: true }); } // counted live by Boost Desk; nothing to fetch
    const b = req.body || {}, today = sync.todayIn();
    let n;
    if (isDay(b.from) && isDay(b.to) && b.from <= b.to && b.from >= sync.addDays(today, -800)) n = await orders.pullRange(b.from, b.to > today ? today : b.to, { force: !!b.force });
    else n = await orders.pullApi(Math.min(62, Number(b.days) || 7)); if (n === null) return res.status(400).json({ error: 'Connect the adsbox.biz API first (Orders page → API settings).' }); res.json({ ok: true, rows: n }); }));
  api.get('/orders/report', wrap(async (req, res) => {
    const { from, to } = req.query;
    if (!isDay(from) || !isDay(to) || from > to) return res.status(400).json({ error: 'Pick a valid period.' });
    res.json(await orders.report(req.user.fb_id, from, to, String(req.query.src || 'all')));
  }));

  // Set a campaign to Live or Post by hand (kind: 'live' | 'post' | null to go back to automatic), then recount.
  api.put('/kind-override', wrap(async (req, res) => {
    const id = String((req.body || {}).campaignId || ''), kind = (req.body || {}).kind;
    if (!/^\d{3,30}$/.test(id)) return res.status(400).json({ error: 'Pick a campaign.' });
    const ov = (await db.getUserSetting(req.user.fb_id, 'kindOverride', {})) || {};
    if (kind === 'live' || kind === 'post') ov[id] = kind; else delete ov[id];
    await db.setUserSetting(req.user.fb_id, 'kindOverride', ov);
    // Recount now; if a sync is running, wait for it (the choice is already saved and every sync uses it).
    for (let i = 0; i < 40; i++) {
      if (await sync.exclusive(req.user.fb_id, () => sync.rematch(req.user))) return res.json({ ok: true });
      await new Promise((r) => setTimeout(r, 1500));
    }
    res.json({ ok: true, later: true });
  }));
};
