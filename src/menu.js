// Task menu: the fixed list of duties a Project Manager and a media buyer must do every day.
// Admins edit the two lists (setting taskMenu = { pm: [{ id, text }], mb: [...] }); each person ticks
// their items day by day (setting menuTicks:<person>:<YYYY-MM-DD> = { itemId: { at, by } }).
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
const clean = (list) => (Array.isArray(list) ? list : []).slice(0, 60).map((x) => (typeof x === 'string' ? { text: x } : x || {}))
  .map((x) => ({ id: /^[a-f0-9]{8}$/.test(String(x.id || '')) ? x.id : newId(), text: String(x.text || '').trim().slice(0, 160) })).filter((x) => x.text);

// since = the first day the menu existed; earlier days show no menu (not 0%).
async function all() {
  const saved = (await db.getSetting('taskMenu', null)) || {};
  const out = { since: saved.since || sync.todayIn() };
  for (const r of ROLES) out[r] = saved[r] ? clean(saved[r]) : clean(DEFAULT[r]);
  if (!saved.pm && !saved.mb) await db.setSetting('taskMenu', out); // first use: keep the defaults so their ids stay stable
  return out;
}
async function save(menu, by) {
  const cur = await all(), out = { since: cur.since }; for (const r of ROLES) out[r] = clean((menu || {})[r]);
  await db.setSetting('taskMenu', { ...out, at: new Date().toISOString(), by });
  return out;
}

// A person's own items on top of the role's: every day from the day added, or for one day only.
const ownKey = (person) => `menuOwn:${person}`;
const ownOf = async (person) => ((await db.getSetting(ownKey(person), null)) || []).filter((x) => x && x.id && x.text);
async function addOwn(person, text, day) {
  const list = await ownOf(person), t = String(text || '').trim().slice(0, 160); if (!t) throw new Error('Type the task.');
  if (list.length >= 30) throw new Error('That is enough own items — remove one first.');
  const item = { id: newId(), text: t, since: sync.todayIn(), day: day || null }; list.push(item);
  await db.setSetting(ownKey(person), list); return item;
}
async function removeOwn(person, id) { await db.setSetting(ownKey(person), (await ownOf(person)).filter((x) => x.id !== id)); }
const ownFor = (list, day) => list.filter((x) => (x.day ? x.day === day : x.since <= day)).map((x) => ({ id: x.id, text: x.text, own: true, once: !!x.day }));
const tickKey = (person, day) => `menuTicks:${person}:${day}`;
const ticksOf = async (person, day) => (await db.getSetting(tickKey(person, day), null)) || {};
async function tick(person, day, itemId, done, by) {
  const t = await ticksOf(person, day);
  if (done) t[itemId] = { at: new Date().toISOString(), by }; else delete t[itemId];
  await db.setSetting(tickKey(person, day), t);
  return t;
}

// One person's menu for a day: items with done / time / by, and the % done.
async function dayOf(person, role, day) {
  const items = [...((await all())[role] || []), ...ownFor(await ownOf(person), day)], t = await ticksOf(person, day);
  const list = items.map((i) => ({ ...i, done: !!t[i.id], at: t[i.id] ? t[i.id].at : null, by: t[i.id] ? t[i.id].by : null }));
  const done = list.filter((x) => x.done).length;
  return { day, role, items: list, total: list.length, done, pct: list.length ? Math.round(done / list.length * 100) : null };
}
// A month, day by day (days up to today only have a score; the menu is the current list).
async function monthOf(person, role, month) {
  const today = sync.todayIn(), menu = await all(), roleItems = menu[role] || [], since = menu.since, own = await ownOf(person);
  const rows = (await db.pool.query('SELECT key, value FROM settings WHERE key LIKE $1', [`menuTicks:${person}:${month}-%`])).rows;
  const ticks = Object.fromEntries(rows.map((r) => [r.key.split(':').pop(), r.value || {}]));
  const [y, m] = month.split('-').map(Number), last = new Date(Date.UTC(y, m, 0)).getUTCDate(), days = {};
  for (let d = 1; d <= last; d++) {
    const day = `${month}-${String(d).padStart(2, '0')}`, t = ticks[day] || {};
    if (day > today || (day < since && !Object.keys(t).length)) { days[day] = { tasks: [], total: 0, done: 0, pct: null }; continue; }
    const list = [...roleItems, ...ownFor(own, day)].map((i) => ({ text: i.text, done: !!t[i.id], missed: !t[i.id] && day < today }));
    const done = list.filter((x) => x.done).length;
    days[day] = { tasks: list, total: list.length, done, pct: list.length ? Math.round(done / list.length * 100) : null };
  }
  return { month, today, days };
}
// For KPIs: how often each menu item was ticked this month (per item text).
async function monthStats(person, role, month) {
  const today = sync.todayIn(), menu = await all(), items = menu[role] || [], since = menu.since;
  const rows = (await db.pool.query('SELECT key, value FROM settings WHERE key LIKE $1', [`menuTicks:${person}:${month}-%`])).rows;
  const ticks = Object.fromEntries(rows.map((r) => [r.key.split(':').pop(), r.value || {}]));
  const [y, m] = month.split('-').map(Number), last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  let due = 0; const dayList = [];
  for (let d = 1; d <= last; d++) { const day = `${month}-${String(d).padStart(2, '0')}`; if (day <= today && (day >= since || Object.keys(ticks[day] || {}).length)) { due++; dayList.push(day); } }
  const own = (await ownOf(person)).map((x) => { const ds = dayList.filter((day) => (x.day ? x.day === day : x.since <= day)); return { id: x.id, text: x.text, due: ds.length, done: ds.filter((day) => (ticks[day] || {})[x.id]).length }; });
  return [...items.map((i) => ({ id: i.id, text: i.text, due, done: dayList.filter((day) => (ticks[day] || {})[i.id]).length })), ...own];
}

module.exports = { all, save, tick, dayOf, monthOf, monthStats, addOwn, removeOwn, ROLES };
