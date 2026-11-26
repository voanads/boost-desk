// Admin website access, security, backups, blocked accounts, auto sync control
// Moved out of server.js unchanged; server.js mounts it at the same place, so route order is kept.
const cfg = require('../config');
const db = require('../db');
const invoice = require('../invoice');
const jobs = require('../jobs');
const orders = require('../orders');
const sync = require('../sync');
const telegram = require('../telegram');

module.exports = function mountAdminSecurity(app, api, deps) {
  const { adminOnly, dedupeClients, googleRedirect, isFull, normEmail, ownerOnly, siteCfg, wrap } = deps;
  // ---- Admin website: who can sign in with Google (owner) ----
  api.get('/admin/site-access', ownerOnly, wrap(async (req, res) => {
    const users = (await db.allUsers()).map((u) => ({ id: u.fb_id, name: u.name }));
    res.json({ google: !!(cfg.googleClientId && cfg.googleClientSecret), url: cfg.baseUrl + '/admin', redirectUri: googleRedirect(), people: (await siteCfg()).people, users });
  }));
  api.post('/admin/site-access', ownerOnly, wrap(async (req, res) => {
    const email = normEmail((req.body || {}).email), linkTo = String((req.body || {}).linkTo || '');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Type a full email address, like name@gmail.com.' });
    if (linkTo && !(await db.getUser(linkTo))) return res.status(400).json({ error: 'That Boost Desk account was not found.' });
    const site = await siteCfg(), old = site.people.find((p) => p.email === email);
    const full = (req.body || {}).full == null ? (old ? !!old.full : false) : !!(req.body || {}).full;
    if (old) Object.assign(old, { linkTo, full, name: String((req.body || {}).name || old.name || '').slice(0, 80) });
    else site.people.push({ email, name: String((req.body || {}).name || '').slice(0, 80), linkTo, full, addedAt: new Date().toISOString(), addedBy: req.user.name, lastLogin: null });
    await db.setSetting('adminSite', site); res.json({ people: site.people });
  }));
  api.delete('/admin/site-access/:email', ownerOnly, wrap(async (req, res) => {
    const site = await siteCfg(); site.people = site.people.filter((p) => p.email !== normEmail(req.params.email));
    await db.setSetting('adminSite', site); res.json({ people: site.people });
  }));
  // ---- Security (secret rotation checklist) and database backups — owner only ----
  api.get('/admin/security', ownerOnly, wrap(async (req, res) => res.json(await require('../security').status())));
  api.post('/admin/security/done', ownerOnly, wrap(async (req, res) => {
    const k = String((req.body || {}).key || ''); if (!/^[a-z]{2,20}$/.test(k)) return res.status(400).json({ error: 'Unknown step.' });
    const r = await db.getSetting('secretsRotated', {}); if ((req.body || {}).done === false) delete r[k]; else r[k] = new Date().toISOString();
    await db.setSetting('secretsRotated', r); res.json({ rotated: r });
  }));
  api.post('/admin/backup', ownerOnly, wrap(async (req, res) => {
    const r = await require('../backup').run(telegram); delete r.gz; res.json(r);
  }));
  api.get('/admin/backup/download', ownerOnly, wrap(async (req, res) => {
    const b = await require('../backup').make();
    res.set({ 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="${b.name}"`, 'Cache-Control': 'no-store' });
    res.send(b.gz);
  }));
  // Settings overview for the admin panel.
  api.get('/admin/settings', adminOnly, wrap(async (req, res) => {
    const prof = invoice.profileOf(await db.getUserSetting(req.user.fb_id, 'invoiceProfile', {}));
    res.json({
      telegram: { bot: telegram.hasBot(), username: await telegram.username(), teamGroup: !!cfg.telegramChatId },
      orders: await orders.publicConfig(),
      invoice: { company: prof.company, bankName: prof.bankName, accountName: prof.accountName, accountNo: prof.accountNo, qr: prof.qr },
      autoSyncServer: process.env.AUTO_SYNC !== 'off', tz: cfg.tz, taxRate: sync.TAX_RATE,
      canEdit: await isFull(req),
      ai: await require('../ai').publicConfig(),
    });
  }));
  api.put('/admin/invoice-qr', ownerOnly, wrap(async (req, res) => {
    const qr = String((req.body || {}).qr || '');
    if (qr && (!/^data:image\/(png|jpe?g);base64,/.test(qr) || qr.length > 450000)) return res.status(400).json({ error: 'The QR must be a PNG or JPG, up to about 300 KB.' });
    await db.setSetting('invoiceQr', qr); invoice.setQr(qr); res.json({ ok: true });
  }));
  api.get('/blocked', ownerOnly, wrap(async (req, res) => res.json(await db.blockedUsers())));
  api.delete('/users/:id', ownerOnly, wrap(async (req, res) => {
    const id = req.params.id;
    if (id === req.user.fb_id) return res.status(400).json({ error: "You can't remove your own account." });
    const u = await db.getUser(id);
    if (!u) return res.status(404).json({ error: 'Account not found.' });
    if (sync.isBusy(id)) return res.status(409).json({ error: `${u.name} is syncing right now. Try again in a minute.` });
    await db.setBlocked(id, u.name, true);
    await db.removeUser(id);
    res.json({ ok: true });
  }));
  // Merge two workspaces of one team (src/merge.js). The plan only counts; the merge itself needs the typed name and a fresh backup.
  api.get('/admin/merge/plan', ownerOnly, wrap(async (req, res) => res.json(await require('../merge').plan(String(req.query.from || ''), String(req.query.into || '')))));
  api.post('/admin/merge', ownerOnly, wrap(async (req, res) => {
    const b = req.body || {}, M = require('../merge'), p = await M.plan(String(b.from || ''), String(b.into || ''));
    if (String(b.confirm || '').trim().toLowerCase() !== p.from.name.trim().toLowerCase()) return res.status(400).json({ error: `Type "${p.from.name}" to confirm.` });
    if (p.from.id === req.user.fb_id) return res.status(400).json({ error: 'You are signed in as the account that would go away. Sign in as the other one, or ask another admin.' });
    // a backup first, so the merge can be undone by hand: sent to the owner's Telegram like the nightly one
    const bk = await require('../backup').run(telegram);
    if (!bk.sent && !b.noBackup) return res.status(409).json({ error: 'A backup could not be sent first (' + (bk.error || 'unknown reason') + '). Fix that, or download a backup in Admin → Settings and tick "I have a backup".', needBackup: true });
    const out = await M.run(p.from.id, p.into.id, req.user.name);
    console.log('[merge]', p.from.name, '→', p.into.name, 'by', req.user.name, '·', p.clients, 'clients,', p.adAccounts, 'ad accounts');
    const into = await db.getUser(p.into.id); sync.refreshAccounts(into).catch((e) => console.error('[merge] account refresh:', e.message));
    dedupeClients(into).catch((e) => console.error('[merge] dedupe:', e.message)); // the same client in both accounts becomes one
    res.json(out);
  }));
  api.delete('/blocked/:id', ownerOnly, wrap(async (req, res) => { await db.setBlocked(req.params.id, '', false); res.json({ ok: true }); }));
  api.post('/auto-sync/:id/run', ownerOnly, wrap(async (req, res) => { await jobs.runNow(req.params.id); res.json({ ok: true }); }));

  // Clients
  const cleanClient = (b) => {
    const c = {};
    if (b.name != null) c.name = String(b.name).trim().slice(0, 120);
    if (b.match != null) c.match = String(b.match).trim().slice(0, 120);
    if (b.type != null) c.type = ['live', 'post', 'both'].includes(b.type) ? b.type : 'live';
    if (b.budget != null) c.budget = Math.max(0, Number(b.budget) || 0);
    if (b.lives != null) c.lives = Math.min(6, Math.max(1, parseInt(b.lives, 10) || 2));
    if (b.account != null) c.account = String(b.account).trim().slice(0, 120);
    if (b.telegram != null) c.telegram = String(b.telegram).trim().slice(0, 40);
    if (b.telegram_title != null) c.telegram_title = String(b.telegram_title).trim().slice(0, 150);
    if (Array.isArray(b.pages)) c.pages = [...new Set(b.pages.map((x) => String(x).trim().slice(0, 150)).filter(Boolean))].slice(0, 20);
    if (b.archived != null) c.archived = !!b.archived;
    if (b.topics && typeof b.topics === 'object') { // Telegram topic for each Page: { page: { id, title } }
      c.topics = {};
      for (const [pg, v] of Object.entries(b.topics).slice(0, 20)) if (v && /^-?\d+(:\d+)?$/.test(String(v.id || ''))) c.topics[String(pg).slice(0, 150)] = { id: String(v.id), title: String(v.title || '').slice(0, 150) };
    }
    if (b.service && typeof b.service === 'object') { // service fee + bill-to details (Payments tab)
      const v = b.service, str = (x, n) => String(x == null ? '' : x).trim().slice(0, n);
      c.service = { price: Math.max(0, Math.round((Number(v.price) || 0) * 100) / 100), day: Math.min(31, Math.max(0, parseInt(v.day, 10) || 0)), description: str(v.description, 160), customer: str(v.customer, 120), company: str(v.company, 120), phone: str(v.phone, 40) };
    }
    return c;
  };
  return { cleanClient };
};
