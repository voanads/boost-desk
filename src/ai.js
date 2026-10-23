// AI advice for one client (Claude API). It gets the numbers Boost Desk already has for the client and period —
// spend per day (lives and posts), each live, post results, spend per Page, orders per Page and day from
// adsbox.biz, the period before, and the boost setups saved from the Lives page — and explains what is working,
// what is wasting money and what to do next. Only totals, campaign names and post text are sent; Boost Desk has
// no customer data to send.
const crypto = require('crypto');
const db = require('./db');
const sync = require('./sync');
const { encrypt, decrypt } = require('./crypto');

const MODEL = () => process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
const DAILY_LIMIT = Number(process.env.AI_DAILY_LIMIT) || 60; // advice requests per person per day
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

// ---------- API key (Admin → Settings; saved encrypted) ----------
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
  else if (key && String(key).trim()) {
    const k = String(key).trim();
    if (!/^sk-ant-/.test(k)) throw Object.assign(new Error('That does not look like an Anthropic API key (it starts with sk-ant-).'), { status: 400 });
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
  return {
    client: { name: c.name, type: c.type, pages: c.pages || [] },
    period: { from, to, days, previous: `${pFrom} to ${pTo}` },
    totals: { spend, live: r2(liveT), post: r2(postT), lives: lives.length, daysWithSpend: daily.length, orders: ord, costPerOrder: ord ? r2(spend / ord) : null, postResults: res, postResultType: resType, postCostPerResult: res ? r2(resSpend / res) : null },
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

async function callClaude(key, system, messages) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 90000);
  let res, body;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ctl.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL(), max_tokens: 1200, system, messages }),
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
  if (!cfg.key) throw Object.assign(new Error('AI is not set up yet. The app owner adds an Anthropic API key in Admin → Settings.'), { status: 400, notSetUp: true });
  const data = await clientData(owner, clientId, from, to);
  if (!data.totals.spend && !data.totals.orders) return { text: lang === 'km' ? 'មិនមានការចំណាយ Boost ក្នុងរយៈពេលនេះទេ។' : 'No boost spend for this client in this period.', empty: true };
  const ck = crypto.createHash('sha1').update(JSON.stringify([owner, clientId, from, to, lang, question, data.totals, data.daily.length])).digest('hex');
  const hit = cache.get(ck); if (!fresh && hit && Date.now() - hit.at < 3600e3) return { ...hit.out, cached: true };
  const today = sync.todayIn(), useKey = `aiUse:${today}`, used = Number(await db.getUserSetting(owner, useKey, 0)) || 0;
  if (used >= DAILY_LIMIT) throw Object.assign(new Error(`You used today's ${DAILY_LIMIT} AI requests. Try again tomorrow.`), { status: 429 });
  const langLine = lang === 'km' ? 'Write the whole answer in Khmer (ខ្មែរ). Keep Page names, campaign names, numbers and $ as they are.' : 'Write the answer in simple English.';
  const ask = question ? `\n\nThe media buyer also asks: "${String(question).slice(0, 400)}" — answer it within the advice.` : '';
  const out = await callClaude(cfg.key, SYSTEM, [{ role: 'user', content: `${langLine}${ask}\n\nClient data (JSON):\n${JSON.stringify(data)}` }]);
  await db.setUserSetting(owner, useKey, used + 1);
  const result = { text: out.text, client: data.client.name, totals: data.totals, at: new Date().toISOString() };
  cache.set(ck, { at: Date.now(), out: result });
  for (const [k, v] of cache) if (Date.now() - v.at > 3600e3) cache.delete(k);
  return result;
}

module.exports = { publicConfig, saveKey, clientAdvice, clientData };
