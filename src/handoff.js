// Handoff between the media buyer's day (morning) and the PM's day (afternoon–evening).
//   • notes — a short note each side leaves for the other, kept in the workspace's settings (no new table):
//       user setting `handoff` = { notes: [{ id, day, at, kind: 'mb' | 'pm', by, byId, text }] }   (last 14 days)
//   • 08:00 — morning brief to every media buyer on Telegram: yesterday, the PM's note, today's tasks
//   • 16:45 — "before you leave" to every media buyer: tasks still open + write a note for the PM
//   • 20:45 — evening digest to the PM and their media buyers: every client's day + reports + tasks
//   A note can be written in Boost Desk (Dashboard) or simply typed as a reply to the bot after 16:45 / 20:45.
const crypto = require('crypto');
const db = require('./db');
const sync = require('./sync');
const telegram = require('./telegram');
const buyers = require('./buyers');
const cfg = require('./config');

const TIMES = { brief: '08:00', remind: '16:45', digest: '20:45' };
const KEEP_DAYS = 14, ASK_MS = 4 * 3600e3, MAX = 800;
const money = (n) => '$' + (Math.round((Number(n) || 0) * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const hm = (iso) => new Date(iso).toLocaleTimeString('en-GB', { timeZone: cfg.tz, hour: '2-digit', minute: '2-digit' });
const niceDay = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
const first = (n) => String(n || '').trim().split(/\s+/)[0] || 'there';
const bullets = (text) => String(text).split(/\n+/).map((l) => l.trim()).filter(Boolean).map((l) => (/^[•\-–]/.test(l) ? l.replace(/^[\-–]\s*/, '• ') : '• ' + l)).join('\n');

// Each workspace can switch the three Telegram messages off (Dashboard → Handoff → ⚙).
const prefs = async (owner) => ({ on: true, ...((await db.getUserSetting(owner, 'handoffPrefs', null)) || {}) });
const savePrefs = async (owner, b) => { const p = { on: !!(b || {}).on }; await db.setUserSetting(owner, 'handoffPrefs', p); return p; };

const load = async (owner) => { const h = (await db.getUserSetting(owner, 'handoff', null)) || {}; return Array.isArray(h.notes) ? h.notes : []; };
async function addNote(owner, { kind, by, byId, text }) {
  const t = String(text || '').replace(/\r/g, '').trim().slice(0, MAX); if (!t) throw Object.assign(new Error('Write the note first.'), { status: 400 });
  const day = sync.todayIn(), cut = sync.addDays(day, -KEEP_DAYS);
  const note = { id: crypto.randomBytes(5).toString('hex'), day, at: new Date().toISOString(), kind: kind === 'mb' ? 'mb' : 'pm', by: String(by || '').slice(0, 60), byId: String(byId || ''), text: t };
  // one note per person per day: writing again replaces today's
  const notes = (await load(owner)).filter((n) => n.day >= cut && !(n.day === day && n.kind === note.kind && n.byId === note.byId));
  await db.setUserSetting(owner, 'handoff', { notes: [...notes, note].slice(-60) });
  return note;
}
// The newest note of each person on one side, written on or after `since`.
async function latest(owner, kind, since) {
  const seen = new Set(), out = [];
  for (const n of (await load(owner)).slice().reverse()) { if (n.kind !== kind || n.day < since || seen.has(n.byId)) continue; seen.add(n.byId); out.push(n); }
  return out;
}

const pmChat = async (owner) => { const c = await db.getUserSetting(owner, 'tgChat', null); return c && c.id ? String(c.id) : ''; };
const teamOf = async (owner) => (await buyers.list()).filter((b) => b.addedById === owner);
// today's tasks of one media buyer / of the PM himself, from the shared day list
const forBuyer = (tasks, id) => tasks.filter((t) => t.to && t.to.id === id);
const forPm = (tasks) => tasks.filter((t) => !t.to);
const count = (list) => ({ done: list.filter((t) => t.done).length, total: list.length });

// Waiting for a typed reply: the next plain message from this chat (within 4 hours) is saved as their note.
const asks = async () => (await db.getSetting('handoffAsks', {})) || {};
async function setAsk(chat, who) { const a = await asks(), now = Date.now(); for (const k of Object.keys(a)) if (a[k].until < now) delete a[k]; a[String(chat)] = { ...who, until: now + ASK_MS }; await db.setSetting('handoffAsks', a); }

// ---------- the three messages (text only — also used by the preview in Boost Desk) ----------
// The clients to look at first today, from the client status (red, amber, green).
function statusLines(status) {
  if (!status || !status.length) return [];
  const names = (l) => { const a = status.filter((c) => c.level === l); return a.length ? `${a.length} — ${a.slice(0, 5).map((c) => c.name + (c.reasons[0] ? ` (${c.reasons[0].text})` : '')).join(', ')}${a.length > 5 ? ` … +${a.length - 5}` : ''}` : ''; };
  const bad = names('bad'), warn = names('warn'), ok = status.filter((c) => c.level === 'ok').length, out = ['ស្ថានភាពភ្ញៀវព្រឹកនេះ (ភ្ញៀវកំពុង Boost)'];
  if (bad) out.push(`🔴 បន្ទាន់ ${bad}`); if (warn) out.push(`🟡 ត្រូវមើល ${warn}`); out.push(`🟢 ល្អ ${ok}`);
  // boost plans that end today or within two days: ask the client whether to go on (this was a separate 9:00 message)
  const ending = status.filter((c) => (c.reasons || []).some((r) => r.kind === 'ending') && c.plan);
  if (ending.length) out.push(`🔔 Plan ជិតចប់ ${ending.length} — ${ending.slice(0, 6).map((c) => `${c.name} (${c.plan.left <= 0 ? 'ចប់ថ្ងៃនេះ' : `នៅ ${c.plan.left} ថ្ងៃ`} · $${Number(c.plan.budget).toFixed(2)})`).join(', ')}${ending.length > 6 ? ` … +${ending.length - 6}` : ''} · សូមសួរភ្ញៀវថាបន្តឬអត់`);
  const idle = status.filter((c) => c.level === 'idle'), fol = idle.filter((c) => c.follow); // not boosting now: kept apart, never urgent
  if (idle.length) out.push(`⚪ មិនកំពុង Boost ${idle.length}${fol.length ? ` · តាមដាន ${fol.length} — ${fol.slice(0, 4).map((c) => `${c.name} (${c.follow.text})`).join(', ')}${fol.length > 4 ? ` … +${fol.length - 4}` : ''}` : ''}`);
  return out;
}
function briefText({ buyer, pmName, day, y, notes, tasks, status }) {
  const lines = [`🌅 អរុណសួស្ដី ${first(buyer.name)} — ${niceDay(day)}`, ''];
  lines.push(`ម្សិលមិញ · ${money(y.spend)}${y.orders ? ` · ${y.orders} orders${y.cpo != null ? ` · ${money(y.cpo)}/order` : ''}` : ''} · ភ្ញៀវមានចំណាយ ${y.withSpend}`);
  if (y.unsent) lines.push(`⚠ របាយការណ៍ម្សិលមិញ ${y.unsent} មិនទាន់ផ្ញើ`);
  const sl = statusLines(status); if (sl.length) lines.push('', ...sl);
  for (const n of notes) lines.push('', `📝 កំណត់ចំណាំពី ${n.by} (${n.day === day ? 'ថ្ងៃនេះ' : 'យប់មិញ'} ${hm(n.at)})`, bullets(n.text));
  if (!notes.length) lines.push('', `📝 យប់មិញគ្មានកំណត់ចំណាំពី ${pmName} ទេ។`);
  lines.push('', `ការងារលើភ្ញៀវថ្ងៃនេះ (${tasks.length})`);
  for (const t of tasks.slice(0, 6)) lines.push(`☐ ${t.client ? t.client + ' — ' : ''}${t.text}`);
  if (tasks.length > 6) lines.push(`… +${tasks.length - 6} ទៀត ក្នុង Dashboard`);
  if (!tasks.length) lines.push('ថ្ងៃនេះមិនទាន់មានការងារលើភ្ញៀវទេ — PM អាចបន្ថែមបានគ្រប់ពេល។');
  return lines.join('\n');
}
function remindText({ buyer, pmName, open, tonight }) {
  const lines = ['⏰ 15 នាទីមុនចេញពីការងារ', ''];
  if (open.length) { lines.push(`នៅសល់ការងារលើភ្ញៀវ ${open.length} មិនទាន់រួច៖`); for (const t of open.slice(0, 5)) lines.push(`☐ ${t.client ? t.client + ' — ' : ''}${t.text}`); if (open.length > 5) lines.push(`… +${open.length - 5} ទៀត`); }
  else lines.push('ការងារលើភ្ញៀវរួចរាល់ទាំងអស់ហើយ ✅');
  lines.push('', `✍ សូមសរសេរកំណត់ចំណាំជូន ${first(pmName)} សម្រាប់យប់នេះ — វាយនៅទីនេះ ហើយផ្ញើ។${tonight ? `\n(${tonight})` : ''}`);
  return lines.join('\n');
}
function digestText({ day, rep, team, pmName, forPmChat }) {
  const t = rep.totals, due = t.sent + t.unsent, lines = [`🌙 សរុបប្រចាំថ្ងៃ — ${niceDay(day)}`];
  lines.push(`សរុប ${money(t.spend)}${t.orders ? ` · ${t.orders} orders${t.cpo != null ? ` · ${money(t.cpo)}/order` : ''}` : ''}`);
  lines.push(`របាយការណ៍ ✓ ${t.sent} / ${due}${t.unsent ? ` · ${t.unsent} មិនទាន់ផ្ញើ` : ''}${t.nogroup ? ` · ${t.nogroup} គ្មាន group` : ''}`, '');
  const rows = rep.rows.filter((r) => r.spend > 0 || r.status !== 'nospend');
  for (const r of rows.slice(0, 25)) lines.push(`${r.status === 'sent' ? '✓' : r.status === 'unsent' ? '●' : r.status === 'nogroup' ? '⚠' : '·'} ${r.name} — ${r.spend > 0 ? money(r.spend) : 'គ្មានចំណាយ'}${r.orders ? ` · ${r.orders}${r.cpo != null ? ` · ${money(r.cpo)}` : ''}` : ''}${r.status === 'unsent' ? ' · មិនទាន់ផ្ញើ' : r.status === 'nogroup' ? ' · គ្មាន group' : ''}`);
  if (rows.length > 25) lines.push(`… +${rows.length - 25} ទៀត`);
  const skipped = rep.rows.length - rows.length; if (skipped) lines.push(`ភ្ញៀវគ្មានចំណាយ ${skipped}`);
  lines.push('', 'ក្រុមថ្ងៃនេះ');
  lines.push(team.map((m) => `${first(m.name)} ${m.done}/${m.total}${m.total && m.done === m.total ? ' ✅' : ''}`).join(' · ') || 'ថ្ងៃនេះគ្មានការងារលើភ្ញៀវ');
  if (forPmChat) lines.push('', '✍ សូមទុកកំណត់ចំណាំជូន Media Buyer សម្រាប់ព្រឹកស្អែក — វាយនៅទីនេះ ហើយផ្ញើ។');
  else lines.push('', `កំណត់ចំណាំសម្រាប់ស្អែក នឹងមកពី ${first(pmName)} ម៉ោង 8:00។`);
  return lines.join('\n');
}

// ---------- data for one workspace ----------
async function dayData(owner, D) {
  const day = sync.todayIn(), yest = sync.addDays(day, -1), users = await db.allUsers(), pm = users.find((u) => u.fb_id === owner) || { name: 'your PM' };
  const tasks = (((await D.dayTasks(day)).users || {})[owner] || { tasks: [] }).tasks, mbs = await teamOf(owner);
  return { day, yest, pm, tasks, mbs };
}
async function yesterday(owner, yest, D) {
  const r = await D.reportStatus(owner, yest), t = r.totals;
  return { spend: t.spend, orders: t.orders, cpo: t.cpo, unsent: t.unsent, withSpend: r.rows.filter((x) => x.spend > 0).length };
}
// Tonight's lives, as a hint for the note ("live 7pm LR").
const teamCounts = (pm, mbs, tasks) => [...mbs.map((b) => ({ name: b.name, ...count(forBuyer(tasks, b.id)) })), { name: pm.name, ...count(forPm(tasks)) }];

// ---------- the three runs (called by the scheduler) ----------
async function owners() { const set = new Map(); for (const b of await buyers.list()) if (b.addedById) set.set(b.addedById, true); return [...set.keys()]; }

async function morningBrief(D, log = () => {}) {
  if (!telegram.hasBot()) return 0; let n = 0;
  for (const owner of await owners()) {
    try {
      if (!(await prefs(owner)).on) continue;
      const { day, yest, pm, tasks, mbs } = await dayData(owner, D), linked = mbs.filter((b) => b.chat);
      let status = []; try { status = (await require('./status').forOwner({ fb_id: owner, name: pm.name })).clients; } catch (_) {}
      // the PM gets the client status too, when something needs a look
      const pc = await pmChat(owner); if (pc && status.some((c) => c.level === 'bad' || c.level === 'warn' || c.follow)) { try { await telegram.sendButtons([`🌅 ${niceDay(day)}`, '', ...statusLines(status)].join('\n'), pc, [[{ text: '👥 បើក Clients today', url: `${cfg.baseUrl}/projectmanager#dashboard` }]]); n++; } catch (e) { log('morning status failed for', pm.name, e.message); } }
      if (!linked.length) continue;
      const y = await yesterday(owner, yest, D), notes = await latest(owner, 'pm', yest);
      for (const b of linked) {
        try { await telegram.sendButtons(briefText({ buyer: b, pmName: pm.name, day, y, notes, status, tasks: forBuyer(tasks, b.id).filter((t) => !t.done) }), b.chat, [[{ text: '👥 ភ្ញៀវរបស់ខ្ញុំ', url: buyers.dashLink(b) + '#dashboard' }]]); n++; }
        catch (e) { log('morning brief failed for', b.name, e.message); }
      }
    } catch (e) { log('morning brief failed:', e.message); }
  }
  return n;
}
async function leaveReminder(D, log = () => {}) {
  if (!telegram.hasBot()) return 0; let n = 0;
  for (const owner of await owners()) {
    try {
      if (!(await prefs(owner)).on) continue;
      const { day, pm, tasks, mbs } = await dayData(owner, D);
      for (const b of mbs.filter((x) => x.chat)) {
        if ((await latest(owner, 'mb', day)).some((x) => x.byId === b.id)) continue; // already wrote today's note
        try {
          await telegram.sendButtons(remindText({ buyer: b, pmName: pm.name, open: forBuyer(tasks, b.id).filter((t) => !t.done) }), b.chat, [[{ text: '👥 ភ្ញៀវរបស់ខ្ញុំ', url: buyers.dashLink(b) + '#dashboard' }]]);
          await setAsk(b.chat, { owner, kind: 'mb', byId: b.id, by: b.name }); n++;
        } catch (e) { log('leave reminder failed for', b.name, e.message); }
      }
    } catch (e) { log('leave reminder failed:', e.message); }
  }
  return n;
}
async function eveningDigest(D, log = () => {}) {
  if (!telegram.hasBot()) return 0; let n = 0;
  for (const u of await db.allUsers()) {
    const owner = u.fb_id;
    try {
      if (!(await prefs(owner)).on) continue;
      const { day, pm, tasks, mbs } = await dayData(owner, D), chat = await pmChat(owner), linked = mbs.filter((b) => b.chat);
      if (!chat && !linked.length) continue;
      const rep = await D.reportStatus(owner, day); if (!rep.rows.length) continue;
      const team = teamCounts(pm, mbs, tasks);
      if (chat) { try { await telegram.send(digestText({ day, rep, team, pmName: pm.name, forPmChat: mbs.length > 0 }), chat); n++; if (mbs.length && !(await latest(owner, 'pm', day)).length) await setAsk(chat, { owner, kind: 'pm', byId: owner, by: pm.name }); } catch (e) { log('digest failed for', pm.name, e.message); } }
      for (const b of linked) { try { await telegram.send(digestText({ day, rep, team, pmName: pm.name, forPmChat: false }), b.chat); n++; } catch (e) { log('digest failed for', b.name, e.message); } }
    } catch (e) { log('digest failed:', e.message); }
  }
  return n;
}

// A plain message typed to the bot after a reminder: save it as that person's note.
async function onTelegram(fresh) {
  const texts = fresh.texts || []; if (!texts.length) return;
  const a = await asks(); let changed = false;
  for (const m of texts) {
    const ask = a[m.id]; if (!ask || ask.until < Date.now()) continue;
    try {
      const note = await addNote(ask.owner, { kind: ask.kind, by: ask.by, byId: ask.byId, text: m.text });
      delete a[m.id]; changed = true;
      if (ask.kind === 'mb') { telegram.send('✓ បានរក្សាទុកកំណត់ចំណាំ — PM ឃើញឥឡូវនេះក្នុង Boost Desk។', m.id).catch(() => {}); await pingPm(ask.owner, note); }
      else telegram.send('✓ បានរក្សាទុកកំណត់ចំណាំ — Media Buyer នឹងទទួលនៅម៉ោង 8:00 ព្រឹកស្អែក។', m.id).catch(() => {});
    } catch (e) { telegram.send('រក្សាទុកកំណត់ចំណាំមិនបាន — សូមសាកម្ដងទៀត ឬសរសេរក្នុង Boost Desk → Dashboard។', m.id).catch(() => {}); }
  }
  if (changed) await db.setSetting('handoffAsks', a);
}
// A media buyer's note reaches the PM's Telegram straight away (when the PM connected one).
async function pingPm(owner, note) {
  try { const chat = await pmChat(owner); if (chat && telegram.hasBot() && (await prefs(owner)).on) await telegram.send(`📝 កំណត់ចំណាំពី ${note.by} (${hm(note.at)})\n${bullets(note.text)}`, chat); } catch (_) { /* the note is saved either way */ }
}

// ---------- the Dashboard card ----------
async function card(user, D) {
  const owner = user.fb_id, me = user.buyer ? { kind: 'mb', id: user.buyer.id, name: user.buyer.name } : { kind: 'pm', id: owner, name: user.name };
  const { day, yest, pm, tasks, mbs } = await dayData(owner, D), other = me.kind === 'mb' ? 'pm' : 'mb';
  const mine = (await latest(owner, me.kind, day)).find((n) => n.byId === me.id) || null;
  const theirs = await latest(owner, other, me.kind === 'mb' ? yest : day); // MB reads last night's note; PM reads today's
  const older = me.kind === 'pm' && !theirs.length ? (await latest(owner, 'mb', yest)) : [];
  const team = me.kind === 'pm'
    ? mbs.map((b) => { const l = forBuyer(tasks, b.id); return { id: b.id, name: b.name, linked: !!b.chat, ...count(l), open: l.filter((t) => !t.done).slice(0, 4).map((t) => ({ text: t.text, client: t.client || '' })), doneList: l.filter((t) => t.done).slice(0, 4).map((t) => ({ text: t.text, client: t.client || '', at: t.doneAt ? hm(t.doneAt) : '' })) }; })
    : [];
  const pub = (n) => ({ id: n.id, by: n.by, text: n.text, at: n.at, time: hm(n.at), day: n.day, today: n.day === day });
  return { me, day, pmName: pm.name, hasTeam: mbs.length > 0, mine: mine ? pub(mine) : null, theirs: [...theirs, ...older].map(pub), team,
    telegram: { bot: telegram.hasBot(), on: (await prefs(owner)).on, mine: me.kind === 'mb' ? !!((mbs.find((b) => b.id === me.id) || {}).chat) : !!(await pmChat(owner)) }, times: TIMES, max: MAX };
}
// What the three Telegram messages would say right now (Dashboard → Handoff → "See the Telegram messages").
async function preview(user, D) {
  const owner = user.fb_id, { day, yest, pm, tasks, mbs } = await dayData(owner, D);
  const b = (user.buyer && mbs.find((x) => x.id === user.buyer.id)) || mbs[0] || { id: '', name: 'Media buyer' };
  const rep = await D.reportStatus(owner, day);
  let status = []; try { status = (await require('./status').forOwner({ fb_id: owner, name: pm.name })).clients; } catch (_) {}
  return { times: TIMES,
    brief: briefText({ buyer: b, pmName: pm.name, day, y: await yesterday(owner, yest, D), notes: await latest(owner, 'pm', yest), status, tasks: forBuyer(tasks, b.id).filter((t) => !t.done) }),
    remind: remindText({ buyer: b, pmName: pm.name, open: forBuyer(tasks, b.id).filter((t) => !t.done) }),
    digest: digestText({ day, rep, team: teamCounts(pm, mbs, tasks), pmName: pm.name, forPmChat: true }) };
}

module.exports = { TIMES, prefs, savePrefs, addNote, latest, card, preview, pingPm, morningBrief, leaveReminder, eveningDigest, onTelegram };
