// Admin panel: users, health, settings, Page pictures
// Moved out of server.js unchanged; server.js mounts it at the same place, so route order is kept.
const cfg = require('../config');
const crypto = require('crypto');
const db = require('../db');
const health = require('../health');
const jobs = require('../jobs');
const meta = require('../meta');
const orders = require('../orders');
const sync = require('../sync');
const telegram = require('../telegram');

module.exports = function mountAdminPanel(app, api, deps) {
  const { LEAD, ROLES, adminOnly, adminViewers, fullAdmins, getTeams, isFull, ownerOnly, roleMap, roleOf, sha, wrap } = deps;
  // ---- Admin panel: users, health, settings ----
  api.get('/admin/users', adminOnly, wrap(async (req, res) => {
    const owner = await db.ownerId(), viewers = await adminViewers(), teams = await getTeams();
    const status = await jobs.statusAll();
    const users = await db.allUsers();
    const out = [];
    for (const st of status) {
      const u = users.find((x) => x.fb_id === st.id) || {};
      const t = teams.find((x) => x.members.includes(st.id));
      out.push({ ...st, role: st.id === owner ? 'owner' : viewers.has(st.id) ? 'admin' : 'member', company: await roleOf(st.id), team: t ? t.name : '', lastLogin: u.updated_at || null,
        lastSeen: await db.getUserSetting(st.id, 'lastSeen', null), autoReport: await db.getUserSetting(st.id, 'autoReport', null) });
    }
    out.sort((a, b) => ({ owner: 0, admin: 1, member: 2 }[a.role] - { owner: 0, admin: 1, member: 2 }[b.role]) || String(a.name).localeCompare(String(b.name)));
    const full = await isFull(req), fa = await fullAdmins(); for (const u of out) if (u.role !== 'owner' && fa.has(u.id) && !LEAD.has(u.company)) u.company = 'full'; // CEO/COO/CMO keep their title; 'full' is for others with owner rights
    res.json({ users: out, canEdit: full, me: req.user.fb_id, autoSyncServer: process.env.AUTO_SYNC !== 'off', blocked: full ? await db.blockedUsers() : {} });
  }));
  api.put('/admin/role/:id', ownerOnly, wrap(async (req, res) => {
    const id = req.params.id; if (id === req.user.fb_id) return res.status(400).json({ error: 'You can\'t change your own role.' });
    if (id === (await db.ownerId())) return res.status(400).json({ error: 'The app owner\'s role can\'t be changed.' });
    if (!(await db.getUser(id))) return res.status(404).json({ error: 'Account not found.' });
    const role = String((req.body || {}).role || ''), map = await roleMap();
    // ceo / coo see everything (admin viewers); pm and the older "member" see only their own clients; full = everything the owner can do.
    const v = await adminViewers(); if (role === 'admin' || LEAD.has(role) || role === 'full') v.add(id); else v.delete(id);
    const fa = await fullAdmins(); if (role === 'full' || LEAD.has(role)) fa.add(id); else fa.delete(id); await db.setSetting('fullAdmins', [...fa]);
    if (ROLES.includes(role)) map[id] = role; else if (role === 'full') map[id] = 'ceo'; else delete map[id];
    await db.setSetting('roles', map); await db.setSetting('adminViewers', [...v]); res.json({ ok: true, role: role === 'full' ? 'full' : await roleOf(id) });
  }));
  // Everything that needs attention, worst first.
  api.get('/admin/health', adminOnly, wrap(async (req, res) => {
    const items = [], now = Date.now(), day = 864e5, today = sync.todayIn();
    const add = (level, area, title, detail, action) => items.push({ level, area, title, detail, action: action || null });
    const status = await jobs.statusAll();
    for (const u of status) {
      const exp = u.tokenExpires ? Date.parse(u.tokenExpires) : 0;
      if (u.expired) add('bad', 'Login', `${u.name}'s Facebook login has expired`, 'Nothing syncs for this account until they log in to Boost Desk again.', null);
      else if (exp && exp - now < 7 * day) add('warn', 'Login', `${u.name}'s Facebook login expires in ${Math.max(1, Math.round((exp - now) / day))} day(s)`, 'Ask them to log out and log in again to renew it.', null);
      const lr = u.lastRun;
      if (lr && lr.error) add('bad', 'Sync', `Auto sync failed for ${u.name}`, `${lr.error} · ${new Date(lr.at).toLocaleString('en-GB', { timeZone: cfg.tz, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`, { kind: 'run', id: u.id });
      else if (lr && lr.errors) add('warn', 'Sync', `${u.name}: ${lr.errors} ad account(s) failed in the last sync`, 'Check Ad accounts for disabled or unpaid accounts.', { kind: 'run', id: u.id });
      if (!u.expired && u.enabled && !u.synced) add('info', 'Sync', `${u.name} has never synced`, 'Auto sync starts after they tap Sync from Meta once.', null);
      if (!u.expired && u.enabled && u.synced && lr && lr.at && now - Date.parse(lr.at) > 3 * 3600e3) add('warn', 'Sync', `No auto sync for ${u.name} in ${Math.round((now - Date.parse(lr.at)) / 3600e3)} hours`, 'Usually it runs every hour.', { kind: 'run', id: u.id });
      const na = Object.values((await db.getUserSetting(u.id, 'acctNoAccess', {})) || {});
      if (na.length) add('warn', 'Sync', `${u.name}: ${na.length} ad account(s) Boost Desk can't read`, `${na.map((x) => x.name).join(', ')} — Meta says no permission. Untick it in Ad accounts, or ask the account's owner to give ${u.name} access again. Boost Desk retries every 6 hours.`, null);
      const ar = await db.getUserSetting(u.id, 'autoReportLast', null);
      try { const gaps = await require('../pm').setup(u.id), np = gaps.filter((x) => x.missing.includes('price')), no = gaps.filter((x) => x.missing.includes('orders'));
        if (gaps.length) add('info', 'Setup', `${u.name}: ${gaps.length} boosting client${gaps.length === 1 ? '' : 's'} not fully set up`, [np.length ? `No service price (no invoice): ${np.slice(0, 6).map((x) => x.name).join(', ')}${np.length > 6 ? ` +${np.length - 6}` : ''}` : '', no.length ? `Spend but 0 orders counted: ${no.slice(0, 6).map((x) => x.name).join(', ')}${no.length > 6 ? ` +${no.length - 6}` : ''}` : ''].filter(Boolean).join(' · '), null); } catch (_) {}
      if (ar && ar.failed && ar.failed.length) add('bad', 'Reports', `${ar.failed.length} auto report(s) failed for ${u.name}`, ar.failed.slice(0, 3).map((f) => `${f.name}: ${f.error}`).join(' · '), null);
    }
    if (!telegram.hasBot()) add('bad', 'Telegram', 'The Telegram bot is not set up', 'Add TELEGRAM_BOT_TOKEN in Railway so reports can be sent.', null);
    const oc = await orders.publicConfig();
    if (oc.own && oc.own.on) {
      const pg = (await db.pool.query(`SELECT count(*)::int AS n, count(*) FILTER (WHERE NOT subscribed OR last_error <> '')::int AS bad FROM page_links`)).rows[0];
      if (!pg.n) add('info', 'Orders', 'No Facebook Page is connected for orders', 'Orders → Connect Pages, so Boost Desk can count orders from Messenger and comments.', { kind: 'orders' });
      else if (pg.bad) add('warn', 'Orders', `${pg.bad} connected Page${pg.bad === 1 ? ' has' : 's have'} a problem`, 'Open Orders → Pages to see which one and connect it again.', { kind: 'orders' });
    } else if (!oc.hasKey) add('info', 'Orders', 'adsbox.biz is not connected', 'Connect it to see cost per order.', { kind: 'orders' });
    else if (oc.lastError) add('bad', 'Orders', 'Getting orders from adsbox.biz failed', oc.lastError.message, { kind: 'orders' });
    else if (oc.last && now - Date.parse(oc.last.at) > 2 * 3600e3) add('warn', 'Orders', 'Orders from adsbox.biz have not updated in ' + Math.round((now - Date.parse(oc.last.at)) / 3600e3) + ' hours', 'Usually every 30 minutes.', { kind: 'orders' });
    const ps = await orders.pushStatus();
    if (ps.on && ps.last && ps.last.error) add('bad', 'Orders', 'Sending spend to adsbox.biz failed', ps.last.error, { kind: 'orders' });
    else if (ps.on && ps.last && ps.last.noPage) add('info', 'Orders', `${ps.last.noPage} campaign(s) sent to adsbox.biz without a Page`, 'adsbox.biz can only match spend to orders when the Page is known.', null);
    if (process.env.AUTO_SYNC === 'off') add('warn', 'Sync', 'Auto sync is switched off on the server', 'AUTO_SYNC=off is set in Railway.', null);
    const order = { bad: 0, warn: 1, info: 2 };
    items.sort((a, b) => order[a.level] - order[b.level]);
    const ok = [];
    if (telegram.hasBot()) ok.push('Telegram bot is set up');
    if (oc.hasKey && !oc.lastError) ok.push('adsbox.biz orders are connected' + (oc.last ? ' · last update ' + new Date(oc.last.at).toLocaleTimeString('en-GB', { timeZone: cfg.tz, hour: '2-digit', minute: '2-digit' }) : ''));
    const running = status.filter((u) => u.enabled && u.synced && !u.expired).length;
    ok.push(`Auto sync running for ${running} of ${status.length} account(s)`);
    res.json({ items, ok, checkedAt: new Date().toISOString(), today });
  }));
  // System health (server, database, jobs, outside services, errors) and owner alerts.
  api.get('/admin/system', adminOnly, wrap(async (req, res) => {
    const snap = await health.snapshot(db);
    const chat = await db.getSetting('alertChat', null), isOwner = await isFull(req);
    res.json({ ...snap, problems: health.problems(snap), alerts: { on: !!(chat && chat.id), name: chat ? chat.name : '', at: chat ? chat.at : null, bot: await telegram.username(), code: isOwner ? await deps.linkCode(req.user.fb_id) : '', canEdit: isOwner } });
  }));
  api.delete('/admin/alerts', ownerOnly, wrap(async (req, res) => { await db.setSetting('alertChat', null); res.json({ ok: true }); }));
  api.post('/admin/alerts/test', ownerOnly, wrap(async (req, res) => {
    const chat = await db.getSetting('alertChat', null); if (!chat || !chat.id) return res.status(400).json({ error: 'Connect your Telegram first.' });
    await telegram.send('🩺 Boost Desk test alert — alerts are working.', chat.id); res.json({ ok: true });
  }));
  // Keys for the public spend API (owner only). The key is shown once, at creation.
  const pubKeys = (list) => list.map((k) => ({ id: k.id, name: k.name, prefix: k.prefix, at: k.at, by: k.by, calls: k.calls || 0, lastUsed: k.lastUsed || null }));
  api.get('/admin/spend-keys', ownerOnly, wrap(async (req, res) => res.json({ keys: pubKeys((await db.getSetting('spendApiKeys', [])) || []), base: cfg.baseUrl })));
  api.post('/admin/spend-keys', ownerOnly, wrap(async (req, res) => {
    const name = String((req.body || {}).name || 'adsbox.biz').trim().slice(0, 60) || 'adsbox.biz';
    const plain = 'bd_' + crypto.randomBytes(24).toString('hex');
    const keys = (await db.getSetting('spendApiKeys', [])) || [];
    keys.push({ id: 'k' + Date.now().toString(36), name, prefix: plain.slice(0, 10), hash: sha(plain), at: new Date().toISOString(), by: req.user.name, calls: 0 });
    await db.setSetting('spendApiKeys', keys);
    res.json({ key: plain, keys: pubKeys(keys), base: cfg.baseUrl });
  }));
  api.delete('/admin/spend-keys/:id', ownerOnly, wrap(async (req, res) => {
    const keys = ((await db.getSetting('spendApiKeys', [])) || []).filter((k) => k.id !== req.params.id);
    await db.setSetting('spendApiKeys', keys); res.json({ keys: pubKeys(keys) });
  }));
  // ---- Facebook Page profile pictures: /api/page-pic/<page id> sends the browser to the picture (kept 12 hours) ----
  const picCache = new Map(); // page id -> { url | null, at }
  const picWait = new Map();
  async function pagePicUrl(id, prefer) {
    const hit = picCache.get(id);
    if (hit && Date.now() - hit.at < (hit.url ? 12 : 2) * 3600e3) return hit.url;
    if (picWait.has(id)) return picWait.get(id);
    const job = (async () => {
      const owner = await db.ownerId(), users = await db.activeUsers();
      const order = [prefer, owner, ...users.map((u) => u.fb_id)].filter((x, i, a) => x && a.indexOf(x) === i).slice(0, 4);
      let url = null;
      for (const uid of order) {
        try { const u = await db.getUser(uid); if (!u) continue; const r = await meta.get(`/${id}/picture`, { redirect: 0, type: 'normal', width: 120, height: 120 }, await sync.tokenFor(u)); url = (r.data && !r.data.is_silhouette && r.data.url) || null; break; }
        catch (_) { /* try the next person's login */ }
      }
      picCache.set(id, { url, at: Date.now() }); if (picCache.size > 3000) picCache.delete(picCache.keys().next().value);
      return url;
    })().finally(() => picWait.delete(id));
    picWait.set(id, job);
    return job;
  }
  api.get('/page-pic/:id', wrap(async (req, res) => {
    const id = String(req.params.id); if (!/^\d{5,20}$/.test(id)) return res.status(404).end();
    const url = await pagePicUrl(id, req.user.google ? null : req.user.fb_id);
    if (!url) { res.set('Cache-Control', 'private, max-age=3600'); return res.status(404).end(); }
    res.set('Cache-Control', 'private, max-age=21600').redirect(302, url);
  }));
};
