// Today's to-do for a PM: reports to send, service invoices due or unpaid, clients without a group,
// ad accounts that can't spend, and a Facebook login about to expire.
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
    if (!c.telegram) items.push({ kind: 'nogroup', level: 'warn', clientId: c.id, title: `${c.name} has spend today but no Telegram group`, detail: `${money(spend)} today · pick a group so the report can be sent`, action: 'client' });
    else {
      const autoNote = auto.on && !(auto.skip || []).includes(c.id) ? ` · auto report sends at ${auto.time}` : '';
      items.push({ kind: 'report', level: 'todo', clientId: c.id, title: `Send ${c.name}'s report`, detail: `${money(spend)} today${autoNote}`, action: 'report' });
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
    if (!thisMonth && days <= 3) items.push({ kind: 'invoice', level: days < 0 ? 'bad' : 'todo', clientId: c.id, title: `${days < 0 ? 'Overdue' : days === 0 ? 'Due today' : `Due in ${days} day${days === 1 ? '' : 's'}`}: ${c.name}'s service fee`, detail: `${money(sv.price)} · no invoice yet this month`, action: 'payments' });
  }
  for (const v of invs) {
    if (!v.sentAt || v.paidAt) continue;
    const c = clients.find((x) => x.id === v.clientId); if (!c) continue;
    const days = Math.round((Date.parse(today) - Date.parse(v.date)) / 864e5);
    if (days >= 3) items.push({ kind: 'unpaid', level: days > 10 ? 'bad' : 'warn', clientId: c.id, title: `${c.name} hasn't paid invoice ${v.number}`, detail: `${money(v.total)} · sent ${days} days ago`, action: 'payments' });
  }

  // Ad accounts that can't spend, and a Facebook login about to expire.
  for (const a of await db.listAccounts(owner)) {
    const i = a.info || {};
    if (!a.enabled || !i.statusCode || i.statusCode === 1) continue;
    items.push({ kind: 'account', level: 'bad', title: `Ad account ${a.name || a.id}: ${i.status || 'not active'}`, detail: i.disableReason ? `Reason: ${i.disableReason}` : 'Check it in Ads Manager', action: 'accounts' });
  }
  if (user.token_expires) {
    const d = Math.ceil((new Date(user.token_expires) - Date.now()) / 864e5);
    if (d <= 7) items.push({ kind: 'login', level: d <= 0 ? 'bad' : 'warn', title: d <= 0 ? 'Your Facebook login has expired' : `Your Facebook login expires in ${d} day${d === 1 ? '' : 's'}`, detail: 'Log out and log in again to keep syncing', action: 'logout' });
  }

  const order = { bad: 0, warn: 1, todo: 2 };
  items.sort((a, b) => order[a.level] - order[b.level]);
  return { today, items };
}

module.exports = { todo };
