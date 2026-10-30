// AI advice for one client (Claude API). It gets the numbers Boost Desk already has for the client and period —
// spend per day (lives and posts), each live, post results, spend per Page, orders per Page and day from
// adsbox.biz, the period before, and the boost setups saved from the Lives page — and explains what is working,
// what is wasting money and what to do next. Only totals, campaign names and post text are sent; Boost Desk has
// no customer data to send.
const crypto = require('crypto');
const db = require('./db');
const sync = require('./sync');
const { encrypt, decrypt } = require('./crypto');

// Works with a Claude key (sk-ant-…) or a Google Gemini key (AIza…); the key's shape picks the provider.
// Claude keys start with sk-ant-; anything else is treated as a Google Gemini key (AI Studio keys have changed shape over time).
const providerOf = (key) => (/^sk-ant-/.test(key || '') ? 'claude' : 'gemini');
const MODEL_FOR = (p) => (p === 'gemini' ? process.env.GEMINI_MODEL || 'gemini-2.5-flash' : process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5');
const DAILY_LIMIT = Number(process.env.AI_DAILY_LIMIT) || 60; // advice requests per person per day
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

// ---------- API key (Admin → Settings; saved encrypted) ----------
async function keyConfig() {
  const c = (await db.getSetting('anthropicApi', null)) || {};
  let key = ''; try { key = c.keyEnc ? decrypt(c.keyEnc) : ''; } catch (_) { key = ''; }
  const env = process.env.ANTHROPIC_API_KEY || process.env.GEMINI_API_KEY || '';
  key = key || env;
  return { key, provider: providerOf(key), hint: c.keyHint || (env ? '…' + env.slice(-4) : ''), by: c.by || '', at: c.at || '' };
}
async function publicConfig() { const c = await keyConfig(); return { hasKey: !!c.key, provider: c.provider, keyHint: c.hint, savedBy: c.by, savedAt: c.at, model: MODEL_FOR(c.provider), dailyLimit: DAILY_LIMIT }; }
async function saveKey(key, by) {
  const cur = (await db.getSetting('anthropicApi', null)) || {};
  const next = { ...cur, by, at: new Date().toISOString() };
  if (key === null) { delete next.keyEnc; delete next.keyHint; }
  else if (key && String(key).trim()) {
    const k = String(key).trim().replace(/^["'`]+|["'`]+$/g, '').replace(/^(Bearer|key=|api_key=)\s*/i, '').replace(/\s+/g, '');
    if (k.length < 20 || /[^\w.\-]/.test(k)) throw Object.assign(new Error('That does not look like an API key. Copy the whole key from Google AI Studio (Gemini) or console.anthropic.com (Claude).'), { status: 400 });
    next.keyEnc = encrypt(k); next.keyHint = '…' + k.slice(-4);
  }
  await db.setSetting('anthropicApi', next);
  return publicConfig();
}

// ---------- the client's numbers ----------
async function clientData(owner, clientId, from, to) {
  const c = (await db.listClients(owner)).find((x) => x.id === Number(clientId));
  if (!c) throw Object.assign(new Error('Client not found.'), { status: 404 });
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 864e5) + 1;
  const pFrom = sync.addDays(from, -days), pTo = sync.addDays(from, -1);
  const orders = require('./orders');

  // spend per day from the saved entries
  const entries = (await db.monthEntries(owner, from, to)).filter((r) => r.client_id === c.id).sort((a, b) => a.day.localeCompare(b.day));
  const daily = [], lives = [];
  let liveT = 0, postT = 0, res = 0, resSpend = 0, resType = '';
  for (const r of entries) {
    const e = r.data || {};
    let dl = 0; const dLives = [];
    for (const [k, l] of Object.entries(e.lives || {})) {
      const v = Number(l && l.spend) || 0; if (!(v > 0)) continue;
      dl += v; dLives.push(k);
      lives.push({ day: r.day, live: k, start: l.time || '', spend: r2(v), campaigns: l.campaigns || (l.ids || []).length || 1 });
    }
    const p = e.post || {}, dp = Number(p.spend) || 0;
    if (dp > 0 && Number(p.results) > 0) { res += Number(p.results); resSpend += dp; resType = resType || p.resultType || ''; }
    liveT += dl; postT += dp;
    if (dl || dp) daily.push({ day: r.day, live: r2(dl), lives: dLives.length, post: r2(dp), postResults: Number(p.results) || 0, postResultType: p.resultType || '' });
  }

  // spend per Page with its campaigns
  const ps = ((await sync.pageSpend(owner, from, to)) || {})[c.id] || [];
  const pages = ps.map((p) => ({
    page: p.page || p.guess || ('Page ' + p.pageId), pageId: p.pageId, spend: r2(p.spend), live: r2(p.live), post: r2(p.post),
    campaigns: (p.list || []).slice(0, 12).map((x) => ({ id: x.id, name: x.name, kind: x.live ? 'live' : 'post', spend: r2(x.spend), days: x.days, runMinutes: typeof x.run === 'number' ? x.run : null })),
  }));

  // orders from adsbox.biz per Page and day (matched to this client's Pages)
  let ordersBlock = null;
  try {
    const oc = (await orders.byClient(owner, from, to)).clients[c.id];
    const prevOc = (await orders.byClient(owner, pFrom, pTo)).clients[c.id];
    const keys = new Set(Object.keys((oc && oc.pages) || {}));
    for (const p of ps) { if (p.pageId) keys.add(String(p.pageId)); keys.add('name:' + norm(p.page)); }
    const rows = (await db.pool.query('SELECT day::text AS day, page_id, max(page_name) AS page_name, sum(orders)::int AS orders FROM page_orders WHERE day BETWEEN $1 AND $2 GROUP BY day, page_id', [from, to])).rows
      .filter((r) => keys.has(String(r.page_id)) || keys.has('name:' + norm(r.page_name)));
    const perDay = {}; for (const r of rows) perDay[r.day] = (perDay[r.day] || 0) + r.orders;
    const perPage = {}; for (const r of rows) { const k = r.page_name || r.page_id; perPage[k] = (perPage[k] || 0) + r.orders; }
    const quality = await orders.periodQuality(from, to);
    ordersBlock = { total: oc ? oc.orders : 0, previousPeriod: prevOc ? prevOc.orders : 0, perDay, perPage, daysEstimated: quality.estimate, daysExact: quality.kept };
  } catch (_) { ordersBlock = null; }

  // the period before, for comparison
  let prev = null;
  try { const d = await sync.dashboard(owner, pFrom, pTo); const pc = d.clients.find((x) => x.id === c.id); if (pc) prev = { spend: r2(pc.spend), live: r2(pc.liveSpend), post: r2(pc.postSpend), lives: pc.lives, days: pc.days }; } catch (_) {}

  // how the boosts were set up (saved when the Lives page was opened)
  const ids = pages.flatMap((p) => p.campaigns.map((x) => x.id)).filter(Boolean).slice(0, 40);
  const setups = [];
  for (const row of await db.getSetups(owner, ids)) {
    const s = row.data || {}, t = s.targeting || {};
    setups.push({ campaign: row.campaign_id, goal: s.goal, dailyBudget: s.dailyBudget, lifetimeBudget: s.lifetimeBudget, minutes: s.minutes, gender: t.gender, age: [t.ageMin, t.ageMax].filter(Boolean).join('–'), places: (t.places || []).slice(0, 4), interests: (t.interests || []).slice(0, 6), postText: s.text ? String(s.text).slice(0, 140) : '' });
    if (setups.length >= 15) break;
  }

  const spend = r2(liveT + postT), ord = ordersBlock ? ordersBlock.total : 0;
  // Same rule as the rest of the app: cost per order uses the spend on Pages that got orders.
  const scaled = sync.scalePages(pages.map((p) => ({ ...p })), spend);
  const oSpend = ordersBlock ? sync.orderSpend(scaled.map((p) => ({ spend: p.spend, orders: (ordersBlock.perPage[p.page] || 0) })), ord, spend) : spend;
  return {
    client: { name: c.name, type: c.type, pages: c.pages || [] },
    period: { from, to, days, previous: `${pFrom} to ${pTo}` },
    totals: { spend, live: r2(liveT), post: r2(postT), lives: lives.length, daysWithSpend: daily.length, orders: ord, costPerOrder: ord ? r2(oSpend / ord) : null, spendOnPagesWithoutOrders: ord ? r2(spend - oSpend) : null, postResults: res, postResultType: resType, postCostPerResult: res ? r2(resSpend / res) : null },
    previous: prev ? { ...prev, orders: ordersBlock ? ordersBlock.previousPeriod : null, costPerOrder: prev && ordersBlock && ordersBlock.previousPeriod ? r2(prev.spend / ordersBlock.previousPeriod) : null } : null,
    daily, lives: lives.slice(-40), pages, orders: ordersBlock, boostSetups: setups,
  };
}

// ---------- Claude ----------
const SYSTEM = `You are the ads advisor inside Boost Desk, the tool Ads Box (a Facebook ads agency in Cambodia) uses to run and track boosts for its clients. Clients sell through Facebook live videos and boosted posts; customers order in comments and Messenger. Orders come from adsbox.biz, matched to the client's Pages by Page and day.

You get ONE client's numbers for a period. Give the media buyer practical advice for this client.

Write exactly these short sections:
1. Summary — one or two lines: spend, orders, cost per order, and the change vs the period before.
2. What's working — the best days, lives, Pages or posts, with numbers.
3. What's wasting money — spend with few or no orders, expensive lives, Pages or campaigns that cost much more per order.
4. Do next — 3 to 5 concrete actions for the coming days (which Page or live to spend more or less on, budget per live, best start time, live vs post, what to test in the video or audience). Tie each action to a number.

Rules:
- Use only the numbers given; never invent data. Money as $ with 2 decimals.
- Cost per order = spend ÷ orders; lower is better. If there are no orders data, judge by post results (messages) and spend per live instead, and say orders are missing.
- Lives are numbered per day (Live 1, Live 2…) with their start time; compare start times and spend per live when you can.
- With little data (few days or lives), say the evidence is thin and suggest a simple test.
- Days marked as estimates can have too many orders — mention it if most days are estimates.
- Days where spend is high but orders are low matter most — point them out by date.
- Be concise and scannable: short headings, bullets, no intro, max about 250 words.`;

// Google Gemini (AI Studio key).
async function callGemini(key, system, messages, model = MODEL_FOR('gemini')) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 90000);
  let res, body;
  try {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST', signal: ctl.signal,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })), generationConfig: { maxOutputTokens: 2048, temperature: 0.4 } }),
    });
    body = await res.json().catch(() => ({}));
  } catch (e) { throw new Error(e.name === 'AbortError' ? 'The AI took too long to answer. Try again.' : 'Could not reach Gemini: ' + e.message); }
  finally { clearTimeout(t); }
  const msg = (body.error && body.error.message) || '';
  // The default model name can be retired by Google: fall back to the "latest Flash" alias once.
  if (res.status === 404 && model !== 'gemini-flash-latest') return callGemini(key, system, messages, 'gemini-flash-latest');
  if (res.status === 400 && /api key/i.test(msg) || res.status === 403) throw Object.assign(new Error('The Gemini API key was refused — check it in Admin → Settings.'), { status: 400 });
  if (res.status === 429) throw Object.assign(new Error('Gemini is busy or the free limit was reached. Try again in a minute.'), { status: 429 });
  if (!res.ok) throw new Error('AI error: ' + (msg || 'HTTP ' + res.status));
  const text = ((body.candidates || [])[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
  if (!text) throw new Error('Gemini gave no answer (it may have blocked the request). Try again.');
  return { text, usage: body.usageMetadata || {} };
}
async function callClaude(key, system, messages) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 90000);
  let res, body;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ctl.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL_FOR('claude'), max_tokens: 1200, system, messages }),
    });
    body = await res.json().catch(() => ({}));
  } catch (e) { throw new Error(e.name === 'AbortError' ? 'The AI took too long to answer. Try again.' : 'Could not reach the AI: ' + e.message); }
  finally { clearTimeout(t); }
  if (res.status === 401) throw Object.assign(new Error('The Anthropic API key was refused — check it in Admin → Settings.'), { status: 400 });
  if (res.status === 429) throw Object.assign(new Error('The AI is busy or the account hit its limit. Try again in a minute.'), { status: 429 });
  const msg = (body.error && body.error.message) || '';
  if (/credit balance is too low/i.test(msg)) throw Object.assign(new Error('The Anthropic account has no credit left. The owner adds credit at console.anthropic.com → Plans & Billing, then AI advice works again.'), { status: 402 });
  if (!res.ok) throw new Error('AI error: ' + (msg || 'HTTP ' + res.status));
  return { text: (body.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim(), usage: body.usage || {} };
}

