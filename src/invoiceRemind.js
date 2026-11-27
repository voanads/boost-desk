// Invoice reminders to each Project Manager's own Telegram, with a button to mark an invoice paid.
// Why: in the Admin "Payments and invoices" page almost nothing was ever marked paid, so leaders could not tell real
// debt from invoices nobody updated. Marking paid has to be one tap from where the PM already is: Telegram.
//   · every morning: invoices sent 7+ days ago and not paid, and invoices made 3+ days ago and never sent;
//   · each invoice is reminded again at most every 3 days (user setting invRemind = { '<invoice id>': '<day>' });
//   · a tap on "✅ <number> បានបង់" marks it paid — only from that PM's own chat.
const db = require('./db');
const sync = require('./sync');
const telegram = require('./telegram');

const PAID_AFTER = 7, SEND_AFTER = 3, AGAIN_DAYS = 3, MAX_BUTTONS = 8, LOOKBACK = 120;
// Owner's decision (27 Nov 2026): an invoice older than 45 days is no longer reminded every few days. Most of those were
// paid and never marked, so the reminders had become noise. An admin checks them in Admin → Payments and marks Paid there.
const STALE_AFTER = 45;
const money = (n) => '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const daysSince = (today, day) => Math.round((Date.parse(today) - Date.parse(day)) / 864e5);

// What one PM should be told today (pure: easy to test). invs = db.listInvoices rows; names = { clientId: name }.
function due(invs, names, today, reminded = {}) {
  const unpaid = [], unsent = [];
  for (const v of invs) {
    if (v.paidAt) continue;
    const last = reminded[v.id]; if (last && daysSince(today, last) < AGAIN_DAYS) continue;
    const d = daysSince(today, v.date); if (d > STALE_AFTER) continue;
    const row = { id: v.id, number: v.number, client: names[v.clientId] || '', total: Number(v.total) || 0, days: d };
    if (v.sentAt && d >= PAID_AFTER) unpaid.push(row);
    else if (!v.sentAt && d >= SEND_AFTER) unsent.push(row);
  }
  unpaid.sort((a, b) => b.days - a.days); unsent.sort((a, b) => b.days - a.days);
  return { unpaid, unsent };
}

function text(name, { unpaid, unsent }) {
  const lines = [`🧾 វិក្កយបត្រ · ${name}`];
  if (unpaid.length) lines.push('', `💰 បានផ្ញើហើយ តែមិនទាន់បង់ ${unpaid.length} (${money(unpaid.reduce((t, r) => t + r.total, 0))})៖`, ...unpaid.slice(0, 15).map((r) => `• ${r.number} · ${r.client || '–'} · ${money(r.total)} · ${r.days} ថ្ងៃ`));
  if (unsent.length) lines.push('', `📤 មិនទាន់ផ្ញើទៅភ្ញៀវ ${unsent.length}៖`, ...unsent.slice(0, 10).map((r) => `• ${r.number} · ${r.client || '–'} · ${money(r.total)} · បង្កើត ${r.days} ថ្ងៃមុន`));
  lines.push('', 'ភ្ញៀវបង់ហើយ? ចុចប៊ូតុងខាងក្រោម ដើម្បីកត់ថា "បានបង់"។');
  return lines.join('\n');
}

async function run(log = () => {}) {
  if (!telegram.hasBot()) return 0;
  const today = sync.todayIn(); let n = 0;
  for (const u of await db.allUsers()) {
    try {
      const chat = await db.getUserSetting(u.fb_id, 'tgChat', null); if (!chat || !chat.id) continue;
      const invs = await db.listInvoices(u.fb_id, sync.addDays(today, -LOOKBACK), today); if (!invs.length) continue;
      const names = {}; for (const c of await db.listClients(u.fb_id)) names[c.id] = c.name;
      const reminded = (await db.getUserSetting(u.fb_id, 'invRemind', null)) || {};
      const d = due(invs, names, today, reminded); if (!d.unpaid.length && !d.unsent.length) continue;
      // unpaid first (sent, waiting for money), then unsent ones — both can be paid already (paid in cash, sent by hand)
      const buttons = [...d.unpaid, ...d.unsent].slice(0, MAX_BUTTONS).map((r) => [{ text: `✅ ${r.number} បានបង់`, data: `inv:paid:${r.id}` }]);
      await telegram.sendButtons(text(u.name, d), chat.id, buttons);
      for (const r of [...d.unpaid, ...d.unsent]) reminded[r.id] = today;
      for (const k of Object.keys(reminded)) if (daysSince(today, reminded[k]) > LOOKBACK) delete reminded[k];
      await db.setUserSetting(u.fb_id, 'invRemind', reminded); n++;
    } catch (e) { log('invoice reminder failed for', u.name, e.message); }
  }
  return n;
}

// A tap on "✅ IN26-1522 បានបង់". Only the PM who owns the invoice, from their own linked chat, can mark it.
async function onTelegram(fresh) {
  for (const t of (fresh && fresh.taps) || []) {
    const m = String(t.data).match(/^inv:paid:(\d+)$/); if (!m) continue;
    try {
      const row = (await db.pool.query('SELECT owner, number, total FROM invoices WHERE id=$1', [m[1]])).rows[0];
      if (!row) { telegram.answerTap(t.qid, 'វិក្កយបត្រនេះត្រូវបានលុប។'); continue; }
      const chat = await db.getUserSetting(row.owner, 'tgChat', null);
      if (!chat || String(chat.id) !== String(t.chat)) { telegram.answerTap(t.qid, 'មានតែ PM ម្ចាស់វិក្កយបត្រទេ ដែលអាចកត់បាន។'); continue; }
      await db.markInvoice(row.owner, Number(m[1]), { paid: true });
      telegram.answerTap(t.qid, `បានកត់៖ ${row.number} បានបង់`);
      telegram.send(`✅ ${row.number} · ${money(row.total)} — បានកត់ថាបានបង់ (${t.name || 'PM'})`, t.chat).catch(() => {});
    } catch (_) { telegram.answerTap(t.qid, 'សូមសាកម្ដងទៀត'); }
  }
}

module.exports = { due, text, run, onTelegram, PAID_AFTER, SEND_AFTER, AGAIN_DAYS, STALE_AFTER };
