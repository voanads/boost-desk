// Company summary for the CEO / COO dashboard: one month of the whole company — money (boost spend,
// service invoices, Profit books), clients, every team's work, KPI achievement, monthly targets,
// overdue tasks and alerts. Everything is read from what already exists; nothing new is stored.
const db = require('./db');
const sync = require('./sync');
const kpi = require('./kpi');
const buyers = require('./buyers');
const profitCalc = require('./profitCalc');

const r2 = (x) => Math.round((Number(x) || 0) * 100) / 100;
const lastOf = (ym) => { const [y, m] = ym.split('-').map(Number); return `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`; };

// deps: { getTeams, dayTasks, clientMoney } from server.js (they already cache the expensive parts).
async function summary({ month, getTeams, dayTasks, clientMoney }) {
  const today = sync.todayIn(), thisMonth = today.slice(0, 7), ym = /^\d{4}-\d{2}$/.test(month || '') ? month : thisMonth;
  const from = ym + '-01', to = ym === thisMonth ? today : lastOf(ym);
  const [users, teams, bl] = await Promise.all([db.allUsers(), getTeams(), buyers.all()]);
  const uName = Object.fromEntries(users.map((u) => [u.fb_id, u.name])), teamOf = {};
  for (const t of teams) for (const m of t.members) teamOf[m] = t.id;
  const byName = Object.fromEntries(users.map((u) => [u.name, u.fb_id]));
  const buyerTeam = (b) => teamOf[b.addedById || byName[b.addedBy] || ''] || null;

  // ---- clients ----
  const cl = (await db.pool.query('SELECT id, name, owner, type, archived, created_at FROM clients')).rows.filter((c) => uName[c.owner]);
  const active = cl.filter((c) => !c.archived), newClients = cl.filter((c) => String(c.created_at.toISOString ? c.created_at.toISOString() : c.created_at).slice(0, 7) === ym);

  // ---- spend per person / team (this month: the Board's cached numbers; other months: a direct read) ----
  const spendOf = {}, ordersOf = {};
  if (ym === thisMonth) {
    const money = await clientMoney(today);
    for (const [uid, v] of Object.entries(money.out || {})) { spendOf[uid] = 0; ordersOf[uid] = 0; for (const m of Object.values(v.m || {})) { spendOf[uid] += m.spend || 0; ordersOf[uid] += m.orders || 0; } }
  } else {
    for (const u of users) { try { const d = await sync.dashboard(u.fb_id, from, to); spendOf[u.fb_id] = d.clients.reduce((t, c) => t + (c.spend || 0), 0); } catch (_) { spendOf[u.fb_id] = 0; } ordersOf[u.fb_id] = 0; }
  }
  const spend = r2(Object.values(spendOf).reduce((a, b) => a + b, 0));

  // ---- revenue: service invoices dated in the month (every person's Payments tab) ----
  const inv = (await db.pool.query('SELECT owner, total, paid_at, sent_at FROM invoices WHERE date BETWEEN $1 AND $2', [from, lastOf(ym)])).rows;
  const revenue = { invoiced: r2(inv.reduce((t, i) => t + Number(i.total), 0)), paid: r2(inv.filter((i) => i.paid_at).reduce((t, i) => t + Number(i.total), 0)), count: inv.length, unpaid: inv.filter((i) => !i.paid_at).length };
  revenue.outstanding = r2(revenue.invoiced - revenue.paid);
  const revByUser = {}; for (const i of inv) revByUser[i.owner] = r2((revByUser[i.owner] || 0) + Number(i.total));

  // ---- profit: every Profit book for the month (same formulas as the Profit tab) ----
  let profit = { total: 0, split: 0, company: 0, books: 0, submitted: 0, byBook: [] };
  try {
    const ov = await profitCalc.overview({ people: async () => users.map((u) => ({ id: u.fb_id, name: u.name, kind: 'Facebook', access: 'member' })), monthsBack: 24 });
    for (const b of ov.books) { const m = b.months[ym]; if (!m) continue; profit.books++; if (m.submitted) profit.submitted++; profit.total = r2(profit.total + m.profit); profit.split = r2(profit.split + m.split); profit.company = r2(profit.company + ((m.roles || {}).company || 0)); profit.byBook.push({ id: b.id, name: b.name, profit: m.profit, submitted: !!m.submitted }); }
  } catch (_) {}

  // ---- today's work: every person's tasks (done / open / overdue), alerts ----
  const dt = await dayTasks(today);
  const perUser = {}, overdue = [], alerts = [];
  for (const [uid, o] of Object.entries(dt.users || {})) {
    const p = perUser[uid] = { done: 0, open: 0, overdue: 0, target: 0, reached: 0, tgTasks: 0 };
    for (const t of o.tasks || []) {
      if (t.done) p.done++; else p.open++;
      if (t.late && !t.done) { p.overdue++; overdue.push({ person: o.name, personId: uid, team: teamOf[uid] || null, client: t.client, clientId: t.clientId, text: t.text, day: t.day, to: t.to ? t.to.name : '' }); }
      if (t.from === 'work' && !t.done && (t.level === 'urgent' || t.level === 'high')) alerts.push({ person: o.name, personId: uid, team: teamOf[uid] || null, client: t.client, clientId: t.clientId, text: t.text, detail: t.detail || '', level: t.level });
      if (Number(t.target) > 0) { p.tgTasks++; p.target += Number(t.target); p.reached += Math.min(Number(t.reached) || 0, Number(t.target)); }
    }
  }
  overdue.sort((a, b) => a.day.localeCompare(b.day));

  // ---- monthly KPIs: every person (users + media buyers) ----
  const people = [...users.map((u) => ({ id: u.fb_id, name: u.name, buyer: false, team: teamOf[u.fb_id] || null })), ...bl.map((b) => ({ id: b.id, name: b.name, buyer: true, team: buyerTeam(b) }))];
  const kpiRows = [];
  await Promise.all(people.map(async (p) => {
    let rs = []; try { rs = await kpi.results(p.id, ym, p.buyer); } catch (_) {}
    for (const k of rs) if (k.target > 0) kpiRows.push({ person: p.name, personId: p.id, buyer: p.buyer, team: p.team, name: k.name, target: k.target, unit: k.unit, result: k.result, score: k.score });
  }));
  const kpiAvg = kpiRows.length ? Math.round(kpiRows.reduce((t, k) => t + Math.min(k.score, 150), 0) / kpiRows.length) : null;
  const kpiHit = kpiRows.filter((k) => k.score >= 100).length;

  // ---- teams ----
  const teamRows = [...teams.map((t) => ({ id: t.id, name: t.name, members: t.members })), { id: null, name: 'No team', members: users.map((u) => u.fb_id).filter((id) => !teamOf[id]) }]
    .map((t) => {
      const m = t.members.filter((id) => uName[id]);
      const agg = { done: 0, open: 0, overdue: 0, target: 0, reached: 0 };
      for (const id of m) { const p = perUser[id]; if (!p) continue; agg.done += p.done; agg.open += p.open; agg.overdue += p.overdue; agg.target += p.target; agg.reached += p.reached; }
      const ks = kpiRows.filter((k) => k.team === t.id);
      return { id: t.id, name: t.name, people: m.map((id) => ({ id, name: uName[id] })), buyers: bl.filter((b) => buyerTeam(b) === t.id).length,
        clients: active.filter((c) => m.includes(c.owner)).length, spend: r2(m.reduce((s, id) => s + (spendOf[id] || 0), 0)), orders: m.reduce((s, id) => s + (ordersOf[id] || 0), 0), revenue: r2(m.reduce((s, id) => s + (revByUser[id] || 0), 0)),
        tasks: agg, targetPct: agg.target ? Math.round(agg.reached / agg.target * 100) : null, kpiAvg: ks.length ? Math.round(ks.reduce((s, k) => s + Math.min(k.score, 150), 0) / ks.length) : null, kpis: ks.length };
    }).filter((t) => t.id || t.people.length);
  teamRows.sort((a, b) => b.spend - a.spend);

  const tasks = Object.values(perUser).reduce((a, p) => ({ done: a.done + p.done, open: a.open + p.open, overdue: a.overdue + p.overdue, target: a.target + p.target, reached: a.reached + p.reached }), { done: 0, open: 0, overdue: 0, target: 0, reached: 0 });
  return {
    month: ym, from, to, today, isThisMonth: ym === thisMonth,
    money: { spend, revenue, profit },
    clients: { active: active.length, new: newClients.length, paused: cl.length - active.length, newList: newClients.slice(0, 12).map((c) => ({ id: c.id, name: c.name, owner: uName[c.owner] })) },
    people: { users: users.length, buyers: bl.length, buyersLinked: bl.filter((b) => b.linked).length, teams: teams.length },
    tasks: { ...tasks, targetPct: tasks.target ? Math.round(tasks.reached / tasks.target * 100) : null },
    kpis: { rows: kpiRows.sort((a, b) => b.score - a.score), avg: kpiAvg, hit: kpiHit, total: kpiRows.length },
    teams: teamRows, overdue: overdue.slice(0, 40), alerts: alerts.slice(0, 40),
  };
}

module.exports = { summary };
