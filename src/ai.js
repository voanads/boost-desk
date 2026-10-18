// AI analyst for the Insights page (Claude API). It gets the period's numbers that Boost Desk already worked
// out — per Page spend / orders / cost per order, live vs post, the rule-based findings, and the best and worst
// boosted lives with their setup (budget, audience, start time, length), post text and thumbnail — and explains
// which Pages sell and why: the Page, the video/post, or the boost. Only aggregates, names, post text and
// thumbnails are sent; never customer data (Boost Desk has none).
const crypto = require('crypto');
const db = require('./db');
const sync = require('./sync');
const { encrypt, decrypt } = require('./crypto');

const MODEL = () => process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
const DAILY_LIMIT = Number(process.env.AI_DAILY_LIMIT) || 40; // analyses + questions per person per day

async function keyConfig() {
  const c = (await db.getSetting('anthropicApi', null)) || {};
  let key = ''; try { key = c.keyEnc ? decrypt(c.keyEnc) : ''; } catch (_) { key = ''; }
  key = key || process.env.ANTHROPIC_API_KEY || '';
  return { key, hint: c.keyHint || (process.env.ANTHROPIC_API_KEY ? '…' + process.env.ANTHROPIC_API_KEY.slice(-4) : ''), by: c.by || '', at: c.at || '' };
}
async function publicConfig() { const c = await keyConfig(); return { hasKey: !!c.key, keyHint: c.hint, savedBy: c.by, savedAt: c.at, model: MODEL(), dailyLimit: DAILY_LIMIT }; }
async function saveKey(key, by) {
  const cur = (await db.getSetting('anthropicApi', null)) || {};
  const next = { ...cur, by, at: new Date().toISOString() };
  if (key === null) { delete next.keyEnc; delete next.keyHint; }
  else if (key && String(key).trim()) { const k = String(key).trim(); if (!/^sk-ant-/.test(k)) throw Object.assign(new Error('That does not look like an Anthropic API key (it starts with sk-ant-).'), { status: 400 }); next.keyEnc = encrypt(k); next.keyHint = '…' + k.slice(-4); }
  await db.setSetting('anthropicApi', next);
  return publicConfig();
}

// Best and worst boosted lives of the period, with how they were boosted (from the saved setups only — no Meta calls).
async function livesContext(owner, from, to) {
  let lives = [];
  try { lives = await require('./lives').listLives(owner, from, to); } catch (_) { return { lives: [], thumbs: [] }; }
  lives = lives.filter((l) => l.spend >= 2);
  const score = (l) => (l.messages ? l.spend / l.messages : l.comments ? l.spend / l.comments * 3 : Infinity);
  const ranked = [...lives].sort((a, b) => score(a) - score(b));
  const pick = [...ranked.slice(0, 6), ...ranked.slice(-4).reverse()].filter((l, i, a) => a.indexOf(l) === i);
  const ids = pick.flatMap((l) => l.campaigns.map((c) => c.id)).filter(Boolean);
  const setups = {}; for (const r of await db.getSetups(owner, ids)) setups[r.campaign_id] = r.data;
  const out = [], thumbs = [];
  pick.forEach((l, i) => {
    const s = l.campaigns.map((c) => setups[c.id]).find(Boolean) || null;
    const t = s && s.targeting ? s.targeting : {};
    out.push({
      ref: 'L' + (i + 1), rank: i < 6 ? 'best' : 'worst', page: l.page, client: l.client, day: l.day, start: l.time,
      spend: l.spend, comments: l.comments, messages: l.messages, costPerMessage: l.messages ? Math.round(l.spend / l.messages * 100) / 100 : null,
      boosts: l.campaigns.length,
      setup: s ? { goal: s.goal, dailyBudget: s.dailyBudget, lifetimeBudget: s.lifetimeBudget, minutes: s.minutes, gender: t.gender, age: [t.ageMin, t.ageMax].filter(Boolean).join('–'), places: (t.places || []).slice(0, 4), interests: (t.interests || []).slice(0, 6), advantage: t.advantage } : null,
      postText: s && s.text ? s.text.slice(0, 160) : '',
    });
    if (s && s.thumb && thumbs.length < 6) thumbs.push({ ref: 'L' + (i + 1), url: s.thumb });
  });
  return { lives: out, thumbs, totalLives: lives.length };
}

