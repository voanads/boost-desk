// AI status, orders compare / Pages / pull / report, and Live or Post by hand
// Moved out of server.js unchanged; server.js mounts it at the same place, so route order is kept.
const db = require('../db');
const orders = require('../orders');
const pageOrders = require('../pageOrders');
const sync = require('../sync');

module.exports = function mountOrdersPages(app, api, deps) {
  const { adminOnly, canSeeAdmin, isDay, ownerOnly, wrap } = deps;
  api.get('/ai/status', wrap(async (req, res) => { const ai = require('../ai'), c = await ai.publicConfig(); res.json({ hasKey: c.hasKey, used: await ai.usedToday(req.user.fb_id), limit: ai.DAILY_LIMIT, noCredit: c.provider !== 'gemini' && !!ai.noCredit.at }); }));
  api.put('/admin/ai', ownerOnly, wrap(async (req, res) => res.json(await require('../ai').saveKey((req.body || {}).key === null ? null : String((req.body || {}).key || ''), req.user.name))));
  // Boost Desk's own order counting: connected Pages.
  api.get('/orders/pages', wrap(async (req, res) => { res.json(await pageOrders.list(req.user.fb_id, await canSeeAdmin(req.user.fb_id))); }));
  api.delete('/orders/pages/:id', wrap(async (req, res) => {
    if (req.user.buyer) return res.status(403).json({ error: 'Ask your PM.' });
    const id = String(req.params.id || ''); if (!/^\d{5,30}$/.test(id)) return res.status(400).json({ error: 'Pick a Page.' });
    const row = (await db.pool.query('SELECT connected_by FROM page_links WHERE page_id=$1', [id])).rows[0];
    if (!row) return res.status(404).json({ error: 'That Page is not connected.' });
    if (row.connected_by !== req.user.fb_id && !(await canSeeAdmin(req.user.fb_id))) return res.status(403).json({ error: 'Only the person who connected it or an admin can remove it.' });
    await pageOrders.disconnect(id); res.json({ ok: true });
  }));
  api.post('/orders/pull', wrap(async (req, res) => { await pageOrders.flush(); res.json({ ok: true, own: true }); })); // counted live; this only saves what is waiting
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
