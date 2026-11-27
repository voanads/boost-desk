// Check My Ads extension hooks (the public spend API for adsbox.biz was removed 26 Nov 2026)
// Moved out of server.js unchanged; server.js mounts it at the same place, so route order is kept.
const cfg = require('../config');
const crypto = require('crypto');
const db = require('../db');
const orders = require('../orders');
const sync = require('../sync');

module.exports = function mountPublicApi(app, api, deps) {
  const { isDay, wrap } = deps;
  const sha = (x) => crypto.createHash('sha256').update(String(x)).digest('hex'); // extension keys are kept as SHA-256 only (also used by server.js)
  // ---- Check My Ads browser extension → billing thresholds ----
  // The extension reads each account's automatic-payment ("billing") threshold from the user's own
  // logged-in Facebook session and pushes the numbers here. Meta does not expose this field to the
  // Marketing API, so this is the only way Boost Desk can show it. Only the numbers travel — never
  // Facebook cookies or tokens. Auth is a per-user extension key (not a browser cookie), so CORS is
  // open: the key is the credential.
  function extCors(res) {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, Authorization');
  }
  app.options('/public-api/thresholds', (req, res) => { extCors(res); res.sendStatus(204); });
  app.post('/public-api/thresholds', wrap(async (req, res) => {
    extCors(res);
    const key = String(req.get('x-api-key') || (req.get('authorization') || '').replace(/^Bearer\s+/i, '') || (req.body || {}).key || '').trim();
    const idx = (await db.getSetting('extKeyIndex', {})) || {};
    const owner = key ? idx[sha(key)] : null;
    if (!owner) return res.status(401).json({ ok: false, error: 'Extension key missing or not valid.' });
    const items = Array.isArray((req.body || {}).thresholds) ? req.body.thresholds : [];
    const map = (await db.getUserSetting(owner, 'extThresholds', {})) || {};
    let stored = 0;
    for (const it of items) {
      const rawId = String((it && (it.id || it.account_id || it.accountId || it.meta_account_id)) || '').trim();
      const id = rawId.startsWith('act_') ? rawId : (rawId ? 'act_' + rawId : '');
      if (!/^act_\d{5,25}$/.test(id)) continue;
      const prev = map[id] || {};
      const v = it.threshold != null ? Number(it.threshold) : prev.v;
      const card = String(it.card || it.payment_card || it.paymentMethods || prev.card || '').trim().slice(0, 80) || null;
      const dailyLimit = it.dailyLimit != null || it.daily_limit != null ? Number(it.dailyLimit ?? it.daily_limit) : (prev.dailyLimit ?? null);
      const business = String(it.business || it.business_name || it.businessName || prev.business || '').trim().slice(0, 120) || null;
      const role = String(it.role || prev.role || '').trim().slice(0, 40) || null;
      const nextBillDate = String(it.nextBillDate || it.pay_date || prev.nextBillDate || '').trim().slice(0, 40) || null;
      const originalId = String(it.originalId || it.original_id || it.bm_id || prev.originalId || '').trim().slice(0, 40) || null;
      if (it.threshold === null && !card && dailyLimit == null) {
        delete map[id];
        continue;
      }
      map[id] = {
        v: isFinite(v) && v >= 0 && v <= 1e9 ? Math.round(v * 100) / 100 : (prev.v ?? null),
        cur: (String(it.currency || prev.cur || '').slice(0, 8) || null),
        card,
        dailyLimit: isFinite(dailyLimit) && dailyLimit > 0 ? Math.round(dailyLimit * 100) / 100 : null,
        business,
        role,
        nextBillDate,
        originalId,
        at: new Date().toISOString()
      };
      stored++;
    }
    await db.setUserSetting(owner, 'extThresholds', map);
    res.json({ ok: true, stored, accounts: Object.keys(map).length });
  }));

  const lastSeenMem = new Map();
  // Everything below needs a logged-in user.
  return { lastSeenMem, sha };
};
