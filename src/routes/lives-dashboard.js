// Live videos, live setups, Dashboard and Page names
// Moved out of server.js unchanged; server.js mounts it at the same place, so route order is kept.
const cfg = require('../config');
const crypto = require('crypto');
const db = require('../db');
const lives = require('../lives');
const meta = require('../meta');
const sync = require('../sync');

module.exports = function mountLivesDashboard(app, api, deps) {
  const { isDay, sha, wrap } = deps;
  // ---- Live videos ----
  api.get('/lives', wrap(async (req, res) => {
    const { from, to } = req.query;
    if (!deps.rangeOk(from, to)) return res.status(400).json({ error: 'Pick a valid period (at most one year).' });
    const list = await lives.listLives(req.user.fb_id, from, to);
    const setups = await lives.setupsFor(req.user, list.flatMap((l) => l.campaigns), { fetch: false });
    res.json({ lives: list, setups, saved: await db.getUserSetting(req.user.fb_id, 'liveSetups', []) });
  }));
  api.post('/lives/setups', wrap(async (req, res) => {
    const camps = (Array.isArray(req.body?.campaigns) ? req.body.campaigns : []).slice(0, 200)
      .filter((c) => c && /^\d+$/.test(String(c.id)) && /^act_\d+$/.test(String(c.accountId))).map((c) => ({ id: String(c.id), accountId: String(c.accountId) }));
    res.json(await lives.setupsFor(req.user, camps));
  }));
  api.post('/live-setups', wrap(async (req, res) => {
    const b = req.body || {};
    if (!b.setup || typeof b.sig !== 'string') return res.status(400).json({ error: 'Nothing to save.' });
    const list = await db.getUserSetting(req.user.fb_id, 'liveSetups', []);
    if (list.some((x) => x.sig === b.sig)) return res.json(list);
    list.unshift({ id: Date.now().toString(36), name: String(b.name || 'Saved setup').slice(0, 80), sig: b.sig, setup: b.setup, from: b.from || null, savedAt: new Date().toISOString() });
    await db.setUserSetting(req.user.fb_id, 'liveSetups', list.slice(0, 50));
    res.json(list.slice(0, 50));
  }));
  api.patch('/live-setups/:id', wrap(async (req, res) => {
    const list = await db.getUserSetting(req.user.fb_id, 'liveSetups', []);
    const x = list.find((y) => y.id === req.params.id); if (!x) return res.status(404).json({ error: 'Not found.' });
    if (req.body?.name) x.name = String(req.body.name).slice(0, 80);
    await db.setUserSetting(req.user.fb_id, 'liveSetups', list); res.json(list);
  }));
  api.delete('/live-setups/:id', wrap(async (req, res) => {
    const list = (await db.getUserSetting(req.user.fb_id, 'liveSetups', [])).filter((x) => x.id !== req.params.id);
    await db.setUserSetting(req.user.fb_id, 'liveSetups', list); res.json(list);
  }));

  api.get('/dashboard/pages', wrap(async (req, res) => {
    const { from, to } = req.query;
    if (!deps.rangeOk(from, to)) return res.status(400).json({ error: 'Pick a valid date or month.' });
    res.json(await sync.pageSpend(req.user.fb_id, from, to));
  }));
  // Names for Page IDs (saved names first, then names Meta gave us), for the client window.
  api.get('/page-names', wrap(async (req, res) => {
    const ids = String(req.query.ids || '').split(',').filter((x) => /^\d{5,25}$/.test(x)).slice(0, 100);
    const saved = await db.getSetting('pageNames', {}), known = meta.knownPageNames();
    res.json(Object.fromEntries(ids.map((id) => [id, saved[id] || known[id] || ''])));
  }));
  // Ask Meta once more for a Page's real name (a name typed by a person is otherwise kept for good).
  api.post('/page-names/:id/ask', wrap(async (req, res) => {
    const id = String(req.params.id); if (!/^\d{5,25}$/.test(id)) return res.status(400).json({ error: 'Not a Page ID.' });
    let name = '';
    try { name = String((await meta.get(`/${id}`, { fields: 'name' }, await sync.tokenFor(req.user))).name || '').trim().slice(0, 120); } catch (e) { if (e.needsLogin) throw e; }
    if (name) { const names = await db.getSetting('pageNames', {}); names[id] = name; await db.setSetting('pageNames', names); meta.rememberPageNames({ [id]: name }, true); }
    res.json({ ok: true, name });
  }));
  // Name a Page that Meta won't name (client Pages you don't manage). Saved for everyone, used by every sync.
  api.put('/page-names/:id', wrap(async (req, res) => {
    const id = String(req.params.id), name = String((req.body || {}).name || '').trim().slice(0, 120);
    if (!/^\d{5,25}$/.test(id)) return res.status(400).json({ error: 'Not a Page ID.' });
    const names = await db.getSetting('pageNames', {});
    if (name) names[id] = name; else delete names[id];
    await db.setSetting('pageNames', names);
    if (name) meta.rememberPageNames({ [id]: name }, true);
    res.json({ ok: true });
  }));
  api.get('/dashboard', wrap(async (req, res) => {
    const { from, to } = req.query;
    if (!isDay(from) || !isDay(to) || from > to) return res.status(400).json({ error: 'Pick a valid date or month.' });
    if ((Date.parse(to) - Date.parse(from)) / 864e5 > 366) return res.status(400).json({ error: 'Pick at most one year.' });
    res.json(await sync.dashboard(req.user.fb_id, from, to));
  }));

  // Ad accounts
  // Today's spend per ad account comes from the campaign rows the last sync saved for today
  // (Sync, auto sync every hour / on new campaigns), so it stays current without extra Meta calls.
  const FAKE_DEMO_CARDS = new Set([
    'Visa •••• 4829',
    'Mastercard •••• 7741',
    'Visa •••• 3104',
    'Mastercard •••• 9912',
    'Amex •••• 1008',
    'Visa •••• 6590',
  ]);
  const cleanCard = (c) => {
    const s = String(c || '').trim().slice(0, 80);
    return s && !FAKE_DEMO_CARDS.has(s) ? s : null;
  };

  async function accountsWithToday(owner) {
    const list = await db.listAccounts(owner);
    const day = sync.todayIn();
    const rows = await db.getRaw(owner, day);
    const meta0 = (await db.getDay(owner, day)).meta;
    const ext = (await db.getUserSetting(owner, 'extThresholds', {})) || {};
    const byAcct = {};
    for (const r of rows || []) byAcct[r.accountId] = (byAcct[r.accountId] || 0) + (Number(r.spend) || 0);
    for (const a of list) {
      const i = a.info || (a.info = {});
      if (rows && a.enabled) { i.todaySpend = Math.round((byAcct[a.id] || 0) * 100) / 100; i.todayAt = meta0?.synced_at || null; delete i.todayError; }
      // Meta's API doesn't return the billing threshold; use what the browser extension pushed when
      // the API left it blank. Flagged so the UI can note where it came from.
      if (ext[a.id]) {
        if (ext[a.id].v != null && ext[a.id].v > 0) { i.threshold = ext[a.id].v; i.thresholdExt = true; }
        const c = cleanCard(ext[a.id].card);
        if (c) i.card = c; else delete i.card;
        if (ext[a.id].dailyLimit != null && ext[a.id].dailyLimit > 0) i.dailyLimit = ext[a.id].dailyLimit;
        if (ext[a.id].business && !i.business) i.business = ext[a.id].business;
        if (ext[a.id].originalId && !i.originalId) i.originalId = ext[a.id].originalId;
        if (ext[a.id].role) i.role = ext[a.id].role;
        if (ext[a.id].nextBillDate && ext[a.id].nextBillDate !== '—') i.nextBillDate = ext[a.id].nextBillDate;
      }
    }
    return list;
  }
  // Direct Web-to-Extension Bridge Sync (saves Thresholds, Payment Cards, Daily Limits & BMs from AdsCheck Connect Pro)
  api.post('/accounts/ext-sync', wrap(async (req, res) => {
    const owner = req.user.fb_id;
    const items = Array.isArray((req.body || {}).accounts) ? req.body.accounts : (Array.isArray((req.body || {}).thresholds) ? req.body.thresholds : []);
    const map = (await db.getUserSetting(owner, 'extThresholds', {})) || {};
    let stored = 0;
    for (const it of items) {
      const rawId = String((it && (it.id || it.account_id || it.accountId || it.meta_account_id)) || '').trim();
      const id = rawId.startsWith('act_') ? rawId : (rawId ? 'act_' + rawId : '');
      if (!/^act_\d{5,25}$/.test(id)) continue;
      const rawThr = it.threshold != null && it.threshold !== '' ? Number(it.threshold) : null;
      const v = rawThr != null && isFinite(rawThr) && rawThr > 0 && rawThr <= 1e9 ? Math.round(rawThr * 100) / 100 : null;
      const card = cleanCard(it.card || it.payment_card || it.paymentMethods);
      const rawDsl = it.dailyLimit != null || it.daily_limit != null ? Number(it.dailyLimit ?? it.daily_limit) : null;
      const dailyLimit = rawDsl != null && isFinite(rawDsl) && rawDsl > 0 ? Math.round(rawDsl * 100) / 100 : null;
      const business = String(it.business || it.business_name || it.businessName || '').trim().slice(0, 120) || null;
      const originalId = String(it.originalId || it.businessId || it.business_id || '').trim().slice(0, 40) || null;
      const role = String(it.role || '').trim().slice(0, 40) || null;
      const nextBillDate = String(it.nextBillDate || it.pay_date || '').trim().slice(0, 40) || null;
      map[id] = {
        v,
        cur: (String(it.currency || '').slice(0, 8) || null),
        card,
        dailyLimit,
        business,
        originalId,
        role,
        nextBillDate: nextBillDate && nextBillDate !== '—' ? nextBillDate : null,
        at: new Date().toISOString()
      };
      stored++;
    }
    await db.setUserSetting(owner, 'extThresholds', map);
    res.json({ ok: true, stored, accounts: await accountsWithToday(owner) });
  }));
  // The logged-in user's key + endpoint for the Check My Ads extension to push thresholds (lazily created).
  api.get('/ext/key', wrap(async (req, res) => {
    const owner = req.user.fb_id;
    let key = await db.getUserSetting(owner, 'extKey', null);
    if (!key) {
      key = 'bd_ext_' + crypto.randomBytes(20).toString('hex');
      await db.setUserSetting(owner, 'extKey', key);
      const idx = (await db.getSetting('extKeyIndex', {})) || {};
      idx[sha(key)] = owner;
      await db.setSetting('extKeyIndex', idx);
    }
    res.json({ key, url: cfg.baseUrl + '/public-api/thresholds' });
  }));
  return { accountsWithToday };
};