const cache = new Map();
async function clientAdvice(owner, clientId, { from, to, lang = 'en', question = '', fresh = false }) {
  const cfg = await keyConfig();
  if (!cfg.key) throw Object.assign(new Error('AI is not set up yet. The app owner adds a Claude or Gemini API key in Admin → Settings.'), { status: 400, notSetUp: true });
  const data = await clientData(owner, clientId, from, to);
  if (!data.totals.spend && !data.totals.orders) return { text: lang === 'km' ? 'មិនមានការចំណាយ Boost ក្នុងរយៈពេលនេះទេ។' : 'No boost spend for this client in this period.', empty: true };
  const ck = crypto.createHash('sha1').update(JSON.stringify([owner, clientId, from, to, lang, question, data.totals, data.daily.length])).digest('hex');
  const hit = cache.get(ck); if (!fresh && hit && Date.now() - hit.at < 3600e3) return { ...hit.out, cached: true };
  const today = sync.todayIn(), useKey = `aiUse:${today}`, used = Number(await db.getUserSetting(owner, useKey, 0)) || 0;
  if (used >= DAILY_LIMIT) throw Object.assign(new Error(`You used today's ${DAILY_LIMIT} AI requests. Try again tomorrow.`), { status: 429 });
  const langLine = lang === 'km' ? 'Write the whole answer in Khmer (ខ្មែរ). Keep Page names, campaign names, numbers and $ as they are.' : 'Write the answer in simple English.';
  const ask = question ? `\n\nThe media buyer also asks: "${String(question).slice(0, 400)}" — answer it within the advice.` : '';
  const out = await (cfg.provider === 'gemini' ? callGemini : callClaude)(cfg.key, SYSTEM, [{ role: 'user', content: `${langLine}${ask}\n\nClient data (JSON):\n${JSON.stringify(data)}` }]);
  await db.setUserSetting(owner, useKey, used + 1);
  const result = { text: out.text, client: data.client.name, totals: data.totals, at: new Date().toISOString() };
  cache.set(ck, { at: Date.now(), out: result });
  for (const [k, v] of cache) if (Date.now() - v.at > 3600e3) cache.delete(k);
  return result;
}

