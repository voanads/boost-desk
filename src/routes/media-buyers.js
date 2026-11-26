// Media buyers, and client tasks given to them
// Moved out of server.js unchanged; server.js mounts it at the same place, so route order is kept.
const db = require('../db');
const sync = require('../sync');
const telegram = require('../telegram');

module.exports = function mountMediaBuyers(app, api, deps) {
  const { AI, LOGINS, MB, adminOnly, canSeeAdmin, isFull, ownClient, ownsBuyer, wrap } = deps;
  // Media buyers (no login needed: they connect Telegram once from an invite link).
  // A PM sees only the media buyers they added; the owner / CEO / COO see everyone's.
  api.get('/media-buyers', wrap(async (req, res) => {
    const all = await require('../buyers').all(), me = req.user.fb_id, mine = all.filter((b) => b.addedById === me || (!b.addedById && b.addedBy === req.user.name));
    res.json({ buyers: (await canSeeAdmin(me)) ? all : mine, bot: telegram.hasBot() });
  }));
  // A media buyer's Telegram picture (synced when they connect and once a day).
  app.get('/mb-pic/:id', wrap(async (req, res) => {
    const p = await require('../buyers').photoOf(req.params.id); if (!p) return res.status(404).end();
    const m = p.match(/^data:(image\/\w+);base64,(.+)$/); if (!m) return res.status(404).end();
    res.set('Content-Type', m[1]).set('Cache-Control', 'private, max-age=3600').send(Buffer.from(m[2], 'base64'));
  }));
  api.post('/media-buyers/:id/sync', wrap(async (req, res) => { // re-read name + picture from Telegram now
    const B = require('../buyers'), all = await B.list(), b = all.find((x) => x.id === req.params.id);
    if (!b) return res.status(404).json({ error: 'Media buyer not found.' });
    if (!(await ownsBuyer(req, b.id))) return res.status(403).json({ error: 'Only this media buyer\'s PM or an admin can do this.' });
    if (!b.chat) return res.status(400).json({ error: 'Not connected to Telegram yet.' });
    if (await B.syncProfile(b, '')) await B.save(all);
    res.json({ ok: true, name: b.name, photo: !!b.photo });
  }));
  api.post('/media-buyers', wrap(async (req, res) => { try { res.json(await require('../buyers').add((req.body || {}).name, req.user.name, req.user.fb_id)); } catch (e) { res.status(400).json({ error: e.message }); } }));
  api.delete('/media-buyers/:id', wrap(async (req, res) => {
    if (!(await MB().get(req.params.id))) return res.status(404).json({ error: 'Media buyer not found.' });
    if (!(await ownsBuyer(req, req.params.id))) return res.status(403).json({ error: 'Only this media buyer\'s PM or an admin can remove them.' });
    await require('../buyers').remove(req.params.id); res.json({ ok: true });
  }));
  // "This is the PM": a Project Manager who connected Telegram as a media buyer (the old way in). Their Telegram becomes
  // the team's PM chat, the media-buyer entry goes, tasks that were given to it become the PM's own, and a username made
  // for it opens the team account as PM.
  api.post('/media-buyers/:id/make-pm', wrap(async (req, res) => {
    const B = require('../buyers'), b = await B.get(req.params.id); if (!b) return res.status(404).json({ error: 'Media buyer not found.' });
    const users = await db.allUsers(), owner = b.addedById || (users.find((u) => u.name === b.addedBy) || {}).fb_id || '';
    if (!owner || !(await db.getUser(owner))) return res.status(400).json({ error: `${b.name} is not under a team account yet — choose the PM first.` });
    if (req.user.buyer || !((await isFull(req)) || req.user.fb_id === owner)) return res.status(403).json({ error: 'Only this team\'s PM or an admin can do this.' });
    if (!b.chat) return res.status(400).json({ error: `${b.name} has not connected Telegram yet.` });
    const prev = await db.getUserSetting(owner, 'tgChat', null);
    await db.setUserSetting(owner, 'tgChat', { id: String(b.chat), name: b.tgName || b.name, at: new Date().toISOString() });
    let moved = 0;
    for (const r of (await db.pool.query(`SELECT key, value FROM settings WHERE key LIKE $1`, [`${owner}:cwb:%`])).rows) {
      const w = r.value || {}; let ch = false;
      for (const t of w.tasks || []) if (t.to && t.to.id === b.id) { delete t.to; ch = true; moved++; }
      if (ch) await db.setSetting(r.key, w);
    }
    const L = LOGINS(), lg = await L.forMb(b.id); let username = '';
    if (lg) { if (await L.forFb(owner)) await L.remove(lg.username); else { lg.role = 'pm'; lg.fbId = owner; lg.mbId = ''; await L.save(lg); username = lg.username; } }
    await B.remove(b.id);
    console.log('[teams]', b.name, 'is now the PM Telegram of', (users.find((u) => u.fb_id === owner) || {}).name || owner, 'by', req.user.name);
    res.json({ ok: true, name: b.tgName || b.name, replaced: prev && prev.id && String(prev.id) !== String(b.chat) ? prev.name || 'another chat' : '', tasks: moved, username });
  }));
  // Admin: move a media buyer under another PM (keeps their Telegram link, KPIs and tasks).
  api.patch('/media-buyers/:id', adminOnly, wrap(async (req, res) => {
    const B = require('../buyers'), pm = String((req.body || {}).pm || '').trim(), users = await db.allUsers(), u = users.find((x) => x.fb_id === pm);
    if (!u) return res.status(400).json({ error: 'Pick the PM.' });
    const all = await B.list(), b = all.find((x) => x.id === String(req.params.id)); if (!b) return res.status(404).json({ error: 'Media buyer not found.' });
    b.addedById = u.fb_id; b.addedBy = u.name; await B.save(all); res.json({ ok: true, pm: { id: u.fb_id, name: u.name } });
  }));
  api.patch('/clients/:id/tasks/:tid', wrap(async (req, res) => {
    if (!(await ownClient(req))) return res.status(404).json({ error: 'Client not found.' });
    const w = await AI().workbook(req.user.fb_id, req.params.id), t = w.tasks.find((x) => x.id === req.params.tid);
    if (!t) return res.status(404).json({ error: 'Task not found.' });
    if ((req.body || {}).done != null) {
      t.done = !!req.body.done; t.doneAt = t.done ? new Date().toISOString() : null; t.doneBy = t.done ? req.user.name : null;
      const day = sync.todayIn(), lid = 't:' + t.id + ':' + day; w.log = (w.log || []).filter((x) => x.id !== lid);
      if (t.done) w.log.push({ id: lid, day, at: t.doneAt, by: req.user.name, text: t.text, kind: t.repeat ? 'repeat' : t.from === 'ai' ? 'ai' : 'me' });
    }
    if (typeof (req.body || {}).text === 'string' && req.body.text.trim()) t.text = req.body.text.trim().slice(0, 200);
    if ((req.body || {}).repeat != null) { if (req.body.repeat) t.repeat = true; else delete t.repeat; }
    if ((req.body || {}).target != null) { const tg = Math.min(1e6, Math.max(0, Number(req.body.target) || 0)); if (tg) { t.target = tg; t.hit = t.hit || {}; } else { delete t.target; delete t.unit; delete t.hit; } }
    if (typeof (req.body || {}).unit === 'string' && t.target) t.unit = req.body.unit.trim().slice(0, 20);
    if ((req.body || {}).kpi !== undefined) { if (/^[a-f0-9]{8}$/.test(String(req.body.kpi || ''))) t.kpi = req.body.kpi; else delete t.kpi; }
    if ((req.body || {}).reached != null && t.target) { t.hit = t.hit || {}; const k = t.repeat ? sync.todayIn() : t.day; t.hit[k] = Math.min(1e7, Math.max(0, Number(req.body.reached) || 0)); }
    await AI().saveWorkbook(req.user.fb_id, req.params.id, w); res.json({ today: sync.todayIn(), ...w });
  }));
  api.delete('/clients/:id/tasks/:tid', wrap(async (req, res) => {
    if (!(await ownClient(req))) return res.status(404).json({ error: 'Client not found.' });
    const w = await AI().workbook(req.user.fb_id, req.params.id); w.tasks = w.tasks.filter((x) => x.id !== req.params.tid);
    await AI().saveWorkbook(req.user.fb_id, req.params.id, w); res.json({ today: sync.todayIn(), ...w });
  }));
  // Tick an item of "Today's work" (report to send, client not boosting…) as done for today.
  api.put('/clients/:id/tick', wrap(async (req, res) => {
    if (!(await ownClient(req))) return res.status(404).json({ error: 'Client not found.' });
    const key = sync.todayIn() + ':' + String((req.body || {}).key || '').slice(0, 60);
    const w = await AI().workbook(req.user.fb_id, req.params.id); if ((req.body || {}).done) w.ticks[key] = { at: new Date().toISOString(), by: req.user.name }; else delete w.ticks[key];
    const lid = 'k:' + key; w.log = (w.log || []).filter((x) => x.id !== lid);
    if ((req.body || {}).done) w.log.push({ id: lid, day: sync.todayIn(), at: new Date().toISOString(), by: req.user.name, text: String(req.body.title || req.body.key || '').slice(0, 200), kind: String(req.body.key || '').slice(0, 30) });
    await AI().saveWorkbook(req.user.fb_id, req.params.id, w); res.json({ today: sync.todayIn(), ...w });
  }));
};
