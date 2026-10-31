// Post boost plan per client: the posts to boost ($ a day × days, start date), optional tax, and a
// message to send the client before boosting so they can pay first. After it starts, post spend
// since the first start date is tracked against the plan.
const cfg = require('./config');
const db = require('./db');
const sync = require('./sync');
const telegram = require('./telegram');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const money = (n) => '$' + round2(n).toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(round2(n)) ? 0 : 2, maximumFractionDigits: 2 });
const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MON_KM = ['មករា', 'កុម្ភៈ', 'មីនា', 'មេសា', 'ឧសភា', 'មិថុនា', 'កក្កដា', 'សីហា', 'កញ្ញា', 'តុលា', 'វិច្ឆិកា', 'ធ្នូ'];
const dayTxt = (d, km) => `${Number(d.slice(8, 10))} ${(km ? MON_KM : MON)[Number(d.slice(5, 7)) - 1]}`;
const addDays = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };

// Clean what the app sends. lines: [{ post, daily, days, start }]
function clean(b, cur = {}) {
  const p = { ...cur };
  if (Array.isArray(b.lines)) p.lines = b.lines.slice(0, 30).map((l) => ({
    post: String(l.post || '').trim().slice(0, 160),
    link: /^https:\/\/[^\s]{4,400}$/.test(String(l.link || '').trim()) ? String(l.link).trim() : '',
    img: /^[a-f0-9]{24}$/.test(String(l.img || '')) ? String(l.img) : '',
    // more posts boosted under the same budget: [{ link, img }]
    extra: (Array.isArray(l.extra) ? l.extra : []).slice(0, 6).map((x) => ({ link: /^https:\/\/[^\s]{4,400}$/.test(String((x || {}).link || '').trim()) ? String(x.link).trim() : '', img: /^[a-f0-9]{24}$/.test(String((x || {}).img || '')) ? String(x.img) : '' })).filter((x) => x.link || x.img),
    daily: Math.min(1e5, Math.max(0, round2(l.daily))),
    days: Math.min(365, Math.max(1, parseInt(l.days, 10) || 1)),
    start: isDay(l.start) ? l.start : '',
  })).filter((l) => l.daily > 0);
  if (b.tax != null) p.tax = !!b.tax;
  if (b.hidden != null) p.hidden = !!b.hidden;
  if (b.lang != null) p.lang = b.lang === 'km' ? 'km' : 'en';
  if (b.sentAt !== undefined) p.sentAt = b.sentAt || null;
  return p;
}

function totals(plan) {
  const lines = (plan && plan.lines) || [];
  const budget = round2(lines.reduce((t, l) => t + l.daily * l.days, 0));
  const rate = plan && plan.tax ? sync.TAX_RATE : 0, tax = round2(budget * rate / 100);
  const starts = lines.map((l) => l.start).filter(isDay).sort();
  const ends = lines.filter((l) => isDay(l.start)).map((l) => addDays(l.start, l.days - 1)).sort();
  return { budget, rate, tax, total: round2(budget + tax), from: starts[0] || '', to: ends[ends.length - 1] || '' };
}

// Post spend since the plan's first start date (nothing before it starts).
async function progress(owner, c, today = sync.todayIn()) {
  const t = totals(c.plan); if (!t.budget) return null;
  let spent = 0;
  if (t.from && t.from <= today) {
    const d = await sync.dashboard(owner, t.from, today < t.to || !t.to ? today : t.to);
    const x = (d.clients || []).find((y) => y.id === c.id); spent = round2(x ? x.postSpend : 0);
  }
  return { ...t, spent, pct: Math.round(spent / t.budget * 100), started: !!t.from && t.from <= today, done: !!t.to && t.to < today };
}

