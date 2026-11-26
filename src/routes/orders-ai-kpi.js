// Orders (adsbox.biz API), AI advice, KPIs, people today / month, audit, nudges
// Moved out of server.js unchanged; server.js mounts it at the same place, so route order is kept.
const cfg = require('../config');
const db = require('../db');
const orders = require('../orders');
const sync = require('../sync');
const telegram = require('../telegram');

module.exports = function mountOrdersAiKpi(app, api, deps) {
  const { LEAD, LOGINS, MB, ROLES, TASKS_OFF, adminOnly, adminViewers, auditFlush, canSeeAdmin, dayTasks, getTeams, isDay, ownerOnly, roleMap, roleOf, wrap } = deps;
  // ---------- Orders page (adsbox.biz API) ----------
  api.get('/orders/api', wrap(async (req, res) => { const c = await orders.publicConfig(); if (!(await canSeeAdmin(req.user.fb_id))) { delete c.keyHint; delete c.url; delete c.savedBy; c.url = c.hasKey ? 'set' : ''; } res.json(c); })); // non-admins only learn whether it is connected
  api.put('/orders/api', adminOnly, wrap(async (req, res) => res.json(await orders.saveApiConfig(req.body || {}, req.user.name))));
  api.get('/orders/hook', adminOnly, wrap(async (req, res) => res.json({ url: `${req.protocol}://${req.get('host')}/hooks/adsbox`, secret: await orders.hookSecret(), last: ((await db.getSetting('adsboxApi', null)) || {}).hookLast || null })));
  api.post('/orders/hook/renew', adminOnly, wrap(async (req, res) => res.json({ secret: await orders.hookSecret(true) })));
  api.get('/orders/push', adminOnly, wrap(async (req, res) => res.json(await orders.pushStatus())));
  api.put('/orders/push', adminOnly, wrap(async (req, res) => res.json(await orders.setPush(!!(req.body || {}).on))));
  api.post('/orders/push', adminOnly, wrap(async (req, res) => { await orders.setPush(true); res.json(await orders.pushSpend(Math.min(31, Number((req.body || {}).days) || 7))); }));
  // AI advice for one client (Claude API). The owner adds the key in Admin → Settings.
  api.post('/ai/client/:id', wrap(async (req, res) => {
    const b = req.body || {};
    if (!isDay(b.from) || !isDay(b.to) || b.from > b.to || (Date.parse(b.to) - Date.parse(b.from)) / 864e5 > 185) return res.status(400).json({ error: 'Pick a period of up to 6 months.' });
    try { res.json(await require('../ai').clientAdvice(req.user.fb_id, req.params.id, { from: b.from, to: b.to, lang: b.lang === 'km' ? 'km' : 'en', question: String(b.question || ''), fresh: !!b.fresh })); }
    catch (e) { if (e.status) return res.status(e.status).json({ error: e.message, notSetUp: !!e.notSetUp }); throw e; }
  }));
  // Client workbook: today's AI plan (per Page + tasks), the user's notes and tasks, and ticks on today's work.
  const AI = () => require('../ai');
  const ownClient = async (req) => (await db.listClients(req.user.fb_id)).find((x) => x.id === Number(req.params.id));
  // Open tasks and today's ticks for every client (for the badges in the Clients list).
  // Monthly KPIs (per person or media buyer). person = a user id, or mb:<media buyer id>.
  const KPI = () => require('../kpi');
  // A media buyer of mine (I added them), or any media buyer for leaders. A media buyer session is never "mine".
  const ownsBuyer = async (req, id) => { if (req.user.buyer) return false; if (await canSeeAdmin(req.user.fb_id)) return true; const b = await MB().get(String(id)); return !!b && (b.addedById === req.user.fb_id || (!b.addedById && b.addedBy === req.user.name)); };
  // Whose KPIs: a media buyer sees only their own; a PM their own and their media buyers'; leaders anyone's.
  const kpiPerson = async (req, raw) => {
    if (req.user.buyer) { const own = 'mb:' + req.user.buyer.id; if (raw && String(raw) !== own) return null; return { id: own, name: req.user.buyer.name, buyer: true, canEdit: false }; }
    const p = String(raw || req.user.fb_id);
    if (p.startsWith('mb:')) { if (!(await ownsBuyer(req, p.slice(3)))) return null; const b = await require('../buyers').get(p.slice(3)); return b ? { id: p, name: b.name, buyer: true, canEdit: true } : null; }
    if (p === req.user.fb_id) return { id: p, name: req.user.name, buyer: false, canEdit: true };
    if (!(await canSeeAdmin(req.user.fb_id))) return null;
    const u = await db.getUser(p); return u ? { id: p, name: u.name, buyer: false, canEdit: true } : null;
  };
  api.get('/kpis', wrap(async (req, res) => {
    const who = await kpiPerson(req, req.query.person); if (!who) return res.status(404).json({ error: 'Person not found.' });
    const month = /^\d{4}-\d{2}$/.test(req.query.month) ? req.query.month : sync.todayIn().slice(0, 7);
    const K = KPI(), kpis = await K.results(who.buyer ? who.id.slice(3) : who.id, month, who.buyer), ms = await K.months(who.buyer ? who.id.slice(3) : who.id);
    const prev = ms.filter((m) => m < month).pop() || '';
    res.json({ person: who, month, kpis, months: ms, prev, today: sync.todayIn() });
  }));
  api.put('/kpis', wrap(async (req, res) => {
    const who = await kpiPerson(req, (req.body || {}).person); if (!who) return res.status(404).json({ error: 'Person not found.' });
    const month = /^\d{4}-\d{2}$/.test((req.body || {}).month) ? req.body.month : sync.todayIn().slice(0, 7);
    await KPI().putList(who.buyer ? who.id.slice(3) : who.id, month, (req.body || {}).kpis);
    res.json({ ok: true });
  }));
  // 💡 Suggested daily actions for one KPI (AI). The person's menu and other KPIs give it context.
  api.post('/kpis/suggest', wrap(async (req, res) => {
    const b = req.body || {}, who = await kpiPerson(req, b.person); if (!who) return res.status(404).json({ error: 'Person not found.' });
    const k = b.kpi || {}; if (!String(k.name || '').trim()) return res.status(400).json({ error: 'Which KPI?' });
    const month = /^\d{4}-\d{2}$/.test(b.month) ? b.month : sync.todayIn().slice(0, 7);
    const pid = who.buyer ? who.id.slice(3) : who.id, role = who.buyer ? 'mb' : 'pm';
    let menu = [], others = [];
    try { menu = (await deps.MENU().listOf(pid, role)).map((x) => x.text); } catch (_) {}
    try { others = (await KPI().getList(pid, month)).filter((x) => x.id !== k.id).map((x) => `${x.name} (${x.target} ${x.unit})`); } catch (_) {}
    try { res.json(await AI().kpiSuggest(req.user.fb_id, { name: String(k.name).slice(0, 120), target: Number(k.target) || 0, unit: String(k.unit || '').slice(0, 12), role, menu, others, lang: b.lang === 'en' ? 'en' : 'km', fresh: !!b.fresh })); }
    catch (e) { res.status(e.status || 500).json({ error: e.message, notSetUp: !!e.notSetUp }); }
  }));
  // People whose KPIs an admin can open: every user and every media buyer.
  api.get('/kpis/people', adminOnly, wrap(async (req, res) => {
    const users = (await db.allUsers()).map((u) => ({ id: u.fb_id, name: u.name, kind: 'PM' }));
    const byName = Object.fromEntries(users.map((u) => [u.name, u.id]));
    const buyers = (await require('../buyers').all()).map((b) => ({ id: 'mb:' + b.id, name: b.name, kind: 'Media buyer', pm: b.addedById || byName[b.addedBy] || null }));
    res.json({ people: [...users, ...buyers] });
  }));
  // Admin My Task page: every person with today's task counts and this month's KPI score (users and media buyers).
  api.get('/admin/people-today', adminOnly, wrap(async (req, res) => {
    const today = sync.todayIn(), ym = today.slice(0, 7), owner = await db.ownerId(), roles = await roleMap(), av = await adminViewers();
    const users = await db.allUsers(), byName = Object.fromEntries(users.map((u) => [u.name, u.fb_id]));
    const bl = await MB().all(), teams = await getTeams(), teamOf = {}; for (const t of teams) for (const m of t.members) teamOf[m] = t.name;
    const dt = await dayTasks(today), K = KPI();
    const kpiAvg = async (id, buyer) => { try { const rs = (await K.results(id, ym, buyer)).filter((k) => k.target > 0); return rs.length ? Math.round(rs.reduce((t, k) => t + Math.min(k.score, 100), 0) / rs.length) : null; } catch (_) { return null; } };
    const count = (list) => ({ done: list.filter((t) => t.done).length, open: list.filter((t) => !t.done).length, late: list.filter((t) => !t.done && t.late).length });
    const people = [];
    for (const u of users) {
      const ts = ((dt.users[u.fb_id] || {}).tasks || []).filter((t) => t.from !== 'work' && t.from !== 'ai');
      const RN = { ceo: 'CEO', coo: 'COO', cmo: 'CMO', pm: 'Project Manager', mb: 'Media buyer' }, role = u.fb_id === owner ? 'CEO · Owner' : RN[ROLES.includes(roles[u.fb_id]) ? roles[u.fb_id] : av.has(u.fb_id) ? 'coo' : 'pm'];
      const isMb = ROLES.includes(roles[u.fb_id]) && roles[u.fb_id] === 'mb', mn = await deps.MENU().dayOf(u.fb_id, isMb ? 'mb' : 'pm', today);
      people.push({ id: u.fb_id, name: u.name, kind: isMb ? 'Media buyer' : 'PM', role, team: teamOf[u.fb_id] || '', done: mn.done, open: mn.total - mn.done, late: 0, pct: mn.pct, planAt: mn.plan ? mn.plan.at : null, resultAt: mn.result ? mn.result.at : null, tasks: count(ts), kpi: await kpiAvg(u.fb_id, false), buyers: bl.filter((b) => (b.addedById || byName[b.addedBy]) === u.fb_id).length });
    }
    for (const b of bl) {
      const pm = b.addedById || byName[b.addedBy] || null, ts = pm ? ((dt.users[pm] || {}).tasks || []).filter((t) => t.to && t.to.id === b.id) : [];
      const mn = await deps.MENU().dayOf(b.id, 'mb', today);
      people.push({ id: 'mb:' + b.id, name: b.name, kind: 'Media buyer', role: 'Media buyer', pm, pmName: pm ? (users.find((u) => u.fb_id === pm) || {}).name || '' : '', team: pm ? teamOf[pm] || '' : '', linked: !!(b.linked || b.chat), photo: !!b.photo, done: mn.done, open: mn.total - mn.done, late: 0, pct: mn.pct, planAt: mn.plan ? mn.plan.at : null, resultAt: mn.result ? mn.result.at : null, tasks: count(ts), kpi: await kpiAvg(b.id, true) });
    }
    // yesterday's menu result of the same people, for the calm "before the working day" view
    const yd = sync.addDays(today, -1), yest = { done: 0, total: 0 };
    for (const p of people) { if (p.role !== 'Project Manager' && p.kind !== 'Media buyer') continue; try { const d = await deps.MENU().dayOf(p.id.startsWith('mb:') ? p.id.slice(3) : p.id, p.kind === 'Media buyer' ? 'mb' : 'pm', yd); yest.done += d.done; yest.total += d.total; } catch (_) {} }
    res.json({ today, month: ym, people, teams: teams.map((t) => t.name), hour: hourNow(), shift: SHIFT, yesterday: yest });
  }));
  // Leader's "This month" board: every Project Manager and media buyer with each KPI's score, and how many days
  // they sent a plan and a result and how much of the daily menu they ticked. Read only; no personal data of clients.
  api.get('/admin/people-month', adminOnly, wrap(async (req, res) => {
    const today = sync.todayIn(), month = /^\d{4}-\d{2}$/.test(req.query.month) && req.query.month <= today.slice(0, 7) ? req.query.month : today.slice(0, 7);
    const owner = await db.ownerId(), roles = await roleMap(), av = await adminViewers(), users = await db.allUsers(), byName = Object.fromEntries(users.map((u) => [u.name, u.fb_id]));
    const bl = await MB().all(), teams = await getTeams(), teamOf = {}; for (const t of teams) for (const m of t.members) teamOf[m] = t.name;
    const K = KPI(), [y, m] = month.split('-').map(Number), last = new Date(Date.UTC(y, m, 0)).getUTCDate(), dayNo = month === today.slice(0, 7) ? Number(today.slice(8)) : last;
    const one = async (id, buyer) => {
      let kpis = []; try { kpis = (await K.results(id, month, buyer)).filter((k) => k.target > 0).map((k) => ({ name: k.name, unit: k.unit, target: k.target, result: k.result, score: Math.round(k.score) })); } catch (_) {}
      let days = 0, plans = 0, results = 0, pctSum = 0;
      try { const mo = await deps.MENU().monthOf(id, buyer ? 'mb' : 'pm', month); for (const d of Object.values(mo.days)) { if (!d.total) continue; days++; pctSum += d.pct || 0; if (d.planAt || d.resultAt) plans++; if (d.resultAt) results++; } } catch (_) {}
      return { kpis, avg: kpis.length ? Math.round(kpis.reduce((t, k) => t + Math.min(k.score, 100), 0) / kpis.length) : null, days, plans, results, menuPct: days ? Math.round(pctSum / days) : null };
    };
    const people = [];
    for (const u of users) {
      const r = ROLES.includes(roles[u.fb_id]) ? roles[u.fb_id] : av.has(u.fb_id) ? 'coo' : 'pm';
      if (u.fb_id === owner || LEAD.has(r)) continue; // leaders compare the teams; they are not compared
      people.push({ id: u.fb_id, name: u.name, kind: r === 'mb' ? 'Media buyer' : 'PM', team: teamOf[u.fb_id] || '', ...(await one(u.fb_id, false)) });
    }
    for (const b of bl) { const pm = b.addedById || byName[b.addedBy] || null; people.push({ id: 'mb:' + b.id, name: b.name, kind: 'Media buyer', pm, team: pm ? teamOf[pm] || '' : '', photo: !!b.photo, ...(await one(b.id, true)) }); }
    res.json({ today, month, dayNo, daysInMonth: last, pace: Math.round(dayNo / last * 100), people });
  }));
  api.get('/admin/audit', adminOnly, wrap(async (req, res) => { await auditFlush(); const log = await db.getSetting('auditLog', []); res.json({ log: (Array.isArray(log) ? log : []).slice(-300).reverse() }); }));
  // 🔔 Nudge: a short Telegram reminder with today's progress. A PM nudges their own media buyers; leaders nudge anyone.
  // One nudge per person every 10 minutes, so nobody gets flooded.
  const nudged = new Map();
  // Working day starts (Phnom Penh time): media buyers in the morning, Project Managers in the afternoon.
  const SHIFT = { mb: 8, pm: 13 };
  const hourNow = () => Number(new Date().toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: cfg.tz || 'Asia/Phnom_Penh' })) % 24;
  // Send one reminder. Returns { ok, name } or { ok:false, name, why: 'telegram' | 'wait' | 'missing', wait }.
  async function nudgeOne(fromName, p) {
    const today = sync.todayIn(); let chat = null, name = '', day = null, site = '/projectmanager#mytasks';
    if (p.startsWith('mb:')) { const b = await MB().get(p.slice(3)); if (!b) return { ok: false, why: 'missing' }; chat = b.chat || null; name = b.name; day = await deps.MENU().dayOf(b.id, 'mb', today); site = '/mediabuyer#mytasks'; }
    else { const u = await db.getUser(p); if (!u) return { ok: false, why: 'missing' }; chat = (await db.getUserSetting(u.fb_id, 'tgChat', null) || {}).id || null; name = u.name; day = await deps.MENU().dayOf(u.fb_id, (await roleOf(u.fb_id)) === 'mb' ? 'mb' : 'pm', today); }
    if (!chat) return { ok: false, name, why: 'telegram' };
    const wait = Math.ceil(((nudged.get(p) || 0) + 10 * 60e3 - Date.now()) / 60e3); if (wait > 0) return { ok: false, name, why: 'wait', wait };
    const open = day.items.filter((x) => !x.done), lines = [`🔔 ${fromName} សូមរំលឹក`, ''];
    if (!day.total) lines.push('ថ្ងៃនេះមិនទាន់មាន Task menu ទេ។ សូមបើក Boost Desk ហើយរៀបចំ។');
    else {
      lines.push(`Task ថ្ងៃនេះ៖ រួច ${day.done} / ${day.total} (${day.pct}%)`);
      if (!day.plan && !day.result) lines.push('⚠ មិនទាន់ផ្ញើ Plan');
      if (open.length) { lines.push('', 'នៅសល់៖'); for (const x of open.slice(0, 6)) lines.push(`☐ ${x.text}`); if (open.length > 6) lines.push(`… +${open.length - 6} ទៀត`); }
      else if (!day.result) lines.push('Task រួចអស់ហើយ ✅ សូមផ្ញើ Result។');
    }
    lines.push('', `${cfg.baseUrl}${site}`);
    await telegram.send(lines.join('\n'), chat); nudged.set(p, Date.now());
    return { ok: true, name };
  }
  api.post('/nudge', wrap(async (req, res) => {
    if (TASKS_OFF) return res.status(410).json({ error: 'Daily task reminders were moved to GenZ KPI.' });
    if (req.user.buyer) return res.status(403).json({ error: 'Only a PM or a leader can send a reminder.' });
    if (!telegram.hasBot()) return res.status(400).json({ error: 'Telegram is not set up yet.' });
    const p = String((req.body || {}).person || '');
    if (p.startsWith('mb:')) { if (!(await ownsBuyer(req, p.slice(3)))) return res.status(403).json({ error: 'Only this media buyer\'s PM or a leader can do this.' }); }
    else if (!(await canSeeAdmin(req.user.fb_id))) return res.status(403).json({ error: 'Only a leader can remind a Project Manager.' });
    let r; try { r = await nudgeOne(req.user.name, p); } catch (e) { return res.status(502).json({ error: 'Telegram did not take the message: ' + e.message }); }
    if (r.ok) return res.json(r);
    if (r.why === 'telegram') return res.status(400).json({ error: `${r.name} has not connected Telegram yet.` });
    if (r.why === 'wait') return res.status(429).json({ error: `${r.name} was reminded a moment ago. Try again in ${r.wait} minute${r.wait === 1 ? '' : 's'}.` });
    res.status(404).json({ error: 'Person not found.' });
  }));
  // Leaders: remind everyone whose working day has started and who has not sent today's plan. ?dry=1 only counts.
  api.post('/nudge/no-plan', adminOnly, wrap(async (req, res) => {
    if (TASKS_OFF) return res.status(410).json({ error: 'Daily task reminders were moved to GenZ KPI.' });
    const today = sync.todayIn(), h = hourNow(), owner = await db.ownerId(), roles = await roleMap(), av = await adminViewers(), list = [];
    for (const u of await db.allUsers()) { const r = ROLES.includes(roles[u.fb_id]) ? roles[u.fb_id] : av.has(u.fb_id) ? 'coo' : 'pm'; if (u.fb_id === owner || LEAD.has(r)) continue; list.push({ p: u.fb_id, id: u.fb_id, role: r === 'mb' ? 'mb' : 'pm', name: u.name }); }
    for (const b of await MB().all()) list.push({ p: 'mb:' + b.id, id: b.id, role: 'mb', name: b.name });
    const due = []; let early = 0;
    for (const x of list) { const d = await deps.MENU().dayOf(x.id, x.role, today); if (!d.total || d.plan || d.result) continue; if (h < SHIFT[x.role]) { early++; continue; } due.push(x); }
    if (req.query.dry || (req.body || {}).dry) return res.json({ dry: true, due: due.map((x) => x.name), early });
    if (!telegram.hasBot()) return res.status(400).json({ error: 'Telegram is not set up yet.' });
    const sent = [], noTelegram = [], waiting = [], failed = [];
    for (const x of due) { try { const r = await nudgeOne(req.user.name, x.p); (r.ok ? sent : r.why === 'telegram' ? noTelegram : r.why === 'wait' ? waiting : failed).push(r.name || x.name); } catch (_) { failed.push(x.name); } }
    res.json({ sent, noTelegram, waiting, failed, early });
  }));
  // Leaders rename a team account (the person's own name, e.g. the PM's — not the Facebook account's name, which is kept).
  api.post('/admin/users/:id/rename', ownerOnly, wrap(async (req, res) => {
    const u = await db.getUser(String(req.params.id)); if (!u) return res.status(404).json({ error: 'Account not found.' });
    const name = String((req.body || {}).name || '').trim().replace(/\s+/g, ' ').slice(0, 80); if (!name) return res.status(400).json({ error: 'Type the name.' });
    if (name === u.name) return res.json({ ok: true, name });
    if (!(await db.getUserSetting(u.fb_id, 'fbName', ''))) await db.setUserSetting(u.fb_id, 'fbName', u.name); // remember the Facebook account's own name
    // media buyers that were tied to this account by its old name keep their PM
    const B = MB(), all = await B.list(); let touched = false;
    for (const b of all) if (b.addedById === u.fb_id || (!b.addedById && b.addedBy === u.name)) { b.addedById = u.fb_id; b.addedBy = name; touched = true; }
    if (touched) await B.save(all);
    await db.pool.query('UPDATE users SET name=$2 WHERE fb_id=$1', [u.fb_id, name]);
    const lg = await LOGINS().forFb(u.fb_id); if (lg) { lg.name = name; await LOGINS().save(lg); }
    res.json({ ok: true, name, was: u.name });
  }));
  return { AI, KPI, kpiPerson, ownClient, ownsBuyer };
};
