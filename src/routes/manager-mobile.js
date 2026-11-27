// 📱 Manager on the phone (/admin/m): one mobile page for the CEO / COO — Today at a glance, Team follow-up, AI & ads health.
// It reads the same admin data as the Main Dashboard (/api/admin/clients-today, /reports, /lives, /health) plus:
//   GET  /api/admin/m/extra                       each PM's Telegram link, and the saved competitor analyses
//   POST /api/admin/m/nudge                       a short message from the manager to a PM's own Telegram (preset texts)
//   GET  /api/admin/m/ad-doctor/:owner/:client    🩺 Ad Doctor for any client (rules, no AI)
//   POST /api/admin/m/ad-doctor/:owner/:client/ai the AI's fixes (counts on that PM's daily AI limit)
const db = require('../db');
const telegram = require('../telegram');

module.exports = function mountManagerMobile(app, api, { wrap, adminOnly, canSeeAdmin }) {
  app.get(['/admin/m', '/admin/m/'], wrap(async (req, res) => {
    if (!req.user.google && !(await canSeeAdmin(req.user.fb_id))) return res.redirect('/projectmanager');
    res.set({ 'Cache-Control': 'no-cache', 'X-Robots-Tag': 'noindex' }).type('html').send(require('../managerPage').html());
  }));
  app.get('/admin/m/manifest.webmanifest', (req, res) => res.type('application/manifest+json').send(JSON.stringify({
    name: 'Ads Box · Manager', short_name: 'Ads Box', start_url: '/admin/m', scope: '/admin/m', display: 'standalone', background_color: '#f6f5fa', theme_color: '#14122A',
    icons: [{ src: '/assets/logo.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
  })));

  api.get('/admin/m/extra', adminOnly, wrap(async (req, res) => {
    const pms = [];
    for (const u of await db.allUsers()) { const tg = await db.getUserSetting(u.fb_id, 'tgChat', null); pms.push({ id: u.fb_id, name: u.name, telegram: !!(tg && tg.id) }); }
    const names = {}, rows = (await db.pool.query(`SELECT key, (value::jsonb)->'analysis' AS a FROM settings WHERE key LIKE '%:comp:%'`)).rows;
    const comp = [];
    for (const r of rows) {
      if (!r.a || !r.a.text) continue;
      const [owner, , cid] = r.key.split(':');
      if (!names[owner]) { names[owner] = {}; for (const c of await db.listClients(owner)) names[owner][c.id] = c.name; }
      comp.push({ owner, clientId: Number(cid), client: names[owner][cid] || '', pm: (pms.find((p) => p.id === owner) || {}).name || '', at: r.a.at, by: r.a.by || '', competitors: r.a.competitors || 0, text: r.a.text });
    }
    comp.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    res.json({ pms, competitors: comp.slice(0, 30), me: req.user.name || '' });
  }));

  // Preset messages only: the manager taps, Boost Desk's bot sends it to that PM's own Telegram.
  const NUDGE = {
    reports: (n) => `📣 សូមផ្ញើរបាយការណ៍ទៅភ្ញៀវថ្ងៃនេះ${n ? ` (${n} នៅសល់)` : ''}។`,
    urgent: (n) => `🚨 មាន client Urgent${n ? ` ${n}` : ''} មិនទាន់មានអ្នកមើល — សូមពិនិត្យក្នុង Boost Desk។`,
    autoreport: () => '⏰ សូមបើក Auto report ក្នុង Settings → My auto report ដើម្បីឲ្យរបាយការណ៍ទៅដល់ភ្ញៀវរៀងរាល់ថ្ងៃ។',
    telegram: () => '🔗 សូមភ្ជាប់ Telegram របស់អ្នកក្នុង Settings → Link my Telegram ដើម្បីទទួលការជូនដំណឹង។',
  };
  api.post('/admin/m/nudge', adminOnly, wrap(async (req, res) => {
    const b = req.body || {}, make = NUDGE[b.kind];
    if (!make) return res.status(400).json({ error: 'Unknown message.' });
    const u = await db.getUser(String(b.owner || '')); if (!u) return res.status(404).json({ error: 'Person not found.' });
    const tg = await db.getUserSetting(u.fb_id, 'tgChat', null);
    if (!telegram.hasBot() || !tg || !tg.id) return res.status(400).json({ error: `${u.name} has not linked Telegram yet.` });
    const from = req.user.name || 'Manager';
    await telegram.send(`${make(Math.max(0, Math.round(Number(b.count) || 0)))}\n— ${from}`, tg.id);
    res.json({ ok: true, to: u.name });
  }));

  const docUser = async (req, res) => {
    const u = await db.getUser(String(req.params.owner)); const cid = Number(req.params.client);
    if (!u || !(await db.ownsClient(u.fb_id, cid))) { res.status(404).json({ error: 'Client not found.' }); return null; }
    return { u, cid };
  };
  const fail = (res, e) => { if (e.needsLogin) return res.status(409).json({ error: 'This PM\'s Facebook login has expired — they need to log in again.' }); if (e.status) return res.status(e.status).json({ error: e.message }); throw e; };
  api.get('/admin/m/ad-doctor/:owner/:client', adminOnly, wrap(async (req, res) => {
    const x = await docUser(req, res); if (!x) return;
    try { res.json(await require('../adDoctor').gather(x.u, x.cid, Number(req.query.days) === 14 ? 14 : 7, req.query.fresh === '1')); } catch (e) { fail(res, e); }
  }));
  api.post('/admin/m/ad-doctor/:owner/:client/ai', adminOnly, wrap(async (req, res) => {
    const x = await docUser(req, res); if (!x) return;
    try { res.json(await require('../adDoctor').advice(x.u, x.cid, { days: Number((req.body || {}).days) === 14 ? 14 : 7, lang: (req.body || {}).lang === 'en' ? 'en' : 'km' })); } catch (e) { fail(res, e); }
  }));
};
