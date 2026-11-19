// Client status: every client is fine (ok), to watch (warn) or has a problem (bad), worked out from data Boost Desk
// already has — nobody types the colour.
//   bad  (red)   — work for the client has stopped or money is at risk: the ad account is disabled or its payment failed,
//                  the boost plan runs today but nothing was spent by the afternoon, an invoice is overdue.
//   warn (amber) — something moved and someone should look: report not sent, no Telegram group, spend over the plan,
//                  far more / no boost compared with the usual, cost per result up, the plan ends in two days.
// People add two things: "checked today" (I looked at this client) and "I'm on it" (I am handling the problem).
// When a client turns red the team's PM and media buyers get one Telegram message; if nobody taps "I'm on it" within
// 30 minutes the leaders get it too; when the problem is gone the team is told. Only between 8:00 and 21:00.
// Stored per workspace in one settings row (<owner>:cstatus); no schema change, nothing about a client's customers.
const db = require('./db');
const sync = require('./sync');
const cfg = require('./config');
const pm = require('./pm');
const plan = require('./plan');
const telegram = require('./telegram');
const buyers = require('./buyers');

const KEY = 'cstatus';
const ESCALATE_MIN = 30, QUIET = [8, 21], NO_BOOST_FROM = 14; // hours, workspace time
const money = (n) => '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const hourNow = () => Number(new Date().toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: cfg.tz || 'Asia/Phnom_Penh' })) % 24;
const hm = (iso) => { try { return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: cfg.tz }); } catch (_) { return ''; } };
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
// Meta account_status: 1 active · 2 disabled · 3 unsettled (a payment failed) · 9 in grace period
const ACCT = { 2: ['bad', 'acct-off', 'Ad account ត្រូវបិទ'], 3: ['bad', 'acct-pay', 'Ad account បង់ប្រាក់បរាជ័យ'], 9: ['warn', 'acct-grace', 'Ad account នៅក្នុងរយៈពេលអនុគ្រោះ (ត្រូវបង់ប្រាក់)'] };
const HOW = {
  'acct-pay': 'ពិនិត្យកាតបង់ប្រាក់ក្នុង Ad account រួចបើក Boost វិញ។', 'acct-off': 'បើក Ad accounts មើលមូលហេតុ ហើយប្ដូរទៅ Ad account ផ្សេងបើចាំបាច់។',
  noboost: 'ពិនិត្យ Boost របស់ភ្ញៀវ៖ campaign បិទ, budget អស់ ឬ Ad account មានបញ្ហា។', invoice: 'ទាក់ទងភ្ញៀវអំពីការបង់ប្រាក់សេវា។', unpaid: 'ទាក់ទងភ្ញៀវអំពី invoice ដែលមិនទាន់បង់។',
};

