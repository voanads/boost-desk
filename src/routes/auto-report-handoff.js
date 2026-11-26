// Auto daily report, report status, handoff notes and today's to-do
// Moved out of server.js unchanged; server.js mounts it at the same place, so route order is kept.
const cfg = require('../config');
const db = require('../db');
const extras = require('../extras');
const pm = require('../pm');
const reports = require('../reports');
const sync = require('../sync');
const telegram = require('../telegram');

module.exports = function mountAutoReportHandoff(app, api, deps) {
  const { MB, adminOnly, dayTasks, getTeams, isDay, wrap } = deps;
  // ---------- auto daily report ----------
  api.get('/auto-report', wrap(async (req, res) => res.json({ ...(await extras.autoSettings(req.user.fb_id)), last: await db.getUserSetting(req.user.fb_id, 'autoReportLast', null), bot: telegram.hasBot(), tz: cfg.tz })));
  api.put('/auto-report', wrap(async (req, res) => res.json({ ...(await extras.saveAutoSettings(req.user.fb_id, req.body || {})), last: await db.getUserSetting(req.user.fb_id, 'autoReportLast', null) })));
  // One workspace's clients for one day: spend, orders, and whether each report went out.
  async function reportStatus(owner, day) {
    const clients = (await db.listClients(owner)).filter((c) => !c.archived), set = await extras.autoSettings(owner);
    let oc = { clients: {} }; try { oc = await require('../orders').byClient(owner, day, day); } catch (_) { /* orders not connected */ }
    const live = (c) => c.type === 'live' || c.type === 'both', post = (c) => c.type === 'post' || c.type === 'both' || !c.type;
    const rows = [];
    for (const c of clients) {
      const e = await db.getEntry(owner, day, c.id), lives = live(c) ? Object.values(e.lives || {}).filter((l) => Number(l && l.spend) > 0) : [];
      const liveSpend = lives.reduce((t, l) => t + Number(l.spend), 0), postSpend = post(c) ? Number((e.post || {}).spend) || 0 : 0, spend = Math.round((liveSpend + postSpend) * 100) / 100;
      const routes = reports.routes(c), chat = routes.find((r) => r.chat), o = (oc.clients || {})[c.id], orders = o ? o.orders : null;
      const sent = e.reportSent && e.reportSent.at ? { at: e.reportSent.at, by: e.reportSent.by || '' } : null;
      rows.push({ id: c.id, name: c.name, type: c.type || 'post', page: (c.pages || []).find((p) => /^\d{5,20}$/.test(String(p))) || '', group: chat ? (chat.title || c.telegram_title || 'Telegram group') : '', hasGroup: !!chat,
        spend, lives: lives.length, orders, cpo: orders > 0 && spend > 0 ? Math.round(spend / orders * 100) / 100 : null, sent, auto: !set.skip.includes(c.id),
        status: sent ? 'sent' : !chat ? 'nogroup' : spend > 0 ? 'unsent' : 'nospend' });
    }
    const rank = { unsent: 0, nogroup: 1, sent: 2, nospend: 3 }; rows.sort((a, b) => rank[a.status] - rank[b.status] || b.spend - a.spend || a.name.localeCompare(b.name));
    return { rows, auto: { on: !!set.on, time: set.time }, anyOrders: rows.some((r) => r.orders != null), totals: reportTotals(rows) };
  }
  function reportTotals(rows) {
    const cnt = (k) => rows.filter((r) => r.status === k).length, tot = (k) => rows.reduce((t, r) => t + (Number(r[k]) || 0), 0), spend = Math.round(tot('spend') * 100) / 100, orders = tot('orders');
    return { clients: rows.length, spend, orders, cpo: orders > 0 && spend > 0 ? Math.round(spend / orders * 100) / 100 : null, sent: cnt('sent'), unsent: cnt('unsent'), nogroup: cnt('nogroup'), nospend: cnt('nospend') };
  }
  // Reports page: every client of this account for one day.
  api.get('/reports/status', wrap(async (req, res) => {
    const today = sync.todayIn(), day = isDay(req.query.day) && req.query.day <= today ? req.query.day : today;
    res.json({ day, today, bot: telegram.hasBot(), ...(await reportStatus(req.user.fb_id, day)) });
  }));
  // Team reports (leaders): the same day for every team, one group per Project Manager. Read only.
  api.get('/admin/reports', adminOnly, wrap(async (req, res) => {
    const today = sync.todayIn(), day = isDay(req.query.day) && req.query.day <= today ? req.query.day : today;
    const users = await db.allUsers(), tms = await getTeams(), teamOf = {}; for (const t of tms) for (const m of t.members) teamOf[m] = t.name;
    let buyers = []; try { buyers = await MB().all(); } catch (_) { /* no media buyers yet */ }
    const teams = [];
    for (const u of users) {
      const r = await reportStatus(u.fb_id, day); if (!r.rows.length) continue;
      teams.push({ owner: u.fb_id, name: u.name, team: teamOf[u.fb_id] || '', buyers: buyers.filter((b) => b.addedById === u.fb_id).map((b) => b.name), ...r });
    }
    teams.sort((a, b) => b.totals.unsent - a.totals.unsent || b.totals.nogroup - a.totals.nogroup || b.totals.spend - a.totals.spend || a.name.localeCompare(b.name));
    const all = teams.flatMap((t) => t.rows);
    res.json({ day, today, bot: telegram.hasBot(), teams, anyOrders: teams.some((t) => t.anyOrders), totals: { ...reportTotals(all), teams: teams.length, teamsDone: teams.filter((t) => !t.totals.unsent).length } });
  }));
  // ---------- Handoff: notes between the media buyer (morning) and the PM (evening), and the Telegram brief / digest ----------
  const HANDOFF_DEPS = { reportStatus, dayTasks };
  api.get('/handoff', wrap(async (req, res) => res.json(await require('../handoff').card(req.user, HANDOFF_DEPS))));
  api.post('/handoff', wrap(async (req, res) => {
    const HO = require('../handoff'), b = req.user.buyer;
    const note = await HO.addNote(req.user.fb_id, { kind: b ? 'mb' : 'pm', by: b ? b.name : req.user.name, byId: b ? b.id : req.user.fb_id, text: (req.body || {}).text });
    if (b) HO.pingPm(req.user.fb_id, note); // the PM hears about it on Telegram straight away
    res.json(await HO.card(req.user, HANDOFF_DEPS));
  }));
  api.get('/handoff/preview', wrap(async (req, res) => res.json(await require('../handoff').preview(req.user, HANDOFF_DEPS))));
  api.put('/handoff/prefs', wrap(async (req, res) => { if (req.user.buyer) return res.status(403).json({ error: 'Your PM switches these messages on or off.' }); res.json(await require('../handoff').savePrefs(req.user.fb_id, req.body || {})); }));
  api.post('/auto-report/run', wrap(async (req, res) => {
    if (!telegram.hasBot()) return res.status(400).json({ error: 'Telegram is not set up. Add TELEGRAM_BOT_TOKEN in Railway.' });
    const today = sync.todayIn(), pick = (req.body || {}).day;
    if (isDay(pick) && pick < today) return res.json(await extras.sendClientReports(req.user, pick, { refresh: false })); // an earlier day from the Reports page: send what is saved, keep "last auto run" as it was
    const r = await extras.sendClientReports(req.user, today);
    await db.setUserSetting(req.user.fb_id, 'autoReportLast', r);
    res.json(r);
  }));
  // ---------- today's to-do ----------
  api.get('/todo', wrap(async (req, res) => res.json(await pm.todo(req.user))));

  return { HANDOFF_DEPS };
};
