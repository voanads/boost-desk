// Boost plan per client: a monthly budget + lives a day, the pace against it, and a message
// that can be sent to the client's Telegram group (by hand or every Monday 9:00).
const cfg = require('./config');
const db = require('./db');
const sync = require('./sync');
const telegram = require('./telegram');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const money = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('en-US');
const daysIn = (day) => { const [y, m] = day.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_KM = ['មករា', 'កុម្ភៈ', 'មីនា', 'មេសា', 'ឧសភា', 'មិថុនា', 'កក្កដា', 'សីហា', 'កញ្ញា', 'តុលា', 'វិច្ឆិកា', 'ធ្នូ'];

// Clean what the app sends: budget ($ a month), lives a day, auto-send, language.
function clean(b, cur = {}) {
  const p = { ...cur };
  if (b.budget != null) p.budget = Math.min(1e7, Math.max(0, round2(b.budget)));
  if (b.lives != null) p.lives = Math.min(20, Math.max(0, parseInt(b.lives, 10) || 0));
  if (b.autoSend != null) p.autoSend = !!b.autoSend;
  if (b.lang != null) p.lang = b.lang === 'km' ? 'km' : 'en';
  return p;
}

// Pace for this month: spend vs budget, against how much of the month has gone.
function pace(plan, spend, lives, today) {
  const b = Number(plan && plan.budget) || 0; if (!b) return null;
  const day = Number(today.slice(8, 10)), dim = daysIn(today), rest = Math.max(1, dim - day + 1);
  const exp = b * day / dim, left = Math.max(0, b - spend);
  const status = spend > b ? 'over' : spend > exp * 1.15 ? 'ahead' : spend < exp * 0.85 ? 'behind' : 'on';
  return { budget: b, lives: Number(plan.lives) || 0, spend: round2(spend), livesDone: lives, livesPlan: (Number(plan.lives) || 0) * day,
    pct: Math.round(spend / b * 100), timePct: Math.round(day / dim * 100), expected: round2(exp), left: round2(left), perDay: round2(left / rest), day, dim, status };
}

// This month's spend + lives per client — the same numbers the Clients page shows.
async function monthOf(owner, today = sync.todayIn()) {
  const d = await sync.dashboard(owner, today.slice(0, 8) + '01', today);
  return Object.fromEntries((d.clients || []).map((c) => [c.id, { spend: Number(c.spend) || 0, lives: c.lives || 0 }]));
}

function message(c, p, lang, today) {
  const mi = Number(today.slice(5, 7)) - 1;
  if (lang === 'km') return [
    `🎯 ផែនការ Boost ខែ${MONTHS_KM[mi]} — ${c.name}`,
    `💰 ថវិកា: ${money(p.budget)} / ខែ`,
    p.lives ? `📺 Live: ${p.lives} ដង / ថ្ងៃ (ខែនេះបាន ${p.livesDone} ដង)` : '',
    `📊 បានចំណាយ: ${money(p.spend)} (${p.pct}%)`,
    `💵 នៅសល់: ${money(p.left)} (${money(p.perDay)} / ថ្ងៃ)`,
  ].filter(Boolean).join('\n');
  return [
    `🎯 Boost plan · ${MONTHS[mi]} — ${c.name}`,
    `💰 Budget: ${money(p.budget)} / month`,
    p.lives ? `📺 Lives: ${p.lives} a day (${p.livesDone} done this month)` : '',
    `📊 Spent: ${money(p.spend)} (${p.pct}%)`,
    `💵 Left: ${money(p.left)} (${money(p.perDay)} a day)`,
  ].filter(Boolean).join('\n');
}

async function forClient(owner, c, today = sync.todayIn()) {
  const m = (await monthOf(owner, today))[c.id] || { spend: 0, lives: 0 };
  return pace(c.plan, m.spend, m.lives, today);
}

// Send one client's plan. to: 'client' (their group) or 'team' (the team group).
async function send(owner, c, { to = 'client', lang } = {}) {
  const today = sync.todayIn(), p = await forClient(owner, c, today);
  if (!p) throw new Error('Set a monthly budget for this client first.');
  const chat = to === 'team' ? cfg.telegramChatId : c.telegram;
  if (!chat) throw new Error(to === 'team' ? 'No team group is set up (TELEGRAM_CHAT_ID in Railway).' : 'This client has no Telegram group yet — pick one in Client settings.');
  await telegram.send(message(c, p, lang || (c.plan && c.plan.lang) || 'en', today), chat);
  return { ok: true };
}

// Monday 9:00: send every plan that has auto-send on and a group.
async function weekly(log = () => {}) {
  if (!telegram.hasBot()) return 0;
  let n = 0; const seen = new Set();
  for (const u of await db.activeUsers()) {
    if (seen.has(u.fb_id)) continue; seen.add(u.fb_id);
    for (const c of await db.listClients(u.fb_id)) {
      if (c.archived || !c.telegram || !c.plan || !c.plan.autoSend || !(Number(c.plan.budget) > 0)) continue;
      try { await send(u.fb_id, c, { to: 'client' }); n++; } catch (e) { log('boost plan to', c.name, 'failed:', e.message); }
    }
  }
  return n;
}

module.exports = { clean, pace, monthOf, message, forClient, send, weekly };
