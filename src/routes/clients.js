// Clients, post pictures, day checklist and Sync from Meta
// Moved out of server.js unchanged; server.js mounts it at the same place, so route order is kept.
const cfg = require('../config');
const db = require('../db');
const meta = require('../meta');
const sync = require('../sync');

module.exports = function mountClients(app, api, deps) {
  const { cleanClient, isDay, wrap } = deps;
  api.get('/pages', wrap(async (req, res) => res.json(await db.listPagesSeen(req.user.fb_id))));
  // picId: the Facebook Page whose picture stands for the client — a Page ID typed on the client, else a Page known by one of the client's names.
  api.get('/clients', wrap(async (req, res) => {
    const list = await db.listClients(req.user.fb_id), byName = {};
    try { const names = { ...(await db.getSetting('pageNames', {})), ...meta.knownPageNames() }; for (const [id, n] of Object.entries(names)) { const k = String(n || '').trim().toLowerCase(); if (k && /^\d{5,20}$/.test(id) && !byName[k]) byName[k] = id; } } catch (_) {}
    res.json(list.map((c) => { const all = [...(c.pages || []), c.name, c.match].map((x) => String(x || '').trim()).filter(Boolean); return { ...c, picId: all.find((x) => /^\d{5,20}$/.test(x)) || (all.map((x) => byName[x.toLowerCase()]).find(Boolean) || '') }; }));
  }));
  const groupAllowed = async (fbId, chatId) => !chatId || (String(chatId).includes(':') && (await groupAllowed(fbId, String(chatId).split(':')[0]))) || (await db.getSetting('telegramChats', [])).some((c) => c.id === chatId && (c.owners || [c.owner]).includes(fbId)) || (await db.listClients(fbId)).some((c) => c.telegram === chatId);
  api.post('/clients', wrap(async (req, res) => {
    const c = cleanClient(req.body || {});
    if (!c.name) return res.status(400).json({ error: 'Client name is required.' });
    if (!(await groupAllowed(req.user.fb_id, c.telegram))) return res.status(403).json({ error: 'That Telegram group is linked to another account.' });
    for (const v of Object.values(c.topics || {})) if (!(await groupAllowed(req.user.fb_id, v.id))) return res.status(403).json({ error: 'That Telegram topic is linked to another account.' });
    if ((await db.listClients(req.user.fb_id)).some((x) => String(x.name).trim().toLowerCase() === c.name.trim().toLowerCase())) return res.status(409).json({ error: `You already have a client called “${c.name}”. Open it and add the Page there, or use another name.` });
    const created = await db.createClient(req.user.fb_id, c);
    await sync.rematch(req.user);
    res.json(created);
  }));
  api.patch('/clients/:id', wrap(async (req, res) => {
    const body = cleanClient(req.body || {});
    if (body.telegram && !(await groupAllowed(req.user.fb_id, body.telegram))) return res.status(403).json({ error: 'That Telegram group is linked to another account.' });
    for (const v of Object.values(body.topics || {})) if (!(await groupAllowed(req.user.fb_id, v.id))) return res.status(403).json({ error: 'That Telegram topic is linked to another account.' });
    if (body.name) { const mine = await db.listClients(req.user.fb_id), low = (x) => String(x || '').trim().toLowerCase(), cur = mine.find((x) => x.id === Number(req.params.id)); if (cur && low(cur.name) !== low(body.name) && mine.some((x) => x.id !== cur.id && low(x.name) === low(body.name))) return res.status(409).json({ error: `You already have a client called “${body.name}”. Use “Merge a duplicate…” to make them one.` }); }
    const c = await db.updateClient(req.user.fb_id, Number(req.params.id), body);
    if (!c) return res.status(404).json({ error: 'Client not found.' });
    // Only changes that affect matching need a re-match (not e.g. the Telegram group).
    if (['name', 'match', 'pages', 'type', 'archived'].some((k) => k in body)) await sync.rematch(req.user);
    res.json(c);
  }));
  // Post pictures for boost plans: upload one, or read it from a public Facebook post link.
  const IMG_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
  api.post('/post-img', wrap(async (req, res) => {
    const m = String((req.body || {}).data || '').match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!m) return res.status(400).json({ error: 'Pick a JPG, PNG or WebP picture.' });
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 2.5e6) return res.status(400).json({ error: 'That picture is too big (max 2.5 MB).' });
    res.json({ id: await db.putPostImage(req.user.fb_id, m[1], buf) });
  }));
  api.get('/post-img/:id', wrap(async (req, res) => {
    const im = await db.getPostImage(req.user.fb_id, req.params.id);
    if (!im) return res.status(404).end();
    res.set('content-type', im.mime).set('cache-control', 'private, max-age=31536000, immutable').send(im.data);
  }));
  const FB_HOST = /^(?:www\.|m\.|web\.|mbasic\.)?(?:facebook\.com|fb\.watch|fb\.com)$/i;
  async function fbGet(url, hops = 0) {
    const u = new URL(url); if (u.protocol !== 'https:' || !FB_HOST.test(u.hostname)) throw new Error('Paste a facebook.com post link.');
    const r = await fetch(u, { redirect: 'manual', headers: { 'user-agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)', 'accept-language': 'en' }, signal: AbortSignal.timeout(8000) });
    if (r.status >= 300 && r.status < 400 && r.headers.get('location') && hops < 3) return fbGet(new URL(r.headers.get('location'), u).toString(), hops + 1);
    if (!r.ok) throw new Error('Facebook said ' + r.status);
    return (await r.text()).slice(0, 1.5e6);
  }
  const unesc = (x) => require('../plan').unent(String(x || '')).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  api.post('/post-preview', wrap(async (req, res) => {
    const url = String((req.body || {}).url || '').trim();
    let html; try { html = await fbGet(url); } catch (e) { return res.status(400).json({ error: (e.message.startsWith('Paste') ? e.message : 'Could not open that post') + ' — upload the picture instead.' }); }
    const meta = (k) => { const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${k}["'][^>]*content=["']([^"']+)`, 'i')) || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${k}["']`, 'i')); return m ? unesc(m[1]) : ''; };
    const imgUrl = meta('og:image'), title = (meta('og:description') || meta('og:title')).replace(/\s+/g, ' ').slice(0, 120);
    if (!imgUrl) return res.status(404).json({ error: 'That post has no public picture — upload it instead.', title });
    let iu; try { iu = new URL(imgUrl); } catch (_) { return res.status(404).json({ error: 'No picture found — upload it instead.', title }); }
    if (iu.protocol !== 'https:' || !/(^|\.)(fbcdn\.net|facebook\.com)$/i.test(iu.hostname)) return res.status(404).json({ error: 'No picture found — upload it instead.', title });
    const r = await fetch(iu, { signal: AbortSignal.timeout(10000) }).catch(() => null);
    const mime = r && (r.headers.get('content-type') || '').split(';')[0];
    if (!r || !r.ok || !IMG_TYPES.includes(mime)) return res.status(404).json({ error: 'Could not download the picture — upload it instead.', title });
    const buf = Buffer.from(await r.arrayBuffer()); if (buf.length > 2.5e6) return res.status(400).json({ error: 'Picture too big — upload a smaller one.', title });
    res.json({ img: await db.putPostImage(req.user.fb_id, mime, buf), title });
  }));
  // Boost plan: monthly budget + lives a day, its pace, and sending it to Telegram.
  api.put('/clients/:id/boost-plan', wrap(async (req, res) => {
    const c = (await db.listClients(req.user.fb_id)).find((x) => x.id === Number(req.params.id));
    if (!c) return res.status(404).json({ error: 'Client not found.' });
    const b = req.body || {}, cur = c.plan || {}, old = (cur.lines || []);
    let plan;
    // Past plans are kept (owner, 19 Nov 2026): a new plan or "Delete" moves the current one to plan.past instead of losing it.
    const keep = (pl) => ({ lines: pl.lines || [], tax: !!pl.tax, sentAt: pl.sentAt || null, at: new Date().toISOString(), by: req.user.buyer ? req.user.buyer.name : req.user.name });
    if (Number.isInteger(b.restore)) { // bring a past plan back; the current one takes its place in the list
      const past = [...(cur.past || [])], back = past[b.restore]; if (!back) return res.status(400).json({ error: 'That past plan is no longer there.' });
      past.splice(b.restore, 1); if (old.length) past.unshift(keep(cur));
      plan = { ...cur, lines: back.lines || [], tax: !!back.tax, sentAt: back.sentAt || null, past: past.slice(0, 20) };
    } else if (Number.isInteger(b.forget)) { const past = [...(cur.past || [])]; past.splice(b.forget, 1); plan = { ...cur, past };
    } else {
      plan = require('../plan').clean(b, cur);
      if (Array.isArray(b.lines) && b.sentAt === null && old.length) plan.past = [keep(cur), ...(cur.past || [])].slice(0, 20);
      // a campaign whose line a person took out of the plan is not added again by itself (src/autoplan.js)
      if (Array.isArray(b.lines)) { const still = new Set(plan.lines.map((l) => l.camp).filter(Boolean)), gone = old.map((l) => l.camp).filter((x) => x && !still.has(x)); if (gone.length) plan.noAuto = [...new Set([...(cur.noAuto || []), ...gone])].slice(-300); }
    }
    // The ad account on a line must be one of this workspace's own; its name is taken from our list.
    if ((plan.lines || []).some((l) => l.account)) {
      const mine = new Map((await db.listAccounts(req.user.fb_id)).map((a) => [a.id, a.name || a.id]));
      for (const l of plan.lines) { if (l.account && !mine.has(l.account)) l.account = ''; l.accountName = l.account ? String(mine.get(l.account)).slice(0, 120) : ''; }
    } else for (const l of plan.lines || []) l.accountName = '';
    res.json(await db.updateClient(req.user.fb_id, c.id, { plan }));
  }));
  api.get('/clients/:id/boost-plan/message', wrap(async (req, res) => {
    const P = require('../plan'), c = (await db.listClients(req.user.fb_id)).find((x) => x.id === Number(req.params.id));
    if (!c) return res.status(404).json({ error: 'Client not found.' });
    const only = String(req.query.only || '') ? String(req.query.only).split(',').map(Number) : null, pl = P.subset(c.plan, only).plan;
    if (!P.totals(pl).budget) return res.status(400).json({ error: 'Add at least one post with a daily budget first.' });
    res.json({ text: P.message(c, pl, req.query.lang === 'km' ? 'km' : 'en'), teamGroup: !!cfg.telegramChatId });
  }));
  // Delete the plan last sent to the client's Telegram group (sent by mistake / wrong plan) — within 48 hours.
  api.post('/clients/:id/boost-plan/unsend', wrap(async (req, res) => {
    const c = (await db.listClients(req.user.fb_id)).find((x) => x.id === Number(req.params.id));
    if (!c) return res.status(404).json({ error: 'Client not found.' });
    try { res.json(await require('../plan').unsend(req.user.fb_id, c)); } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  }));
  api.get('/clients/:id/boost-plan/progress', wrap(async (req, res) => {
    const c = (await db.listClients(req.user.fb_id)).find((x) => x.id === Number(req.params.id));
    if (!c) return res.status(404).json({ error: 'Client not found.' });
    res.json(await require('../plan').progress(req.user.fb_id, c));
  }));
  api.post('/clients/:id/boost-plan/send', wrap(async (req, res) => {
    const c = (await db.listClients(req.user.fb_id)).find((x) => x.id === Number(req.params.id));
    if (!c) return res.status(404).json({ error: 'Client not found.' });
    const b = req.body || {};
    const text = typeof b.text === 'string' && b.text.trim() ? b.text.replace(/\u0000/g, '').trim() : '';
    if (text.length > 4000) return res.status(400).json({ error: 'The message is too long for Telegram (4,000 letters at most). Shorten it a little.' });
    res.json(await require('../plan').send(req.user.fb_id, c, { to: b.to === 'team' ? 'team' : 'client', lang: b.lang === 'km' ? 'km' : 'en', topic: String(b.topic || ''), only: Array.isArray(b.only) ? b.only.slice(0, 30) : null, text, replace: !!b.replace }));
  }));
  api.delete('/clients/:id', wrap(async (req, res) => { await db.deleteClient(req.user.fb_id, Number(req.params.id)); await sync.rematch(req.user); res.json({ ok: true }); }));

  // Days
  api.get('/day/:day', wrap(async (req, res) => {
    if (!isDay(req.params.day)) return res.status(400).json({ error: 'Bad date.' });
    res.json(await db.getDay(req.user.fb_id, req.params.day));
  }));
  const UNSAFE_KEY = new Set(['__proto__', 'constructor', 'prototype']);
  function deepMerge(t, s) {
    for (const k of Object.keys(s)) {
      if (UNSAFE_KEY.has(k)) continue; // never let a request body reach Object.prototype
      if (s[k] && typeof s[k] === 'object' && !Array.isArray(s[k])) { t[k] = t[k] && typeof t[k] === 'object' ? t[k] : {}; deepMerge(t[k], s[k]); }
      else t[k] = s[k];
    }
    return t;
  }
  api.patch('/day/:day/:clientId', wrap(async (req, res) => {
    const { day, clientId } = req.params;
    if (!isDay(day)) return res.status(400).json({ error: 'Bad date.' });
    if (!(await db.ownsClient(req.user.fb_id, Number(clientId)))) return res.status(404).json({ error: 'Client not found.' });
    const e = deepMerge(await db.getEntry(req.user.fb_id, day, Number(clientId)), req.body || {});
    await db.putEntry(req.user.fb_id, day, Number(clientId), e);
    res.json(e);
  }));
  api.post('/sync/:day', wrap(async (req, res) => {
    if (!isDay(req.params.day)) return res.status(400).json({ error: 'Bad date.' });
    res.json(await sync.syncDay(req.params.day, req.user));
  }));
  // Main sync: the last 30 days (or the month containing ?around= when that's older), in one pass.
  // Live progress of each admin's running sync (one at a time per admin; admins don't block each other).
  const progressByUser = new Map();
  const getProg = (id) => progressByUser.get(id) || { running: false };
  api.get('/sync-progress', (req, res) => {
    const p = getProg(req.user.fb_id);
    res.json({ ...p, elapsed: p.startedAt ? Math.round((Date.now() - p.startedAt) / 1000) : 0 });
  });
  api.post('/sync-recent', wrap(async (req, res) => {
    const me = req.user.fb_id;
    if (getProg(me).running || sync.isBusy(me)) return res.status(409).json({ error: 'A sync is already running for you (another tab or an automatic refresh). Try again in a moment.', busy: true });
    const today = sync.todayIn();
    const from30 = sync.addDays(today, -29);
    const around = isDay(req.body?.around) ? req.body.around : today;
    let from = from30, to = today;
    const rf = req.body?.from, rt = req.body?.to;
    if (isDay(rf) && isDay(rt) && rf <= rt && rf < from30) {
      // Looking at an older period on the Dashboard: sync exactly that period (up to ~3 months at a time).
      from = rf; to = rt > today ? today : rt;
      if ((Date.parse(to) - Date.parse(from)) / 864e5 > 92) from = sync.addDays(to, -92);
    } else if (around < from30) { // looking at an older day: sync that whole month
      from = around.slice(0, 8) + '01';
      const last = new Date(Date.UTC(Number(around.slice(0, 4)), Number(around.slice(5, 7)), 0)).getUTCDate();
      to = around.slice(0, 8) + String(last).padStart(2, '0');
    }
    const startedAt = Date.now();
    progressByUser.set(me, { running: true, phase: 'starting', done: 0, total: 0, account: '', from, to, startedAt });
    let r;
    try {
      r = await sync.exclusive(me, () => sync.syncRange(from, to, req.user, (p) => progressByUser.set(me, { ...getProg(me), ...p })));
      if (!r) return res.status(409).json({ error: 'An automatic refresh is running right now. Try again in a moment.', busy: true });
    }
    finally { progressByUser.set(me, { running: false, lastSeconds: Math.round((Date.now() - startedAt) / 1000) }); }
    res.json({ ...r, from, to });
  }));
  // Backfill past days, e.g. the whole month: { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' } (max 93 days).
  api.post('/sync-range', wrap(async (req, res) => {
    const { from, to } = req.body || {};
    if (!isDay(from) || !isDay(to) || from > to) return res.status(400).json({ error: 'Pick a valid date range.' });
    const today = sync.todayIn();
    const until = to > today ? today : to;
    if ((Date.parse(until) - Date.parse(from)) / 864e5 > 92) return res.status(400).json({ error: 'Sync at most 3 months at a time.' });
    res.json(await sync.syncRange(from, until, req.user));
  }));
  // Day entries for any range (the dashboard's per-client breakdown).
  api.get('/entries', wrap(async (req, res) => {
    const { from, to } = req.query;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '') || from > to) return res.status(400).json({ error: 'Pick a valid date range.' });
    res.json(await db.monthEntries(req.user.fb_id, from, to));
  }));
  api.get('/month/:ym', wrap(async (req, res) => {
    const m = String(req.params.ym).match(/^(\d{4})-(\d{2})$/);
    if (!m) return res.status(400).json({ error: 'Bad month.' });
    const last = new Date(Number(m[1]), Number(m[2]), 0).getDate();
    res.json(await db.monthEntries(req.user.fb_id, `${m[1]}-${m[2]}-01`, `${m[1]}-${m[2]}-${last}`));
  }));

  // Result of the last sync's completeness check (per ad account: Meta total vs found)
  api.get('/sync-check', wrap(async (req, res) => res.json(await db.getUserSetting(req.user.fb_id, 'lastSyncCheck', null))));

  // Dashboard: per-client totals for a day or a month (?from=YYYY-MM-DD&to=YYYY-MM-DD, max 93 days)
  return { deepMerge };
};
