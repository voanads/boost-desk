// Today's to-do for a PM — client work only: reports to send, clients without a group, service invoices
// due or unpaid — plus suggestions about clients from their recent spend.
const db = require('./db');
const sync = require('./sync');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const hasLive = (c) => c.type === 'live' || c.type === 'both';
const hasPost = (c) => c.type === 'post' || c.type === 'both';
const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

const money = (n) => (n < 0 ? '-$' : '$') + Math.abs(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// ---------- today's to-do ----------
async function todo(user) {
  const owner = user.fb_id, today = sync.todayIn();
  const clients = (await db.listClients(owner)).filter((c) => !c.archived);
  const entries = Object.fromEntries((await db.monthEntries(owner, today, today)).map((r) => [r.client_id, r.data || {}]));
  const items = [];

  // Reports: clients with spend today whose report wasn't sent yet.
  const auto = (await db.getUserSetting(owner, 'autoReport', null)) || {};
  for (const c of clients) {
    const e = entries[c.id] || {};
    const spend = round2((hasLive(c) ? Object.values(e.lives || {}).reduce((s, l) => s + (Number(l && l.spend) || 0), 0) : 0) + (hasPost(c) ? Number((e.post || {}).spend) || 0 : 0));
    if (!(spend > 0) || e.reportSent) continue;
    if (!c.telegram) items.push({ kind: 'nogroup', level: 'warn', clientId: c.id, title: `${c.name} មានការចំណាយថ្ងៃនេះ ប៉ុន្តែមិនទាន់មានគ្រុប Telegram`, detail: `${money(spend)} ថ្ងៃនេះ · សូមជ្រើសរើសគ្រុប ដើម្បីអាចផ្ញើរបាយការណ៍បាន`, action: 'client' });
    else {
      const autoNote = auto.on && !(auto.skip || []).includes(c.id) ? ` · របាយការណ៍ស្វ័យប្រវត្តិនឹងផ្ញើនៅម៉ោង ${auto.time}` : '';
      items.push({ kind: 'report', level: 'todo', clientId: c.id, title: `ផ្ញើរបាយការណ៍របស់ ${c.name}`, detail: `${money(spend)} ថ្ងៃនេះ${autoNote}`, action: 'report' });
    }
  }

  // Service invoices: due soon / overdue without an invoice, and sent but not paid.
  const ym = today.slice(0, 7), last = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5)), 0)).getUTCDate();
  const invs = await db.listInvoices(owner, sync.addDays(today, -120), sync.addDays(today, 31));
  for (const c of clients) {
    const sv = c.service || {}; if (!(Number(sv.price) > 0)) continue;
    const due = `${ym}-${String(Math.min(sv.day || 1, last)).padStart(2, '0')}`;
    const days = Math.round((Date.parse(due) - Date.parse(today)) / 864e5);
    const thisMonth = invs.some((v) => v.clientId === c.id && v.date.slice(0, 7) === ym);
    if (!thisMonth && days <= 3) items.push({ kind: 'invoice', level: days < 0 ? 'bad' : 'todo', clientId: c.id, title: `${days < 0 ? 'ហួសកំណត់' : days === 0 ? 'ដល់ថ្ងៃបង់ថ្ងៃនេះ' : `នៅសល់ ${days} ថ្ងៃ`}៖ ថ្លៃសេវារបស់ ${c.name}`, detail: `${money(sv.price)} · មិនទាន់មានវិក្កយបត្រសម្រាប់ខែនេះ`, action: 'payments' });
  }
  for (const v of invs) {
    if (!v.sentAt || v.paidAt) continue;
    const c = clients.find((x) => x.id === v.clientId); if (!c) continue;
    const days = Math.round((Date.parse(today) - Date.parse(v.date)) / 864e5);
    if (days >= 3) items.push({ kind: 'unpaid', level: days > 10 ? 'bad' : 'warn', clientId: c.id, title: `${c.name} មិនទាន់បង់វិក្កយបត្រ ${v.number}`, detail: `${money(v.total)} · បានផ្ញើ ${days} ថ្ងៃមុន`, action: 'payments' });
  }

  // Client setup (Nov 2026 review): boosting clients without a service price get no invoice, and clients whose orders are
  // not counted get no cost per order. Both are to-dos for the PM, never a red / amber status (see status.js).
  try { for (const x of await setup(owner)) for (const k of x.missing) items.push(k === 'price'
    ? { kind: 'setup-price', level: 'todo', clientId: x.clientId, title: `${x.name} មិនទាន់មានតម្លៃសេវា`, detail: `ចំណាយ ${money(x.spend7)} ក្នុង 7 ថ្ងៃ · កំណត់តម្លៃសេវា និងថ្ងៃបង់ ដើម្បីឲ្យវិក្កយបត្រ និងការរំលឹកដំណើរការ`, action: 'client' }
    : { kind: 'setup-orders', level: 'todo', clientId: x.clientId, title: `${x.name}៖ មិនទាន់រាប់ Order បាន`, detail: `ចំណាយ ${money(x.spend7)} ក្នុង 7 ថ្ងៃ តែ 0 order · ភ្ជាប់ Page របស់ភ្ញៀវក្នុង Orders → Connect Pages`, action: 'orders' }); } catch (_) {}

  const order = { bad: 0, warn: 1, todo: 2 };
  items.sort((a, b) => order[a.level] - order[b.level]);
  // Post boost plans: spend went over the planned budget.
  try {
    const P = require('./plan');
    for (const c of clients.filter((x) => x.plan && x.plan.lines && x.plan.lines.length)) {
      const p = await P.progress(owner, c, today);
      if (p && p.started && p.spent > p.budget * 1.02) items.push({ kind: 'plan', level: 'warn', clientId: c.id, title: `${c.name} ចំណាយ Boost Post លើសផែនការ`, detail: `${money(p.spent)} / ${money(p.budget)} តាមផែនការ · លើស ${money(p.spent - p.budget)} · សូមពិនិត្យ ឬផ្អាក Boost`, action: 'client' });
    }
  } catch (_) {}
  return { today, items, tips: await suggestions(owner, clients, today) };
}

