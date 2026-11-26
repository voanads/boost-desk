// Weekly AI strategy per client, and merging duplicate clients
// Moved out of server.js unchanged; server.js mounts it at the same place, so route order is kept.
const crypto = require('crypto');
const db = require('../db');
const sync = require('../sync');
const telegram = require('../telegram');

module.exports = function mountStrategyMerge(app, api, deps) {
  const { AI, ownClient, wrap } = deps;
  // ---- Weekly AI strategy per client (19 Nov 2026): a draft for the team; only a PM can send it to the client ----
  const aiErr = (res, e) => { if (e.status) return res.status(e.status).json({ error: e.message, notSetUp: !!e.notSetUp }); throw e; };
  const pmOnly = (req, res) => { if (req.user.buyer) { res.status(403).json({ error: 'Only the Project Manager can do this.' }); return false; } return true; };
  api.get('/clients/:id/strategy', wrap(async (req, res) => {
    if (!(await ownClient(req))) return res.status(404).json({ error: 'Client not found.' });
    const w = (await AI().workbook(req.user.fb_id, req.params.id)).weekly;
    res.json({ on: (await AI().weeklyPick(req.user.fb_id)).includes(Number(req.params.id)), weekly: w, week: AI().weekRange(), canSend: true });
  }));
  api.put('/clients/:id/strategy', wrap(async (req, res) => {
    if (!(await ownClient(req))) return res.status(404).json({ error: 'Client not found.' });
    const b = req.body || {};
    if ('on' in b) await AI().setWeeklyPick(req.user.fb_id, req.params.id, !!b.on);
    let weekly = (await AI().workbook(req.user.fb_id, req.params.id)).weekly;
    if (typeof b.text === 'string') { try { weekly = await AI().saveWeeklyText(req.user.fb_id, req.params.id, b.lang === 'en' ? 'en' : 'km', b.text); } catch (e) { return aiErr(res, e); } }
    res.json({ on: (await AI().weeklyPick(req.user.fb_id)).includes(Number(req.params.id)), weekly });
  }));
  api.post('/clients/:id/strategy/run', wrap(async (req, res) => {
    if (!(await ownClient(req))) return res.status(404).json({ error: 'Client not found.' });
    try { res.json({ weekly: await AI().weeklyStrategy(req.user.fb_id, req.params.id, { force: !!(req.body || {}).force }) }); } catch (e) { return aiErr(res, e); }
  }));
  // The three actions become Clients Tasks of this client (once).
  api.post('/clients/:id/strategy/tasks', wrap(async (req, res) => {
    if (!(await ownClient(req))) return res.status(404).json({ error: 'Client not found.' });
    const w = await AI().workbook(req.user.fb_id, req.params.id), wk = w.weekly; if (!wk) return res.status(400).json({ error: 'There is no weekly strategy yet.' });
    const acts = ((req.body || {}).lang === 'en' ? wk.actionsEn : wk.actionsKm) || []; if (!acts.length) return res.status(400).json({ error: 'This strategy has no actions to add.' });
    const today = sync.todayIn(); let added = 0;
    for (const t of acts) if (!w.tasks.some((x) => x.text === t && !x.done)) { w.tasks.push({ id: crypto.randomBytes(5).toString('hex'), text: t, from: 'weekly', day: today, done: false, by: req.user.name }); added++; }
    wk.tasksAt = new Date().toISOString(); await AI().saveWorkbook(req.user.fb_id, req.params.id, w);
    res.json({ added, weekly: wk });
  }));
  // Send to the client's Telegram group — the PM's decision, in Khmer, English or both.
  api.post('/clients/:id/strategy/send', wrap(async (req, res) => {
    const c = await ownClient(req); if (!c) return res.status(404).json({ error: 'Client not found.' });
    if (!telegram.hasBot()) return res.status(400).json({ error: 'Telegram is not set up yet.' });
    if (!c.telegram) return res.status(400).json({ error: `${c.name} has no Telegram group yet. Pick one in the Clients tab.` });
    const w = await AI().workbook(req.user.fb_id, req.params.id), wk = w.weekly; if (!wk || !wk.km) return res.status(400).json({ error: 'There is no weekly strategy yet.' });
    const lang = ['km', 'en', 'both'].includes((req.body || {}).lang) ? req.body.lang : 'km';
    try { await telegram.send(AI().weeklyMessage(c.name, wk, lang), c.telegram); } catch (e) { return res.status(502).json({ error: 'Telegram did not take the message: ' + e.message }); }
    wk.sent = { at: new Date().toISOString(), by: req.user.name, lang, to: c.telegram_title || '' }; await AI().saveWorkbook(req.user.fb_id, req.params.id, w);
    res.json({ weekly: wk });
  }));
  // ---- Merge a duplicate client into another (19 Nov 2026): after two accounts were merged the same client can be there twice ----
  // The client that stays keeps its name, settings and saved days. From the duplicate it takes: Page names, the Telegram group
  // (if it has none), days it has no entry for, invoices, notes, open tasks and boost plans. Then the duplicate is removed and
  // every saved day is matched again, so the spend lands on the client that stays.
  async function mergeClients(user, aId, bId, { rematch = true } = {}) {
    const owner = user.fb_id, list = await db.listClients(owner), A = list.find((x) => x.id === Number(aId)), B = list.find((x) => x.id === Number(bId));
    if (!A || !B || A.id === B.id) throw Object.assign(new Error('Choose two different clients of yours.'), { status: 400 });
    if (rematch && sync.isBusy(owner)) throw Object.assign(new Error('A sync is running right now. Try again in a minute.'), { status: 409 });
    const low = (x) => String(x || '').trim().toLowerCase(), have = new Set([A.name, A.match, ...(A.pages || [])].map(low));
    const pages = [...(A.pages || [])]; for (const x of [B.name, B.match, ...(B.pages || [])]) { const k = low(x); if (k && !have.has(k)) { have.add(k); pages.push(String(x).trim()); } }
    const planA = A.plan || {}, planB = B.plan || {}, pastB = [...((planB.lines || []).length ? [{ lines: planB.lines, tax: !!planB.tax, sentAt: planB.sentAt || null, at: new Date().toISOString(), by: `merged from ${B.name}` }] : []), ...(planB.past || [])];
    const plan = (planA.lines || []).length || !(planB.lines || []).length ? { ...planA, past: [...(planA.past || []), ...pastB].slice(0, 20) } : { ...planB, past: [...(planA.past || []), ...(planB.past || [])].slice(0, 20) };
    const type = A.type === B.type ? A.type : 'both';
    const c = await db.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('UPDATE day_entries SET client_id=$1 WHERE client_id=$2 AND day NOT IN (SELECT day FROM day_entries WHERE client_id=$1)', [A.id, B.id]);
      await c.query('UPDATE invoices SET client_id=$1 WHERE client_id=$2 AND owner=$3', [A.id, B.id, owner]);
      const wk = (id) => `${owner}:cwb:${id}`, get = async (k) => ((await c.query('SELECT value FROM settings WHERE key=$1', [k])).rows[0] || {}).value;
      const wa = (await get(wk(A.id))) || {}, wb = await get(wk(B.id));
      if (wb) {
        const notes = [wa.notes, wb.notes].map((x) => String(x || '').trim()).filter(Boolean).join('\n\n').slice(0, 5000);
        const tasks = [...(Array.isArray(wa.tasks) ? wa.tasks : []), ...(Array.isArray(wb.tasks) ? wb.tasks : []).filter((t) => t && !t.done)];
        await c.query('INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2', [wk(A.id), JSON.stringify({ ...wb, ...wa, notes, notesAt: wa.notesAt || wb.notesAt || null, tasks, log: [...(Array.isArray(wa.log) ? wa.log : []), ...(Array.isArray(wb.log) ? wb.log : [])].slice(-400) })]);
        await c.query('DELETE FROM settings WHERE key=$1', [wk(B.id)]);
      }
      await c.query('UPDATE clients SET pages=$3, plan=$4, type=$5, telegram=$6, telegram_title=$7 WHERE id=$1 AND owner=$2', [A.id, owner, JSON.stringify(pages.slice(0, 60)), JSON.stringify(plan), type, A.telegram || B.telegram || '', A.telegram ? A.telegram_title || '' : B.telegram_title || '']);
      await c.query('DELETE FROM clients WHERE id=$1 AND owner=$2', [B.id, owner]);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
    console.log(`[client merge] ${user.name}: "${B.name}" (#${B.id}) into "${A.name}" (#${A.id})`);
    if (rematch) { try { await sync.exclusive(owner, () => sync.rematch(user)); } catch (e) { console.error('[client merge] rematch failed:', e.message); } }
    return (await db.listClients(owner)).find((x) => x.id === A.id);
  }
  // Every group of clients with the same name in one workspace becomes one client (owner's decision, 19 Nov 2026: for every
  // team, and from now on after an account merge). The one with the most spend this month stays (an active one before a
  // paused one). All spend is matched again once at the end; this month's spend per name is logged before and after.
  const sameName = (list) => { const g = {}; for (const c of list) { const k = String(c.name || '').trim().toLowerCase(); if (k) (g[k] = g[k] || []).push(c); } return Object.values(g).filter((x) => x.length > 1); };
  async function dedupeClients(user) {
    const owner = user.fb_id, dups = sameName(await db.listClients(owner)); if (!dups.length) return { groups: 0, removed: 0, bad: [] };
    const today = sync.todayIn(), from = today.slice(0, 8) + '01', r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
    const spendOf = async () => Object.fromEntries(((await sync.dashboard(owner, from, today)).clients || []).map((x) => [x.id, x.spend || 0]));
    const before = await spendOf(), plan = [];
    for (const g of dups) { const o = g.slice().sort((a, b) => (!!a.archived - !!b.archived) || (before[b.id] || 0) - (before[a.id] || 0) || a.id - b.id); plan.push({ keep: o[0], rest: o.slice(1), sum: r2(g.reduce((t, c) => t + (before[c.id] || 0), 0)) }); }
    let removed = 0;
    for (const p of plan) for (const b of p.rest) { try { await mergeClients(user, p.keep.id, b.id, { rematch: false }); removed++; } catch (e) { console.error(`[dedupe] ${user.name}: ${b.name} #${b.id} failed:`, e.message); } }
    let matched = false;
    for (let i = 0; i < 20 && !matched; i++) { const r = await sync.exclusive(owner, async () => { await sync.rematch(user); return true; }).catch((e) => { console.error('[dedupe] rematch failed:', e.message); return true; }); if (r) matched = true; else await new Promise((ok) => setTimeout(ok, 30e3)); }
    const after = await spendOf(), bad = [];
    for (const p of plan) { const a = r2(after[p.keep.id]); const ok = Math.abs(a - p.sum) < 0.01; if (!ok) bad.push(p.keep.name); console.log(`[dedupe] ${user.name}: ${p.keep.name} ×${p.rest.length + 1} → #${p.keep.id} · this month before $${p.sum.toFixed(2)}, after $${a.toFixed(2)} ${ok ? '✓' : '✗ DIFFERENT'}`); }
    console.log(`[dedupe] ${user.name}: ${plan.length} names, ${removed} duplicate clients removed${matched ? '' : ' — spend NOT matched again yet (a sync was running)'}${bad.length ? ` — ${bad.length} with a different total: ${bad.join(', ')}` : ''}`);
    return { groups: plan.length, removed, bad };
  }
  api.post('/clients/:id/merge-from', wrap(async (req, res) => {
    if (!pmOnly(req, res)) return;
    try { res.json({ ok: true, client: await mergeClients(req.user, req.params.id, (req.body || {}).from) }); } catch (e) { if (e.status) return res.status(e.status).json({ error: e.message }); throw e; }
  }));
  return { dedupeClients, mergeClients, sameName };
};