async function forOwner(user) {
  const owner = user.fb_id, today = sync.todayIn(), hour = hourNow();
  const clients = (await db.listClients(owner)).filter((c) => !c.archived);
  if (!clients.length) return { today, clients: [] };
  const R = Object.fromEntries(clients.map((c) => [c.id, []]));
  const add = (id, level, kind, text, detail = '', action = '') => { if (R[id] && !R[id].some((x) => x.kind === kind)) R[id].push({ level, kind, text, detail, action }); };

  // 1. what the PM to-do and the suggestions already find (reports, groups, invoices, plan overspend, unusual spend)
  let t = { items: [], tips: [] }; try { t = await pm.todo(user); } catch (_) {}
  for (const x of [...(t.items || []), ...(t.tips || [])]) {
    if (!x.clientId || x.level === 'good') continue;
    add(x.clientId, x.level === 'bad' ? 'bad' : 'warn', x.kind, x.title, x.detail || '', x.action || '');
  }
  // 2. today's spend (all, and post boosts)
  const spend = {}; try { const d = await sync.dashboard(owner, today, today); for (const x of d.clients || []) spend[x.id] = { all: x.spend || 0, post: x.postSpend || 0 }; } catch (_) {}
  // 3. the ad accounts named in the client's boost plan
  const acct = {}; try { for (const a of await db.listAccounts(owner)) acct[String(a.id).replace(/^act_/, '')] = a; } catch (_) {}
  for (const c of clients) {
    const lines = (c.plan && c.plan.lines) || [];
    for (const id of new Set(lines.map((l) => String(l.account || '').replace(/^act_/, '')).filter(Boolean))) {
      const a = acct[id], st = a && ACCT[(a.info || {}).statusCode]; if (!st) continue;
      add(c.id, st[0], st[1], st[2], `${a.name || 'act_' + id}${(a.info || {}).disableReason ? ' · ' + a.info.disableReason : ''}`, 'accounts');
    }
    // 4. the boost plan: runs today but nothing spent by the afternoon; ends within two days
    const tt = plan.totals(c.plan);
    if (tt.budget && tt.from && tt.from <= today && tt.to && tt.to >= today) {
      const running = lines.some((l) => l.start && l.start <= today && daysBetween(l.start, today) < l.days);
      if (running && hour >= NO_BOOST_FROM && !((spend[c.id] || {}).post > 0)) add(c.id, 'bad', 'noboost', 'Plan ថា Boost ថ្ងៃនេះ ប៉ុន្តែគ្មានចំណាយ', `Plan ${money(tt.budget)} · ថ្ងៃនេះ ${money(0)}`, 'plan');
      const left = daysBetween(today, tt.to);
      if (left <= 2) add(c.id, 'warn', 'ending', left === 0 ? 'Boost plan ចប់ថ្ងៃនេះ' : `Boost plan នឹងចប់ក្នុង ${left} ថ្ងៃ`, 'សួរភ្ញៀវថាបន្តឬអត់', 'plan');
    }
  }
  const st = (await db.getUserSetting(owner, KEY, null)) || {};
  const rank = { bad: 0, warn: 1, ok: 2 };
  const out = clients.map((c) => {
    const reasons = R[c.id].sort((a, b) => rank[a.level] - rank[b.level]), level = reasons.some((x) => x.level === 'bad') ? 'bad' : reasons.length ? 'warn' : 'ok';
    const s = st[c.id] || {};
    return { id: c.id, name: c.name, level, reasons, spend: (spend[c.id] || {}).all || 0, telegram: !!c.telegram,
      checked: s.checked && s.checked.day === today ? { by: s.checked.by, at: s.checked.at } : null,
      onIt: s.onIt && s.onIt.day === today ? { by: s.onIt.by, at: s.onIt.at } : null };
  }).sort((a, b) => rank[a.level] - rank[b.level] || (!!a.onIt - !!b.onIt) || a.name.localeCompare(b.name));
  return { today, clients: out };
}

// "checked today" / "I'm on it" — by a PM, a media buyer or a leader. Returns the client's new marks.
async function mark(owner, clientId, what, by, on = true) {
  const today = sync.todayIn(), st = (await db.getUserSetting(owner, KEY, null)) || {}, s = st[clientId] || (st[clientId] = {});
  if (what === 'checked') { if (on) s.checked = { day: today, by, at: new Date().toISOString() }; else delete s.checked; }
  if (what === 'onIt') { if (on) s.onIt = { day: today, by, at: new Date().toISOString() }; else delete s.onIt; }
  await db.setUserSetting(owner, KEY, st);
  return { checked: s.checked && s.checked.day === today ? s.checked : null, onIt: s.onIt && s.onIt.day === today ? s.onIt : null };
}