// Suggestions about clients, from the last two weeks of spend: who usually boosts but hasn't today,
// who went quiet, who spent far more than usual, whose cost per result moved, and the best recent lives.
async function suggestions(owner, clients, today) {
  const from = sync.addDays(today, -14), yest = sync.addDays(today, -1);
  const [past, now] = await Promise.all([sync.dashboard(owner, from, yest), sync.dashboard(owner, today, today)]);
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: require('./config').tz, hour: '2-digit', hour12: false }).format(new Date()));
  const nice = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('km-KH', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  const tips = [];
  for (const c of clients) {
    const p = past.clients.find((x) => x.id === c.id), t = now.clients.find((x) => x.id === c.id);
    if (!p) continue;
    const daily = p.daily || {}, todaySpend = (t && t.spend) || 0;
    const last7 = Object.keys(daily).filter((d) => d >= sync.addDays(today, -7) && daily[d] > 0).length;
    const activeDays = Object.keys(daily).filter((d) => daily[d] > 0).sort();
    const avg = activeDays.length ? activeDays.reduce((s, d) => s + daily[d], 0) / activeDays.length : 0;
    const lastDay = activeDays[activeDays.length - 1];
    if (!todaySpend && last7 >= 5 && hour >= 14) {
      tips.push({ kind: 'missing', level: 'warn', clientId: c.id, title: `${c.name} ធម្មតា Boost រាល់ថ្ងៃ ប៉ុន្តែថ្ងៃនេះមិនទាន់មាន`, detail: `បាន Boost ${last7} ថ្ងៃ ក្នុង 7 ថ្ងៃចុងក្រោយ · សួរអតិថិជនថា ចង់ Live ឬ Boost Post ថ្ងៃនេះទេ`, action: 'client' });
    } else if (!todaySpend && activeDays.length >= 4 && lastDay && lastDay < sync.addDays(today, -2)) {
      const gap = Math.round((Date.parse(today) - Date.parse(lastDay)) / 864e5);
      tips.push({ kind: 'quiet', level: 'warn', clientId: c.id, title: `${c.name} មិនបាន Boost ${gap} ថ្ងៃហើយ`, detail: `Boost ចុងក្រោយ ${nice(lastDay)} · Boost ${activeDays.length} ថ្ងៃ ក្នុង 2 សប្តាហ៍មុន · សូមទាក់ទងតាមដានអតិថិជន`, action: 'client' });
    }
    if (todaySpend >= 20 && avg > 0 && todaySpend >= avg * 2) {
      tips.push({ kind: 'high', level: 'warn', clientId: c.id, title: `${c.name} ចំណាយថ្ងៃនេះ ${(todaySpend / avg).toFixed(1)}× ច្រើនជាងធម្មតា`, detail: `${money(todaySpend)} ថ្ងៃនេះ ធៀបនឹងប្រហែល ${money(avg)} នៅថ្ងៃ Boost ធម្មតា · សូមពិនិត្យថវិកាឡើងវិញ`, action: 'client' });
    }
    // Post cost per result today vs the last two weeks (posts only, like the Dashboard).
    if (t && t.results > 0 && t.resSpend > 0 && p.results > 0 && p.resSpend > 0) {
      const cNow = t.resSpend / t.results, cPast = p.resSpend / p.results, ch = Math.round((cNow - cPast) / cPast * 100);
      const what = t.resultType || 'result';
      if (ch >= 50) tips.push({ kind: 'cpr-up', level: 'warn', clientId: c.id, title: `តម្លៃក្នុងមួយលទ្ធផលរបស់ ${c.name} ឡើង ${ch}% ថ្ងៃនេះ`, detail: `${money3(cNow)} ថ្ងៃនេះ ធៀបនឹង ${money3(cPast)} ក្នុង 2 សប្តាហ៍មុន · សាកល្បង Post ឬ Audience ថ្មី`, action: 'client' });
      else if (ch <= -30) tips.push({ kind: 'cpr-down', level: 'good', clientId: c.id, title: `Post របស់ ${c.name} ដំណើរការល្អជាងធម្មតាថ្ងៃនេះ`, detail: `តម្លៃក្នុងមួយលទ្ធផល ${money3(cNow)} ធៀបនឹង ${money3(cPast)} ធម្មតា (ថោកជាង ${-ch}%) · Post ល្អ គួរ Boost បន្ថែម`, action: 'client' });
    }
  }
  // Best lives of the last 7 days (by comments): worth reusing how they were boosted.
  try {
    const lv = (await require('./lives').listLives(owner, sync.addDays(today, -7), yest)).filter((l) => l.comments > 0 && clients.some((c) => c.id === l.clientId));
    const seen = new Set();
    for (const l of lv) {
      if (seen.has(l.clientId) || seen.size >= 2) continue; seen.add(l.clientId);
      tips.push({ kind: 'best', level: 'good', clientId: l.clientId, title: `Live ល្អបំផុតរបស់ ${l.client} សប្តាហ៍នេះ៖ ${nice(l.day)}${l.time ? ' ម៉ោង ' + l.time : ''}`, detail: `${l.comments.toLocaleString('en-US')} Comment ក្នុងតម្លៃ ${money(l.spend)} · អាចប្រើការកំណត់ Boost និងម៉ោងនេះម្តងទៀត`, action: 'lives' });
    }
  } catch (_) { /* best lives are a nice-to-have */ }
  const order = { warn: 0, good: 1 };
  return tips.sort((a, b) => order[a.level] - order[b.level]).slice(0, 8);
}
const money3 = (n) => '$' + (Number(n) || 0).toFixed(3);

