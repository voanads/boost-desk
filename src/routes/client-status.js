// Client status, admin today / lives / invoices pages, KPI copy and targets
// Moved out of server.js unchanged; server.js mounts it at the same place, so route order is kept.
const db = require('../db');
const health = require('../health');
const lives = require('../lives');
const sync = require('../sync');
const telegram = require('../telegram');

module.exports = function mountClientStatus(app, api, deps) {
  const { KPI, LEAD, MB, adminOnly, getTeams, isDay, kpiPerson, ownClient, roleMap, tgt, wrap } = deps;
  // ---- Client status (19 Nov 2026): fine / watch / problem per client, "checked today", "I'm on it", Telegram alerts ----
  const STATUS = () => require('../status');
  const whoAmI = (req) => (req.user.buyer ? req.user.buyer.name : req.user.name);
  // My team's clients with their status (a media buyer sees their PM's clients).
  api.get('/clients-status', wrap(async (req, res) => res.json(await STATUS().forOwner({ fb_id: req.user.fb_id, name: req.user.name }))));
  api.post('/clients/:id/checked', wrap(async (req, res) => {
    if (!(await ownClient(req))) return res.status(404).json({ error: 'Client not found.' });
    // remember which reasons were there when the person looked: a new one brings the client back to "to watch"
    const id = Number(req.params.id), on = (req.body || {}).on !== false; let kinds;
    if (on) { try { const x = (await STATUS().forOwner({ fb_id: req.user.fb_id, name: req.user.name })).clients.find((k) => k.id === id); if (x) kinds = x.reasons.map((r) => r.kind); } catch (_) {} }
    res.json(await STATUS().mark(req.user.fb_id, id, 'checked', whoAmI(req), on, kinds));
  }));
  api.post('/clients/:id/on-it', wrap(async (req, res) => {
    if (!(await ownClient(req))) return res.status(404).json({ error: 'Client not found.' });
    res.json(await STATUS().mark(req.user.fb_id, Number(req.params.id), 'onIt', whoAmI(req), (req.body || {}).on !== false));
  }));
  // Leaders: every team's clients by status.
  api.get('/admin/clients-today', adminOnly, wrap(async (req, res) => {
    const teams = await getTeams(), teamOf = {}; for (const t of teams) for (const m of t.members) teamOf[m] = t.name;
    const bl = await MB().all(), out = [];
    for (const u of await db.allUsers()) {
      let s; try { s = await STATUS().forOwner({ fb_id: u.fb_id, name: u.name }); } catch (e) { s = { clients: [], error: e.message }; }
      if (!s.clients.length) continue;
      out.push({ id: u.fb_id, account: u.name, team: teamOf[u.fb_id] || u.name, mbs: bl.filter((b) => (b.addedById || '') === u.fb_id).map((b) => b.name), clients: s.clients });
    }
    res.json({ today: sync.todayIn(), hour: STATUS().hourNow(), teams: out });
  }));
  // Admin menu (21 Nov 2026): Live boosts and invoices of every team on one page each. Read only.
  api.get('/admin/lives', adminOnly, wrap(async (req, res) => {
    const teams = await getTeams(), teamOf = {}; for (const t of teams) for (const m of t.members) teamOf[m] = t.name;
    const today = sync.todayIn(), now = Date.now(), rows = [];
    for (const u of await db.allUsers()) {
      let list = []; try { list = await lives.listLives(u.fb_id, today, today); } catch (_) {}
      const sent = {};
      for (const l of list) {
        if (!(l.clientId in sent)) { try { const e = await db.getEntry(u.fb_id, today, l.clientId); sent[l.clientId] = (e && e.reportSent && e.reportSent.at) || ''; } catch (_) { sent[l.clientId] = ''; } }
        rows.push({ team: teamOf[u.fb_id] || u.name, client: l.client, page: l.page, time: l.time, start: l.start, spend: l.spend, comments: l.comments, messages: l.messages, perComment: l.perComment, camps: l.campaigns.length,
          state: l.end != null && l.end <= now ? 'ended' : l.end != null ? 'on' : '', sent: sent[l.clientId] });
      }
    }
    rows.sort((a, b) => (b.start || 0) - (a.start || 0));
    res.json({ today, rows });
  }));
  api.get('/admin/invoices', adminOnly, wrap(async (req, res) => {
    const teams = await getTeams(), teamOf = {}; for (const t of teams) for (const m of t.members) teamOf[m] = t.name;
    const today = sync.todayIn(), from = sync.addDays(today, -60), rows = [];
    for (const u of await db.allUsers()) {
      let inv = [], names = {}; try { inv = await db.listInvoices(u.fb_id, from, today); if (inv.length) for (const c of await db.listClients(u.fb_id)) names[c.id] = c.name; } catch (_) {}
      for (const i of inv) rows.push({ team: teamOf[u.fb_id] || u.name, client: names[i.client_id] || '', number: i.number, date: i.date, total: Number(i.total) || 0, sent: !!i.sent_at, paid: !!i.paid_at,
        days: i.paid_at ? 0 : Math.max(0, Math.round((new Date(today) - new Date(i.date)) / 864e5)) });
    }
    rows.sort((a, b) => (a.paid - b.paid) || (b.days - a.days) || String(b.date).localeCompare(String(a.date)));
    res.json({ today, from, rows });
  }));
  // Telegram for red clients: every 5 minutes (8:00–21:00). Leaders = the alert chat and every CEO / COO / CMO with Telegram.
  async function leaderChats() {
    const out = new Set(); const a = await db.getSetting('alertChat', null); if (a && a.id) out.add(String(a.id));
    const roles = await roleMap(), owner = await db.ownerId();
    for (const u of await db.allUsers()) { if (u.fb_id !== owner && !LEAD.has(roles[u.fb_id])) continue; const c = await db.getUserSetting(u.fb_id, 'tgChat', null); if (c && c.id) out.add(String(c.id)); }
    return [...out];
  }
  if (telegram.hasBot()) {
    health.register('Client status alerts', 5, 'every 5 minutes, 8:00–21:00');
    setInterval(require('../runOnce').once('Client status alerts', () => health.track('Client status alerts', () => STATUS().tick({ leaders: leaderChats, log: (...a) => console.log('[status]', ...a) })).then((n) => { if (n) console.log('[status] client alerts sent:', n); }).catch((e) => console.error('[status]', e.message)), 5 * 60e3), 5 * 60e3).unref();
  }
  // Copy one person's KPI list for a month to others, replacing theirs:
  //   scope 'team' — the other Project Managers of the same team (a team's KPI is its PM's KPI)
  //   scope 'pms'  — every Project Manager;   scope 'mbs' — every media buyer (from a media buyer's list)
  // Only name, target and unit travel. A person who already has a KPI of the same name keeps its id (so the tasks
  // linked to it stay linked) and the result they typed; nobody receives someone else's typed result.
  const kpiCopy = wrap(async (req, res) => {
    const b = req.body || {}, who = await kpiPerson(req, b.person); if (!who) return res.status(404).json({ error: 'Person not found.' });
    const scope = ['team', 'pms', 'mbs'].includes(b.scope) ? b.scope : 'team';
    const month = /^\d{4}-\d{2}$/.test(b.month) ? b.month : sync.todayIn().slice(0, 7), K = KPI();
    const roles = await roleMap(), owner = await db.ownerId(), users = await db.allUsers();
    const isPm = (id) => id !== owner && !LEAD.has(roles[id]) && roles[id] !== 'mb';
    let to = [], label = '';
    if (scope === 'mbs') {
      if (!who.buyer) return res.status(400).json({ error: 'Open a media buyer first — their KPIs are copied to the other media buyers.' });
      to = (await MB().all()).filter((x) => 'mb:' + x.id !== who.id).map((x) => ({ id: x.id, name: x.name })); label = 'media buyers';
    } else {
      if (who.buyer) return res.status(400).json({ error: 'Choose a Project Manager.' });
      if (scope === 'team') {
        const team = (await getTeams()).find((t) => t.members.includes(who.id)); if (!team) return res.status(400).json({ error: `${who.name} is not in a team yet.` });
        to = team.members.filter((m) => m !== who.id && isPm(m)).map((m) => users.find((u) => u.fb_id === m)).filter(Boolean).map((u) => ({ id: u.fb_id, name: u.name })); label = team.name;
      } else { to = users.filter((u) => u.fb_id !== who.id && isPm(u.fb_id)).map((u) => ({ id: u.fb_id, name: u.name })); label = 'Project Managers'; }
    }
    if (!to.length) return res.status(400).json({ error: 'There is nobody else to copy to.' });
    const src = await K.getList(who.buyer ? who.id.slice(3) : who.id, month);
    if (!src.length) return res.status(400).json({ error: 'Set the KPIs first, then copy them.' });
    const nm = (x) => String(x || '').trim().toLowerCase();
    for (const p of to) {
      const cur = await K.getList(p.id, month);
      await K.putList(p.id, month, src.map((k) => { const old = cur.find((c) => nm(c.name) === nm(k.name)); return { id: old ? old.id : '', name: k.name, target: k.target, unit: k.unit, manual: old ? old.manual : null }; }));
    }
    res.json({ ok: true, scope, label, month, count: src.length, to: to.map((p) => p.name) });
  });
  api.post('/kpis/copy', adminOnly, kpiCopy);
  api.post('/kpis/copy-team', adminOnly, (req, res, next) => { req.body = { ...(req.body || {}), scope: 'team' }; kpiCopy(req, res, next); });
  // My target tasks for a day: every task of mine with a target, with what I reached.
  api.get('/targets/mine', wrap(async (req, res) => {
    const day = isDay(req.query.day) ? req.query.day : sync.todayIn(), out = [];
    for (const c of await db.listClients(req.user.fb_id)) {
      if (c.archived) continue;
      const w = (await db.getUserSetting(req.user.fb_id, `cwb:${c.id}`, null)) || {};
      for (const t of w.tasks || []) {
        if (!(Number(t.target) > 0)) continue;
        if (t.repeat ? t.day > day : t.day !== day) continue;
        out.push({ id: t.id, clientId: c.id, client: c.name, text: t.text, repeat: !!t.repeat, done: !!t.done, ...tgt(t, t.repeat ? day : t.day) });
      }
    }
    res.json({ day, today: sync.todayIn(), tasks: out });
  }));
  return { STATUS };
};
