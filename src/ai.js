// AI advice for one client (Claude API). It gets the numbers Boost Desk already has for the client and period —
// spend per day (lives and posts), each live, post results, spend per Page, orders per Page and day (counted by
// Boost Desk), the period before, and the boost setups saved from the Lives page — and explains what is working,
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
async function usedToday(owner) { return Number(await db.getUserSetting(owner, `aiUse:${sync.todayIn()}`, 0)) || 0; }
async function publicConfig() { const c = await keyConfig(); return { hasKey: !!c.key, provider: c.provider, keyHint: c.hint, savedBy: c.by, savedAt: c.at, model: MODEL_FOR(c.provider), dailyLimit: DAILY_LIMIT, usage: await usageOf(sync.todayIn().slice(0, 7)) }; }

// ---------- usage per month (Admin → Settings → AI advice) ----------
// $ per million tokens [input, output] for the default models; other models show tokens only. Prices change: check
// anthropic.com/pricing (Claude) or ai.google.dev/pricing (Gemini) when changing ANTHROPIC_MODEL / GEMINI_MODEL.
const PRICE = { 'claude-sonnet-5-5': [2, 10] };
const usageKey = (ym) => `aiUsage:${ym}`;
async function usageOf(ym) {
  const u = (await db.getSetting(usageKey(ym), null)) || { calls: 0, input: 0, output: 0, models: {} };
  let cost = 0, priced = true;
  for (const [m, x] of Object.entries(u.models || {})) { const p = PRICE[m]; if (!p) { priced = false; continue; } cost += (x.input * p[0] + x.output * p[1]) / 1e6; }
  return { month: ym, calls: u.calls || 0, input: u.input || 0, output: u.output || 0, cost: Math.round(cost * 100) / 100, priced };
}
// One request's tokens, added to this month's total (never fails the request).
async function noteUsage(model, input, output) {
  try {
    const k = usageKey(sync.todayIn().slice(0, 7)), u = (await db.getSetting(k, null)) || { calls: 0, input: 0, output: 0, models: {} };
    u.models = u.models || {}; u.calls = (u.calls || 0) + 1; u.input = (u.input || 0) + input; u.output = (u.output || 0) + output;
    const m = (u.models[model] = u.models[model] || { calls: 0, input: 0, output: 0 }); m.calls++; m.input += input; m.output += output;
    await db.setSetting(k, u);
  } catch (e) { console.error('[ai] usage not saved:', e.message); }
}
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

  // orders per Page and day (counted by Boost Desk; adsbox.biz before 20 Nov 2026) (matched to this client's Pages)
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
    client: { name: c.name, type: c.type, pages: c.pages || [], pageProfile: await require('./pageProfile').forClient(owner, c.id) },
    period: { from, to, days, previous: `${pFrom} to ${pTo}` },
    totals: { spend, live: r2(liveT), post: r2(postT), lives: lives.length, daysWithSpend: daily.length, orders: ord, costPerOrder: ord ? r2(oSpend / ord) : null, spendOnPagesWithoutOrders: ord ? r2(spend - oSpend) : null, postResults: res, postResultType: resType, postCostPerResult: res ? r2(resSpend / res) : null },
    previous: prev ? { ...prev, orders: ordersBlock ? ordersBlock.previousPeriod : null, costPerOrder: prev && ordersBlock && ordersBlock.previousPeriod ? r2(prev.spend / ordersBlock.previousPeriod) : null } : null,
    daily, lives: lives.slice(-40), pages, orders: ordersBlock, boostSetups: setups,
  };
}

// ---------- Claude ----------
const SYSTEM = `You are the ads advisor inside Boost Desk, the tool Ads Box (a Facebook ads agency in Cambodia) uses to run and track boosts for its clients. Clients sell through Facebook live videos and boosted posts; customers order in comments and Messenger. Boost Desk counts the orders itself (a Messenger message or comment with a phone number = one order), per Page and day.

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
- Be concise and scannable: short headings, bullets, no intro, max about 250 words.` + require('./pageProfile').RULE;

