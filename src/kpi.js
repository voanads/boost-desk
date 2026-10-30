// Monthly KPIs per person (a Boost Desk user or a media buyer), like the GenZ-KPI sheet: each KPI has a
// target and a unit; the result fills itself from the daily tasks linked to it, and the score is
// result ÷ target. Stored in the setting kpi:<person>:<YYYY-MM> = { kpis: [{ id, name, target, unit }] }.
//
// How a result is worked out from the month's tasks linked to a KPI:
//   unit "%"  → tasks done ÷ tasks due in the month × 100 (every-day tasks count once per day)
//   any other → the sum of what people typed as "reached" on tasks that have a 🎯 number,
//               plus one per task (per day) ticked done on tasks without a number
const crypto = require('crypto');
const db = require('./db');
const sync = require('./sync');

const key = (person, month) => `kpi:${person}:${month}`;
const MON = /^\d{4}-\d{2}$/;
const clean = (list) => (Array.isArray(list) ? list : []).slice(0, 40).map((k) => ({
  id: /^[a-f0-9]{8}$/.test(String(k.id || '')) ? k.id : crypto.randomBytes(4).toString('hex'),
  name: String(k.name || '').trim().slice(0, 120),
  target: Math.max(0, Number(k.target) || 0),
  unit: String(k.unit || '').trim().slice(0, 12),
  manual: k.manual === null || k.manual === undefined || k.manual === '' ? null : Math.max(0, Number(k.manual) || 0),
})).filter((k) => k.name);

const getList = async (person, month) => clean(((await db.getSetting(key(person, month), null)) || {}).kpis);
const putList = (person, month, kpis) => db.setSetting(key(person, month), { kpis: clean(kpis), at: new Date().toISOString() });
const months = async (person) => (await db.pool.query("SELECT key FROM settings WHERE key LIKE $1", [`kpi:${person}:%`])).rows.map((r) => r.key.split(':').pop()).filter((m) => MON.test(m)).sort();

// All workbooks that hold tasks of this person: a user's own client workbooks, or (media buyer) every
// workbook whose tasks are assigned to them.
async function tasksOf(person, isBuyer) {
  const rows = isBuyer
    ? (await db.pool.query(`SELECT key, value FROM settings WHERE key ~ '^[^:]+:cwb:[0-9]+$'`)).rows
    : (await db.pool.query(`SELECT key, value FROM settings WHERE key LIKE $1`, [`${person}:cwb:%`])).rows;
  const out = [];
  for (const r of rows) { const w = r.value || {}; for (const t of w.tasks || []) { if (isBuyer && !(t.to && t.to.id === person)) continue; if (!isBuyer && t.to) continue; out.push({ t, log: w.log || [] }); } }
  return out;
}

function monthDays(month, today) {
  const [y, m] = month.split('-').map(Number), dim = new Date(Date.UTC(y, m, 0)).getUTCDate(), out = [];
  for (let d = 1; d <= dim; d++) { const day = `${month}-${String(d).padStart(2, '0')}`; if (day <= today) out.push(day); }
  return out;
}

// A task counts toward a KPI when it was linked to it, or — auto-detect — when the task text contains the KPI's
// name (or every word of it). A "%" KPI with no matching task at all uses the person's overall daily completion.
const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
function matches(t, k) {
  if (t.kpi) return t.kpi === k.id;
  const a = norm(t.text), b = norm(k.name); if (!a || !b) return false;
  if (a.includes(b) || b.includes(a)) return true;
  const aw = a.split(' '), words = b.split(' ').filter((w) => w.length > 2);
  const same = (x, y) => x === y || (x.length >= 4 && y.length >= 4 && (x.startsWith(y.slice(0, 4)) || y.startsWith(x.slice(0, 4)))); // boost / boosted, live / lives
  return words.length > 0 && words.every((w) => aw.some((x) => same(x, w)));
}
async function results(person, month, isBuyer) {
  const kpis = await getList(person, month), today = sync.todayIn(), days = monthDays(month, today);
  const all = await tasksOf(person, isBuyer);
  const dayOf = (iso) => { try { return sync.todayIn(undefined, new Date(iso)); } catch (_) { return ''; } };
  // what each task did this month: days due, days done, reached numbers
  const stat = all.map(({ t, log }) => {
    const dueDays = t.repeat ? days.filter((d) => d >= t.day) : (String(t.day || '').startsWith(month) ? [t.day] : []);
    const doneDays = new Set(log.filter((x) => x.id === 't:' + t.id + ':' + x.day && x.day.startsWith(month)).map((x) => x.day));
    if (!t.repeat && t.done && t.doneAt && dayOf(t.doneAt).startsWith(month)) doneDays.add(dayOf(t.doneAt));
    const done = [...doneDays].filter((d) => dueDays.includes(d) || !t.repeat).length;
    let sum = 0; if (Number(t.target) > 0) { for (const [d, v] of Object.entries(t.hit || {})) if (d.startsWith(month)) sum += Number(v) || 0; } else sum = doneDays.size;
    return { t, due: dueDays.length, done, sum };
  });
  const allDue = stat.reduce((a, x) => a + x.due, 0), allDone = stat.reduce((a, x) => a + x.done, 0);
  return kpis.map((k) => {
    let due = 0, done = 0, sum = 0, n = 0, linked = 0;
    for (const x of stat) { if (!matches(x.t, k)) continue; n++; if (x.t.kpi) linked++; due += x.due; done += x.done; sum += x.sum; }
    let source = linked ? 'linked' : n ? 'name' : '';
    if (!n && k.unit === '%') { due = allDue; done = allDone; source = allDue ? 'all' : ''; }
    const auto = k.unit === '%' ? (due ? Math.round(done / due * 1000) / 10 : 0) : Math.round(sum * 100) / 100;
    const result = k.manual != null ? k.manual : auto;
    const score = k.target ? Math.round(result / k.target * 1000) / 10 : 0;
    return { ...k, tasks: n, due, done, auto, result, score, estimated: k.manual == null, source };
  });
}

module.exports = { getList, putList, months, results, clean };
