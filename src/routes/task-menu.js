// Task menu, tasks, team, targets and client workbooks
// Moved out of server.js unchanged; server.js mounts it at the same place, so route order is kept.
const cfg = require('../config');
const db = require('../db');
const sync = require('../sync');
const telegram = require('../telegram');

module.exports = function mountTaskMenu(app, api, deps) {
  const { AI, KPI, MB, MENU, TASKS_OFF, adminOnly, canSeeAdmin, dayTasks, getTeams, isDay, menuPerson, ownClient, wrap } = deps;
  // A media buyer's menu also lists the client tasks their PM gave them for the day (ticked here or on the client page).
  async function buyerClientItems(who, day) {
    if (who.role !== 'mb') return [];
    const b = await MB().get(who.person); if (!b) return [];
    const dt = await dayTasks(day), owner = b.addedById || Object.fromEntries((await db.allUsers()).map((u) => [u.name, u.fb_id]))[b.addedBy];
    return (((dt.users[owner] || {}).tasks || [])).filter((t) => t.to && t.to.id === b.id && t.from !== 'work')
      .map((t) => ({ id: `ct:${t.clientId}:${t.id}`, text: t.text, client: t.client, clientId: t.clientId, pm: true, done: !!t.done, at: t.doneAt || null, by: t.doneBy || null, late: !!t.late, target: t.target || 0, reached: t.reached || 0, unit: t.unit || '' }));
  }
  const withClientItems = async (who, d) => { const extra = await buyerClientItems(who, d.day); if (!extra.length) return d; const items = [...d.items, ...extra], done = items.filter((x) => x.done).length; return { ...d, items, total: items.length, done, pct: items.length ? Math.round(done / items.length * 100) : null }; };
  api.get('/menu', wrap(async (req, res) => {
    const who = await menuPerson(req, req.query.as); if (!who) return res.status(404).json({ error: 'Person not found.' });
    const day = isDay(req.query.day) ? req.query.day : sync.todayIn();
    res.json({ ...(await withClientItems(who, await MENU().dayOf(who.person, who.role, day))), today: sync.todayIn(), name: who.name });
  }));
  api.post('/menu/tick', wrap(async (req, res) => {
    const b = req.body || {}, who = await menuPerson(req, b.as); if (!who) return res.status(404).json({ error: 'Person not found.' });
    const day = isDay(b.day) ? b.day : sync.todayIn(); if (day > sync.todayIn()) return res.status(400).json({ error: 'That day has not come yet.' });
    const byName = req.user.buyer ? req.user.buyer.name : req.user.name;
    const ct = String(b.id || '').match(/^ct:(\d+):([a-f0-9]{6,20})$/);
    if (ct) { // a client task from the PM: tick it in the client's workbook
      const cid = ct[1], tid = ct[2], owner = ((await db.pool.query('SELECT owner FROM clients WHERE id=$1', [cid])).rows[0] || {}).owner;
      if (!owner) return res.status(404).json({ error: 'Client not found.' });
      const w = await AI().workbook(owner, cid), t = (w.tasks || []).find((x) => x.id === tid); if (!t) return res.status(404).json({ error: 'Task not found.' });
      const lid = 't:' + t.id + ':' + day; w.log = (w.log || []).filter((x) => x.id !== lid);
      if (b.done) { const at = new Date().toISOString(); t.done = true; t.doneAt = at; t.doneBy = byName; w.log.push({ id: lid, day, at, by: byName, text: t.text, kind: t.repeat ? 'repeat' : 'me' }); } else { t.done = false; t.doneAt = null; t.doneBy = null; }
      if (b.reached != null && Number(t.target) > 0) { t.hit = t.hit || {}; t.hit[day] = Math.max(0, Number(b.reached) || 0); }
      await AI().saveWorkbook(owner, cid, w);
      return res.json(await withClientItems(who, await MENU().dayOf(who.person, who.role, day)));
    }
    if (!/^[a-f0-9]{8}$/.test(String(b.id || ''))) return res.status(400).json({ error: 'Which item?' });
    await MENU().tick(who.person, day, b.id, !!b.done, byName, b.amount);
    res.json(await withClientItems(who, await MENU().dayOf(who.person, who.role, day)));
  }));
  // Top 5 menu tasks from the person's KPIs (AI) — shown when a day's menu is empty, or on demand.
  api.post('/menu/suggest', wrap(async (req, res) => {
    const b = req.body || {}, who = await menuPerson(req, b.as); if (!who) return res.status(404).json({ error: 'Person not found.' });
    const month = /^\d{4}-\d{2}$/.test(b.month) ? b.month : sync.todayIn().slice(0, 7);
    let kpis = [], menu = [];
    try { kpis = (await KPI().getList(who.person, month)).filter((k) => String(k.name || '').trim()).map((k) => ({ id: k.id, name: k.name, target: k.target, unit: k.unit })); } catch (_) {}
    try { menu = (await MENU().listOf(who.person, who.role)).map((x) => x.text); } catch (_) {}
    try { res.json(await AI().menuSuggest(req.user.fb_id, { kpis, menu, role: who.role, lang: b.lang === 'en' ? 'en' : 'km', fresh: !!b.fresh })); }
    catch (e) { res.status(e.status || 500).json({ error: e.message, notSetUp: !!e.notSetUp }); }
  }));
  api.post('/menu/item', wrap(async (req, res) => {
    const b = req.body || {}, who = await menuPerson(req, b.as); if (!who) return res.status(404).json({ error: 'Person not found.' });
    const day = b.once ? (isDay(b.day) ? b.day : sync.todayIn()) : null;
    try { const it = await MENU().addItem(who.person, who.role, b.text, day); if (b.kpi) await MENU().editItem(who.person, who.role, it.id, undefined, b.kpi); res.json(await MENU().dayOf(who.person, who.role, day || sync.todayIn())); } catch (e) { res.status(400).json({ error: e.message }); }
  }));
  api.put('/menu/item/:id', wrap(async (req, res) => {
    const b = req.body || {}, who = await menuPerson(req, b.as); if (!who) return res.status(404).json({ error: 'Person not found.' });
    try { res.json({ item: await MENU().editItem(who.person, who.role, req.params.id, b.text, b.kpi) }); } catch (e) { res.status(400).json({ error: e.message }); }
  }));
  api.delete('/menu/item/:id', wrap(async (req, res) => {
    const who = await menuPerson(req, req.query.as); if (!who) return res.status(404).json({ error: 'Person not found.' });
    await MENU().removeItem(who.person, who.role, req.params.id); res.json({ ok: true });
  }));
  api.post('/menu/reset', wrap(async (req, res) => {
    const who = await menuPerson(req, (req.body || {}).as); if (!who) return res.status(404).json({ error: 'Person not found.' });
    await MENU().resetList(who.person, who.role); res.json(await MENU().dayOf(who.person, who.role, sync.todayIn()));
  }));
  // Plan / result alerts go to the team Telegram group (TELEGRAM_CHAT_ID); a media buyer without a team group gets it in their own chat.
  async function menuAlert(req, who, d, kind) {
    if (TASKS_OFF || !telegram.hasBot()) return;
    const roleName = who.role === 'mb' ? 'Media buyer' : 'Project Manager', when = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: cfg.tz });
    const dayLbl = new Date(d.day + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
    let text;
    if (kind === 'plan') text = `📋 ផែនការថ្ងៃនេះ · ${who.name} (${roleName})\n🗓 ${dayLbl} · ${when}\n\n${d.items.map((x, i) => `${i + 1}. ${x.text}`).join('\n')}`;
    else {
      text = `✅ លទ្ធផលថ្ងៃនេះ · ${who.name} (${roleName})\n🗓 ${dayLbl} · ${when} · ${d.done} / ${d.total} (${d.pct}%)\n\n${d.items.map((x) => `${x.done ? '✔' : '✘'} ${x.text}`).join('\n')}`;
      // the Clients Task lines they ticked that day (per client), from the PM's workbooks
      try {
        const dt = await dayTasks(d.day), owner = req.user.fb_id, all = ((dt.users[owner] || {}).tasks || []).filter((t) => t.done);
        const mine = all.filter((t) => (req.user.buyer ? (t.to && t.to.id === who.person) : (!t.to || who.role !== 'mb')));
        if (mine.length) {
          const byClient = {}; for (const t of mine) (byClient[t.client] = byClient[t.client] || []).push(t);
          text += `\n\n📌 Clients Task · ${mine.length} done\n` + Object.entries(byClient).map(([c, ts]) => `${c}\n${ts.map((t) => `  ✔ ${t.text}${t.reached != null && t.target ? ` (${t.reached}/${t.target}${t.unit ? ' ' + t.unit : ''})` : ''}`).join('\n')}`).join('\n');
        }
        const open = ((dt.users[owner] || {}).tasks || []).filter((t) => !t.done && (req.user.buyer ? (t.to && t.to.id === who.person) : (!t.to || who.role !== 'mb')) && t.from !== 'work' && t.from !== 'ai');
        if (open.length) text += `\n\n⏳ Not done yet: ${open.length}\n${open.slice(0, 10).map((t) => `  ✘ ${t.client} — ${t.text}`).join('\n')}${open.length > 10 ? `\n  … +${open.length - 10} more` : ''}`;
      } catch (e) { console.error('[menu] client tasks:', e.message); }
      if (d.result && d.result.note) text += `\n\n📝 ${d.result.note}`;
    }
    const chats = new Set(); if (cfg.telegramChatId) chats.add(String(cfg.telegramChatId));
    if (who.role === 'mb') { // the media buyer's PM gets it in their own chat; without a team group the buyer gets a copy too
      let pmId = null;
      try { const b = await MB().get(who.person); if (b) { const byName = Object.fromEntries((await db.allUsers()).map((u) => [u.name, u.fb_id])); pmId = b.addedById || byName[b.addedBy] || null; if (!cfg.telegramChatId && b.chat) chats.add(String(b.chat)); } } catch (_) {}
      const addChat = async (id) => { const c = await db.getUserSetting(id, 'tgChat', null); if (c && c.id) chats.add(String(c.id)); };
      if (pmId) await addChat(pmId);
      if (req.user && req.user.fb_id) { await addChat(req.user.fb_id); // the submitter's own chat (a Facebook login marked Media buyer), or the PM behind a bot buyer
        if (!req.user.buyer) { const team = (await getTeams()).find((t) => t.members.includes(req.user.fb_id)); for (const m of (team ? team.members : []).filter((x) => x !== req.user.fb_id)) await addChat(m); } // their teammates (the PM)
      }
    }
    for (const chat of chats) { try { await telegram.send(text, chat); } catch (e) { console.error('[menu] telegram:', e.message); } }
  }
  // Morning: submit the plan (freezes today's list). Evening: submit the result (closes the day). Reopen undoes the result.
  api.post('/menu/plan', wrap(async (req, res) => {
    const b = req.body || {}, who = await menuPerson(req, b.as); if (!who) return res.status(404).json({ error: 'Person not found.' });
    const day = isDay(b.day) ? b.day : sync.todayIn(); if (day > sync.todayIn()) return res.status(400).json({ error: 'That day has not come yet.' });
    try { await MENU().submitPlan(who.person, who.role, day, req.user.buyer ? req.user.buyer.name : req.user.name); const d = await MENU().dayOf(who.person, who.role, day); res.json(d); menuAlert(req, who, d, 'plan'); } catch (e) { res.status(400).json({ error: e.message }); }
  }));
  api.post('/menu/result', wrap(async (req, res) => {
    const b = req.body || {}, who = await menuPerson(req, b.as); if (!who) return res.status(404).json({ error: 'Person not found.' });
    const day = isDay(b.day) ? b.day : sync.todayIn(); if (day > sync.todayIn()) return res.status(400).json({ error: 'That day has not come yet.' });
    await MENU().submitResult(who.person, who.role, day, req.user.buyer ? req.user.buyer.name : req.user.name, b.note); const d = await MENU().dayOf(who.person, who.role, day); res.json(d); menuAlert(req, who, d, 'result');
  }));
  api.post('/menu/reopen', wrap(async (req, res) => {
    const b = req.body || {}, who = await menuPerson(req, b.as); if (!who) return res.status(404).json({ error: 'Person not found.' });
    const day = isDay(b.day) ? b.day : sync.todayIn(); await MENU().reopen(who.person, day); res.json(await MENU().dayOf(who.person, who.role, day));
  }));
  api.get('/menu/month', wrap(async (req, res) => {
    const who = await menuPerson(req, req.query.as); if (!who) return res.status(404).json({ error: 'Person not found.' });
    const ym = /^\d{4}-\d{2}$/.test(req.query.month) ? req.query.month : sync.todayIn().slice(0, 7);
    res.json(await MENU().monthOf(who.person, who.role, ym));
  }));
  api.get('/admin/menu', adminOnly, wrap(async (req, res) => res.json({ menu: await MENU().all(), canEdit: await canSeeAdmin(req.user.fb_id) })));
  api.put('/admin/menu', adminOnly, wrap(async (req, res) => res.json({ menu: await MENU().save((req.body || {}).menu, req.user.name) })));
  api.get('/admin/menu/defaults', adminOnly, wrap(async (req, res) => res.json({ menu: MENU().DEFAULT })));
  // A month of one person's tasks (the ones people created — not the automatic suggestions), day by day, for the calendar.
  // Buyers (and admins looking at a buyer: &buyer=<id>) see only the tasks assigned to that buyer.
  api.get('/tasks/month', wrap(async (req, res) => {
    const today = sync.todayIn(), ym = /^\d{4}-\d{2}$/.test(req.query.month) ? req.query.month : today.slice(0, 7);
    const owner = req.user.fb_id, buyerId = req.user.buyer ? req.user.buyer.id : (req.query.as && req.query.buyer ? String(req.query.buyer) : '');
    const cl = (await db.pool.query('SELECT id, name FROM clients WHERE owner=$1', [owner])).rows, cName = Object.fromEntries(cl.map((c) => [c.id, c.name]));
    const rows = (await db.pool.query(`SELECT key, value FROM settings WHERE key LIKE $1`, [owner + ':cwb:%'])).rows;
    const localDay = (iso) => { try { return sync.todayIn(undefined, new Date(iso)); } catch (_) { return ''; } };
    const [y, m] = ym.split('-').map(Number), last = new Date(Date.UTC(y, m, 0)).getUTCDate(), days = {};
    for (let d = 1; d <= last; d++) days[`${ym}-${String(d).padStart(2, '0')}`] = [];
    for (const r of rows) {
      const cid = r.key.split(':')[2]; if (!cName[cid]) continue;
      for (const t of (r.value || {}).tasks || []) {
        if (t.from === 'ai') continue;
        if (buyerId && !(t.to && t.to.id === buyerId)) continue;
        const doneDay = t.done && t.doneAt ? localDay(t.doneAt) : '';
        const base = { id: t.id, text: t.text, client: cName[cid], clientId: Number(cid), to: t.to ? t.to.name : '', repeat: !!t.repeat };
        for (const day of Object.keys(days)) {
          if (t.repeat) { if (t.day <= day && day <= today) days[day].push({ ...base, done: doneDay === day, late: false, missed: day < today && doneDay !== day }); continue; }
          if (t.day === day) days[day].push({ ...base, done: !!t.done, late: false, missed: !t.done && day < today && !(doneDay && doneDay > day) });
          else if (t.day < day && ((!t.done && day === today) || doneDay === day)) days[day].push({ ...base, done: doneDay === day, late: true, missed: false, since: t.day });
        }
      }
    }
    const out = {};
    for (const [day, list] of Object.entries(days)) { const done = list.filter((t) => t.done).length; out[day] = { tasks: list, total: list.length, done, pct: list.length ? Math.round(done / list.length * 100) : null }; }
    res.json({ month: ym, today, days: out });
  }));
  api.get('/tasks/mine', wrap(async (req, res) => {
    const day = isDay(req.query.day) ? req.query.day : sync.todayIn();
    const dt = await dayTasks(day), mine = (dt.users[req.user.fb_id] || { tasks: [] }).tasks;
    res.json({ day, today: dt.today, tasks: mine });
  }));
  // PM dashboard: my team — media buyers I work with, today's tasks (done / open / overdue), what was sent to Telegram.
  api.get('/team/mine', wrap(async (req, res) => {
    const today = sync.todayIn(), me = req.user.fb_id;
    const teams = await getTeams(), team = teams.find((t) => t.members.includes(me)) || null;
    const members = team ? team.members : [me], users = await db.allUsers(), uName = Object.fromEntries(users.map((u) => [u.fb_id, u.name]));
    const byName = Object.fromEntries(users.map((u) => [u.name, u.fb_id]));
    const bl = (await require('../buyers').all()).filter((b) => members.includes(b.addedById || byName[b.addedBy] || '') || (!team && !b.addedById && !byName[b.addedBy]));
    const dt = await dayTasks(today);
    const mine = (dt.users[me] || { tasks: [] }).tasks, counts = { done: 0, open: 0, overdue: 0, sent: 0, notSent: 0, buyerDone: 0, buyerOpen: 0 };
    const buyerTasks = [];
    for (const t of mine) {
      if (t.done) counts.done++; else counts.open++;
      if (t.late && !t.done) counts.overdue++;
      if (t.to) { if (t.sentAt) counts.sent++; else counts.notSent++; if (t.done) counts.buyerDone++; else counts.buyerOpen++; buyerTasks.push(t); }
    }
    const perBuyer = bl.map((b) => { const ts = buyerTasks.filter((t) => t.to && t.to.id === b.id); return { ...b, today: ts.length, done: ts.filter((t) => t.done).length, late: ts.filter((t) => t.late && !t.done).length, notSent: ts.filter((t) => !t.sentAt).length }; });
    // the KPI score of each media buyer this month (average of KPIs with a target)
    const K = KPI(); for (const b of perBuyer) { try { const rs = (await K.results(b.id, today.slice(0, 7), true)).filter((k) => k.target > 0); b.kpi = rs.length ? Math.round(rs.reduce((t, k) => t + Math.min(k.score, 150), 0) / rs.length) : null; } catch (_) { b.kpi = null; } }
    const teammates = members.filter((id) => id !== me && uName[id]).map((id) => { const o = dt.users[id] || { tasks: [] }; return { id, name: uName[id], done: o.tasks.filter((t) => t.done).length, open: o.tasks.filter((t) => !t.done).length, clients: o.clients || 0 }; });
    res.json({ today, team: team ? { id: team.id, name: team.name } : null, counts, buyers: perBuyer, teammates, buyerTasks: buyerTasks.slice(0, 30), clients: (dt.users[me] || {}).clients || 0 });
  }));
  // Admin: every team's target tasks for a day, with totals.
  api.get('/admin/targets', adminOnly, wrap(async (req, res) => {
    const day = isDay(req.query.day) ? req.query.day : sync.todayIn();
    const { users } = await dayTasks(day), teams = await getTeams(), teamOf = {};
    for (const t of teams) for (const m of t.members) teamOf[m] = t.name;
    const people = Object.entries(users).map(([id, u]) => { const tasks = u.tasks.filter((t) => t.target > 0); return { id, name: u.name, team: teamOf[id] || '', tasks, target: tasks.reduce((s, t) => s + t.target, 0), reached: tasks.reduce((s, t) => s + Math.min(t.reached, t.target), 0), tasksTotal: u.tasks.filter((t) => t.from !== 'work').length, tasksDone: u.tasks.filter((t) => t.from !== 'work' && t.done).length }; });
    res.json({ day, today: sync.todayIn(), teams: teams.map((t) => t.name), people });
  }));
  api.get('/clients-work', wrap(async (req, res) => {
    const today = sync.todayIn(), out = {};
    for (const c of await db.listClients(req.user.fb_id)) {
      const w = (await db.getUserSetting(req.user.fb_id, `cwb:${c.id}`, null)) || {};
      out[c.id] = { openTasks: (w.tasks || []).filter((t) => !t.done && (t.day || '') <= today).length, // due today or earlier; tasks planned for later days are not "left" yet
         ticked: Object.keys(w.ticks || {}).filter((k) => k.startsWith(today + ':')).map((k) => k.slice(11)) };
    }
    res.json({ today, clients: out });
  }));
  api.get('/clients/:id/workbook', wrap(async (req, res) => { if (!(await ownClient(req))) return res.status(404).json({ error: 'Client not found.' }); res.json({ today: sync.todayIn(), ...(await AI().workbook(req.user.fb_id, req.params.id)) }); }));
  api.post('/clients/:id/plan', wrap(async (req, res) => {
    if (!(await ownClient(req))) return res.status(404).json({ error: 'Client not found.' });
    const lang = (req.body || {}).lang === 'km' ? 'km' : 'en'; await db.setUserSetting(req.user.fb_id, 'aiLang', lang);
    try { await AI().dailyPlan(req.user.fb_id, req.params.id, { lang, force: !!(req.body || {}).force }); res.json({ today: sync.todayIn(), ...(await AI().workbook(req.user.fb_id, req.params.id)) }); }
    catch (e) { if (e.status) return res.status(e.status).json({ error: e.message, notSetUp: !!e.notSetUp }); throw e; }
  }));
  api.put('/clients/:id/notes', wrap(async (req, res) => {
    if (!(await ownClient(req))) return res.status(404).json({ error: 'Client not found.' });
    const w = await AI().workbook(req.user.fb_id, req.params.id); w.notes = String((req.body || {}).notes || '').slice(0, 5000); w.notesAt = new Date().toISOString();
    await AI().saveWorkbook(req.user.fb_id, req.params.id, w); res.json({ ok: true, notesAt: w.notesAt });
  }));
  api.post('/clients/:id/tasks', wrap(async (req, res) => {
    if (!(await ownClient(req))) return res.status(404).json({ error: 'Client not found.' });
    const text = String((req.body || {}).text || '').trim().slice(0, 200); if (!text) return res.status(400).json({ error: 'Type the task.' });
    const w = await AI().workbook(req.user.fb_id, req.params.id);
    const B = require('../buyers'), buyer = (req.body || {}).to ? await B.get(req.body.to) : null;
    if ((req.body || {}).to && !buyer) return res.status(400).json({ error: 'That media buyer was removed.' });
    const tg = Math.min(1e6, Math.max(0, Number((req.body || {}).target) || 0));
    const today = sync.todayIn(), askDay = String((req.body || {}).day || ''), day = isDay(askDay) && askDay > today && askDay <= sync.addDays(today, 60) ? askDay : today; // a task can be planned for a later day
    const t = { id: require('crypto').randomBytes(5).toString('hex'), text, from: 'me', day, done: false, by: req.user.name, ...((req.body || {}).repeat ? { repeat: true } : {}), ...(buyer ? { to: { id: buyer.id, name: buyer.name } } : {}), ...(tg ? { target: tg, unit: String((req.body || {}).unit || '').trim().slice(0, 20), hit: {} } : {}), ...(/^[a-f0-9]{8}$/.test(String((req.body || {}).kpi || '')) ? { kpi: req.body.kpi } : {}) };
    let warn = '';
    if (buyer && day === today) { // a later day: the bot sends it that morning
      const c = (await db.listClients(req.user.fb_id)).find((x) => x.id === Number(req.params.id));
      try { await B.notify(buyer, { client: c ? c.name : '', text, from: req.user.name, repeat: !!t.repeat, cid: req.params.id, tid: t.id }); t.sentAt = new Date().toISOString(); }
      catch (e) { warn = e.message; }
    }
    w.tasks.push(t);
    await AI().saveWorkbook(req.user.fb_id, req.params.id, w); res.json({ today: sync.todayIn(), ...w, ...(warn ? { warn } : {}) });
  }));
};
