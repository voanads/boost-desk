// 🥊 Competitor research (v1) for one client. Meta does not let apps read other Pages' posts or Cambodian commercial ads
// (Ad Library API = EU / political only; other Pages' posts need "Page Public Content Access" from App Review), so the PM
// adds the competitors: a Page link, what they see (price, offer, delivery, how they sell) and up to two screenshots.
// The AI then compares them with OUR client's real numbers (last 30 days) and says what our Page should do.
//   user setting comp:<clientId> = { list: [{ id, name, link, note, images: [dataUrl] }], ours: { note, images }, analysis: { text, at, lang, by } }
const crypto = require('crypto');
const db = require('./db');
const sync = require('./sync');

const MAX = 5, MAX_IMG = 2, IMG_MAX = 450000, key = (clientId) => 'comp:' + Number(clientId);
const clean = (s, n) => String(s == null ? '' : s).replace(/\u0000/g, '').trim().slice(0, n);
const okImg = (x) => typeof x === 'string' && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(x) && x.length <= IMG_MAX;
const okLink = (x) => !x || /^https:\/\/([a-z0-9-]+\.)*(facebook\.com|fb\.com|fb\.watch|tiktok\.com|instagram\.com|t\.me)\//i.test(x);

async function get(owner, clientId) { const v = (await db.getUserSetting(owner, key(clientId), null)) || {}; return { list: v.list || [], ours: v.ours || { note: '', images: [] }, analysis: v.analysis || null }; }
async function save(owner, clientId, body) {
  const cur = await get(owner, clientId), b = body || {};
  const list = (Array.isArray(b.list) ? b.list : []).slice(0, MAX).map((x) => {
    const link = clean(x.link, 300);
    if (!okLink(link)) throw Object.assign(new Error(`"${clean(x.name, 40) || link}": use a Facebook, TikTok or Instagram link (https://…).`), { status: 400 });
    return { id: /^[a-z0-9]{6,16}$/.test(x.id || '') ? x.id : crypto.randomBytes(5).toString('hex'), name: clean(x.name, 80), link, note: clean(x.note, 1500), images: (Array.isArray(x.images) ? x.images : []).filter(okImg).slice(0, MAX_IMG) };
  }).filter((x) => x.name || x.link);
  const ours = { note: clean((b.ours || {}).note, 1500), images: (Array.isArray((b.ours || {}).images) ? b.ours.images : []).filter(okImg).slice(0, MAX_IMG) };
  const next = { list, ours, analysis: cur.analysis };
  await db.setUserSetting(owner, key(clientId), next);
  return next;
}

const SYSTEM = `You are the competitor analyst inside Boost Desk (Ads Box, a Facebook ads agency in Cambodia). Clients sell on Facebook (boosted posts and live videos); customers order in Messenger and comments.

You get OUR client (its real numbers for the last 30 days from Boost Desk, and what the media buyer wrote about its offer) and up to five COMPETITOR Pages that sell the same kind of product, each with what the media buyer saw: price, offer, delivery, how they sell, and screenshots (labelled with the Page name).

Use only what is given: the notes, the screenshots and the numbers. Do not invent prices, follower counts or results; when something is not given, say it is not known. Write for a media buyer who will act today.

Format exactly:
## <competitor name>
- **ចំណុចខ្លាំង / Strengths:** 2–4 points.
- **ចំណុចខ្សោយ / Weaknesses:** 1–3 points.
(one section per competitor)
## ប្រៀបធៀបជាមួយ <our client> / Compared with us
2–4 lines: where we are ahead, where we are behind (use our numbers).
## ផេកយើងគួរធ្វើ / What our Page should do
3–5 numbered, concrete actions (offer, price display, picture or video style, caption, live time, ad audience or budget), the most important first.

Short lines. No intro, no closing.` + require('./pageProfile').RULE;

const toImg = (u) => { const m = String(u).match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/); return m ? { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } } : null; };
async function analyze(user, clientId, { lang = 'km' } = {}) {
  const owner = user.fb_id, c = await get(owner, clientId);
  if (!c.list.length) throw Object.assign(new Error('Add at least one competitor Page first.'), { status: 400 });
  const ai = require('./ai'), today = sync.todayIn();
  let ours = {}; try { const d = await ai.clientData(owner, clientId, sync.addDays(today, -29), today); ours = { client: d.client, totals: d.totals, previous: d.previous, lives: (d.lives || []).slice(-15), pages: d.pages }; } catch (e) { if (e.status === 404) throw e; }
  const name = (ours.client && ours.client.name) || 'our client';
  const payload = { ourClient: { ...ours, mediaBuyerNotes: c.ours.note }, competitors: c.list.map((x) => ({ name: x.name, link: x.link, mediaBuyerNotes: x.note, screenshots: x.images.length })) };
  const content = [];
  for (const im of c.ours.images) { const i = toImg(im); if (i) content.push({ type: 'text', text: `OUR client "${name}" screenshot:` }, i); }
  for (const x of c.list) for (const im of x.images) { const i = toImg(im); if (i) content.push({ type: 'text', text: `COMPETITOR "${x.name || x.link}" screenshot:` }, i); }
  const langLine = lang === 'km' ? 'Write the whole answer in Khmer (ខ្មែរ). Keep Page names, numbers and $ as they are.' : 'Write the answer in simple English.';
  content.push({ type: 'text', text: `${langLine}\n\nData (JSON):\n${JSON.stringify(payload).slice(0, 24000)}` });
  const out = await ai.askAI(owner, SYSTEM, content, { maxTokens: 2200 });
  const analysis = { text: out.text, at: new Date().toISOString(), lang, by: user.buyer ? user.buyer.name : user.name, competitors: c.list.length };
  const now = await get(owner, clientId); await db.setUserSetting(owner, key(clientId), { ...now, analysis });
  return analysis;
}

module.exports = { get, save, analyze, okImg, okLink, MAX, MAX_IMG };
