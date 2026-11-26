// Client reports: preview, picture, send, delete; summary and day report
// Moved out of server.js unchanged; server.js mounts it at the same place, so route order is kept.
const db = require('../db');
const reportImage = require('../reportImage');
const reports = require('../reports');
const sync = require('../sync');
const telegram = require('../telegram');

module.exports = function mountClientReports(app, api, deps) {
  const { chatsNow, deepMerge, isDay, kindOf, linkCode, partsOf, rangeOk, wrap } = deps;
  async function myChats(fbId) {
    const all = await chatsNow();
    const used = new Set((await db.listClients(fbId)).map((c) => c.telegram).filter(Boolean));
    for (const c of await db.listClients(fbId)) for (const v of Object.values(c.topics || {})) used.add(v.id);
    return all.filter((c) => (c.owners || [c.owner]).includes(fbId) || used.has(c.id)).map(({ id, title, type, chat, topic }) => ({ id, title, type, chat, topic }));
  }
  api.get('/telegram/chats', wrap(async (req, res) => {
    res.json({ chats: await myChats(req.user.fb_id), code: await linkCode(req.user.fb_id), bot: await telegram.username() });
  }));
  // skip: Pages left out of the report (JSON list of Page IDs / names), unticked on the Dashboard.
  function skipOf(v) {
    let a = v; if (typeof v === 'string') { try { a = JSON.parse(v); } catch (_) { a = []; } }
    return Array.isArray(a) ? a.map((x) => String(x || '').trim().slice(0, 150)).filter(Boolean).slice(0, 50) : [];
  }
  const skipScope = (skip) => (skip.length ? { exclude: skip } : null);
  api.get('/client-report/:id', wrap(async (req, res) => {
    const { from, to } = req.query;
    if (!rangeOk(from, to)) return res.status(400).json({ error: 'Pick a valid date or month.' });
    const kind = kindOf(req.query.kind), parts = partsOf(req.query.parts), skip = skipOf(req.query.skip), orders = req.query.orders !== '0';
    const c = (await db.listClients(req.user.fb_id)).find((x) => x.id === Number(req.params.id));
    if (c && to === sync.todayIn()) { try { await sync.freshenToday(req.user, c.id, to); } catch (e) { console.error('[report] fresh spend:', e.message); } } // today's numbers straight from Meta, like the picture
    // does the client have both Lives and posts in this period? Then the dialog offers "All · Live · Post" (20 Nov 2026)
    let mix = null; if (c) { try { const m = await reportImage.clientCampaigns(req.user.fb_id, c.id, from, to); mix = { live: m.lives > 0, post: m.posts > 0 }; } catch (_) {} }
    const rts = c ? reports.routes(c) : [];
    if (rts.length > 1) { // Pages that report to their own topics: one text per Page
      const list = await reports.preview(req.user.fb_id, c, from, to, { kind, parts, skip, orders });
      const r = await sync.clientReport(req.user.fb_id, req.params.id, from, to, kind, parts, skipScope(skip), { orders });
      return res.json({ ...r, routes: list, mix });
    }
    res.json({ ...(await sync.clientReport(req.user.fb_id, req.params.id, from, to, kind, parts, skipScope(skip), { orders })), mix });
  }));
  // The ads picture for a client's report (PNG). 204 = no ads with spend in the period.
  const imgCache = new Map(); // short-lived, so the preview and the send use the same picture
  async function reportPng(user, id, from, to, kind = '', parts = null, skip = []) {
    const k = `${user.fb_id}|${id}|${from}|${to}|${kind}|${(parts || []).join(',')}|${skip.join('¦')}`, hit = imgCache.get(k);
    if (hit && Date.now() - hit.at < 5 * 60000) return hit.png;
    const png = await reportImage.clientReportImage(user, id, from, to, kind, parts, skipScope(skip));
    imgCache.set(k, { png, at: Date.now() });
    for (const [kk, v] of imgCache) if (Date.now() - v.at > 5 * 60000) imgCache.delete(kk);
    return png;
  }
  api.get('/client-report/:id/image', wrap(async (req, res) => {
    const { from, to } = req.query;
    if (!rangeOk(from, to)) return res.status(400).json({ error: 'Pick a valid date or month.' });
    const kind = kindOf(req.query.kind), parts = partsOf(req.query.parts), skip = skipOf(req.query.skip);
    if (req.query.page != null && req.query.page !== '') { // one Page's picture
      const c = (await db.listClients(req.user.fb_id)).find((x) => x.id === Number(req.params.id));
      const r = c && reports.routes(c, skip).find((x) => x.key === String(req.query.page));
      if (!r) return res.status(404).json({ error: 'That Page has no topic.' });
      const png = await reportImage.clientReportImage(req.user, req.params.id, from, to, kind, parts, r.scope);
      if (!png) return res.status(204).end();
      return res.set('content-type', 'image/png').set('cache-control', 'no-store').send(png);
    }
    if (req.query.fresh) imgCache.delete(`${req.user.fb_id}|${req.params.id}|${from}|${to}|${kind}|${(parts || []).join(',')}|${skip.join('¦')}`);
    const png = await reportPng(req.user, req.params.id, from, to, kind, parts, skip);
    if (!png) return res.status(204).end();
    res.set('content-type', 'image/png').set('cache-control', 'no-store').send(png);
  }));
  // Reports sent in the last 48 hours (Telegram lets a bot delete its own messages only that long),
  // so they can be deleted from the group. Per user: { 'clientId|from|to': { at, by, to, msgs: [{ chat, id }] } }.
  const SENT_KEEP = 48 * 3600e3;
  async function sentReports(owner) {
    const all = (await db.getUserSetting(owner, 'sentReports', {})) || {}, out = {};
    for (const [k, v] of Object.entries(all)) if (v && Date.now() - Date.parse(v.at) < SENT_KEEP) out[k] = v;
    return out;
  }
  async function rememberSent(user, id, from, to, msgs, sentTo) {
    if (!msgs.length) return;
    const all = await sentReports(user.fb_id), k = `${Number(id)}|${from}|${to}`;
    const old = all[k] ? all[k].msgs : []; // sent again: Delete removes every copy
    all[k] = { at: new Date().toISOString(), by: user.name, to: sentTo, msgs: [...old, ...msgs].slice(-40) };
    await db.setUserSetting(user.fb_id, 'sentReports', all);
  }
  api.get('/sent-reports', wrap(async (req, res) => {
    const all = await sentReports(req.user.fb_id);
    res.json(Object.fromEntries(Object.entries(all).map(([k, v]) => [k, { at: v.at, by: v.by, to: v.to, count: v.msgs.length }])));
  }));
  api.post('/client-report/:id/delete', wrap(async (req, res) => {
    const { from, to } = req.body || {};
    if (!rangeOk(from, to)) return res.status(400).json({ error: 'Pick a valid date or month.' });
    const all = await sentReports(req.user.fb_id), k = `${Number(req.params.id)}|${from}|${to}`, rec = all[k];
    if (!rec) return res.status(404).json({ error: 'No report sent in the last 48 hours for this period — delete it in Telegram instead (group admins can).' });
    let ok = 0;
    for (const m of rec.msgs) if (await telegram.remove(m.chat, m.id)) ok++;
    delete all[k]; await db.setUserSetting(req.user.fb_id, 'sentReports', all);
    if (from === to && isDay(from)) { const id = Number(req.params.id); await db.putEntry(req.user.fb_id, from, id, deepMerge(await db.getEntry(req.user.fb_id, from, id), { reportSent: null })); }
    res.json({ ok: true, deleted: ok, failed: rec.msgs.length - ok });
  }));
  api.post('/client-report/:id/send', wrap(async (req, res) => {
    const { from, to, text, withImage } = req.body || {}, kind = kindOf((req.body || {}).kind), parts = partsOf((req.body || {}).parts), skip = skipOf((req.body || {}).skip), orders = (req.body || {}).orders !== false;
    if (!rangeOk(from, to)) return res.status(400).json({ error: 'Pick a valid date or month.' });
    const cl = (await db.listClients(req.user.fb_id)).find((x) => x.id === Number(req.params.id));
    if (cl && reports.routes(cl).length > 1) { // each Page to its own topic (or just the one picked in the dialog)
      const page = (req.body || {}).page;
      const track = [];
      const done = await reports.send(req.user, cl, from, to, { kind, parts, withImage: withImage !== false, only: page != null && page !== '' ? String(page) : null, text, skip, track, orders });
      if (!done.length) return res.status(400).json({ error: 'No boost spend to report for these Pages.' });
      await rememberSent(req.user, cl.id, from, to, track, done.map((d) => d.to).join(', '));
      const sentAt = new Date().toISOString();
      if (from === to && isDay(from) && (page == null || page === '')) await db.putEntry(req.user.fb_id, from, cl.id, deepMerge(await db.getEntry(req.user.fb_id, from, cl.id), { reportSent: { at: sentAt, by: req.user.name } }));
      return res.json({ ok: true, sentTo: done.map((d) => d.to).join(', '), sent: done, sentAt, withImage: done.some((d) => d.withImage) });
    }
    const r = await sync.clientReport(req.user.fb_id, req.params.id, from, to, kind, parts, skipScope(skip), { orders });
    if (!r.client.telegram) return res.status(400).json({ error: `${r.client.name} has no Telegram group yet. Pick one in the Clients tab.` });
    const body = typeof text === 'string' && text.trim() ? text.slice(0, 12000) : r.text;
    let png = null;
    if (withImage !== false) { try { png = await reportPng(req.user, req.params.id, from, to, kind, parts, skip); } catch (e) { if (e.needsLogin) throw e; console.error('[report image]', e.message); } }
    const track = [];
    if (png) await telegram.sendPhoto(png, body, r.client.telegram, track);
    else await telegram.send(body, r.client.telegram, track);
    await rememberSent(req.user, req.params.id, from, to, track, r.client.telegramTitle || r.client.telegram);
    const sentAt = new Date().toISOString();
    // A one-day report is remembered on that day's checklist ("Sent 21:05").
    if (from === to && isDay(from)) {
      const id = Number(req.params.id);
      await db.putEntry(req.user.fb_id, from, id, deepMerge(await db.getEntry(req.user.fb_id, from, id), { reportSent: { at: sentAt, by: req.user.name } }));
    }
    res.json({ ok: true, sentTo: r.client.telegramTitle || r.client.telegram, sentAt, withImage: !!png });
  }));
  api.get('/summary', wrap(async (req, res) => {
    const { from, to } = req.query;
    if (!rangeOk(from, to)) return res.status(400).json({ error: 'Pick a valid date or month.' });
    res.json({ text: await sync.summaryReport(req.user.fb_id, from, to) });
  }));
  api.post('/summary/send', wrap(async (req, res) => {
    const { from, to, text } = req.body || {};
    if (!rangeOk(from, to)) return res.status(400).json({ error: 'Pick a valid date or month.' });
    await telegram.send(typeof text === 'string' && text.trim() ? text.slice(0, 12000) : await sync.summaryReport(req.user.fb_id, from, to));
    res.json({ ok: true });
  }));
  api.get('/report/:day', wrap(async (req, res) => {
    if (!isDay(req.params.day)) return res.status(400).json({ error: 'Bad date.' });
    res.json({ text: await sync.buildReport(req.user.fb_id, req.params.day) });
  }));
  api.post('/report/:day/send', wrap(async (req, res) => {
    if (!isDay(req.params.day)) return res.status(400).json({ error: 'Bad date.' });
    const text = await sync.buildReport(req.user.fb_id, req.params.day);
    await telegram.send(text);
    res.json({ ok: true });
  }));

};