// Which boosting clients are not fully set up: no service price, or spend with no order counted. Cached 30 minutes per
// account (todo() runs every few minutes for the status alerts). Only clients with $20+ spend in the last 7 days.
const SETUP_MIN = 20, setupCache = new Map();
function setupGaps(clients, spend7, orders7, countingOrders) {
  const out = [];
  for (const c of clients) {
    const sp = round2(spend7[c.id] || 0); if (c.archived || sp < SETUP_MIN) continue;
    const missing = [];
    if (!(Number((c.service || {}).price) > 0)) missing.push('price');
    if (countingOrders && !((orders7[c.id] || {}).orders > 0)) missing.push('orders');
    if (missing.length) out.push({ clientId: c.id, name: c.name, spend7: sp, missing });
  }
  return out.sort((a, b) => b.spend7 - a.spend7);
}
async function setup(owner) {
  const hit = setupCache.get(owner); if (hit && Date.now() - hit.at < 30 * 60e3) return hit.v;
  const today = sync.todayIn(), from = sync.addDays(today, -6), O = require('./orders');
  const clients = (await db.listClients(owner)).filter((c) => !c.archived);
  const spend7 = {}; for (const r of await db.monthEntries(owner, from, today)) { const c = clients.find((x) => x.id === r.client_id); if (!c) continue; const e = r.data || {};
    spend7[c.id] = (spend7[c.id] || 0) + (hasLive(c) ? Object.values(e.lives || {}).reduce((t, l) => t + (Number(l && l.spend) || 0), 0) : 0) + (hasPost(c) ? Number((e.post || {}).spend) || 0 : 0); }
  let counting = false, orders7 = {}; try { const oc = await O.publicConfig(); counting = !!((oc.own && oc.own.on) || oc.hasKey); if (counting) orders7 = (await O.byClient(owner, from, today)).clients || {}; } catch (_) { counting = false; }
  const v = setupGaps(clients, spend7, orders7, counting); setupCache.set(owner, { at: Date.now(), v }); return v;
}

module.exports = { todo, setup, setupGaps };