// ---------- daily plan per client: suggestions for each Page + today's tasks ----------
const DAILY_SYSTEM = `You are the ads advisor inside Boost Desk (Ads Box, a Facebook ads agency in Cambodia). Clients sell through Facebook live videos and boosted posts; orders come from adsbox.biz per Page.

You get ONE client's numbers for the last days (yesterday is the most recent full day). Write the plan for TODAY for the media buyer.

Format exactly:
## Today
One line: how yesterday went (spend, orders, cost per order) vs the days before.

Then one section per Facebook Page that had spend, biggest first:
## <Page name>
- What happened (numbers).
- What to do today for this Page (budget, live time, post to boost or stop, audience or video to test).

## Tasks
- [ ] 3 to 6 short, concrete tasks for today, each starting with a verb, tied to a Page and a number.

Rules: use only the numbers given, never invent; money as $ with 2 decimals; cost per order = spend ÷ orders (lower is better); if orders are missing say so and judge by messages and spend per live; be short — max about 220 words.`;

async function dailyPlan(owner, clientId, { lang = 'en', force = false } = {}) {
  const cfg = await keyConfig();
  if (!cfg.key) throw Object.assign(new Error('AI is not set up yet. The app owner adds a Claude or Gemini API key in Admin → Settings.'), { status: 400, notSetUp: true });
  const today = sync.todayIn(), wb = await workbook(owner, clientId);
  if (!force && wb.ai && wb.ai.day === today && wb.ai.lang === lang && wb.ai.text) return wb.ai;
  const from = sync.addDays(today, -7), to = today;
  const data = await clientData(owner, clientId, from, to);
  if (!data.totals.spend && !data.totals.orders) {
    const ai = { day: today, lang, at: new Date().toISOString(), text: lang === 'km' ? 'មិនមានការចំណាយ Boost ក្នុង ៧ ថ្ងៃចុងក្រោយទេ។' : 'No boost spend in the last 7 days — nothing to plan.', empty: true };
    wb.ai = ai; await saveWorkbook(owner, clientId, wb); return ai;
  }
  const used = Number(await db.getUserSetting(owner, `aiUse:${today}`, 0)) || 0;
  if (used >= DAILY_LIMIT) throw Object.assign(new Error(`You used today's ${DAILY_LIMIT} AI requests. Try again tomorrow.`), { status: 429 });
  const langLine = lang === 'km' ? 'Write the whole answer in Khmer (ខ្មែរ). Keep Page names, numbers, $, the heading "## Tasks" and the "- [ ]" task markers exactly as they are.' : 'Write the answer in simple English.';
  const out = await (cfg.provider === 'gemini' ? callGemini : callClaude)(cfg.key, DAILY_SYSTEM, [{ role: 'user', content: `${langLine}\nToday is ${today}.\n\nClient data (JSON):\n${JSON.stringify(data)}` }]);
  await db.setUserSetting(owner, `aiUse:${today}`, used + 1);
  // The "- [ ]" lines become today's tasks (ticked ones from earlier stay as they are).
  const tasks = [];
  for (const line of out.text.split('\n')) { const m = line.match(/^\s*[-*]\s*\[\s?\]\s*(.+)$/); if (m) tasks.push(m[1].trim().slice(0, 200)); }
  const text = out.text.replace(/^\s*[-*]\s*\[\s?\]\s*/gm, '- ');
  const ai = { day: today, lang, at: new Date().toISOString(), text: text.replace(/\n## (Tasks|កិច្ចការ)[^\n]*\n(?:- .*\n?)*/i, '\n').trim() || text, taskCount: tasks.length };
  const fresh = await workbook(owner, clientId);
  fresh.ai = ai;
  fresh.tasks = fresh.tasks.filter((t) => !(t.from === 'ai' && t.day === today && !t.done)); // a new plan replaces today's open AI tasks
  for (const t of tasks) if (!fresh.tasks.some((x) => x.day === today && x.text === t)) fresh.tasks.push({ id: crypto.randomBytes(5).toString('hex'), text: t, from: 'ai', day: today, done: false });
  await saveWorkbook(owner, clientId, fresh);
  return ai;
}

// ---------- notes and tasks per client (per user) ----------
async function workbook(owner, clientId) {
  const w = (await db.getUserSetting(owner, `cwb:${Number(clientId)}`, null)) || {};
  const keep = sync.addDays(sync.todayIn(), -30);
  // Tasks set to repeat every day start unticked again each morning.
  const today = sync.todayIn(), dayOf = (iso) => { try { return sync.todayIn(undefined, new Date(iso)); } catch (_) { return ''; } };
  const tasks = (w.tasks || []).filter((t) => t.repeat || !t.done || (t.doneAt || '').slice(0, 10) >= keep).map((t) => {
    const doneDay = t.done && t.doneAt ? dayOf(t.doneAt) : '';
    return t.repeat && t.done && doneDay < today ? { ...t, done: false, doneAt: null, doneBy: null, doneDay: '' } : { ...t, doneDay };
  });
  return { notes: String(w.notes || ''), notesAt: w.notesAt || null, tasks, ai: w.ai || null, ticks: w.ticks || {}, log: Array.isArray(w.log) ? w.log : [] };
}
async function saveWorkbook(owner, clientId, w) {
  w.tasks = (w.tasks || []).slice(-80);
  // Done history (Today's work & tasks ticked off), kept about 13 months.
  const keepLog = sync.addDays(sync.todayIn(), -400); w.log = (Array.isArray(w.log) ? w.log : []).filter((x) => x.day >= keepLog).slice(-1500);
  const keep = sync.addDays(sync.todayIn(), -7); for (const k of Object.keys(w.ticks || {})) if (k.slice(0, 10) < keep) delete w.ticks[k];
  await db.setUserSetting(owner, `cwb:${Number(clientId)}`, w);
  return w;
}

// Every morning: a plan for each client that boosted in the last 3 days (stops early if the AI says it's busy).
async function morningPlans(log = () => {}) {
  const cfg = await keyConfig(); if (!cfg.key) return 0;
  let n = 0; const today = sync.todayIn(), since = sync.addDays(today, -3);
  for (const u of await db.allUsers()) {
    if ((await db.getUserSetting(u.fb_id, 'aiOn', true)) === false) continue; // Settings → AI advice off
    const lang = (await db.getUserSetting(u.fb_id, 'aiLang', 'en')) === 'km' ? 'km' : 'en';
    const active = new Set((await db.monthEntries(u.fb_id, since, today)).filter((r) => { const e = r.data || {}; return Object.values(e.lives || {}).some((l) => Number(l && l.spend) > 0) || Number((e.post || {}).spend) > 0; }).map((r) => r.client_id));
    for (const c of (await db.listClients(u.fb_id)).filter((x) => !x.archived && active.has(x.id))) {
      try { await dailyPlan(u.fb_id, c.id, { lang }); n++; }
      catch (e) { if (e.status === 429) { log('AI daily plans paused: ' + e.message); return n; } log(`AI plan for ${c.name} failed: ${e.message}`); }
    }
  }
  return n;
}

module.exports = { publicConfig, saveKey, clientAdvice, clientData, dailyPlan, workbook, saveWorkbook, morningPlans };
