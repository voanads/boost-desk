// Client status: every client is fine (ok), to watch (warn) or has a problem (bad), worked out from data Boost Desk
// already has — nobody types the colour.
//   bad  (red)   — work for the client has stopped or money is at risk: the ad account is disabled or its payment failed,
//                  the boost plan runs today but nothing was spent by the afternoon.
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
const ESCALATE_MIN = 30, QUIET = [8, 21], NO_BOOST_FROM = 14, FRESH_MIN = 120, RENEW_FROM = 9, REPORT_FROM = '20:00', CPR_MIN_SPEND = 3; // hours, workspace time
// Only problems that stop the client's boost are pushed to Telegram. Money problems (invoice overdue / unpaid) stay red on
// the page for the PM but are not pushed: on the first day live they produced a burst of messages.
const PUSH = new Set(['acct-off', 'acct-pay', 'noboost']);
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

// A short history per client (newest first, 30 lines): who checked, who took a problem, alerts and when they were solved.
const note = (s, kind, by, text) => { const d = sync.todayIn(); if ((kind === 'checked' || kind === 'onIt') && (s.log || []).some((l) => l.kind === kind && l.by === (by || '') && sync.todayIn(undefined, new Date(l.at)) === d)) return; s.log = [{ at: new Date().toISOString(), kind, by: by || '', text: text || '' }, ...(s.log || [])].slice(0, 30); };

async function forOwner(user) {
  const owner = user.fb_id, today = sync.todayIn(), hour = hourNow();
  const clients = (await db.listClients(owner)).filter((c) => !c.archived);
  if (!clients.length) return { today, clients: [] };
  const R = Object.fromEntries(clients.map((c) => [c.id, []]));
  const add = (id, level, kind, text, detail = '', action = '') => { if (R[id] && !R[id].some((x) => x.kind === kind)) R[id].push({ level, kind, text, detail, action }); };

  // today's spend (all, and post boosts)
  const spend = {}; try { const d = await sync.dashboard(owner, today, today); for (const x of d.clients || []) spend[x.id] = { all: x.spend || 0, post: x.postSpend || 0 }; } catch (_) {}
  // 1. what the PM to-do and the suggestions already find (groups, plan overspend, unusual spend) — with the owner's rules of 19 Nov:
  //    · "report not sent" counts only once the auto-report time has passed (20:00 when auto report is off), not all day;
  //    · "cost per result up" counts only when today's post spend is $3 or more.
  let t = { items: [], tips: [] }; try { t = await pm.todo(user); } catch (_) {}
  const auto = (await db.getUserSetting(owner, 'autoReport', null)) || {}, reportFrom = auto.on && /^\d\d:\d\d$/.test(String(auto.time || '')) ? auto.time : REPORT_FROM;
  const nowHM = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: cfg.tz || 'Asia/Phnom_Penh' });
  for (const x of [...(t.items || []), ...(t.tips || [])]) {
    if (!x.clientId || x.level === 'good' || x.kind === 'invoice' || x.kind === 'unpaid') continue; // invoices are not part of the client's status (owner, 19 Nov); they stay in Payments and the to-do
    if (x.kind === 'report' && nowHM < reportFrom) continue;
    if (x.kind === 'cpr-up' && !((spend[x.clientId] || {}).post >= CPR_MIN_SPEND)) continue;
    add(x.clientId, x.level === 'bad' ? 'bad' : 'warn', x.kind, x.title, x.detail || '', x.action || '');
  }
  // 2. yesterday's report was never sent (the client spent and has a Telegram group)
  try {
    const yest = sync.addDays(today, -1), byId = Object.fromEntries(clients.map((c) => [c.id, c]));
    for (const r of await db.monthEntries(owner, yest, yest)) {
      const c = byId[r.client_id], e = r.data || {}; if (!c || !c.telegram || e.reportSent) continue;
      const sp = (c.type !== 'post' ? Object.values(e.lives || {}).reduce((a, l) => a + (Number(l && l.spend) || 0), 0) : 0) + (c.type !== 'live' ? Number((e.post || {}).spend) || 0 : 0);
      if (sp > 0) add(c.id, 'warn', 'report-y', 'របាយការណ៍ម្សិលមិញមិនទាន់ផ្ញើ', `ចំណាយម្សិលមិញ ${money(sp)}`, 'report');
    }
  } catch (_) {}
  // "No spend today" is only believed when today's numbers are fresh: a sync from Meta in the last two hours. Without that
  // (login expired, Meta busy, auto sync off) a whole team would turn red and be alerted for nothing.
  let fresh = false; try { const ats = [await db.getUserSetting(owner, 'autoSyncLast', null), await db.getUserSetting(owner, 'lastSyncCheck', null)].map((x) => Date.parse((x && x.at) || 0) || 0); fresh = Date.now() - Math.max(...ats) < FRESH_MIN * 60e3; } catch (_) {}
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
      if (running && fresh && hour >= NO_BOOST_FROM && !((spend[c.id] || {}).post > 0)) add(c.id, 'bad', 'noboost', 'Plan ថា Boost ថ្ងៃនេះ ប៉ុន្តែគ្មានចំណាយ', `Plan ${money(tt.budget)} · ថ្ងៃនេះ ${money(0)}`, 'plan');
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
      onIt: s.onIt && s.onIt.day === today ? { by: s.onIt.by, at: s.onIt.at } : null, log: (s.log || []).slice(0, 12) };
  }).sort((a, b) => rank[a.level] - rank[b.level] || (!!a.onIt - !!b.onIt) || a.name.localeCompare(b.name));
  return { today, clients: out };
}

