// Task menu: the list of duties a person does every day, planned in the morning and closed in the evening.
//
//   taskMenu                     = { pm: [{ id, text }], mb: [...], since }   the role templates (Admin → Settings)
//   menuList:<person>:<role>     = { items: [{ id, text, since, day }] }       the person's own list (starts as a copy
//                                                                              of the template; they edit, add, remove)
//   menuTicks:<person>:<day>     = { itemId: { at, by } }                      what was ticked that day
//   menuDay:<person>:<day>       = { plan: { at, by, items }, result: { at, by, note, done, total } }
//                                                                              "Submit plan" freezes the day's list;
//                                                                              "Submit result" closes the day
const crypto = require('crypto');
const db = require('./db');
const sync = require('./sync');

const DEFAULT = {
  pm: [
    'ពិនិត្យចំណាយ និង Ad account របស់អតិថិជនទាំងអស់',
    'ផ្ញើរបាយការណ៍ប្រចាំថ្ងៃទៅអតិថិជន',
    'រៀបចំ និងផ្ញើផែនការ Boost Post / Live',
    'ពិនិត្យ និងដឹកនាំការងារ Media buyer',
    'ឆ្លើយតបសារ និងដោះស្រាយបញ្ហាអតិថិជន',
  ],
  mb: [
    'ដឹកនាំ និង Boost Post',
    'ដឹកនាំ និង Boost Live',
    'ចាត់ចែង ពិនិត្យ និង Update Ad account',
    'ទទួល Comment និងសារពី Live / Boost Post',
    'ដោះស្រាយបញ្ហាផ្សេងៗ',
  ],
};
const ROLES = ['pm', 'mb'];
const newId = () => crypto.randomBytes(4).toString('hex');
const okId = (id) => /^[a-f0-9]{8}$/.test(String(id || ''));
const clean = (list) => (Array.isArray(list) ? list : []).slice(0, 60).map((x) => (typeof x === 'string' ? { text: x } : x || {}))
  .map((x) => ({ id: okId(x.id) ? x.id : newId(), text: String(x.text || '').trim().slice(0, 160) })).filter((x) => x.text);

// ---- role templates ----
async function all() {
  const saved = (await db.getSetting('taskMenu', null)) || {};
  const out = { since: saved.since || sync.todayIn() };
  for (const r of ROLES) out[r] = saved[r] ? clean(saved[r]) : clean(DEFAULT[r]);
  if (!saved.pm && !saved.mb) await db.setSetting('taskMenu', out);
  return out;
}
async function save(menu, by) {
  const cur = await all(), out = { since: cur.since }; for (const r of ROLES) out[r] = clean((menu || {})[r]);
  await db.setSetting('taskMenu', { ...out, at: new Date().toISOString(), by });
  return out;
}

// ---- the person's own list ----
const listKey = (person, role) => `menuList:${person}:${role}`;
async function listOf(person, role) {
  const saved = await db.getSetting(listKey(person, role), null);
  if (saved && Array.isArray(saved.items)) return saved.items.filter((x) => x && okId(x.id) && x.text);
  const legacy = (await db.getSetting(`menuOwn:${person}`, null)) || []; // own items from the first version
  const tpl = (await all()), items = [...tpl[role].map((x) => ({ id: x.id, text: x.text, since: tpl.since, day: null })), ...legacy.filter((x) => x && okId(x.id) && x.text)];
  await db.setSetting(listKey(person, role), { items, at: new Date().toISOString() });
  return items;
}
const putList = (person, role, items) => db.setSetting(listKey(person, role), { items: items.slice(0, 60), at: new Date().toISOString() });
async function addItem(person, role, text, day) {
  const items = await listOf(person, role), t = String(text || '').trim().slice(0, 160); if (!t) throw new Error('Type the task.');
  if (items.length >= 60) throw new Error('That is enough items — remove one first.');
  const item = { id: newId(), text: t, since: sync.todayIn(), day: day || null }; items.push(item);
  await putList(person, role, items);
  const d = day || sync.todayIn(), st = await stateOf(person, d); // a day whose plan is already submitted gets the item added to that plan
  if (st.plan && Array.isArray(st.plan.items)) { st.plan.items.push({ id: item.id, text: item.text, once: !!day }); await db.setSetting(dayKey(person, d), st); }
  return item;
}
async function editItem(person, role, id, text) {
  const items = await listOf(person, role), it = items.find((x) => x.id === id); if (!it) throw new Error('Item not found.');
  const t = String(text || '').trim().slice(0, 160); if (!t) throw new Error('Type the task.');
  it.text = t; await putList(person, role, items); return it;
}
async function removeItem(person, role, id) { await putList(person, role, (await listOf(person, role)).filter((x) => x.id !== id)); }
async function resetList(person, role) {
  const tpl = await all(), items = tpl[role].map((x) => ({ id: x.id, text: x.text, since: tpl.since, day: null }));
  await putList(person, role, items); return items;
}
const itemsOn = (items, day) => items.filter((x) => (x.day ? x.day === day : (x.since || '0000') <= day)).map((x) => ({ id: x.id, text: x.text, once: !!x.day }));