async function fetchImage(url) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 6000);
  try {
    const r = await fetch(url, { signal: ctl.signal }); if (!r.ok) return null;
    const type = (r.headers.get('content-type') || '').split(';')[0];
    if (!/^image\/(jpeg|png|gif|webp)$/.test(type)) return null;
    const buf = Buffer.from(await r.arrayBuffer()); if (buf.length > 900000) return null;
    return { type, data: buf.toString('base64') };
  } catch (_) { return null; } finally { clearTimeout(t); }
}

const SYSTEM = `You are the marketing analyst inside Boost Desk, the tool Ads Box (a Facebook ads agency in Cambodia) uses to track boost spend for its clients. Clients sell mostly through Facebook live videos and boosted posts; customers order in comments and Messenger. Orders come from adsbox.biz and are matched to Pages by Page ID and date.

Your job: explain WHICH Pages sell best for their boost money and WHY — separating three causes:
1. The PAGE (its audience/brand): a Page that sells well with or without boosts, or stays cheap whatever the boost.
2. The VIDEO / POST (content): engagement signals — comments, messages per dollar, watch behaviour, post text, thumbnails.
3. The BOOST (settings): budget size, live vs post, start time, run length, audience (age, gender, places, interests), objective.

Rules:
- Use only the numbers given. Quote them (money with $ and 2 decimals). Never invent data.
- Cost per order = spend / orders. Lower is better. Compare against the median Page.
- Say how sure you are. With fewer than 5 days with orders, or a handful of lives, say the evidence is thin.
- Correlation is not proof: phrase as "days with X sold cheaper", and suggest a simple test to confirm.
- Days marked as estimates (before Boost Desk kept daily order counts) can be too high — warn when they dominate.
- When thumbnails are attached, comment on what the best-selling lives show (product close-ups, presenter, text on screen, light) versus the worst — briefly and concretely.
- End with 3–5 concrete actions for next week (which Page to spend more/less on, when to go live, budget per live, what to change in the video), each tied to a number.
- Be concise and scannable: short headings, bullets, no long intros. Max ~350 words for a full analysis, ~150 for a follow-up question.`;

function context(ins, livesCtx, lang) {
  const pages = ins.pages.slice(0, 25).map((p) => ({ page: p.name, client: p.client, spend: p.spend, orders: p.orders, costPerOrder: p.cpo, livePct: p.spend ? Math.round(p.live / p.spend * 100) : 0, boostDays: p.boostDays, orderDays: p.orderDays, ordersChangeVsPrevPct: p.trend, costChangeVsPrevPct: p.cpoTrend, label: p.label, findings: p.findings.map((f) => f.text) }));
  return {
    language: lang === 'km' ? 'Write the answer in Khmer (ខ្មែរ). Keep Page names, numbers and $ as they are.' : 'Write the answer in simple English.',
    period: `${ins.from} to ${ins.to} (compared with ${ins.prevFrom} to ${ins.prevTo})`,
    totals: ins.totals, medianCostPerOrder: ins.medianCpo, dataQuality: { daysKeptExactly: ins.quality.kept, daysEstimated: ins.quality.estimate },
    labelsMeaning: { star: 'many orders and cheap', grow: 'cheap but small — could take more budget', fix: 'expensive with a big budget', ok: 'average', 'no-orders': 'boosted but no orders matched', organic: 'orders without boosts' },
    findingsAcrossAllPages: ins.overall.map((f) => f.text),
    pages,
    boostedLives: livesCtx ? { total: livesCtx.totalLives, bestAndWorst: livesCtx.lives } : null,
  };
}

