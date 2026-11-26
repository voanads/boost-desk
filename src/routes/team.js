// Activity log, roles, me, auto sync, teams, main dashboard and company
// Moved out of server.js unchanged; server.js mounts it at the same place, so route order is kept.
const cfg = require('../config');
const db = require('../db');
const jobs = require('../jobs');
const orders = require('../orders');
const pm = require('../pm');
const sync = require('../sync');
const telegram = require('../telegram');

module.exports = function mountTeam(app, api, deps) {
  const { LOGINS, MB, TASKS_OFF, fbNameOf, isDay, sitePerson, wrap } = deps;
  // ---- Activity log: who changed what (leaders read it in Admin › Activity). Only the action and the person's name are
  // kept — never what was typed, and nothing about a client's customers. The last 400 lines live in one settings row.
  const AUDIT = [
    [/^POST \/clients$/, 'Added a client'], [/^PATCH \/clients\/\d+$/, 'Changed a client\'s details'], [/^DELETE \/clients\/\d+$/, 'Deleted a client'],
    [/^PUT \/clients\/\d+\/boost-plan$/, 'Changed a client\'s boost plan'], [/^PUT \/kpis$/, 'Changed KPIs'], [/^POST \/kpis\/copy/, 'Copied KPIs to other people'],
    [/^POST \/media-buyers$/, 'Added a media buyer'], [/^DELETE \/media-buyers\/[^/]+$/, 'Removed a media buyer'], [/^POST \/media-buyers\/[^/]+\/make-pm$/, 'Marked a media buyer\'s Telegram as the PM'],
    [/^PATCH \/media-buyers\//, 'Changed a media buyer'], [/^PUT \/admin\/auto-report-all$/, 'Turned auto report on or off for everyone'], [/^POST \/nudge$/, 'Sent a reminder on Telegram'], [/^POST \/clients\/\d+\/checked$/, 'Checked a client'], [/^POST \/clients\/\d+\/merge-from$/, 'Merged a duplicate client'], [/^POST \/clients\/\d+\/strategy\/send$/, 'Sent a weekly strategy to a client'], [/^PUT \/clients\/\d+\/strategy$/, 'Changed a client\'s weekly strategy'], [/^POST \/clients\/\d+\/on-it$/, 'Took a client\'s problem'], [/^POST \/nudge\/no-plan$/, 'Reminded everyone without a plan'],
    [/^(POST|PUT|DELETE) \/menu\/(item|reset)/, 'Changed a task menu'], [/^PUT \/admin\/menu$/, 'Changed the standard task menu'],
    [/^POST \/logins$/, 'Made a username'], [/^POST \/logins\/[^/]+\/reset$/, 'Reset a password'], [/^DELETE \/logins\//, 'Removed a username'], [/^POST \/me\/password$/, 'Changed their own password'],
    [/^DELETE \/fb-accounts\//, 'Removed a Facebook account from the team'], [/^POST \/admin\/merge$/, 'Merged two accounts'], [/^POST \/admin\/teams\/share-fb$/, 'Shared a Facebook account with a team'],
    [/^(POST|PUT|PATCH|DELETE) \/admin\/teams/, 'Changed teams'], [/^POST \/admin\/users\/[^/]+\/rename$/, 'Renamed an account'], [/^(POST|PUT|PATCH|DELETE) \/admin\/users/, 'Changed a user or a role'], [/^(POST|PUT|PATCH|DELETE) \/admin\//, 'Changed an Admin setting'],
    [/^POST \/invoices$/, 'Made an invoice'], [/^POST \/invoices\/\d+\/send$/, 'Sent an invoice'], [/^PUT \/invoice-profile$/, 'Changed invoice settings'], [/^PUT \/handoff\/prefs$/, 'Changed handoff messages'],
  ];
  let auditBuf = [], auditBusy = false;
  async function auditFlush() {
    if (auditBusy || !auditBuf.length) return; auditBusy = true; const add = auditBuf; auditBuf = [];
    try { const cur = await db.getSetting('auditLog', []); await db.setSetting('auditLog', [...(Array.isArray(cur) ? cur : []), ...add].slice(-400)); } catch (_) { auditBuf = [...add, ...auditBuf].slice(-400); }
    auditBusy = false;
  }
  { const t = setInterval(auditFlush, 20000); if (t.unref) t.unref(); }
  api.use((req, res, next) => {
    if (req.method === 'GET' || !req.user) return next();
    const key = `${req.method} ${req.path}`, hit = AUDIT.find(([re]) => re.test(key)); if (!hit) return next();
    const by = req.user.buyer ? req.user.buyer.name : req.user.name, role = req.user.buyer ? 'Media buyer' : '';
    res.on('finish', () => { if (res.statusCode < 400) auditBuf.push({ at: new Date().toISOString(), by, role, what: hit[1], where: req.path.replace(/^\/clients\/(\d+).*/, 'client #$1').replace(/^\/(admin\/)?/, '').slice(0, 60), for: req.user.actingFor || '' }); });
    next();
  });
  // Admins (CEO / COO / owner) can see and add tasks for any person: ?as=<fbId> on these routes acts on that person's clients and tasks (ticks are signed with the admin's name).
  const AS_ROUTES = /^\/(tasks\/mine|tasks\/month|clients(\/\d+\/(tasks(\/[^/]+)?|tick))?)$/;
  api.use(wrap(async (req, res, next) => {
    const as = String(req.query.as || (req.body && req.body.as) || '').trim();
    if (!as || !AS_ROUTES.test(req.path) || req.user.buyer) return next();
    if (!(await canSeeAdmin(req.user.fb_id))) return res.status(403).json({ error: 'Only admins can act for another person.' });
    const u = (await db.allUsers()).find((x) => x.fb_id === as); if (!u) return res.status(404).json({ error: 'Person not found.' });
    req.user = { ...req.user, fb_id: u.fb_id, actingFor: u.name };
    next();
  }));

  api.get('/me', wrap(async (req, res) => {
    res.json({
      id: req.user.fb_id, name: req.user.name, tokenExpires: req.user.token_expires,
      isOwner: await isFull(req), isAppOwner: (await db.ownerId()) === req.user.fb_id, fullAdmin: await isFull(req),
      tasksOff: TASKS_OFF,
      canAdmin: !req.user.buyer && await canSeeAdmin(req.user.fb_id), role: req.user.buyer ? 'buyer' : await roleOf(req.user.fb_id), buyer: req.user.buyer || null,
      fbWarn: await (async () => { if (req.user.buyer || req.user.google) return null; const now = Date.now(), exp = req.user.token_expires ? Date.parse(req.user.token_expires) : 0, days = exp ? Math.floor((exp - now) / 864e5) : null;
        const bad = (await sync.extraLogins(req.user.fb_id)).filter((e) => e.error || (e.expires && Date.parse(e.expires) < now)).map((e) => e.name);
        return (days !== null && days < 7) || bad.length ? { days, expired: days !== null && exp < now, extras: bad } : null; })(),
      login: await (async () => { const L = LOGINS(), r = req.user.buyer ? await L.forMb(req.user.buyer.id) : req.user.google ? null : await L.forFb(req.user.fb_id); return r ? { username: r.username, must: !!r.must } : null; })(),
      profitRole: null, // the Profit panel was removed
      google: req.session.gEmail ? { email: req.session.gEmail, picture: req.session.gPic || '' } : null, viewOnly: !!req.user.google,
      taxRate: sync.TAX_RATE, aiOn: (await db.getUserSetting(req.user.fb_id, 'aiOn', true)) !== false,
      today: sync.todayIn(), tz: cfg.tz,
      telegram: { configured: telegram.configured(), bot: telegram.hasBot(), time: cfg.reportTime },
    });
  }));

  // Profit tab (monthly ad accounts, clients and profit split) — its own access list.
  // Profit panel removed (Nov 2026): the router stays in src/profit.js and its tables are kept, but nothing is mounted.

  // Auto sync control — only the app owner can see or change it, for every account that logged in.
  // Full admin = the app owner, a Facebook account the owner marked "Full admin" (setting fullAdmins), or a Gmail person on the
  // admin website with the Full admin tick. They can do everything the owner can in Admin, except change the owner's own role.
  const fullAdmins = async () => new Set((await db.getSetting('fullAdmins', [])) || []);
  async function isFull(req) {
    if (!req.user || req.user.buyer) return false;
    if ((await db.ownerId()) === req.user.fb_id) return true;
    if ((await fullAdmins()).has(req.user.fb_id)) return true;
    if (LEAD.has((await roleMap())[req.user.fb_id])) return true; // CEO / COO / CMO set in Admin → Users control everything
    if (req.session && req.session.gEmail) { const p = await sitePerson(req.session.gEmail); if (p && p.full) return true; }
    return false;
  }
  const ownerOnly = wrap(async (req, res, next) => {
    if (!(await isFull(req))) return res.status(403).json({ error: 'Only the app owner (or a full admin) can do this.' });
    next();
  });
  api.get('/auto-sync', ownerOnly, wrap(async (req, res) => res.json({ on: process.env.AUTO_SYNC !== 'off', users: await jobs.statusAll() })));
  api.put('/auto-sync/:id', ownerOnly, wrap(async (req, res) => {
    if (!(await db.getUser(req.params.id))) return res.status(404).json({ error: 'Account not found.' });
    await jobs.setEnabled(req.params.id, !!req.body.enabled);
    res.json({ ok: true });
  }));
  const autoSyncAll = wrap(async (req, res) => {
    for (const u of await db.allUsers()) await jobs.setEnabled(u.fb_id, !!req.body.enabled);
    res.json({ ok: true });
  });
  api.put('/auto-sync', ownerOnly, autoSyncAll);
  api.put('/admin/auto-sync', ownerOnly, autoSyncAll); // the admin website (Google sign-in) only reaches /api/admin/…
  // Auto report for every Project Manager at once (Admin → App settings). Each person keeps their own time; someone who never
  // set one gets 20:00. Turning it on after today's time has passed starts tomorrow (extras.saveAutoSettings), so this never
  // sends a burst of reports the moment it is tapped.
  const EXTRAS = () => require('../extras');
  const autoReportAll = async () => {
    const out = [];
    for (const u of await db.allUsers()) { const s = await EXTRAS().autoSettings(u.fb_id); out.push({ id: u.fb_id, name: u.name, on: !!s.on, time: s.time }); }
    return { users: out, on: out.filter((x) => x.on).length, total: out.length };
  };
  api.get('/admin/auto-report-all', ownerOnly, wrap(async (req, res) => res.json(await autoReportAll())));
  api.put('/admin/auto-report-all', ownerOnly, wrap(async (req, res) => {
    for (const u of await db.allUsers()) await EXTRAS().saveAutoSettings(u.fb_id, { on: !!(req.body && req.body.on) });
    res.json(await autoReportAll());
  }));
  // Admin overview: every account's spend for a period (owner, or people the owner allowed).
  const adminViewers = async () => new Set(await db.getSetting('adminViewers', []));
  // Company roles: ceo (the app owner, or anyone given it), coo (sees everything, like an admin), pm (own clients).
  // Stored in the setting roles = { fbId: 'ceo'|'coo'|'pm' }; ceo/coo are also admin viewers so every older check holds.
  const ROLES = ['ceo', 'coo', 'cmo', 'pm', 'mb']; // mb = a media buyer who logs in with Facebook: /mediabuyer site, media buyer task menu
  const LEAD = new Set(['ceo', 'coo', 'cmo']); // top leadership: control everything, like the owner
  const roleMap = async () => (await db.getSetting('roles', {})) || {};
  async function roleOf(id) {
    if ((await db.ownerId()) === id) return 'ceo';
    const r = (await roleMap())[id]; if (ROLES.includes(r)) return r;
    return (await adminViewers()).has(id) ? 'coo' : 'pm';
  }
  const canSeeAdmin = async (id) => (String(id).startsWith('g:') && !!(await sitePerson(String(id).slice(2)))) || (await db.ownerId()) === id || (await adminViewers()).has(id);
  const adminOnly = wrap(async (req, res, next) => {
    if (!(await canSeeAdmin(req.user.fb_id))) return res.status(403).json({ error: 'Only the app owner and people they allow can see the Admin dashboard.' });
    next();
  });
  api.put('/admin/viewers/:id', ownerOnly, wrap(async (req, res) => {
    const v = await adminViewers();
    if (req.body && req.body.enabled) v.add(req.params.id); else v.delete(req.params.id);
    await db.setSetting('adminViewers', [...v]);
    res.json({ ok: true });
  }));
  // Teams (groups of accounts shown together on the Admin dashboard). The owner manages them.
  const getTeams = () => db.getSetting('teams', []);
  const saveTeams = (t) => db.setSetting('teams', t);
  api.get('/admin/teams', adminOnly, wrap(async (req, res) => {
    const owner = await db.ownerId(), bl = await MB().all(), byName = {};
    const users = await db.allUsers(); for (const u of users) byName[u.name] = u.fb_id;
    const mbs = bl.map((b) => ({ id: b.id, name: b.name, pm: b.addedById || byName[b.addedBy] || null, linked: !!(b.linked || b.chat) })); // all() gives the public shape: `linked`, never the chat id
    const roles = await roleMap(), av = await adminViewers(), now = Date.now(), logins = await LOGINS().list();
    const counts = Object.fromEntries((await db.pool.query(`SELECT owner, count(*) FILTER (WHERE NOT archived)::int AS n FROM clients GROUP BY owner`)).rows.map((r) => [r.owner, r.n]));
    const accts = Object.fromEntries((await db.pool.query(`SELECT owner, count(*)::int AS n FROM ad_accounts GROUP BY owner`)).rows.map((r) => [r.owner, r.n]));
    const out = [];
    for (const u of users) {
      const exp = u.token_expires ? Date.parse(u.token_expires) : 0, chat = await db.getUserSetting(u.fb_id, 'tgChat', null), lg = logins.find((l) => l.fbId === u.fb_id);
      out.push({ id: u.fb_id, name: u.name, role: u.fb_id === owner ? 'owner' : ROLES.includes(roles[u.fb_id]) ? roles[u.fb_id] : av.has(u.fb_id) ? 'coo' : 'pm',
        buyers: mbs.filter((m) => m.pm === u.fb_id).map((m) => m.name), mbs: mbs.filter((m) => m.pm === u.fb_id).map((m) => ({ id: m.id, name: m.name, linked: m.linked })),
        clients: counts[u.fb_id] || 0, adAccounts: accts[u.fb_id] || 0, username: lg ? lg.username : '',
        facebook: { name: await fbNameOf(u), expired: !!(exp && exp < now), daysLeft: exp ? Math.floor((exp - now) / 864e5) : null },
        extras: (await sync.extraLogins(u.fb_id)).map((e) => ({ id: e.id, name: e.name, expired: !!(e.error || (e.expires && Date.parse(e.expires) < now)), shared: !!e.shared })),
        telegram: { linked: !!(chat && chat.id), name: chat ? chat.name || '' : '' } });
    }
    res.json({ teams: await getTeams(), users: out, canEdit: await isFull(req), bot: telegram.hasBot() });
  }));
  // A leader (owner / CEO / COO / CMO) keeps their own sign-in, and their Facebook login is ALSO used by a team to reach
  // its ad accounts: it is added to that team's Facebook accounts. (An ordinary second account is merged instead.)
  api.post('/admin/teams/share-fb', ownerOnly, wrap(async (req, res) => {
    const b = req.body || {}, from = String(b.from || ''), into = String(b.into || '');
    const src = await db.getUser(from), dst = await db.getUser(into); if (!src || !dst || from === into) return res.status(404).json({ error: 'Choose two different accounts.' });
    const roles = await roleMap(), lead = from === (await db.ownerId()) || LEAD.has(roles[from]) || (await fullAdmins()).has(from);
    if (!lead) return res.status(400).json({ error: `${src.name} is an ordinary account — use Merge into… so its clients move too.` });
    const list = (await sync.extraLogins(into)).filter((x) => x.id !== from);
    if (list.length + 2 > require('../merge').MAX_FB) return res.status(400).json({ error: `${dst.name} already has the most Facebook accounts a workspace can hold.` });
    list.push({ id: from, name: await fbNameOf(src), token_enc: src.token_enc, expires: src.token_expires, addedAt: new Date().toISOString(), shared: true });
    await db.setUserSetting(into, 'fbExtras', list);
    let n = 0; try { await sync.refreshAccounts(dst); n = (await db.listAccounts(into)).filter((a) => (a.info || {}).via === from).length; } catch (e) { console.error('[share fb] account list failed:', e.message); }
    console.log('[teams]', await fbNameOf(src), 'Facebook shared with', dst.name, 'by', req.user.name);
    res.json({ ok: true, name: await fbNameOf(src), into: dst.name, found: n });
  }));
  api.post('/admin/teams', ownerOnly, wrap(async (req, res) => {
    const name = String(req.body?.name || '').trim().slice(0, 60);
    if (!name) return res.status(400).json({ error: 'Give the team a name.' });
    const teams = await getTeams();
    const t = { id: 't' + Date.now().toString(36), name, members: [] };
    teams.push(t); await saveTeams(teams); res.json(t);
  }));
  api.patch('/admin/teams/:id', ownerOnly, wrap(async (req, res) => {
    const teams = await getTeams(), t = teams.find((x) => x.id === req.params.id);
    if (!t) return res.status(404).json({ error: 'Team not found.' });
    if (req.body?.name != null) { const n = String(req.body.name).trim().slice(0, 60); if (n) t.name = n; }
    if (req.body?.add) { const id = String(req.body.add); for (const x of teams) x.members = x.members.filter((m) => m !== id); t.members.push(id); } // one team per person
    if (req.body?.remove) t.members = t.members.filter((m) => m !== String(req.body.remove));
    await saveTeams(teams); res.json(t);
  }));
  api.delete('/admin/teams/:id', ownerOnly, wrap(async (req, res) => {
    await saveTeams((await getTeams()).filter((x) => x.id !== req.params.id)); res.json({ ok: true });
  }));
  // Main Dashboard: each account's to-do list and suggestions for today (the same list each person sees on their Dashboard).
  api.get('/main/suggestions', adminOnly, wrap(async (req, res) => {
    const out = {};
    await Promise.all((await db.allUsers()).map(async (u) => {
      try { const t = await pm.todo({ fb_id: u.fb_id, name: u.name }); out[u.fb_id] = { items: t.items || [], tips: t.tips || [] }; }
      catch (e) { out[u.fb_id] = { items: [], tips: [], error: e.message }; }
    }));
    res.json({ today: sync.todayIn(), users: out });
  }));
  // Main Dashboard: everyone's client tasks for one day (AI daily plan tasks + their own), read-only for the COO.
  // Includes tasks left open from earlier days (only when looking at today) and earlier tasks finished on this day.
  // A task's target for one day: { target, unit, reached } (reached is typed by the person; per day for every-day tasks).
  const tgt = (t, day) => (Number(t.target) > 0 ? { target: Number(t.target), unit: String(t.unit || ''), reached: Number((t.hit || {})[day]) || 0 } : {});
  const AI_TASK_DAYS = 3; // unticked AI plan tasks drop off after this many days
  async function dayTasks(day) {
    const today = sync.todayIn();
    const users = await db.allUsers(), out = {};
    for (const u of users) out[u.fb_id] = { name: u.name, tasks: [], plans: 0, clients: 0 };
    const cl = (await db.pool.query('SELECT id, name, owner, archived FROM clients')).rows, cName = {};
    for (const c of cl) { cName[c.id] = c.name; if (!c.archived && out[c.owner]) out[c.owner].clients++; }
    const rows = (await db.pool.query(`SELECT key, value FROM settings WHERE key ~ '^[^:]+:cwb:[0-9]+$'`)).rows;
    const localDay = (iso) => { try { return sync.todayIn(undefined, new Date(iso)); } catch (_) { return ''; } };
    for (const r of rows) {
      const [owner, , cid] = r.key.split(':'), o = out[owner]; if (!o || !cName[cid]) continue;
      const w = r.value || {};
      if (w.ai && w.ai.day === day) o.plans++;
      for (const t of w.tasks || []) {
        const doneDay = t.done && t.doneAt ? localDay(t.doneAt) : '';
        if (t.repeat) { // every day from the day it was added: done only if ticked that day
          if (t.day > day || day > today) continue;
          o.tasks.push({ id: t.id, text: t.text, from: 'me', day, done: doneDay === day, doneAt: doneDay === day ? t.doneAt : null, doneBy: doneDay === day ? t.doneBy || null : null, late: false, repeat: true, client: cName[cid], clientId: Number(cid), ...tgt(t, day), to: t.to ? { id: t.to.id, name: t.to.name } : null, sentAt: t.sentAt || null, kpi: t.kpi || '' });
          continue;
        }
        const late = t.day < day && ((!t.done && day === today) || doneDay === day);
        if (t.day !== day && !late) continue;
        if (t.from === 'ai' && !t.done && t.day < sync.addDays(day, -AI_TASK_DAYS)) continue; // an AI idea nobody ticked in 3 days has expired
        o.tasks.push({ id: t.id, text: t.text, from: t.from === 'ai' ? 'ai' : 'me', day: t.day, done: !!t.done, doneAt: t.doneAt || null, doneBy: t.doneBy || null, late: t.day < day, client: cName[cid], clientId: Number(cid), ...tgt(t, t.day), to: t.to ? { id: t.to.id, name: t.to.name } : null, sentAt: t.sentAt || null, kpi: t.kpi || '' });
      }
    }
    // Today's work (the same rule-based list each person sees in Clients: send report, unpaid, quiet client…), ticked or not.
    if (day === today) {
      const wb = {}; for (const r of rows) wb[r.key] = r.value || {};
      await Promise.all(users.map(async (u) => {
        let t; try { t = await pm.todo({ fb_id: u.fb_id, name: u.name }); } catch (_) { return; }
        for (const x of [...(t.items || []), ...(t.tips || [])]) {
          if (!x.clientId || !cName[x.clientId]) continue;
          const wbk = wb[`${u.fb_id}:cwb:${x.clientId}`] || {};
          const tk = (wbk.ticks || {})[`${day}:${x.kind}`];
          out[u.fb_id].tasks.push({ id: `w:${x.clientId}:${x.kind}`, text: x.title, detail: x.detail || '', from: 'work', kind: x.kind, level: x.level || '', day, done: !!tk, doneAt: tk ? tk.at : null, doneBy: tk ? tk.by : null, late: false, client: cName[x.clientId], clientId: Number(x.clientId) });
        }
      }));
    }
    const ord = { work: 0, ai: 1, me: 2 };
    for (const o of Object.values(out)) o.tasks.sort((a, b) => a.client.localeCompare(b.client) || (a.done - b.done) || (ord[a.from] - ord[b.from]) || a.day.localeCompare(b.day));
    return { day, today, users: out };
  }
  api.get('/main/tasks', adminOnly, wrap(async (req, res) => {
    const day = isDay(req.query.day) ? req.query.day : sync.todayIn();
    res.json({ ...(await dayTasks(day)), teams: (await getTeams()).map((t) => ({ id: t.id, name: t.name, members: t.members })) });
  }));
  // Clients Board: every client of every person — this month's money (+ yesterday) and today's work & tasks.
  // The money part is kept for 2 minutes (it reads every account); tasks are always fresh.
  let boardMoney = { at: 0, key: '', data: null };
  async function clientMoney(today) {
    if (boardMoney.data && boardMoney.key === today && Date.now() - boardMoney.at < 120e3) return boardMoney.data;
    const from = today.slice(0, 8) + '01', yest = sync.addDays(today, -1), out = {};
    const nm = (x) => String(x || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const cpoPart = async (owner, f, t) => {
      const [d, pages, oc] = await Promise.all([sync.dashboard(owner, f, t), sync.pageSpend(owner, f, t), orders.byClient(owner, f, t)]);
      const r = {};
      for (const c of d.clients) {
        const o = oc.clients[c.id] || { orders: 0, pages: {} };
        const pg = sync.scalePages(pages[c.id] || [], c.spend).map((p) => ({ spend: p.spend, orders: o.pages[p.pageId] || o.pages['name:' + nm(p.page)] || 0 }));
        const top = (pages[c.id] || []).filter((p) => p.pageId).sort((a, b) => b.spend - a.spend)[0];
        r[c.id] = { pageId: top ? String(top.pageId) : '', spend: c.spend, orders: o.orders, ordSpend: sync.orderSpend(pg, o.orders, c.spend), lives: c.lives || 0, liveSpend: c.liveSpend || 0, postSpend: c.postSpend || 0, days: c.days || 0 };
      }
      return r;
    };
    for (const u of await db.allUsers()) {
      try { const [m, y] = await Promise.all([cpoPart(u.fb_id, from, today), cpoPart(u.fb_id, yest, yest)]); out[u.fb_id] = { m, y }; } catch (_) { out[u.fb_id] = { m: {}, y: {} }; }
    }
    boardMoney = { at: Date.now(), key: today, data: { from, to: today, out } };
    return boardMoney.data;
  }
  api.get('/main/board', adminOnly, wrap(async (req, res) => {
    const today = sync.todayIn();
    const [money, tasks, teams, users, cl] = await Promise.all([clientMoney(today), dayTasks(today), getTeams(), db.allUsers(), db.pool.query('SELECT id, name, owner, type, archived, telegram, telegram_title, pages FROM clients ORDER BY name').then((r) => r.rows)]);
    // each client's AI plan (the same "Today's plan" its owner sees; notes stay private)
    const wb = {}; for (const r of (await db.pool.query(`SELECT key, value FROM settings WHERE key ~ '^[^:]+:cwb:[0-9]+$'`)).rows) wb[r.key] = r.value || {};
    const uName = Object.fromEntries(users.map((u) => [u.fb_id, u.name])), teamOf = {};
    for (const t of teams) for (const m of t.members) teamOf[m] = t.id;
    const clients = [];
    for (const c of cl) {
      if (!uName[c.owner]) continue;
      const mm = ((money.out[c.owner] || {}).m || {})[c.id], yy = ((money.out[c.owner] || {}).y || {})[c.id];
      if (c.archived && !(mm && mm.spend > 0)) continue;
      const ts = ((tasks.users[c.owner] || {}).tasks || []).filter((t) => t.clientId === c.id).map(({ client, clientId, ...t }) => t);
      clients.push({ id: c.id, name: c.name, type: c.type, group: c.telegram_title || '', archived: !!c.archived, owner: c.owner, ownerName: uName[c.owner], team: teamOf[c.owner] || null,
        month: mm || { spend: 0, orders: 0, ordSpend: 0, lives: 0, liveSpend: 0, postSpend: 0, days: 0 }, yest: yy || { spend: 0, orders: 0, ordSpend: 0 }, tasks: ts,
        pageId: (mm && mm.pageId) || ((Array.isArray(c.pages) ? c.pages : []).map(String).find((x) => /^\d{5,20}$/.test(x)) || ''),
        hasGroup: !!c.telegram, plan: (() => { const a = (wb[`${c.owner}:cwb:${c.id}`] || {}).ai; return a && a.text ? { day: a.day, lang: a.lang, at: a.at, text: String(a.text).slice(0, 6000) } : null; })() });
    }
    res.json({ today, from: money.from, to: money.to, taxRate: sync.TAX_RATE, teams: teams.map((t) => ({ id: t.id, name: t.name, members: t.members })), people: users.map((u) => ({ id: u.fb_id, name: u.name, team: teamOf[u.fb_id] || null })), clients });
  }));
  // Main Dashboard (COO view): every account, every Page it boosts, spend and adsbox.biz orders per Page.
  api.get('/main/overview', adminOnly, wrap(async (req, res) => {
    const { from, to } = req.query;
    if (!isDay(from) || !isDay(to) || from > to || (Date.parse(to) - Date.parse(from)) / 864e5 > 366) return res.status(400).json({ error: 'Pick a valid period (at most one year).' });
    const nm = (x) => String(x || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const ordRows = (await db.pool.query('SELECT page_id, max(page_name) AS page_name, sum(orders)::int AS orders FROM page_orders WHERE day BETWEEN $1 AND $2 GROUP BY page_id', [from, to])).rows;
    const byId = {}, byName = {};
    for (const r of ordRows) { byId[String(r.page_id)] = r.orders; if (r.page_name) byName[nm(r.page_name)] = (byName[nm(r.page_name)] || 0) + r.orders; }
    const users = [], seenPages = new Map();
    for (const u of await db.allUsers()) {
      const [ps, clients, dash, unl] = await Promise.all([sync.pageSpend(u.fb_id, from, to), db.listClients(u.fb_id), sync.dashboard(u.fb_id, from, to), sync.unmatchedSpend(u.fb_id, from, to)]);
      const cName = Object.fromEntries(clients.map((c) => [c.id, c.name]));
      const pages = [];
      // Spend per client = the saved entries (same as the Dashboard); Pages are scaled to add up to it.
      const per = {};
      for (const dc of dash.clients) {
        if (!(dc.spend > 0)) continue;
        const raw = ps[dc.id] || [];
        per[dc.id] = raw.length ? sync.scalePages(raw, dc.spend)
          : [{ page: dc.name + ' (Page not known)', pageId: '', named: true, spend: dc.spend, live: dc.liveSpend, post: dc.postSpend, list: [{ id: `entry:${u.fb_id}:${dc.id}`, spend: dc.spend }] }];
      }
      for (const [cid, list] of Object.entries(per)) for (const p of list) {
        const orders = (p.pageId && byId[String(p.pageId)]) || byName[nm(p.page)] || byName[nm(p.guess)] || 0;
        // Campaign IDs with their spend: two people syncing the same ad account see the same campaigns,
        // so team and company totals count each campaign once.
        const camps = (p.list || []).map((x, i) => [x.id ? String(x.id) : `${u.fb_id}:${p.page}:${i}`, x.spend]);
        pages.push({ page: p.page, pageId: p.pageId, named: p.named, guess: p.guess || '', client: cName[cid] || '', clientId: Number(cid), spend: p.spend, live: p.live, post: p.post, orders, camps });
        const key = p.pageId || nm(p.page);
        const s = seenPages.get(key) || { orders, camps: new Map() };
        for (const [id, v] of camps) if (!s.camps.has(id)) s.camps.set(id, v);
        seenPages.set(key, s);
      }
      pages.sort((a, b) => b.spend - a.spend);
      const spend = pages.reduce((t, p) => t + p.spend, 0), orders = pages.reduce((t, p) => t + p.orders, 0);
      const ordSpend = pages.filter((p) => p.orders > 0).reduce((t, p) => t + p.spend, 0);
      if (!pages.length && !clients.length && !unl.spend) continue;
      users.push({ id: u.fb_id, name: u.name, you: u.fb_id === req.user.fb_id, spend: Math.round(spend * 100) / 100, orders, ordSpend: Math.round(ordSpend * 100) / 100, clients: clients.filter((c) => !c.archived).length, pages, unlinked: { spend: unl.spend, pages: unl.pages.slice(0, 12) }, _unl: unl.pages });
    }
    users.sort((a, b) => b.spend - a.spend || a.name.localeCompare(b.name));
    // Totals: a Page boosted from two accounts has its orders counted once.
    const tot = { spend: 0, orders: 0, ordSpend: 0, pages: seenPages.size, users: users.filter((u) => u.spend > 0).length };
    let added = 0; for (const u of users) added += u.spend;
    for (const v of seenPages.values()) { const sp = [...v.camps.values()].reduce((a, b) => a + b, 0); tot.spend += sp; tot.orders += v.orders; if (v.orders > 0) tot.ordSpend += sp; }
    tot.shared = Math.max(0, Math.round((added - tot.spend) * 100) / 100);
    tot.spend = Math.round(tot.spend * 100) / 100; tot.ordSpend = Math.round(tot.ordSpend * 100) / 100;
    const unlinked = { spend: 0 }; { const seen = new Map(); for (const u of users) for (const p of u._unl) for (const [id, v] of p.camps || []) if (!seen.has(id)) seen.set(id, v); unlinked.spend = Math.round([...seen.values()].reduce((a, b) => a + b, 0) * 100) / 100; }
    for (const u of users) { delete u._unl; u.unlinked.pages = u.unlinked.pages.map(({ camps, ...p }) => p); }
    tot.unlinked = unlinked.spend;
    res.json({ from, to, totals: tot, users, quality: await orders.periodQuality(from, to), teams: (await getTeams()).map((t) => ({ id: t.id, name: t.name, members: t.members })) });
  }));
  // Company dashboard (CEO / COO): one month of the whole company.
  const company = require('../company');
  api.get('/company/summary', adminOnly, wrap(async (req, res) => {
    res.json(await company.summary({ month: req.query.month, getTeams, dayTasks, clientMoney }));
  }));
  api.get('/admin/overview', adminOnly, wrap(async (req, res) => {
    const { from, to } = req.query;
    if (!isDay(from) || !isDay(to) || from > to || (Date.parse(to) - Date.parse(from)) / 864e5 > 366) return res.status(400).json({ error: 'Pick a valid period (at most one year).' });
    const users = await db.allUsers();
    const out = [];
    // Orders from adsbox.biz for the period (live), counted per account through its clients' Pages.
    const given = null; // kept daily counts (see orders.js)
    for (const u of users) {
      const d = await sync.dashboard(u.fb_id, from, to);
      let ord = 0, ordSpend = 0;
      try { const oc = await orders.byClient(u.fb_id, from, to, 'all', given); for (const c of d.clients) { const o = oc.clients[c.id]; if (o && o.orders) { ord += o.orders; ordSpend += c.spend; } } } catch (_) {}
      const last = (await db.pool.query('SELECT max(synced_at) AS at FROM day_meta WHERE owner=$1', [u.fb_id])).rows[0];
      out.push({
        id: u.fb_id, name: u.name, you: u.fb_id === req.user.fb_id,
        expired: !!(u.token_expires && new Date(u.token_expires) < new Date()),
        lastSync: last && last.at, totals: d.totals, orders: ord, orderSpend: Math.round(ordSpend * 100) / 100,
        clientCount: d.clients.filter((c) => !c.archived).length,
        clients: d.clients.filter((c) => c.spend > 0 || !c.archived).map((c) => ({ id: c.id, name: c.name, type: c.type, lives: c.lives, liveSpend: c.liveSpend, postSpend: c.postSpend, spend: c.spend, days: c.days })),
      });
    }
    out.sort((a, b) => b.totals.spend - a.totals.spend || a.name.localeCompare(b.name));
    const totals = out.reduce((t, u) => ({ spend: t.spend + u.totals.spend, live: t.live + u.totals.live, post: t.post + u.totals.post, lives: t.lives + u.totals.lives, clients: t.clients + u.totals.active, accounts: t.accounts + (u.totals.spend > 0 ? 1 : 0) }), { spend: 0, live: 0, post: 0, lives: 0, clients: 0, accounts: 0 });
    const teams = await getTeams();
    for (const u of out) { const t = teams.find((x) => x.members.includes(u.id)); u.team = t ? t.id : null; }
    // Team and all-account totals count each Meta campaign once (two people can sync the same ad account).
    const teamTotals = {};
    for (const t of teams) {
      const ids = out.filter((u) => u.team === t.id).map((u) => u.id);
      const sum = out.filter((u) => u.team === t.id).reduce((a, u) => a + u.totals.spend, 0);
      teamTotals[t.id] = { ...(await sync.uniqueTotals(ids, from, to)), added: Math.round(sum * 100) / 100 };
    }
    const uniq = await sync.uniqueTotals(out.map((u) => u.id), from, to);
    const allTotals = { ...totals, spend: uniq.spend, live: uniq.live, post: uniq.post, lives: uniq.lives, clients: uniq.clients, added: Math.round(totals.spend * 100) / 100 };
    allTotals.orders = out.reduce((t, u) => t + u.orders, 0); allTotals.orderSpend = out.reduce((t, u) => t + u.orderSpend, 0);
    res.json({ from, to, users: out, totals: allTotals, teams, teamTotals, taxRate: sync.TAX_RATE });
  }));
  return { LEAD, ROLES, adminOnly, adminViewers, auditFlush, canSeeAdmin, dayTasks, fullAdmins, getTeams, isFull, ownerOnly, roleMap, roleOf, tgt };
};
