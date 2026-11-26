// My profile, onboarding, usernames, Facebook accounts, my Telegram and alerts
// Moved out of server.js unchanged; server.js mounts it at the same place, so route order is kept.
const db = require('../db');
const extras = require('../extras');
const meta = require('../meta');
const reports = require('../reports');
const sync = require('../sync');
const telegram = require('../telegram');

module.exports = function mountMe(app, api, deps) {
  const { KPI, LOGINS, MB, TASKS_OFF, canSeeAdmin, fbNameOf, getTeams, isFull, newCode, roleOf, wrap } = deps;
  // My tasks today (every client): the same list each client page shows, in one place.
  // ---------- Task menu: fixed daily duties per role (PM / media buyer), ticked day by day ----------
  const MENU = () => require('../menu');
  // Whose menu: a buyer's own, mine (pm), or — admins — anyone's via ?as=<fbId> or ?as=mb:<buyerId>.
  async function menuPerson(req, raw) {
    if (req.user.buyer) return { person: req.user.buyer.id, role: 'mb', name: req.user.buyer.name };
    const as = String(raw || '').trim();
    if (as && as !== req.user.fb_id) {
      if (as.startsWith('mb:')) { // a PM may open the menus of the media buyers they added; admins any buyer's
        const b = await MB().get(as.slice(3)); if (!b) return null;
        const mine = b.addedById === req.user.fb_id || (!b.addedById && b.addedBy === req.user.name);
        if (!mine && !(await canSeeAdmin(req.user.fb_id))) return null;
        return { person: b.id, role: 'mb', name: b.name };
      }
      if (!(await canSeeAdmin(req.user.fb_id))) return null;
      const u = (await db.allUsers()).find((x) => x.fb_id === as); return u ? { person: u.fb_id, role: 'pm', name: u.name } : null;
    }
    // The role set in Admin → Users decides the menu: a Facebook login marked "Media buyer" gets the media buyer menu everywhere.
    return { person: req.user.fb_id, role: (await roleOf(req.user.fb_id)) === 'mb' ? 'mb' : 'pm', name: req.user.name };
  }
  // My profile for the Settings page: who I am, my Facebook login, my Telegram, my team.
  api.get('/me/profile', wrap(async (req, res) => {
    const teams = await getTeams();
    if (req.user.buyer) {
      const b = await MB().get(req.user.buyer.id), pm = (await db.allUsers()).find((u) => u.fb_id === req.user.fb_id);
      return res.json({ buyer: true, name: b ? b.name : req.user.buyer.name, alias: b ? b.alias || '' : '', tgName: b ? b.tgName || '' : '', photo: !!(b && b.photo), id: req.user.buyer.id, pm: pm ? pm.name : (b ? b.addedBy : ''),
        team: (teams.find((t) => t.members.includes(req.user.fb_id)) || {}).name || '', telegram: { linked: !!(b && b.chat), bot: telegram.hasBot() ? await telegram.username() : '', link: b && telegram.hasBot() ? `https://t.me/${await telegram.username()}?start=mb_${b.code}` : '' }, roleName: 'Media buyer', site: '/mediabuyer' });
    }
    const me = req.user.fb_id, owner = (await db.ownerId()) === me, role = owner ? 'owner' : await roleOf(me);
    const RN = { owner: 'CEO · Owner', ceo: 'CEO', coo: 'COO', cmo: 'CMO', pm: 'Project Manager', mb: 'Media buyer' }, SITE = { owner: '/owner', ceo: '/admin', coo: '/admin', cmo: '/admin', pm: '/projectmanager', mb: '/mediabuyer' };
    const exp = req.user.token_expires ? Date.parse(req.user.token_expires) : 0, left = exp ? Math.round((exp - Date.now()) / 864e5) : null;
    const accounts = (await db.listAccounts(me)).length, clients = (await db.listClients(me)).filter((c) => !c.archived).length;
    const buyers = (await MB().all()).filter((b) => b.addedById === me || (!b.addedById && b.addedBy === req.user.name)).map((b) => ({ name: b.name, linked: !!(b.linked || b.chat) }));
    let code = await db.getUserSetting(me, 'tgCode', ''); if (!code) { code = newCode(); await db.setUserSetting(me, 'tgCode', code); }
    const chat = await db.getUserSetting(me, 'tgChat', null), bot = telegram.hasBot() ? await telegram.username() : '';
    const picture = req.user.google ? '' : `/api/fb-pic/${me}`; // the browser loads it on its own; the page never waits for Facebook
    const pages = (await db.listPagesSeen(me)).length, myAlerts = require('../myalerts');
    res.json({ buyer: false, id: me, name: req.user.name, picture, role, roleName: RN[role] || 'Project Manager', site: SITE[role] || '/projectmanager', team: (teams.find((t) => t.members.includes(me)) || {}).name || '',
      teams: teams.map((t) => t.name), isAdmin: await canSeeAdmin(me),
      username: ((await LOGINS().forFb(me)) || {}).username || '',
      facebook: { id: me, name: await fbNameOf(req.user), expires: req.user.token_expires || null, daysLeft: left, expired: left !== null && left <= 0, accounts, clients, pages, autoSync: (await db.enabledAccountIds(me)).length },
      telegram: { linked: !!(chat && chat.id), name: chat ? chat.name : '', at: chat ? chat.at : null, link: bot ? `https://t.me/${bot}?start=pm_${code}` : '', bot, code }, buyers,
      autoReport: await extras.autoSettings(me), alerts: await myAlerts.prefs(me), ai: { on: (await db.getUserSetting(me, 'aiOn', true)) !== false, lang: (await db.getUserSetting(me, 'aiLang', 'en')) === 'km' ? 'km' : 'en' },
      google: req.session.gEmail ? { email: req.session.gEmail } : null });
  }));
  // Getting started: what a new Project Manager still has to set up (shown on the Dashboard until every step is done).
  api.get('/onboarding', wrap(async (req, res) => {
    if (req.user.buyer || req.user.google) return res.json({ show: false });
    const me = req.user.fb_id, accts = await db.listAccounts(me), clients = (await db.listClients(me)).filter((c) => !c.archived), month = sync.todayIn().slice(0, 7);
    const login = await LOGINS().forFb(me), chat = await db.getUserSetting(me, 'tgChat', null);
    let kpis = 0; try { kpis = (await KPI().getList(me, month)).filter((k) => String(k.name || '').trim()).length; } catch (_) {}
    const steps = [
      { key: 'login', done: !!login && !login.must, title: 'Choose your username and password', hint: 'So you can log in without Facebook.', go: '#settings', cta: 'Open Settings' },
      { key: 'accounts', done: accts.some((a) => a.enabled), title: 'Tick the ad accounts you boost with', hint: `${accts.length} ad account${accts.length === 1 ? '' : 's'} found on your Facebook. Have a second Facebook account? Add it in Settings.`, go: '#accounts', cta: 'Open Ad accounts' },
      { key: 'clients', done: clients.length > 0, title: 'Add your first client', hint: 'A client is matched to spend by its Facebook Page.', go: '#clients', cta: 'Open Clients' },
      { key: 'telegram', done: !!(chat && chat.id), title: 'Link your Telegram', hint: 'For alerts, and so reports can go to your clients\' groups.', go: '#settings', cta: 'Open Settings' },
      { key: 'groups', done: clients.length > 0 && clients.every((c) => reports.routes(c).some((r) => r.chat)), title: 'Give every client a Telegram group', hint: clients.length ? `${clients.filter((c) => !reports.routes(c).some((r) => r.chat)).length} client(s) have no group yet — their report can't be sent.` : 'After you add clients.', go: '#reports', cta: 'Open Reports' },
      ...(TASKS_OFF ? [] : [{ key: 'kpi', done: kpis > 0, title: 'Set this month\'s KPIs and your daily menu', hint: 'My Task → Monthly KPI, then ✨ Suggest from KPI.', go: '#mytasks', cta: 'Open My Task' }]),
    ];
    res.json({ show: steps.some((x) => !x.done), done: steps.filter((x) => x.done).length, total: steps.length, steps });
  }));
  // ---------- Usernames (logins) ----------
  // Who may manage which: a full admin → every login; a PM → the logins of their own media buyers.
  const myBuyerIds = async (req) => new Set((await MB().list()).filter((b) => b.addedById === req.user.fb_id || (!b.addedById && b.addedBy === req.user.name)).map((b) => b.id));
  async function canManageLogin(req, rec) { if (req.user.buyer || req.user.google && !(await isFull(req))) return false; if (await isFull(req)) return true; return rec.role === 'mb' && (await myBuyerIds(req)).has(rec.mbId); }
  const loginErr = (res, e) => res.status(e.status || 400).json({ error: e.message });
  api.get('/logins', wrap(async (req, res) => {
    if (req.user.buyer) return res.status(403).json({ error: 'Ask your PM.' });
    const L = LOGINS(), full = await isFull(req), mine = await myBuyerIds(req);
    res.json({ full, logins: (await L.list()).filter((r) => full || (r.role === 'mb' && mine.has(r.mbId))).map(L.pub) });
  }));
  api.post('/logins', wrap(async (req, res) => {
    const b = req.body || {}, role = b.role === 'mb' ? 'mb' : 'pm';
    if (!(await canManageLogin(req, { role, mbId: String(b.mbId || '') }))) return res.status(403).json({ error: role === 'mb' ? 'You can only make usernames for your own media buyers.' : 'Only the owner (or a full admin) can make a username for a Project Manager.' });
    if (role === 'pm' && b.fbId && !(await db.getUser(String(b.fbId)))) return res.status(400).json({ error: 'That person is not in Boost Desk.' });
    if (role === 'mb' && !(await MB().get(b.mbId))) return res.status(400).json({ error: 'That media buyer is not on the list.' });
    const name = b.name || (role === 'mb' ? (await MB().get(b.mbId)).name : b.fbId ? (await db.getUser(String(b.fbId))).name : '');
    try { res.json(await LOGINS().create({ username: b.username, name, role, fbId: role === 'pm' ? b.fbId : '', mbId: role === 'mb' ? b.mbId : '', by: req.user.name })); } catch (e) { loginErr(res, e); }
  }));
  api.post('/logins/:u/reset', wrap(async (req, res) => {
    const rec = await LOGINS().get(req.params.u); if (!rec || !(await canManageLogin(req, rec))) return res.status(404).json({ error: 'No such username.' });
    try { res.json(await LOGINS().reset(rec.username)); } catch (e) { loginErr(res, e); }
  }));
  api.delete('/logins/:u', wrap(async (req, res) => {
    const rec = await LOGINS().get(req.params.u); if (!rec || !(await canManageLogin(req, rec))) return res.status(404).json({ error: 'No such username.' });
    await LOGINS().remove(rec.username); res.json({ ok: true });
  }));
  // Me: make my own username (I'm logged in with Facebook, so it opens this same workspace), or change my password.
  api.post('/me/login', wrap(async (req, res) => {
    if (req.user.buyer || req.user.google) return res.status(403).json({ error: 'Ask your PM for a username.' });
    const b = req.body || {};
    try { const r = await LOGINS().create({ username: b.username, name: req.user.name, role: 'pm', fbId: req.user.fb_id, by: req.user.name, password: String(b.password || '') }); req.session.loginId = r.login.username; res.json(r); } catch (e) { loginErr(res, e); }
  }));
  api.put('/me/password', wrap(async (req, res) => {
    const L = LOGINS(), rec = req.user.buyer ? await L.forMb(req.user.buyer.id) : await L.forFb(req.user.fb_id), b = req.body || {};
    if (!rec) return res.status(404).json({ error: 'You have no username yet.' });
    try { await L.verify(rec.username, b.current); await L.setPassword(rec.username, b.next); res.json({ ok: true }); } catch (e) { loginErr(res, e.status === 401 ? Object.assign(e, { message: 'The current password is wrong.', status: 400 }) : e); }
  }));
  // Settings → Facebook accounts: the extra logins connected to my workspace.
  // A Facebook account's profile picture (asked with that account's own token), remembered for an hour.
  const fbPics = new Map();
  async function fbPicture(id, token) {
    const hit = fbPics.get(id); if (hit && Date.now() - hit.at < 3600e3) return hit.url;
    let url = '';
    try { const r = await Promise.race([meta.get(`/${id}/picture`, { redirect: 0, type: 'normal', width: 160, height: 160 }, token), new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), 2500))]); url = (r.data && !r.data.is_silhouette && r.data.url) || ''; } catch (_) { /* no picture: the initials show */ }
    fbPics.set(id, { at: Date.now(), url }); return url;
  }
  // A connected Facebook account's profile picture: mine or one of my team's extra accounts. Redirects to Facebook's
  // picture (cached an hour); 404 when there is none, and the page shows initials instead.
  api.get('/fb-pic/:id', wrap(async (req, res) => {
    const me = req.user.fb_id, id = String(req.params.id); let token = '';
    try { if (id === me) token = await sync.tokenFor(req.user); else { const e = (await sync.extraLogins(me)).find((x) => x.id === id); if (e) token = require('../crypto').decrypt(e.token_enc); } } catch (_) {}
    const url = token ? await fbPicture(id, token) : '';
    if (!url) return res.status(404).end();
    res.set('Cache-Control', 'private, max-age=3600').redirect(url);
  }));
  api.get('/fb-accounts', wrap(async (req, res) => {
    const me = req.user.fb_id, accts = await db.listAccounts(me), now = Date.now();
    const exp = req.user.token_expires ? Date.parse(req.user.token_expires) : 0, mine = accts.filter((a) => !(a.info || {}).via);
    const xs = await sync.extraLogins(me), pics = { [me]: `/api/fb-pic/${me}` }; for (const e of xs) pics[e.id] = `/api/fb-pic/${e.id}`; // loaded by the browser, so this list never waits for Facebook
    res.json({ max: require('../merge').MAX_FB, main: { id: me, picture: pics[me] || '', name: await fbNameOf(req.user), expires: req.user.token_expires || null, expired: !!(exp && exp < now), daysLeft: exp ? Math.floor((exp - now) / 864e5) : null, accounts: mine.length, syncing: mine.filter((a) => a.enabled).length, pages: (await db.listPagesSeen(me)).length },
      extras: xs.map((e) => ({ id: e.id, picture: pics[e.id] || '', name: e.name, expires: e.expires || null, expired: !!(e.expires && Date.parse(e.expires) < now), addedAt: e.addedAt, error: e.error || '',
      accounts: accts.filter((a) => (a.info || {}).via === e.id).length, syncing: accts.filter((a) => (a.info || {}).via === e.id && a.enabled).length })) });
  }));
  api.delete('/fb-accounts/:id', wrap(async (req, res) => {
    if (req.user.buyer) return res.status(403).json({ error: 'Ask your PM.' });
    const me = req.user.fb_id, list = await sync.extraLogins(me), next = list.filter((e) => e.id !== String(req.params.id));
    if (next.length === list.length) return res.status(404).json({ error: 'That Facebook account is not connected.' });
    await db.setUserSetting(me, 'fbExtras', next);
    // Its ad accounts leave the workspace (saved spend stays on the clients); the next account refresh would drop them anyway.
    const gone = (await db.pool.query(`DELETE FROM ad_accounts WHERE owner=$1 AND info->>'via'=$2 RETURNING id`, [me, String(req.params.id)])).rows.length;
    res.json({ ok: true, removedAccounts: gone });
  }));
  // Settings → Profile: my display name and team.
  api.put('/me/profile', wrap(async (req, res) => {
    if (req.user.buyer) return res.status(403).json({ error: 'Ask your PM to rename you.' });
    const b = req.body || {}, me = req.user.fb_id, name = String(b.name || '').trim().slice(0, 80);
    if (name && name !== req.user.name) {
      if (!(await db.getUserSetting(me, 'fbName', ''))) await db.setUserSetting(me, 'fbName', req.user.name); // remember the Facebook account's own name
      await db.pool.query('UPDATE users SET name=$2 WHERE fb_id=$1', [me, name]);
      const lg = await LOGINS().forFb(me); if (lg) { lg.name = name; await LOGINS().save(lg); }
    }
    if (b.team !== undefined) { // moving myself between teams (admins may pick any; others only leave or join by name)
      const teams = await getTeams(), want = String(b.team || '').trim();
      for (const t of teams) t.members = t.members.filter((x) => x !== me);
      const t = want ? teams.find((x) => x.name === want) : null; if (want && !t) return res.status(400).json({ error: 'No team with that name.' });
      if (t) t.members.push(me); await db.setSetting('teams', teams);
    }
    res.json({ ok: true, name: name || req.user.name });
  }));
  // Settings → Telegram: a test message to my own chat.
  api.post('/me/telegram/test', wrap(async (req, res) => {
    const chat = req.user.buyer ? ((await MB().get(req.user.buyer.id)) || {}).chat : (await db.getUserSetting(req.user.fb_id, 'tgChat', null) || {}).id;
    if (!chat) return res.status(400).json({ error: 'Telegram is not linked yet.' });
    await telegram.send(`✅ Boost Desk test · ${req.user.name}\nYour Telegram is linked — alerts will arrive here.`, chat); res.json({ ok: true });
  }));
  // Settings → Alerts to my Telegram, and AI advice on/off.
  api.get('/me/alerts', wrap(async (req, res) => res.json(await require('../myalerts').prefs(req.user.fb_id))));
  api.put('/me/alerts', wrap(async (req, res) => res.json(await require('../myalerts').savePrefs(req.user.fb_id, req.body || {}))));
  api.put('/me/ai', wrap(async (req, res) => {
    const b = req.body || {}; if (b.on !== undefined) await db.setUserSetting(req.user.fb_id, 'aiOn', !!b.on); if (b.lang) await db.setUserSetting(req.user.fb_id, 'aiLang', b.lang === 'km' ? 'km' : 'en');
    res.json({ on: (await db.getUserSetting(req.user.fb_id, 'aiOn', true)) !== false, lang: (await db.getUserSetting(req.user.fb_id, 'aiLang', 'en')) === 'km' ? 'km' : 'en' });
  }));
  // My Telegram: a PM / owner connects their own chat to get alerts (plan / result from their media buyers).
  api.get('/me/telegram', wrap(async (req, res) => {
    if (req.user.buyer) return res.json({ buyer: true });
    let code = await db.getUserSetting(req.user.fb_id, 'tgCode', ''); if (!code) { code = newCode(); await db.setUserSetting(req.user.fb_id, 'tgCode', code); }
    const chat = await db.getUserSetting(req.user.fb_id, 'tgChat', null), bot = telegram.hasBot() ? await telegram.username() : '';
    res.json({ linked: !!(chat && chat.id), name: chat ? chat.name : '', at: chat ? chat.at : null, link: bot ? `https://t.me/${bot}?start=pm_${code}` : '', bot, code });
  }));
  api.delete('/me/telegram', wrap(async (req, res) => { if (!req.user.buyer) await db.setUserSetting(req.user.fb_id, 'tgChat', null); res.json({ ok: true }); }));
  return { MENU, menuPerson };
};