// "checked today" / "I'm on it" — by a PM, a media buyer or a leader. Returns the client's new marks.
async function mark(owner, clientId, what, by, on = true) {
  const today = sync.todayIn(), st = (await db.getUserSetting(owner, KEY, null)) || {}, s = st[clientId] || (st[clientId] = {});
  if (what === 'checked') { if (on) { s.checked = { day: today, by, at: new Date().toISOString() }; note(s, 'checked', by); } else delete s.checked; }
  if (what === 'onIt') { if (on) { s.onIt = { day: today, by, at: new Date().toISOString() }; note(s, 'onIt', by); } else delete s.onIt; }
  await db.setUserSetting(owner, KEY, st);
  return { checked: s.checked && s.checked.day === today ? s.checked : null, onIt: s.onIt && s.onIt.day === today ? s.onIt : null, log: (s.log || []).slice(0, 12) };
}

// ---- Telegram: red alert -> "I'm on it" -> leaders after 30 minutes -> resolved ----
const teamChats = async (owner) => {
  const out = []; const c = await db.getUserSetting(owner, 'tgChat', null); if (c && c.id) out.push({ chat: String(c.id), who: 'pm' });
  for (const b of (await buyers.list()).filter((x) => x.addedById === owner && x.chat)) out.push({ chat: String(b.chat), who: b.name, link: buyers.dashLink(b) + '#clients' });
  return out.filter((x, i, a) => a.findIndex((y) => y.chat === x.chat) === i);
};
function alertText(c, teamName) {
  const bad = c.reasons.filter((x) => x.level === 'bad' && PUSH.has(x.kind)), lines = [`🔴 ${c.name} ត្រូវការមើលឥឡូវ`, `${teamName} · ${hm(new Date().toISOString())}`, ''];
  for (const r of bad) lines.push(`• ${r.text}${r.detail ? ' — ' + r.detail : ''}`);
  const how = bad.map((r) => HOW[r.kind]).filter(Boolean)[0]; if (how) lines.push('', 'អ្វីគួរធ្វើ៖ ' + how);
  return lines.join('\n');
}
// One pass over every workspace. leaders(): chat ids of the leaders, for the 30-minute escalation.
let ticking = false;
async function tick(opts = {}) { if (ticking) return 0; ticking = true; try { return await tickOnce(opts); } finally { ticking = false; } }
async function tickOnce({ leaders = async () => [], log = () => {} } = {}) {
  if (!telegram.hasBot()) return 0;
  const hour = hourNow(); if (hour < QUIET[0] || hour >= QUIET[1]) return 0;
  let sent = 0;
  for (const u of await db.allUsers()) {
    try {
      const { today, clients } = await forOwner(u); if (!clients.length) continue;
      const st = (await db.getUserSetting(u.fb_id, KEY, null)) || {}; let dirty = false; const touched = new Set();
      const chats = await teamChats(u.fb_id);
      for (const c of clients) {
        const s = st[c.id] || (st[c.id] = {}), had = sent, push = c.reasons.filter((x) => x.level === 'bad' && PUSH.has(x.kind)), key = push.length ? today + ':' + push.map((x) => x.kind).sort().join(',') : '';
        if (s.alert && s.alert.key !== key && s.alert.key.startsWith(today) && !key) { // the problem is gone
          const wasPushed = s.alert.key.slice(today.length + 1).split(',').some((k) => PUSH.has(k)); // an alert about money only is dropped quietly
          if (wasPushed) for (const t of chats) telegram.send(`✅ ${c.name} — ដោះស្រាយហើយ`, t.chat).catch(() => {});
          if (wasPushed) note(s, 'solved');
          delete s.alert; dirty = true; touched.add(c.id); continue;
        }
        if (s.alert && !s.alert.key.startsWith(today)) { delete s.alert; dirty = true; touched.add(c.id); }
        if (!key) continue;
        if (!s.alert || s.alert.key !== key) {
          if (!chats.length) continue; // nobody in this team has Telegram: the page still shows it
          const text = alertText(c, u.name);
          for (const t of chats) { try { await telegram.sendButtons(text, t.chat, [[{ text: 'ខ្ញុំកំពុងមើល', data: `cs:on:${c.id}` }, { text: 'បើកភ្ញៀវ', url: t.link || `${cfg.baseUrl}/projectmanager#clients` }]]); sent++; } catch (e) { log('client alert failed:', c.name, e.message); } }
          if (sent === had) continue; // Telegram took none of them: try again on the next pass
          log(`alert: ${c.name} (${u.name}) — ${push.map((x) => x.kind).join(', ')} → ${sent - had} chat${sent - had === 1 ? '' : 's'}`);
          touched.add(c.id); s.alert = { key, at: new Date().toISOString(), escalated: false }; note(s, 'alert', '', push.map((x) => x.text).join(' · ')); dirty = true; continue;
        }
        if (!s.alert.escalated && !c.onIt && Date.now() - Date.parse(s.alert.at) > ESCALATE_MIN * 60e3) {
          const text = alertText(c, u.name) + `\n\n⏱ ${ESCALATE_MIN} នាទីហើយ មិនទាន់មានអ្នកមើល។`;
          for (const chat of await leaders()) { if (chats.some((t) => t.chat === chat)) continue; telegram.send(text, chat).catch(() => {}); }
          s.alert.escalated = true; note(s, 'escalated'); dirty = true; touched.add(c.id);
        }
      }
      // Sending took time: someone may have tapped "checked" / "I'm on it" meanwhile. Put only the alert and the new
      // history lines of the clients touched here onto the row as it is now.
      // Renewal reminder: once a day, from 9:00, one message to the PM with the boost plans that end today or within two days.
      try {
        const ending = clients.filter((c) => c.reasons.some((r) => r.kind === 'ending')), pc = (await db.getUserSetting(u.fb_id, 'tgChat', null) || {}).id;
        if (ending.length && pc && hour >= RENEW_FROM && ((await db.getUserSetting(u.fb_id, 'renewLast', null)) || {}).day !== today) {
          await db.setUserSetting(u.fb_id, 'renewLast', { day: today, n: ending.length }); // claim first: never twice a day
          const full = Object.fromEntries((await db.listClients(u.fb_id)).map((c) => [c.id, c]));
          const lines = ending.map((c) => { const t = plan.totals((full[c.id] || {}).plan), left = t.to ? daysBetween(today, t.to) : 0; return `• ${c.name} — ${left <= 0 ? 'ចប់ថ្ងៃនេះ' : `នៅ ${left} ថ្ងៃ`} (${t.to || ''}) · Plan ${money(t.total)}`; });
          await telegram.sendButtons([`🔔 Boost plan ជិតចប់ (${ending.length})`, '', ...lines.slice(0, 15), ending.length > 15 ? `… +${ending.length - 15} ទៀត` : '', '', 'សូមទាក់ទងភ្ញៀវសួរថាបន្តឬអត់ រួចធ្វើ Plan ថ្មី ឬបន្ថែម post។'].filter((x, i, a) => x !== '' || a[i - 1] !== '').join('\n'), String(pc), [[{ text: '👥 បើក Clients', url: `${cfg.baseUrl}/projectmanager#clients` }]]);
          sent++;
        }
      } catch (e) { log('renewal reminder failed for', u.name, e.message); }
      if (dirty) { const now = (await db.getUserSetting(u.fb_id, KEY, null)) || {};
        for (const id of touched) { const mine = st[id] || {}, cur = now[id] || (now[id] = {}); if (mine.alert) cur.alert = mine.alert; else delete cur.alert;
          const seen = new Set((cur.log || []).map((l) => l.at + l.kind)); cur.log = [...(mine.log || []).filter((l) => !seen.has(l.at + l.kind)), ...(cur.log || [])].sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 30); }
        const live = new Set((await db.listClients(u.fb_id)).map((c) => String(c.id))); for (const id of Object.keys(now)) if (!live.has(String(id))) delete now[id]; // clients that were deleted or merged away
        await db.setUserSetting(u.fb_id, KEY, now); }
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