// ---- per day: ticks, plan, result ----
const tickKey = (person, day) => `menuTicks:${person}:${day}`;
const ticksOf = async (person, day) => (await db.getSetting(tickKey(person, day), null)) || {};
async function tick(person, day, itemId, done, by) {
  const t = await ticksOf(person, day);
  if (done) t[itemId] = { at: new Date().toISOString(), by }; else delete t[itemId];
  await db.setSetting(tickKey(person, day), t);
  return t;
}
const dayKey = (person, day) => `menuDay:${person}:${day}`;
const stateOf = async (person, day) => (await db.getSetting(dayKey(person, day), null)) || {};
async function submitPlan(person, role, day, by) {
  const st = await stateOf(person, day), items = itemsOn(await listOf(person, role), day);
  if (!items.length) throw new Error('Add at least one task to the menu first.');
  st.plan = { at: new Date().toISOString(), by, items: items.map((x) => ({ id: x.id, text: x.text, once: x.once })) };
  delete st.result; await db.setSetting(dayKey(person, day), st); return st;
}
async function submitResult(person, role, day, by, note) {
  const st = await stateOf(person, day), d = await dayOf(person, role, day);
  st.result = { at: new Date().toISOString(), by, note: String(note || '').trim().slice(0, 500), done: d.done, total: d.total };
  await db.setSetting(dayKey(person, day), st); return st;
}
async function reopen(person, day) { const st = await stateOf(person, day); delete st.result; await db.setSetting(dayKey(person, day), st); return st; }
// The day's items: the plan snapshot when one was submitted, else the live list.
const dayItems = (st, items, day) => (st.plan && Array.isArray(st.plan.items) ? st.plan.items : itemsOn(items, day));

async function dayOf(person, role, day) {
  const [items, t, st] = await Promise.all([listOf(person, role), ticksOf(person, day), stateOf(person, day)]);
  const list = dayItems(st, items, day).map((i) => ({ ...i, done: !!t[i.id], at: t[i.id] ? t[i.id].at : null, by: t[i.id] ? t[i.id].by : null }));
  const done = list.filter((x) => x.done).length;
  return { day, role, items: list, total: list.length, done, pct: list.length ? Math.round(done / list.length * 100) : null,
    plan: st.plan ? { at: st.plan.at, by: st.plan.by } : null, result: st.result || null };
}
async function monthOf(person, role, month) {
  const today = sync.todayIn(), items = await listOf(person, role), since = (await all()).since;
  const q = async (prefix) => Object.fromEntries((await db.pool.query('SELECT key, value FROM settings WHERE key LIKE $1', [`${prefix}:${person}:${month}-%`])).rows.map((r) => [r.key.split(':').pop(), r.value || {}]));
  const [ticks, states] = await Promise.all([q('menuTicks'), q('menuDay')]);
  const [y, m] = month.split('-').map(Number), last = new Date(Date.UTC(y, m, 0)).getUTCDate(), days = {};
  for (let d = 1; d <= last; d++) {
    const day = `${month}-${String(d).padStart(2, '0')}`, t = ticks[day] || {}, st = states[day] || {};
    if (day > today || (day < since && !Object.keys(t).length && !st.plan)) { days[day] = { tasks: [], total: 0, done: 0, pct: null }; continue; }
    const list = dayItems(st, items, day).map((i) => ({ text: i.text, done: !!t[i.id], missed: !t[i.id] && day < today }));
    const done = list.filter((x) => x.done).length;
    days[day] = { tasks: list, total: list.length, done, pct: list.length ? Math.round(done / list.length * 100) : null, planAt: st.plan ? st.plan.at : null, resultAt: st.result ? st.result.at : null };
  }
  return { month, today, days };
}
// For KPIs: per item, how many days it was due and ticked this month.
async function monthStats(person, role, month) {
  const today = sync.todayIn(), items = await listOf(person, role), since = (await all()).since;
  const q = async (prefix) => Object.fromEntries((await db.pool.query('SELECT key, value FROM settings WHERE key LIKE $1', [`${prefix}:${person}:${month}-%`])).rows.map((r) => [r.key.split(':').pop(), r.value || {}]));
  const [ticks, states] = await Promise.all([q('menuTicks'), q('menuDay')]);
  const [y, m] = month.split('-').map(Number), last = new Date(Date.UTC(y, m, 0)).getUTCDate(), agg = {};
  for (let d = 1; d <= last; d++) {
    const day = `${month}-${String(d).padStart(2, '0')}`, t = ticks[day] || {}, st = states[day] || {};
    if (day > today || (day < since && !Object.keys(t).length && !st.plan)) continue;
    for (const i of dayItems(st, items, day)) { const a = agg[i.id] = agg[i.id] || { id: i.id, text: i.text, due: 0, done: 0 }; a.due++; if (t[i.id]) a.done++; }
  }
  return Object.values(agg);
}

module.exports = { all, save, tick, dayOf, monthOf, monthStats, listOf, addItem, editItem, removeItem, resetList, submitPlan, submitResult, reopen, ROLES };