// ---- Telegram: red alert -> "I'm on it" -> leaders after 30 minutes -> resolved ----
const teamChats = async (owner) => {
  const out = []; const c = await db.getUserSetting(owner, 'tgChat', null); if (c && c.id) out.push({ chat: String(c.id), who: 'pm' });
  for (const b of (await buyers.list()).filter((x) => x.addedById === owner && x.chat)) out.push({ chat: String(b.chat), who: b.name, link: buyers.dashLink(b) + '#clients' });
  return out.filter((x, i, a) => a.findIndex((y) => y.chat === x.chat) === i);
};
function alertText(c, teamName) {
  const bad = c.reasons.filter((x) => x.level === 'bad'), lines = [`🔴 ${c.name} ត្រូវការមើលឥឡូវ`, `${teamName} · ${hm(new Date().toISOString())}`, ''];
  for (const r of bad) lines.push(`• ${r.text}${r.detail ? ' — ' + r.detail : ''}`);
  const how = bad.map((r) => HOW[r.kind]).filter(Boolean)[0]; if (how) lines.push('', 'អ្វីគួរធ្វើ៖ ' + how);
  return lines.join('\n');
}
// One pass over every workspace. leaders(): chat ids of the leaders, for the 30-minute escalation.
async function tick({ leaders = async () => [], log = () => {} } = {}) {
  if (!telegram.hasBot()) return 0;
  const hour = hourNow(); if (hour < QUIET[0] || hour >= QUIET[1]) return 0;
  let sent = 0;
  for (const u of await db.allUsers()) {
    try {
      const { today, clients } = await forOwner(u); if (!clients.length) continue;
      const st = (await db.getUserSetting(u.fb_id, KEY, null)) || {}; let dirty = false;
      const chats = await teamChats(u.fb_id);
      for (const c of clients) {
        const s = st[c.id] || (st[c.id] = {}), key = c.level === 'bad' ? today + ':' + c.reasons.filter((x) => x.level === 'bad').map((x) => x.kind).sort().join(',') : '';
        if (s.alert && s.alert.key !== key && s.alert.key.startsWith(today) && !key) { // the problem is gone
          for (const t of chats) telegram.send(`✅ ${c.name} — ដោះស្រាយហើយ`, t.chat).catch(() => {});
          delete s.alert; dirty = true; continue;
        }
        if (s.alert && !s.alert.key.startsWith(today)) { delete s.alert; dirty = true; }
        if (!key) continue;
        if (!s.alert || s.alert.key !== key) {
          if (!chats.length) continue; // nobody in this team has Telegram: the page still shows it
          const text = alertText(c, u.name);
          for (const t of chats) { try { await telegram.sendButtons(text, t.chat, [[{ text: 'ខ្ញុំកំពុងមើល', data: `cs:on:${c.id}` }, { text: 'បើកភ្ញៀវ', url: t.link || `${cfg.baseUrl}/projectmanager#clients` }]]); sent++; } catch (e) { log('client alert failed:', c.name, e.message); } }
          s.alert = { key, at: new Date().toISOString(), escalated: false }; dirty = true; continue;
        }
        if (!s.alert.escalated && !c.onIt && Date.now() - Date.parse(s.alert.at) > ESCALATE_MIN * 60e3) {
          const text = alertText(c, u.name) + `\n\n⏱ ${ESCALATE_MIN} នាទីហើយ មិនទាន់មានអ្នកមើល។`;
          for (const chat of await leaders()) { if (chats.some((t) => t.chat === chat)) continue; telegram.send(text, chat).catch(() => {}); }
          s.alert.escalated = true; dirty = true;
        }
      }
      if (dirty) await db.setUserSetting(u.fb_id, KEY, st);
    } catch (e) { log('client status failed for', u.name, e.message); }
  }
  return sent;
}
// A tap on "ខ្ញុំកំពុងមើល" under an alert.
async function onTelegram(fresh) {
  for (const t of (fresh && fresh.taps) || []) {
    const m = String(t.data).match(/^cs:on:(\d+)$/); if (!m) continue;
    try {
      const row = (await db.pool.query('SELECT owner, name FROM clients WHERE id=$1', [m[1]])).rows[0];
      if (!row) { telegram.answerTap(t.qid, 'ភ្ញៀវនេះត្រូវបានលុប។'); continue; }
      const chats = await teamChats(row.owner), me = chats.find((x) => x.chat === String(t.chat));
      let by = me ? (me.who === 'pm' ? ((await db.getUser(row.owner)) || {}).name || 'PM' : me.who) : (t.name || 'Leader');
      await mark(row.owner, Number(m[1]), 'onIt', by, true);
      telegram.answerTap(t.qid, 'បានកត់ត្រា៖ អ្នកកំពុងមើល');
      for (const x of chats) if (x.chat !== String(t.chat)) telegram.send(`👀 ${by} កំពុងមើល ${row.name}`, x.chat).catch(() => {});
    } catch (_) { telegram.answerTap(t.qid, 'សូមសាកម្ដងទៀត'); }
  }
}
module.exports = { forOwner, mark, tick, onTelegram, hourNow };