// One post's line of the plan: "1. name / $10/day × 7 days = $70 (from 1 Nov) / 🔗 link".
function lineText(l, i, km) {
  const name = l.post || (km ? `Post ទី${i + 1}` : `Post ${i + 1}`);
  const end = l.start ? addDays(l.start, Math.max(1, Number(l.days) || 1) - 1) : '';
  const when = l.start ? (km ? ` (${dayTxt(l.start, true)} – ${dayTxt(end, true)})` : ` (${dayTxt(l.start)} – ${dayTxt(end)})`) : '';
  const link = [l.link, ...(l.extra || []).map((x) => x.link)].filter(Boolean).map((u) => `\n    🔗 ${u}`).join('');
  return km ? `${i + 1}. ${name}\n    ${money(l.daily)} / ថ្ងៃ × ${l.days} ថ្ងៃ = ${money(l.daily * l.days)}${when}${link}`
    : `${i + 1}. ${name}\n    ${money(l.daily)}/day × ${l.days} day${l.days === 1 ? '' : 's'} = ${money(l.daily * l.days)}${when}${link}`;
}
function message(c, plan, lang = 'en') {
  const km = lang === 'km', t = totals(plan);
  const lines = plan.lines.map((l, i) => lineText(l, i, km));
  return km ? [
    `🎯 ផែនការ Boost Post — ${c.name}`, '', ...lines, '',
    t.rate ? `ថវិកាផ្សាយ: ${money(t.budget)}` : '', t.rate ? `ពន្ធ ${t.rate}%: ${money(t.tax)}` : '',
    `💰 សរុបត្រូវបង់: ${money(t.total)}`, '', 'សូមបង់ប្រាក់មុន ដើម្បីចាប់ផ្តើម Boost 🙏',
  ].filter((x, i, a) => x !== '' || (a[i - 1] !== '' && i)).join('\n') : [
    `🎯 Boost plan — ${c.name}`, '', ...lines, '',
    t.rate ? `Ad budget: ${money(t.budget)}` : '', t.rate ? `Tax ${t.rate}%: ${money(t.tax)}` : '',
    `💰 Total to pay: ${money(t.total)}`, '', 'Please pay first so we can start boosting 🙏',
  ].filter((x, i, a) => x !== '' || (a[i - 1] !== '' && i)).join('\n');
}

// to: 'client' (their group) or 'team' (the team group).
// topic: a destination "<group>:<thread>" inside the client's group (one of its topics) — optional.
async function send(owner, c, { to = 'client', lang, topic = '' } = {}) {
  if (!totals(c.plan).budget) throw new Error('Add at least one post with a daily budget first.');
  let chat = to === 'team' ? cfg.telegramChatId : c.telegram;
  if (to === 'client' && topic) {
    const group = String(c.telegram || '').split(':')[0];
    if (!/^-?\d+:\d+$/.test(topic) || topic.split(':')[0] !== group) throw new Error('That topic is not in this client\'s group.');
    chat = topic;
  }
  if (!chat) throw new Error(to === 'team' ? 'No team group is set up (TELEGRAM_CHAT_ID in Railway).' : 'This client has no Telegram group yet — pick one in Client settings.');
  const lg = lang || c.plan.lang || 'en', km = lg === 'km', text = message(c, c.plan, lg);
  const imgs = [];
  // Per line: its picture plus the pictures of its extra links (all boosted under that line's budget).
  for (const [i, l] of c.plan.lines.entries()) {
    const pics = [];
    for (const id of [l.img, ...(l.extra || []).map((x) => x.img)].filter(Boolean)) { const im = await db.getPostImage(owner, id); if (im) pics.push(im); }
    if (pics.length) imgs.push({ i, pics });
  }
  if (!imgs.length) await telegram.send(text, chat);
  else {
    // Every line with pictures goes as its own photo (or album) with its line under it, then the totals.
    const head = km ? `🎯 ផែនការ Boost Post — ${c.name}` : `🎯 Boost plan — ${c.name}`;
    const withPic = new Set(imgs.map((x) => x.i));
    for (const [n, im] of imgs.entries()) await telegram.sendAlbum(im.pics, (n === 0 ? head + '\n\n' : '') + lineText(c.plan.lines[im.i], im.i, km), chat);
    const rest = c.plan.lines.map((l, i) => (withPic.has(i) ? null : lineText(l, i, km))).filter(Boolean);
    const t = totals(c.plan), tail = km
      ? [...rest, rest.length ? '' : null, t.rate ? `ថវិកាផ្សាយ: ${money(t.budget)}` : null, t.rate ? `ពន្ធ ${t.rate}%: ${money(t.tax)}` : null, `💰 សរុបត្រូវបង់: ${money(t.total)}`, '', 'សូមបង់ប្រាក់មុន ដើម្បីចាប់ផ្តើម Boost 🙏']
      : [...rest, rest.length ? '' : null, t.rate ? `Ad budget: ${money(t.budget)}` : null, t.rate ? `Tax ${t.rate}%: ${money(t.tax)}` : null, `💰 Total to pay: ${money(t.total)}`, '', 'Please pay first so we can start boosting 🙏'];
    await telegram.send(tail.filter((x) => x !== null).join('\n'), chat);
  }
  if (to === 'client') await db.updateClient(owner, c.id, { plan: { ...c.plan, sentAt: new Date().toISOString() } });
  return { ok: true };
}

module.exports = { clean, totals, progress, message, send };