async function callClaude(key, system, messages) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 90000);
  let res, body;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', signal: ctl.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL(), max_tokens: 1400, system, messages }) });
    body = await res.json().catch(() => ({}));
  } catch (e) { throw new Error(e.name === 'AbortError' ? 'The AI took too long to answer. Try again.' : 'Could not reach the AI: ' + e.message); }
  finally { clearTimeout(t); }
  if (res.status === 401) throw Object.assign(new Error('The Anthropic API key was refused — check it in Admin → Settings.'), { status: 400 });
  if (res.status === 429) throw Object.assign(new Error('The AI is busy or the account hit its limit. Try again in a minute.'), { status: 429 });
  if (!res.ok) throw new Error('AI error: ' + ((body.error && body.error.message) || 'HTTP ' + res.status));
  return { text: (body.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim(), usage: body.usage || {} };
}

const cache = new Map();
async function ask(owner, { from, to, question = '', history = [], lang = 'en' }) {
  const cfg = await keyConfig();
  if (!cfg.key) throw Object.assign(new Error('AI is not set up yet. The app owner adds an Anthropic API key in Admin → Settings.'), { status: 400, notSetUp: true });
  const ck = crypto.createHash('sha1').update(JSON.stringify([owner, from, to, lang, question, history.slice(-6)])).digest('hex');
  const hit = cache.get(ck); if (hit && Date.now() - hit.at < 3600e3) return { ...hit.out, cached: true };
  // daily limit per person
  const today = sync.todayIn(), useKey = `aiUse:${today}`, used = Number(await db.getUserSetting(owner, useKey, 0)) || 0;
  if (used >= DAILY_LIMIT) throw Object.assign(new Error(`Daily AI limit reached (${DAILY_LIMIT}). It resets tomorrow.`), { status: 429 });

  const ins = await require('./insights').analyze(owner, from, to);
  if (!ins.pages.length) throw Object.assign(new Error('No boosts or orders in this period to analyse.'), { status: 400 });
  const livesCtx = await livesContext(owner, from, to);
  const data = context(ins, livesCtx, lang);
  const first = [{ type: 'text', text: 'Boost Desk data (JSON):\n' + JSON.stringify(data) }];
  if (!question) for (const th of livesCtx.thumbs) { const img = await fetchImage(th.url); if (img) first.push({ type: 'text', text: `Thumbnail of ${th.ref}:` }, { type: 'image', source: { type: 'base64', media_type: img.type, data: img.data } }); }
  first.push({ type: 'text', text: question ? `Question: ${String(question).slice(0, 500)}` : 'Give the full analysis for this period.' });
  const msgs = [];
  const hist = (Array.isArray(history) ? history : []).slice(-6).filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string');
  if (hist.length) {
    msgs.push({ role: 'user', content: [{ type: 'text', text: 'Boost Desk data (JSON):\n' + JSON.stringify(data) }, { type: 'text', text: 'Give the full analysis for this period.' }] });
    for (const m of hist) msgs.push({ role: m.role, content: m.text.slice(0, 4000) });
    if (msgs[msgs.length - 1].role === 'user') msgs.pop();
    if (msgs[msgs.length - 1].role !== 'assistant') msgs.push({ role: 'assistant', content: '(analysis)' });
    msgs.push({ role: 'user', content: `Question: ${String(question).slice(0, 500)}${lang === 'km' ? ' (answer in Khmer)' : ''}` });
  } else msgs.push({ role: 'user', content: first });
  const r = await callClaude(cfg.key, SYSTEM, msgs);
  await db.setUserSetting(owner, useKey, used + 1).catch(() => {});
  const out = { text: r.text, model: MODEL(), at: new Date().toISOString(), lives: livesCtx.totalLives, pictures: !question ? livesCtx.thumbs.length : 0, left: DAILY_LIMIT - used - 1 };
  cache.set(ck, { at: Date.now(), out }); if (cache.size > 100) cache.delete(cache.keys().next().value);
  return out;
}

module.exports = { ask, publicConfig, saveKey };
