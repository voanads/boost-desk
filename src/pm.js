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

  const order = { bad: 0, warn: 1, todo: 2 };
  items.sort((a, b) => order[a.level] - order[b.level]);
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

module.exports = { todo };