// Google Gemini (AI Studio key).
async function callGemini(key, system, messages, model = MODEL_FOR('gemini'), maxTokens = 2048) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 90000);
  let res, body;
  try {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST', signal: ctl.signal,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })), generationConfig: { maxOutputTokens: maxTokens, temperature: 0.4 } }),
    });
    body = await res.json().catch(() => ({}));
  } catch (e) { throw new Error(e.name === 'AbortError' ? 'The AI took too long to answer. Try again.' : 'Could not reach Gemini: ' + e.message); }
  finally { clearTimeout(t); }
  const msg = (body.error && body.error.message) || '';
  // The default model name can be retired by Google: fall back to the "latest Flash" alias once.
  if (res.status === 404 && model !== 'gemini-flash-latest') { console.error(`[ai] Gemini model ${model} not found; using gemini-flash-latest. Set GEMINI_MODEL to a current model.`); return callGemini(key, system, messages, 'gemini-flash-latest'); }
  if (res.status === 400 && /api key/i.test(msg) || res.status === 403) throw Object.assign(new Error('The Gemini API key was refused — check it in Admin → Settings.'), { status: 400 });
  if (res.status === 429) throw Object.assign(new Error('Gemini is busy or the free limit was reached. Try again in a minute.'), { status: 429 });
  if (!res.ok) throw new Error('AI error: ' + (msg || 'HTTP ' + res.status));
  const text = ((body.candidates || [])[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
  if (!text) throw new Error('Gemini gave no answer (it may have blocked the request). Try again.');
  const um = body.usageMetadata || {};
  await noteUsage(model, Number(um.promptTokenCount) || 0, (Number(um.candidatesTokenCount) || 0) + (Number(um.thoughtsTokenCount) || 0));
  return { text, usage: um };
}
// Set when Anthropic says the balance is empty; cleared by the next good answer. Kept in settings (aiNoCredit) so a restart
// remembers it: while it is set the app hides the AI parts (owner's decision, 27 Nov 2026). The morning plans and their
// catch-up keep trying in the background, so the first good answer after credit is added brings the AI parts back.
const noCredit = { at: null, loaded: false };
async function setNoCredit(at) { noCredit.at = at; noCredit.loaded = true; try { await db.setSetting('aiNoCredit', at); } catch (_) {} }
async function creditOut() { if (!noCredit.loaded) { noCredit.loaded = true; try { noCredit.at = noCredit.at || (await db.getSetting('aiNoCredit', null)) || null; } catch (_) {} } return noCredit.at; }
async function callClaude(key, system, messages, maxTokens = 1200) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 90000);
  let res, body;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ctl.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL_FOR('claude'), max_tokens: maxTokens, system, messages }),
    });
    body = await res.json().catch(() => ({}));
  } catch (e) { throw new Error(e.name === 'AbortError' ? 'The AI took too long to answer. Try again.' : 'Could not reach the AI: ' + e.message); }
  finally { clearTimeout(t); }
  if (res.status === 401) throw Object.assign(new Error('The Anthropic API key was refused — check it in Admin → Settings.'), { status: 400 });
  if (res.status === 429) throw Object.assign(new Error('The AI is busy or the account hit its limit. Try again in a minute.'), { status: 429 });
  const msg = (body.error && body.error.message) || '';
  if (/credit balance is too low/i.test(msg) && !noCredit.at) await setNoCredit(new Date().toISOString());
  if (/credit balance is too low/i.test(msg)) throw Object.assign(new Error('The Anthropic account has no credit left. The owner adds credit at console.anthropic.com → Plans & Billing, then AI advice works again.'), { status: 402 });
  if (!res.ok) throw new Error('AI error: ' + (msg || 'HTTP ' + res.status));
  if (noCredit.at || !noCredit.loaded) await setNoCredit(null);
  const u = body.usage || {};
  await noteUsage(MODEL_FOR('claude'), (Number(u.input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0), Number(u.output_tokens) || 0);
  // A safety decline comes back as HTTP 200 with stop_reason "refusal": say so instead of showing an empty answer.
  if (body.stop_reason === 'refusal') throw Object.assign(new Error('The AI declined to answer this one. Try again, or ask the question differently.'), { status: 422 });
  const text = (body.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
  if (!text) throw new Error('The AI gave no answer. Try again.');
  return { text, usage: u };
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

// ---------- 🩺 Ad Doctor (src/adDoctor.js): why the weak ads are weak and how to fix them ----------
const DOCTOR_SYSTEM = `You are the ads doctor inside Boost Desk (Ads Box, a Facebook ads agency in Cambodia). Clients sell through Facebook boosted posts and live videos; customers order in Messenger and comments.

You get ONE client's weak ads from the last days, with Meta's numbers (spend, results, cost per result, CTR, CPM, frequency, reach), the ad text, the audience, and the problems Boost Desk already found. You also get the client's BEST ads from the same days to compare with. Pictures, when given, are labelled WEAK or BEST.

Explain to the media buyer why each weak ad is weak and exactly what to change. Base every point on the numbers and pictures given; never invent numbers. Compare with the client's own best ads, not with general benchmarks. Be concrete: which picture/first seconds to change and how, what to write in the caption (price, promotion, how to order), which audience change (age, place, interests), what budget, or to pause it.

Format exactly:
## <weak ad name>
- **មូលហេតុ / Why:** one or two lines with the numbers.
- **កែយ៉ាងម៉េច / Fix:** two to four concrete steps.
(one section per weak ad, worst first)
## ធ្វើភ្លាមៗ / Do now
Three numbered actions for today, most money saved first.

Short lines. No intro, no closing.` + require('./pageProfile').RULE;
async function adDoctorAI(owner, payload, pics = [], { lang = 'km', fresh = false } = {}) {
  const cfg = await keyConfig();
  if (!cfg.key) throw Object.assign(new Error('AI is not set up yet. The app owner adds a Claude or Gemini API key in Admin → Settings.'), { status: 400, notSetUp: true });
  const ck = 'doc:' + crypto.createHash('sha1').update(JSON.stringify([owner, payload, lang])).digest('hex');
  const hit = cache.get(ck); if (!fresh && hit && Date.now() - hit.at < 3600e3) return { ...hit.out, cached: true };
  const today = sync.todayIn(), useKey = `aiUse:${today}`, used = Number(await db.getUserSetting(owner, useKey, 0)) || 0;
  if (used >= DAILY_LIMIT) throw Object.assign(new Error(`You used today's ${DAILY_LIMIT} AI requests. Try again tomorrow.`), { status: 429 });
  const langLine = lang === 'km' ? 'Write the whole answer in Khmer (ខ្មែរ). Keep ad names, numbers, $ and terms like CTR, CPM, frequency as they are.' : 'Write the answer in simple English.';
  const text = `${langLine}\n\nAds (JSON):\n${JSON.stringify(payload)}`;
  let out;
  if (cfg.provider === 'gemini' || !pics.length) out = await (cfg.provider === 'gemini' ? callGemini : callClaude)(cfg.key, DOCTOR_SYSTEM, [{ role: 'user', content: text }], ...(cfg.provider === 'gemini' ? [] : [1800]));
  else {
    const content = [];
    for (const p of pics) content.push({ type: 'text', text: p.label + ':' }, { type: 'image', source: { type: 'base64', media_type: p.media_type, data: p.data } });
    content.push({ type: 'text', text });
    try { out = await callClaude(cfg.key, DOCTOR_SYSTEM, [{ role: 'user', content }], 1800); }
    catch (e) { if (e.status === 429 || e.status === 400 && /key/i.test(e.message)) throw e; out = await callClaude(cfg.key, DOCTOR_SYSTEM, [{ role: 'user', content: text }], 1800); } // a picture the AI could not read: try once with the numbers only
  }
  await db.setUserSetting(owner, useKey, used + 1);
  const result = { text: out.text, pictures: pics.length, at: new Date().toISOString() };
  cache.set(ck, { at: Date.now(), out: result });
  return result;
}

// One AI request with text and pictures (content blocks in Claude's shape). Gemini gets the text parts only. If a picture
// can't be read, Claude is asked once more with the text only. Counts against the person's daily limit.
async function askAI(owner, system, content, { maxTokens = 1800 } = {}) {
  const cfg = await keyConfig();
  if (!cfg.key) throw Object.assign(new Error('AI is not set up yet. The app owner adds a Claude or Gemini API key in Admin → Settings.'), { status: 400, notSetUp: true });
  const today = sync.todayIn(), useKey = `aiUse:${today}`, used = Number(await db.getUserSetting(owner, useKey, 0)) || 0;
  if (used >= DAILY_LIMIT) throw Object.assign(new Error(`You used today's ${DAILY_LIMIT} AI requests. Try again tomorrow.`), { status: 429 });
  const textOnly = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  let out;
  if (cfg.provider === 'gemini') out = await callGemini(cfg.key, system, [{ role: 'user', content: textOnly }]);
  else if (!content.some((b) => b.type === 'image')) out = await callClaude(cfg.key, system, [{ role: 'user', content: textOnly }], maxTokens);
  else {
    try { out = await callClaude(cfg.key, system, [{ role: 'user', content }], maxTokens); }
    catch (e) { if (e.status === 429 || e.status === 400 && /key|credit/i.test(e.message)) throw e; out = await callClaude(cfg.key, system, [{ role: 'user', content: textOnly }], maxTokens); }
  }
  await db.setUserSetting(owner, useKey, used + 1);
  return out;
}

// ---------- daily plan per client: suggestions for each Page + today's tasks ----------
const DAILY_SYSTEM = `You are the ads advisor inside Boost Desk (Ads Box, a Facebook ads agency in Cambodia). Clients sell through Facebook live videos and boosted posts; orders are counted by Boost Desk per Page from Messenger messages and comments (a message or comment with a phone number = one order).

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

Rules: use only the numbers given, never invent; money as $ with 2 decimals; cost per order = spend ÷ orders (lower is better); if orders are missing say so and judge by messages and spend per live; be short — max about 220 words.` + require('./pageProfile').RULE;

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
  return { notes: String(w.notes || ''), notesAt: w.notesAt || null, tasks, ai: w.ai || null, weekly: w.weekly || null, ticks: w.ticks || {}, log: Array.isArray(w.log) ? w.log : [] };
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
// Every morning (06:40) — and again each hour until it worked (src/jobs.js "AI daily plans catch-up") — a plan for every
// client that boosted in the last 3 days. Each run is saved (setting aiPlansLast) so Admin → Health can say whether
// today's plans were made and, if not, the AI's own error — the in-memory job history is lost on every restart.
// A client that already has today's plan is not asked again (dailyPlan returns it), so a catch-up costs only the missing ones.
const PLANS_KEY = 'aiPlansLast', PLAN_TRIES = 3;
async function morningPlans(log = () => {}, { reason = 'morning' } = {}) {
  const today = sync.todayIn(), prev = (await db.getSetting(PLANS_KEY, null)) || {};
  const rec = { day: today, at: new Date().toISOString(), reason, made: 0, failed: 0, clients: 0, firstError: '', paused: false, tries: (prev.day === today ? prev.tries || 0 : 0) + 1 };
  const save = async () => { rec.done = !rec.paused && rec.failed === 0; await db.setSetting(PLANS_KEY, rec).catch(() => {}); };
  const cfg = await keyConfig(); if (!cfg.key) { rec.firstError = 'No AI key'; await save(); return 0; }
  const since = sync.addDays(today, -3);
  for (const u of await db.allUsers()) {
    if ((await db.getUserSetting(u.fb_id, 'aiOn', true)) === false) continue; // Settings → AI advice off
    const lang = (await db.getUserSetting(u.fb_id, 'aiLang', 'en')) === 'km' ? 'km' : 'en';
    const active = new Set((await db.monthEntries(u.fb_id, since, today)).filter((r) => { const e = r.data || {}; return Object.values(e.lives || {}).some((l) => Number(l && l.spend) > 0) || Number((e.post || {}).spend) > 0; }).map((r) => r.client_id));
    for (const c of (await db.listClients(u.fb_id)).filter((x) => !x.archived && active.has(x.id))) {
      rec.clients++;
      try { await dailyPlan(u.fb_id, c.id, { lang }); rec.made++; }
      catch (e) {
        rec.failed++; if (!rec.firstError) rec.firstError = `${c.name}: ${e.message}`.slice(0, 300);
        if (e.status === 429) { rec.paused = true; log('AI daily plans paused: ' + e.message); await save(); return rec.made; }
        log(`AI plan for ${c.name} failed: ${e.message}`);
        if (rec.failed >= 5 && !rec.made) { log('AI daily plans stopped: the first 5 all failed'); await save(); return 0; } // the key / credit is the problem: don't hammer it
      }
    }
  }
  await save();
  return rec.made;
}
// The hourly catch-up: run again when today's plans were not made (missed run, restart, AI error), at most PLAN_TRIES a day.
async function plansCatchUp(log = () => {}) {
  const today = sync.todayIn(), last = (await db.getSetting(PLANS_KEY, null)) || {};
  if (last.day === today && (last.done || (last.tries || 0) >= PLAN_TRIES)) return 0;
  return morningPlans(log, { reason: 'catch-up' });
}
const plansStatus = async () => (await db.getSetting(PLANS_KEY, null)) || null;


// ---------- weekly strategy per client (19 Nov 2026) ----------
// For the clients a PM picks: every Monday the AI reads last week (against the week before) and writes a short strategy
// in Khmer and in English with exactly three actions. It is a draft for the team; a PM may edit it and send it to the
// client's Telegram group — nothing goes to a client by itself.
const WEEKLY_SYSTEM = `You are the ads strategist inside Boost Desk (Ads Box, a Facebook ads agency in Cambodia). Clients sell through Facebook live videos and boosted posts; orders are counted by Boost Desk per Page from Messenger messages and comments (a message or comment with a phone number = one order).

You get ONE client's numbers for last week and the week before. Write a short weekly strategy the Project Manager can read in one minute and may forward to the client.

Write it TWICE: first in Khmer (ខ្មែរ), then a line with exactly ===== , then the same content in simple English. Each version uses exactly these headings (keep the headings in English in both versions):
## Last week
One or two lines: spend, orders, cost per order, and the change against the week before.
## What worked
- 1 to 3 bullets: the best days, lives, Pages or posts, with numbers.
## What to change
- 1 to 3 bullets: spend with few or no orders, expensive lives or Pages, with numbers.
## This week
- [ ] exactly 3 concrete actions, each starting with a verb, tied to a Page, a live time, a post or a budget and to a number.

Rules: use only the numbers given, never invent; money as $ with 2 decimals; cost per order = spend ÷ orders (lower is better); if there are no orders data say so once and judge by messages and spend per live; keep Page names, numbers and $ unchanged in both languages; polite and plain, no blame; each version at most about 150 words.` + require('./pageProfile').RULE;
const weeklyPick = async (owner) => { const v = await db.getUserSetting(owner, 'aiWeekly', []); return (Array.isArray(v) ? v : []).map(Number).filter(Number.isFinite); };
async function setWeeklyPick(owner, clientId, on) {
  const cur = new Set(await weeklyPick(owner)); if (on) cur.add(Number(clientId)); else cur.delete(Number(clientId));
  await db.setUserSetting(owner, 'aiWeekly', [...cur]); return on;
}
// The week to write about: on a Monday, last Monday–Sunday; any other day, the seven full days up to yesterday.
function weekRange(today = sync.todayIn()) { const to = sync.addDays(today, -1); return { from: sync.addDays(to, -6), to }; }
const splitWeekly = (text) => {
  const [a, b] = String(text).split(/\n\s*={4,}\s*\n/), clean = (t) => String(t || '').trim();
  const acts = (t) => { const out = []; for (const line of clean(t).split('\n')) { const m = line.match(/^\s*[-*]\s*\[\s?\]\s*(.+)$/); if (m) out.push(m[1].trim().slice(0, 200)); } return out.slice(0, 3); };
  const body = (t) => clean(t).replace(/^\s*[-*]\s*\[\s?\]\s*/gm, '- ');
  return { km: body(a), en: body(b || ''), actionsKm: acts(a), actionsEn: acts(b || '') };
};
async function weeklyStrategy(owner, clientId, { force = false } = {}) {
  const cfg = await keyConfig();
  if (!cfg.key) throw Object.assign(new Error('AI is not set up yet. The app owner adds a Claude or Gemini API key in Admin → Settings.'), { status: 400, notSetUp: true });
  const today = sync.todayIn(), { from, to } = weekRange(today), wb = await workbook(owner, clientId);
  if (!force && wb.weekly && wb.weekly.from === from && wb.weekly.to === to && wb.weekly.km) return wb.weekly;
  const data = await clientData(owner, clientId, from, to);
  if (!data.totals.spend && !data.totals.orders) return { from, to, empty: true, at: new Date().toISOString(), km: 'សប្ដាហ៍មុនគ្មានការចំណាយ Boost ទេ។', en: 'No boost spend last week — nothing to plan.', actionsKm: [], actionsEn: [] };
  const used = Number(await db.getUserSetting(owner, `aiUse:${today}`, 0)) || 0;
  if (used >= DAILY_LIMIT) throw Object.assign(new Error(`You used today's ${DAILY_LIMIT} AI requests. Try again tomorrow.`), { status: 429 });
  const msg = [{ role: 'user', content: `Last week is ${from} to ${to}.\n\nClient data (JSON):\n${JSON.stringify(data)}` }];
  const out = cfg.provider === 'gemini' ? await callGemini(cfg.key, WEEKLY_SYSTEM, msg, undefined, 4096) : await callClaude(cfg.key, WEEKLY_SYSTEM, msg, 2600);
  await db.setUserSetting(owner, `aiUse:${today}`, used + 1);
  const parts = splitWeekly(out.text);
  if (!parts.km) throw Object.assign(new Error('The AI gave an empty answer. Try again.'), { status: 502 });
  const weekly = { from, to, at: new Date().toISOString(), ...parts, totals: data.totals, sent: null, edited: false };
  const fresh = await workbook(owner, clientId); fresh.weekly = weekly; await saveWorkbook(owner, clientId, fresh);
  return weekly;
}
// A PM's own wording replaces the AI's for one language.
async function saveWeeklyText(owner, clientId, lang, text) {
  const wb = await workbook(owner, clientId); if (!wb.weekly) throw Object.assign(new Error('There is no weekly strategy yet.'), { status: 400 });
  wb.weekly[lang === 'en' ? 'en' : 'km'] = String(text || '').trim().slice(0, 4000); wb.weekly.edited = true; wb.weekly.editedLangs = [...new Set([...(wb.weekly.editedLangs || []), lang === 'en' ? 'en' : 'km'])];
  // the actions follow the PM's wording: the bullets under "This week" (the last heading)
  const k = lang === 'en' ? 'en' : 'km', last = wb.weekly[k].split(/^##\s.*$/m).pop() || '';
  const acts = last.split('\n').map((l) => (l.match(/^\s*[-*•]\s*(?:\[\s?\]\s*)?(.+)$/) || [])[1]).filter(Boolean).map((t) => t.trim().slice(0, 200)).slice(0, 5);
  if (acts.length) { wb.weekly[k === 'en' ? 'actionsEn' : 'actionsKm'] = acts; delete wb.weekly.tasksAt; }
  await saveWorkbook(owner, clientId, wb); return wb.weekly;
}
// Plain Telegram text for the client's group.
function weeklyMessage(clientName, w, lang) {
  const H = { en: ['📊 Last week', '✅ What worked', '🔧 What to change', '🎯 This week'], km: ['📊 សប្ដាហ៍មុន', '✅ អ្វីដែលដំណើរការល្អ', '🔧 អ្វីដែលគួរប្ដូរ', '🎯 សប្ដាហ៍នេះ'] };
  const tidy = (t, l) => String(t || '').replace(/^##\s*Last week\s*$/gmi, H[l][0]).replace(/^##\s*What worked\s*$/gmi, '\n' + H[l][1]).replace(/^##\s*What to change\s*$/gmi, '\n' + H[l][2]).replace(/^##\s*This week\s*$/gmi, '\n' + H[l][3]).replace(/^##\s*/gm, '').replace(/^\s*[-*]\s+/gm, '• ').replace(/\*\*/g, '').replace(/\n{3,}/g, '\n\n').trim();
  const day = (iso) => { try { return new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }); } catch (_) { return iso; } };
  const head = `📈 ${clientName} — ${lang === 'en' ? 'Weekly plan' : lang === 'km' ? 'ផែនការប្រចាំសប្ដាហ៍' : 'ផែនការប្រចាំសប្ដាហ៍ · Weekly plan'} · ${day(w.from)} – ${day(w.to)}`;
  return [head, '', ...(lang === 'both' ? [tidy(w.km, 'km'), '', '— — —', '', tidy(w.en, 'en')] : [tidy(lang === 'en' ? w.en : w.km, lang === 'en' ? 'en' : 'km')])].join('\n').slice(0, 3900);
}
// Monday morning: write the strategy for every picked client (stops early if the AI says it is busy).
async function weeklyPlans(log = () => {}) {
  const cfg = await keyConfig(); if (!cfg.key) return 0;
  let n = 0;
  for (const u of await db.allUsers()) {
    if ((await db.getUserSetting(u.fb_id, 'aiOn', true)) === false) continue;
    const pick = new Set(await weeklyPick(u.fb_id)); if (!pick.size) continue;
    for (const c of (await db.listClients(u.fb_id)).filter((x) => !x.archived && pick.has(x.id))) {
      try { const w = await weeklyStrategy(u.fb_id, c.id); if (!w.empty) n++; }
      catch (e) { if (e.status === 429) { log('AI weekly strategies paused: ' + e.message); return n; } log(`AI weekly strategy for ${c.name} failed: ${e.message}`); }
    }
  }
  return n;
}

// ---------- KPI → suggested daily actions ----------
const KPI_SYSTEM = `You coach the staff of Ads Box, a Facebook ads agency in Cambodia (project managers and media buyers who boost client lives and posts, send daily reports, collect payments and keep clients).
You get ONE monthly KPI of one person (name, target, unit, what they already do every day). Suggest 5 or 6 concrete DAILY actions that move that KPI, ordered by impact.
Answer ONLY with JSON: {"actions":[{"title":"short imperative task, max 60 characters","how":"one or two sentences: how to do it and what to check"}]}
Rules: actions must be things one person can do and tick off each day; tie them to Facebook Pages, lives, boosted posts, reports, Telegram, orders, payments where relevant; no generic advice ("work hard"); do not repeat the duties they already do unless you add a specific twist; keep the KPI's own words.`;
const kpiCache = new Map();
async function kpiSuggest(ownerId, { name, target, unit, role = 'pm', menu = [], others = [], lang = 'km', fresh = false }) {
  const cfg = await keyConfig();
  if (!cfg.key) throw Object.assign(new Error('AI is not set up yet. The app owner adds a Claude or Gemini API key in Admin → Settings.'), { status: 400, notSetUp: true });
  const ck = crypto.createHash('sha1').update(JSON.stringify([name, target, unit, role, lang, menu])).digest('hex');
  const hit = kpiCache.get(ck); if (!fresh && hit && Date.now() - hit.at < 6 * 3600e3) return { ...hit.out, cached: true };
  const today = sync.todayIn(), useKey = `aiUse:${today}`, used = Number(await db.getUserSetting(ownerId, useKey, 0)) || 0;
  if (used >= DAILY_LIMIT) throw Object.assign(new Error(`You used today's ${DAILY_LIMIT} AI requests. Try again tomorrow.`), { status: 429 });
  const langLine = lang === 'km' ? 'Write title and how in Khmer (ខ្មែរ); keep product words like Boost, Live, Page, Ad account, Telegram in English.' : 'Write title and how in simple English.';
  const user = `${langLine}\n\nKPI: ${name}\nTarget this month: ${target} ${unit}\nRole: ${role === 'mb' ? 'media buyer' : 'project manager'}\nTheir daily menu now: ${menu.length ? menu.map((m) => '- ' + m).join('\n') : '(empty)'}\nTheir other KPIs: ${others.length ? others.join('; ') : '(none)'}`;
  const out = await (cfg.provider === 'gemini' ? callGemini : callClaude)(cfg.key, KPI_SYSTEM, [{ role: 'user', content: user }]);
  await db.setUserSetting(ownerId, useKey, used + 1);
  let actions = [];
  try { const m = out.text.match(/\{[\s\S]*\}/); actions = (JSON.parse(m ? m[0] : out.text).actions || []); } catch (_) { throw new Error('The AI answer could not be read. Try again.'); }
  actions = actions.slice(0, 6).map((a) => ({ title: String((a && a.title) || '').trim().slice(0, 160), how: String((a && a.how) || '').trim().slice(0, 400) })).filter((a) => a.title);
  if (!actions.length) throw new Error('The AI gave no actions. Try again.');
  const result = { actions, at: new Date().toISOString() };
  kpiCache.set(ck, { at: Date.now(), out: result }); for (const [k, v] of kpiCache) if (Date.now() - v.at > 6 * 3600e3) kpiCache.delete(k);
  return result;
}
// Top 5 daily menu tasks from ALL of a person's monthly KPIs — the "what should my day look like" list.
const MENU_SYSTEM = `You coach the staff of Ads Box, a Facebook ads agency in Cambodia (project managers and media buyers who boost client lives and posts, send daily reports, collect payments and keep clients).
You get one person's monthly KPIs (name, target, unit) and the daily task menu they already have. Propose the 5 best DAILY tasks for their menu so that doing them every day moves the KPIs. Every KPI with a target must be covered by at least one task when there are 5 or fewer KPIs; order by impact.
Answer ONLY with JSON: {"tasks":[{"title":"short imperative task, max 60 characters","how":"one sentence: how to do it / what to check","kpi":"the exact KPI name this task moves"}]}
Rules: concrete things one person ticks off each day, tied to Pages, lives, boosted posts, reports, Telegram, orders, payments, clients; no generic advice; do not repeat a task that is already on their menu (suggest something different for that KPI instead); "kpi" must be copied exactly from the KPI list.`;
const menuCache = new Map();
async function menuSuggest(ownerId, { kpis = [], menu = [], role = 'pm', lang = 'km', fresh = false }) {
  const cfg = await keyConfig();
  if (!cfg.key) throw Object.assign(new Error('AI is not set up yet. The app owner adds a Claude or Gemini API key in Admin → Settings.'), { status: 400, notSetUp: true });
  if (!kpis.length) throw Object.assign(new Error('Add this month\'s KPIs first — the suggestions come from them.'), { status: 400 });
  const ck = crypto.createHash('sha1').update(JSON.stringify([kpis.map((k) => [k.name, k.target, k.unit]), menu, role, lang])).digest('hex');
  const hit = menuCache.get(ck); if (!fresh && hit && Date.now() - hit.at < 6 * 3600e3) return { ...hit.out, cached: true };
  const today = sync.todayIn(), useKey = `aiUse:${today}`, used = Number(await db.getUserSetting(ownerId, useKey, 0)) || 0;
  if (used >= DAILY_LIMIT) throw Object.assign(new Error(`You used today's ${DAILY_LIMIT} AI requests. Try again tomorrow.`), { status: 429 });
  const langLine = lang === 'km' ? 'Write title and how in Khmer (ខ្មែរ); keep product words like Boost, Live, Page, Ad account, Telegram in English. The "kpi" field stays exactly as given.' : 'Write title and how in simple English. The "kpi" field stays exactly as given.';
  const user = `${langLine}\n\nRole: ${role === 'mb' ? 'media buyer' : 'project manager'}\nKPIs this month:\n${kpis.map((k) => `- ${k.name} — target ${k.target} ${k.unit || ''}`.trim()).join('\n')}\nTheir daily menu now: ${menu.length ? menu.map((m) => '- ' + m).join('\n') : '(empty)'}`;
  // Khmer needs far more tokens than English: 1200 cut the answer mid-JSON and the request failed.
  const out = await (cfg.provider === 'gemini' ? callGemini(cfg.key, MENU_SYSTEM, [{ role: 'user', content: user }]) : callClaude(cfg.key, MENU_SYSTEM, [{ role: 'user', content: user }], 3000));
  await db.setUserSetting(ownerId, useKey, used + 1);
  let tasks = [];
  try { const m = out.text.match(/\{[\s\S]*\}/); tasks = (JSON.parse(m ? m[0] : out.text).tasks || []); }
  catch (_) { // an answer cut short still has whole tasks in it — keep those instead of failing
    tasks = (out.text.match(/\{[^{}]*"title"[^{}]*\}/g) || []).map((x) => { try { return JSON.parse(x); } catch (e) { return null; } }).filter(Boolean);
    if (!tasks.length) throw new Error('The AI answer could not be read. Try again.');
  }
  const norm = (x) => String(x || '').toLowerCase().replace(/\s+/g, ' ').trim();
  tasks = tasks.slice(0, 6).map((t) => { const name = norm(t && t.kpi); const k = kpis.find((x) => norm(x.name) === name) || kpis.find((x) => name && (norm(x.name).includes(name) || name.includes(norm(x.name))));
    return { title: String((t && t.title) || '').trim().slice(0, 160), how: String((t && t.how) || '').trim().slice(0, 300), kpi: k ? k.id : '', kpiName: k ? k.name : '' }; }).filter((t) => t.title).slice(0, 5);
  if (!tasks.length) throw new Error('The AI gave no tasks. Try again.');
  const result = { tasks, at: new Date().toISOString() };
  menuCache.set(ck, { at: Date.now(), out: result }); for (const [k, v] of menuCache) if (Date.now() - v.at > 6 * 3600e3) menuCache.delete(k);
  return result;
}

module.exports = { noCredit, creditOut, usedToday, DAILY_LIMIT, publicConfig, saveKey, clientAdvice, adDoctorAI, askAI, plansCatchUp, plansStatus, clientData, dailyPlan, workbook, saveWorkbook, morningPlans, kpiSuggest, menuSuggest, weeklyStrategy, weeklyPlans, weeklyPick, setWeeklyPick, saveWeeklyText, weeklyMessage, weekRange, splitWeekly };
