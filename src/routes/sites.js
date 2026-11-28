// Media buyer site, the login wall and the four sites (/mediabuyer, /owner, /projectmanager, /admin)
// Moved out of server.js unchanged; server.js mounts it at the same place, so route order is kept.
const db = require('../db');
const orders = require('../orders');
const pageOrders = require('../pageOrders');
const sync = require('../sync');
const telegram = require('../telegram');

module.exports = function mountSites(app, api, deps) {
  const { lastSeenMem, sitePerson, wrap } = deps;
  // ---------- Media buyer dashboard (/mb) ----------
  // Media buyers have no Boost Desk account: the Telegram bot gives them a signed link (60 days) that opens
  // their own page — today's tasks, target, monthly KPI, clients and history. They can tick tasks and type
  // what they reached, the same as tapping ✅ Done in Telegram.
  const MB = () => require('../buyers');
  app.get(['/mediabuyer/login', '/mb/login'], wrap(async (req, res) => {
    const { b, e, s: sig } = req.query;
    if (!MB().checkLink(b, e, sig) || !(await MB().get(b))) return res.status(400).send('<meta charset="utf-8"><body style="font-family:system-ui;padding:40px;text-align:center"><h2>This link is old or wrong</h2><p>Open the Boost Desk bot on Telegram and send <b>/dashboard</b> to get a new one.</p>');
    req.session.mb = String(b); req.session.mbAt = Date.now();
    const cid = String(req.query.c || ''); // from a task message: open that client's page
    res.redirect(/^\d{1,10}$/.test(cid) ? '/mediabuyer#client:' + cid : '/mediabuyer#dashboard');
  }));
  const MB_LOGIN_PAGE = '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:system-ui;padding:40px 20px;text-align:center;color:#0F172A"><h2>Media buyer site</h2><p>Open the Boost Desk bot on Telegram and send <b>/dashboard</b> — it replies with your personal link.</p>';
  app.get(['/mediabuyer', '/mediabuyer/'], wrap(async (req, res) => {
    const b = req.session && req.session.mb ? await MB().get(req.session.mb) : null;
    const fbUser = !b && req.session && req.session.fbId ? await db.getUser(req.session.fbId) : null; // a PM / owner looking at the buyer site
    if (!b && !fbUser) return res.status(401).send(MB_LOGIN_PAGE);
    const html = require('../assets').sitePage(req, 'mb', 'Ads Box · Media buyer');
    res.set('Cache-Control', 'no-cache').send(html);
  }));
  // The old one-page media buyer dashboard (/mb) was removed: the media buyer site is /mediabuyer. Old links land on My Task.
  app.get(['/mediabuyer/tasks', '/mb', '/mb/'], (req, res) => res.redirect('/mediabuyer#mytasks'));

  const mbOnly = wrap(async (req, res, next) => {
    const b = req.session && req.session.mb ? await MB().get(req.session.mb) : null;
    if (!b) return res.status(401).json({ error: 'Open your dashboard from the Telegram bot (/dashboard).', needsLogin: true });
    req.buyer = b; next();
  });
  app.post('/mb/logout', (req, res) => { req.session = null; res.json({ ok: true }); });
  // Facebook → Boost Desk webhook for connected Pages (Messenger messages and comments). GET is Facebook's check when the
  // webhook is set up in the Meta app; POST must carry Facebook's signature made with the app secret.
  app.get('/hooks/meta', wrap(async (req, res) => {
    const qy = req.query || {};
    if (qy['hub.mode'] === 'subscribe' && String(qy['hub.verify_token'] || '') === (await pageOrders.verifyToken())) return res.type('text/plain').send(String(qy['hub.challenge'] || ''));
    res.sendStatus(403);
  }));
  app.post('/hooks/meta', (req, res) => {
    if (!pageOrders.signatureOk(req.rawBody, req.get('X-Hub-Signature-256'))) return res.sendStatus(401);
    res.sendStatus(200); // answer at once; Facebook retries slow webhooks
    pageOrders.handleHook(req.body).catch((e) => console.error('[meta hook]', e.message));
  });
  // Every task assigned to this buyer, across every client workbook, with the day's done / late state.
  async function buyerTasks(buyer, day) {
    const today = sync.todayIn();
    const cl = (await db.pool.query('SELECT id, name, owner, archived, plan FROM clients')).rows, cById = Object.fromEntries(cl.map((c) => [c.id, c]));
    const users = Object.fromEntries((await db.allUsers()).map((u) => [u.fb_id, u.name]));
    const rows = (await db.pool.query(`SELECT key, value FROM settings WHERE key ~ '^[^:]+:cwb:[0-9]+$'`)).rows;
    const localDay = (iso) => { try { return sync.todayIn(undefined, new Date(iso)); } catch (_) { return ''; } };
    const out = [], all = [], logs = [], kpiNames = {};
    for (const r of rows) {
      const [owner, , cid] = r.key.split(':'), c = cById[cid]; if (!c) continue;
      const w = r.value || {};
      for (const x of w.log || []) if (x.by === buyer.name) logs.push({ ...x, client: c.name, clientId: Number(cid) });
      for (const t of w.tasks || []) {
        if (!(t.to && t.to.id === buyer.id)) continue;
        const base = { id: t.id, clientId: Number(cid), client: c.name, owner, pm: users[owner] || '', text: t.text, repeat: !!t.repeat, kpi: t.kpi || '', sentAt: t.sentAt || null, day: t.day };
        all.push({ ...base, done: !!t.done, doneAt: t.doneAt || null });
        const doneDay = t.done && t.doneAt ? localDay(t.doneAt) : '';
        if (t.repeat) { if (t.day > day) continue; out.push({ ...base, done: doneDay === day, doneAt: doneDay === day ? t.doneAt : null, late: false, ...deps.tgt(t, day) }); continue; }
        const late = t.day < day && !t.done && day === today;
        if (t.day !== day && !late && !(doneDay === day)) continue;
        out.push({ ...base, done: !!t.done, doneAt: t.doneAt || null, late, ...deps.tgt(t, t.day) });
      }
    }
    // KPI names for chips
    if (out.length) { try { for (const k of await deps.KPI().getList(buyer.id, today.slice(0, 7))) kpiNames[k.id] = k.name; } catch (_) {} } // the buyer's own KPIs: read once
    out.sort((a, b) => (a.done - b.done) || (b.late - a.late) || a.client.localeCompare(b.client));
    return { tasks: out.map((t) => ({ ...t, kpiName: kpiNames[t.kpi] || '' })), all, logs, clients: cl };
  }
  app.get(['/mb/api/me', '/api/mb/me'], mbOnly, wrap(async (req, res) => {
    const b = req.buyer, today = sync.todayIn(), ym = today.slice(0, 7);
    const { tasks, all, logs, clients } = await buyerTasks(b, today);
    const counts = { done: tasks.filter((t) => t.done).length, open: tasks.filter((t) => !t.done).length, late: tasks.filter((t) => t.late).length };
    const tg = tasks.filter((t) => Number(t.target) > 0), target = { total: tg.reduce((s, t) => s + t.target, 0), reached: tg.reduce((s, t) => s + Math.min(t.reached || 0, t.target), 0), tasks: tg.length };
    target.pct = target.total ? Math.round(target.reached / target.total * 100) : null;
    let kpis = []; try { kpis = await deps.KPI().results(b.id, ym, true); } catch (_) {}
    const scored = kpis.filter((k) => k.target > 0), kpiAvg = scored.length ? Math.round(scored.reduce((s, k) => s + Math.min(k.score, 150), 0) / scored.length) : null;
    // my clients: every client with a task for me, with its boost plan summary
    const plan = require('../plan');
    const myClientIds = [...new Set(all.map((t) => t.clientId))];
    const myClients = clients.filter((c) => myClientIds.includes(c.id) && !c.archived).map((c) => {
      const p = c.plan && !c.plan.hidden ? plan.clean(c.plan) : null, tt = p && p.lines && p.lines.length ? plan.totals(p) : null;
      return { id: c.id, name: c.name, pm: all.find((t) => t.clientId === c.id).pm, open: all.filter((t) => t.clientId === c.id && !t.done).length, plan: tt ? { posts: p.lines.length, total: tt.total, from: tt.from, to: tt.to, sentAt: p.sentAt || null } : null };
    });
    // history: the last 30 days of ticks, newest first; completion rate = done ÷ assigned in that window
    const since = sync.addDays(today, -30);
    const hist = logs.filter((x) => x.day >= since).sort((a, b) => (b.day + b.at).localeCompare(a.day + a.at)).slice(0, 60).map((x) => ({ day: x.day, at: x.at, text: x.text, client: x.client }));
    const assigned = all.filter((t) => t.day >= since), rate = assigned.length ? Math.round(assigned.filter((t) => t.done).length / assigned.length * 100) : null;
    const byDay = {}; for (const x of logs) if (x.day >= sync.addDays(today, -13)) byDay[x.day] = (byDay[x.day] || 0) + 1;
    res.json({ me: { id: b.id, name: b.name, linked: !!b.chat, pm: b.addedBy || '' }, today, month: ym, counts, tasks, target, kpis, kpiAvg, clients: myClients, history: hist, rate, byDay, assigned: assigned.length, notifications: { bot: telegram.hasBot(), linked: !!b.chat } });
  }));
  // Tick a task done (or undo), or type what was reached — the same rules as the PM's page and the Telegram button.
  app.post(['/mb/api/tasks/:cid/:tid', '/api/mb/tasks/:cid/:tid'], mbOnly, wrap(async (req, res) => {
    const b = req.buyer, cid = String(req.params.cid), tid = String(req.params.tid);
    const owner = ((await db.pool.query('SELECT owner FROM clients WHERE id=$1', [cid])).rows[0] || {}).owner;
    if (!owner) return res.status(404).json({ error: 'Client not found.' });
    const w = await deps.AI().workbook(owner, cid), t = (w.tasks || []).find((x) => x.id === tid);
    if (!t || !t.to || t.to.id !== b.id) return res.status(404).json({ error: 'This task is not yours.' });
    const day = sync.todayIn(), body = req.body || {};
    if (body.reached != null && Number(t.target) > 0) { t.hit = t.hit || {}; t.hit[day] = Math.max(0, Number(body.reached) || 0); }
    if (body.done != null) {
      const lid = 't:' + t.id + ':' + day; w.log = (w.log || []).filter((x) => x.id !== lid);
      if (body.done) { const at = new Date().toISOString(); t.done = true; t.doneAt = at; t.doneBy = b.name; w.log.push({ id: lid, day, at, by: b.name, text: t.text, kind: t.repeat ? 'repeat' : 'me' }); }
      else { t.done = false; t.doneAt = null; t.doneBy = null; }
    }
    await deps.AI().saveWorkbook(owner, cid, w);
    res.json({ ok: true });
  }));

  app.use(wrap(async (req, res, next) => {
    let user = req.session.fbId && (await db.getUser(req.session.fbId));
    if (!user && req.session.gEmail) { // signed in with Google on the admin website
      const p = await sitePerson(req.session.gEmail);
      if (!p) { req.session.gEmail = null; }
      else if (p.linkTo && (user = await db.getUser(p.linkTo))) { req.adminSite = true; }
      else { user = { fb_id: 'g:' + p.email, name: req.session.gName || p.name || p.email, token_expires: null, google: true }; req.adminSite = true; }
    }
    // A media buyer (signed in from the Telegram link) works inside their PM's account, with limits:
    // no deleting, pausing or merging clients, nothing in Admin / Profit / KPIs / team. Since 20 Nov 2026 (owner) they do the
    // daily client work like their PM: Sync from Meta, client settings, ad accounts, the weekly strategy. Connecting Pages for orders too (removing one stays with the PM).
    if (!user && req.session.mb) {
      const b = await MB().get(req.session.mb);
      const pmId = b && (b.addedById || Object.fromEntries((await db.allUsers()).map((u) => [u.name, u.fb_id]))[b.addedBy]);
      const pm = pmId && (await db.getUser(pmId));
      if (b && pm) {
        // Express matches routes ignoring letter case and a trailing slash, so the limits below check the path the same way
        // (otherwise /api/clients/5/ or /api/Media-Buyers would get past them).
        const ap = req.path.toLowerCase().replace(/\/+$/, '') + '/';
        if (req.method !== 'GET' && ap.startsWith('/api/') && (
          /^\/api\/(admin|auto-sync|profit|media-buyers|kpis|main|company|team|targets)/.test(ap)
          || (req.method === 'DELETE' && /^\/api\/clients\/\d+\/$/.test(ap))
          || (req.method === 'PATCH' && /^\/api\/clients\/\d+\/$/.test(ap) && req.body && 'archived' in req.body) // pausing a client stays with the PM
        )) return res.status(403).json({ error: 'Media buyers can\'t do this — ask your PM.' });
        if (ap.startsWith('/api/') && /^\/api\/(admin|profit|main|company|auto-sync|kpis\/people|admin\/)/.test(ap)) return res.status(403).json({ error: 'Not available on the media buyer site.' });
        if (!ap.startsWith('/api/') && !ap.startsWith('/mediabuyer') && !ap.startsWith('/mb')) return res.redirect('/mediabuyer');
        user = { ...pm, buyer: { id: b.id, name: b.name, photo: !!b.photo } };
      }
    }
    if (!user) {
      if (req.session.loginId && !req.path.startsWith('/api/') && !req.path.startsWith('/admin')) return res.redirect('/welcome');
      if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Please log in again.', needsLogin: true });
      return res.redirect(req.path.startsWith('/admin') ? '/admin/login' : '/login');
    }
    // Google-only people see the admin website and its data, nothing else.
    if (user.google) {
      if (req.path.startsWith('/api/') && !/^\/api\/(me|main\/|admin\/|page-pic\/|profit\/)/.test(req.path)) return res.status(403).json({ error: 'The admin website only has the Main Dashboard and Admin.' });
      if (!req.path.startsWith('/api/') && !req.path.startsWith('/admin')) return res.redirect('/admin');
    }
    req.user = user;
    // When each person was last active (saved at most every 10 minutes).
    const seen = user.google ? Date.now() : lastSeenMem.get(user.fb_id) || 0;
    if (Date.now() - seen > 10 * 60e3) { lastSeenMem.set(user.fb_id, Date.now()); db.setUserSetting(user.fb_id, 'lastSeen', new Date().toISOString()).catch(() => {}); }
    next();
  }));

  // Three websites, one app. The owner gives each person a role in Admin → Users and that decides their site:
  //   /admin           CEO / COO — everything (company view first)
  //   /projectmanager  Project Managers — their own clients, team and media buyers
  //   /mediabuyer      Media buyers — their tasks page, opened from the Telegram bot (no account)
  // The front door (/) sends each person to their site.
  app.get('/', wrap(async (req, res) => {
    if (req.user.google) return res.redirect('/admin');
    // The front door opens the Project Manager site for everyone with a Facebook login; the owner and
    // CEO / COO switch to /owner or /admin from the menu or by typing the address.
    // keep ?fb=…&fbmsg=… (the result of connecting a Facebook account): without it the person never saw why a connect failed
    const qi = req.originalUrl.indexOf('?'), qs = qi >= 0 ? req.originalUrl.slice(qi) : '';
    if ((await deps.roleOf(req.user.fb_id)) === 'mb') return res.redirect('/mediabuyer' + qs);
    res.redirect('/projectmanager' + qs);
  }));
  // /owner: the app owner's site — every page (Work + Admin). Anyone else is sent to their own site.
  app.get(['/owner', '/owner/'], wrap(async (req, res) => {
    if (req.user.google || (await db.ownerId()) !== req.user.fb_id) return res.redirect('/');
    const html = require('../assets').sitePage(req, 'owner', 'Ads Box · Owner');
    res.set('Cache-Control', 'no-cache').send(html);
  }));
  app.get(['/projectmanager', '/projectmanager/'], wrap(async (req, res) => {
    if (!req.user.google && (await deps.roleOf(req.user.fb_id)) === 'mb') return res.redirect('/mediabuyer');
    const html = require('../assets').sitePage(req, 'pm', 'Ads Box · Project Manager');
    res.set('Cache-Control', 'no-cache').send(html);
  }));
  // The admin website: the same app, showing only the Main Dashboard and Admin.
  app.get(['/admin', '/admin/'], wrap(async (req, res) => {
    if (!req.user.google && !(await deps.canSeeAdmin(req.user.fb_id))) return res.redirect('/projectmanager'); // a PM's site is /projectmanager
    const html = require('../assets').sitePage(req, 'admin', 'Ads Box · Admin');
    res.set('Cache-Control', 'no-cache').send(html);
  }));

  return { MB };
};
