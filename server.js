const net = require('./src/net'); // first: time limits on every outside call
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieSession = require('cookie-session');
const cfg = require('./src/config');
const db = require('./src/db');
const meta = require('./src/meta');
const sync = require('./src/sync');
const lives = require('./src/lives');
const invoice = require('./src/invoice');
const health = require('./src/health');
const reportImage = require('./src/reportImage');
const kindOf = (k) => (k === 'live' || k === 'post' ? k : '');
// Ticked report lines: "l1,l3,post" or ['l1','post'] → clean list, or null for everything.
// parts: lines ticked on a one-day report ('l1', 'post'), and lines left out of a longer report ('!2026-10-18:l1').
const partsOf = (v) => { const a = (Array.isArray(v) ? v : String(v || '').split(',')).map(String).filter((x) => /^(l\d{1,2}|post)$/.test(x) || /^!\d{4}-\d{2}-\d{2}:(l\d{1,2}|post)$/.test(x)); return a.length ? [...new Set(a)].sort().slice(0, 400) : null; };
const jobs = require('./src/jobs');
const extras = require('./src/extras');
const reports = require('./src/reports');
const pm = require('./src/pm');
const orders = require('./src/orders');
const pageOrders = require('./src/pageOrders'); // Boost Desk's own order counting (Messenger + comments)
const telegram = require('./src/telegram');
const profit = require('./src/profit');
const { encrypt } = require('./src/crypto');

// 19 Nov 2026 — KPIs and the daily task menu moved to GenZ KPI. Boost Desk follows clients: their status, the MB <-> PM
// handover, reports to clients and AI advice per client. The My Task page, KPI screens and the Telegram messages about
// daily tasks are switched off here (data and code are kept; KPI_TASKS=on in the environment brings them back).
const TASKS_OFF = process.env.KPI_TASKS !== 'on';
// A promise nobody caught must not stop the app; it is logged instead.
process.on('unhandledRejection', (e) => console.error('[unhandled]', e && e.message ? e.message : e));
const app = express();
app.set('trust proxy', 1);
// Smaller pages on slow connections: text responses are compressed (the app script goes from ~530 KB to ~130 KB).
app.use(require('compression')({ threshold: 1024 }));
// Basic browser protections on every response. Frames are allowed from this site only.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (cfg.baseUrl.startsWith('https')) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  next();
});
// Public addresses: a limit per address, so nobody can hammer the login or the open API.
app.use(['/auth', '/admin/login', '/mediabuyer/login', '/mb/login'], net.rateLimit(40, 60000, 'auth'));
app.use(['/public-api', '/hooks/adsbox'], net.rateLimit(240, 60000, 'pub')); // /hooks/meta is signed by Facebook and can be busy during a Live, so it has no per-address limit
app.use('/api', net.sameOrigin);
// /hooks/meta keeps the raw body too: Facebook signs it (X-Hub-Signature-256) and the signature is checked on those bytes.
app.use(express.json({ limit: '8mb', verify: (req, res, buf) => { if (req.originalUrl.startsWith('/hooks/meta')) req.rawBody = buf; } })); // room for the invoice logo / QR / signature pictures
app.use(cookieSession({
  name: 'bd_session', secret: cfg.sessionSecret, maxAge: 30 * 864e5,
  sameSite: 'lax', secure: cfg.baseUrl.startsWith('https'), httpOnly: true,
}));

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const isDay = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d);

// ---------- Facebook login ----------
// The login "state" is signed by the server and valid for 15 minutes, so it works in any tab
// and doesn't depend on a browser cookie surviving the trip to Facebook and back.
const signState = (nonce, ts) => crypto.createHmac('sha256', cfg.sessionSecret).update(`${nonce}.${ts}`).digest('hex').slice(0, 32);
function newState() {
  const nonce = crypto.randomBytes(12).toString('hex'), ts = Date.now().toString(36);
  return `${nonce}.${ts}.${signState(nonce, ts)}`;
}
function stateOk(state) {
  const [nonce, ts, sig] = String(state || '').split('.');
  if (!nonce || !ts || !sig) return false;
  const good = signState(nonce, ts);
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return false;
  return Date.now() - parseInt(ts, 36) < 15 * 60 * 1000;
}
const loggedIn = async (req) => !!(req.session && req.session.fbId && (await db.getUser(req.session.fbId)));

app.get('/auth/facebook', (req, res) => {
  // ?link=1 from Settings: connect ANOTHER Facebook account to the workspace I'm logged in to (my 2nd / 3rd account).
  req.session.linkFor = req.query.link === '1' && req.session.fbId && !req.session.mb ? req.session.fbId : null;
  req.session.next = req.query.next === 'admin' ? '/admin' : null;
  // Asks for the Page permissions too (automatic Page connecting for orders). If Facebook refused that once in this
  // browser session, ask only for the ads permissions so login itself never breaks.
  req.session.lastAuthQ = req.originalUrl.split('?')[1] || '';
  res.redirect(meta.loginUrl(newState(), { noPages: !!req.session.noPageScopes }));
});

// Orders → Connect Pages: the same Facebook login, asking for the Page permissions. The callback below sees pagesFor
// and saves the Pages instead of logging in. Only a logged-in team member (not a media buyer) can start it.
app.get('/auth/facebook/pages', (req, res) => {
  // Facebook/username login, or an owner who signs in with Gmail on the admin site (e.g. Hor Vannak).
  const who = req.session && !req.session.mb ? req.session.fbId || (req.session.gEmail ? 'g:' + req.session.gEmail : '') : '';
  if (!who) return res.redirect('/login');
  req.session.pagesFor = who; req.session.linkFor = null;
  res.redirect(pageOrders.connectUrl(newState()));
});
app.get('/auth/facebook/callback', wrap(async (req, res) => {
  const { code, state, error_description } = req.query;
  if (error_description && !req.session.pagesFor && !req.session.noPageScopes && /scope|permission/i.test(String(error_description))) {
    req.session.noPageScopes = true; // try the login again with the ads permissions only
    return res.redirect('/auth/facebook' + (req.session.lastAuthQ ? '?' + req.session.lastAuthQ : ''));
  }
  if (error_description) return res.redirect('/login?error=' + encodeURIComponent(error_description));
  if (!code || !stateOk(state)) {
    // A replayed or old return link: if you're already logged in, just go in.
    if (await loggedIn(req)) return res.redirect('/');
    return res.redirect('/login?error=' + encodeURIComponent('That login link expired. Tap Continue with Facebook again.'));
  }
  let token, expires;
  try { ({ token, expires } = await meta.exchangeCode(String(code))); }
  catch (e) {
    // Facebook codes work once; a second use (back button, restored tab) fails here.
    if (await loggedIn(req)) return res.redirect('/');
    return res.redirect('/login?error=' + encodeURIComponent('Facebook login did not finish (' + e.message + '). Tap Continue with Facebook again.'));
  }
  const profile = await meta.me(token);
  // Connecting Pages for order counting (Orders → Connect Pages): save the Pages, stay logged in as myself.
  const pagesFor = req.session.pagesFor; req.session.pagesFor = null;
  const viaGmail = !!(pagesFor && req.session.gEmail && pagesFor === 'g:' + req.session.gEmail);
  const pagesUser = pagesFor && req.session.fbId === pagesFor ? await db.getUser(pagesFor) : null;
  if (pagesFor && (pagesUser || viaGmail)) {
    const back = (msg, ok) => res.redirect('/?pg=' + (ok ? 'ok' : 'err') + '&pgmsg=' + encodeURIComponent(msg) + '#orders');
    try {
      const who = pagesUser ? pagesUser.name : req.session.gName || req.session.gEmail;
      const r = await pageOrders.connectFromUserToken(token, { id: pagesFor, name: who + (profile.id !== pagesFor ? ' (' + profile.name + ')' : '') });
      if (r.missing.length && !r.connected.length) return back(`Facebook did not give Boost Desk the Page permissions (${r.missing.join(', ')}). Tap Connect Pages again and allow everything.`, false);
      if (!r.connected.length && !r.failed.length) return back(`${profile.name} does not manage any Facebook Page.`, false);
      return back(`${r.connected.length} Page${r.connected.length === 1 ? '' : 's'} connected — new orders are counted from now.${r.failed.length ? ` ${r.failed.length} could not be connected: ${r.failed[0].name} (${r.failed[0].error}).` : ''}`, r.connected.length > 0);
    } catch (e) { return back('Connecting Pages failed: ' + e.message, false); }
  }
  // Connecting an extra Facebook account to my workspace: keep me logged in as myself, save the other login beside mine.
  const linkFor = req.session.linkFor; req.session.linkFor = null;
  if (linkFor && req.session.fbId === linkFor && (await db.getUser(linkFor))) {
    const back = (msg, ok) => res.redirect('/?fb=' + (ok ? 'ok' : 'err') + '&fbmsg=' + encodeURIComponent(msg) + '#settings');
    if (profile.id === linkFor) { await saveFbLogin(profile, encrypt(token), expires); return back('That is the Facebook account you are already logged in with. On facebook.com switch to your other account first, then tap Connect again.', false); }
    if ((await db.blockedUsers())[profile.id]) return back(`${profile.name}'s access to Boost Desk was removed, so it can't be connected.`, false);
    const other = await db.getUser(profile.id);
    if (other && (await db.listClients(profile.id)).length) return back(`${profile.name} already has its own Boost Desk workspace with clients. Connecting it here would count the same spend twice — ask the owner if the two should be merged.`, false);
    const list = (await sync.extraLogins(linkFor)).filter((x) => x.id !== profile.id);
    if (list.length >= 5) return back('You can connect up to 5 extra Facebook accounts.', false);
    list.push({ id: profile.id, name: profile.name, token_enc: encrypt(token), expires, addedAt: new Date().toISOString() });
    await db.setUserSetting(linkFor, 'fbExtras', list);
    pageOrders.autoConnect({ only: profile.id }).catch((e) => console.error('[own orders] auto-connect (extra login):', e.message));
    let n = 0; try { await sync.refreshAccounts(await db.getUser(linkFor)); n = (await db.listAccounts(linkFor)).filter((a) => (a.info || {}).via === profile.id).length; } catch (e) { console.error('[fb link] account list failed:', e.message); }
    // Pull the last 30 days for the new ad accounts straight away (in the background), so their spend shows without a manual Sync.
    if (n) { const me = await db.getUser(linkFor), today = sync.todayIn(), since = sync.addDays(today, -29);
      sync.exclusive(linkFor, () => sync.syncRange(since, today, { ...me, name: 'Auto sync' })).then((r) => console.log(`[fb link] ${me.name}: first sync after connecting ${profile.name} ${r ? `done, ${r.campaigns} campaigns` : 'skipped (another sync is running)'}`)).catch((e) => console.error('[fb link] first sync failed:', e.message)); }
    return back(n ? `${profile.name} connected — ${n} more ad account${n === 1 ? '' : 's'} found. Their last 30 days are loading now; it takes a few minutes. Untick any you do not boost with in Ad accounts.` : `${profile.name} connected, but no new ad account was found on it.`, true);
  }
  if (cfg.allowedFbIds.length && !cfg.allowedFbIds.includes(profile.id)) {
    return res.redirect('/login?error=' + encodeURIComponent(`${profile.name} is not on this app's team list. Ask the admin to add Facebook ID ${profile.id}.`));
  }
  if ((await db.blockedUsers())[profile.id]) {
    return res.redirect('/login?error=' + encodeURIComponent(`${profile.name}'s access to Boost Desk was removed. Ask the app owner to restore it.`));
  }
  // This Facebook account was merged into another workspace (Admin → Users → Merge): it opens that workspace, and its
  // fresh token is kept there as one of the team's Facebook accounts.
  const mergedInto = await require('./src/merge').aliasOf(profile.id);
  if (mergedInto && (await db.getUser(mergedInto))) {
    const list = (await sync.extraLogins(mergedInto)).filter((x) => x.id !== profile.id);
    list.push({ id: profile.id, name: profile.name, token_enc: encrypt(token), expires, addedAt: new Date().toISOString(), merged: true });
    await db.setUserSetting(mergedInto, 'fbExtras', list);
    req.session.fbId = mergedInto; req.session.name = (await db.getUser(mergedInto)).name;
    const nx = req.session.next === '/admin' ? '/admin' : '/'; req.session.next = null; return res.redirect(nx);
  }
  // A username that has no workspace yet takes this Facebook account as its workspace (existing clients and settings stay as they are).
  if (req.session.loginId) {
    const rec = await LOGINS().get(req.session.loginId);
    if (rec && rec.role === 'pm' && !rec.fbId) {
      const taken = await LOGINS().forFb(profile.id);
      if (taken) return res.redirect('/welcome?error=' + encodeURIComponent(`${profile.name} is already connected to the username "${taken.username}". Switch facebook.com to your own account and try again.`));
      rec.fbId = profile.id; await LOGINS().save(rec);
    } else if (rec && rec.role === 'pm' && rec.fbId && rec.fbId !== profile.id) {
      return res.redirect('/?fb=err&fbmsg=' + encodeURIComponent(`That is a different Facebook account (${profile.name}). To add it to your workspace use Settings → Facebook account → Connect another Facebook account.`) + '#settings');
    }
  }
  await saveFbLogin(profile, encrypt(token), expires);
  req.session.fbId = profile.id;
  req.session.name = profile.name;
  pageOrders.autoConnect({ only: profile.id }).catch((e) => console.error('[own orders] auto-connect after login:', e.message));
  // Each admin starts with an empty workspace; nothing is loaded until they tap Sync from Meta.
  const next = req.session.next === '/admin' ? '/admin' : '/'; req.session.next = null;
  res.redirect(next);
}));

// The workspace's name is the PM's own (set in Settings → My account); the Facebook account's name is kept beside it
// (setting fbName). A Facebook login only renames the workspace while nobody has given it a name of its own.
async function saveFbLogin(profile, tokenEnc, expires) {
  const cur = await db.getUser(profile.id), prevFb = cur ? await db.getUserSetting(profile.id, 'fbName', cur.name) : '';
  const name = cur && cur.name && cur.name !== prevFb ? cur.name : profile.name;
  await db.upsertUser(profile.id, name, tokenEnc, expires);
  await db.setUserSetting(profile.id, 'fbName', profile.name);
  for (const r of (await db.pool.query(`SELECT key, value FROM settings WHERE key LIKE '%:fbExtras'`)).rows) {
    const list = Array.isArray(r.value) ? r.value : []; if (!list.some((e) => e.id === profile.id && e.shared)) continue;
    await db.setSetting(r.key, list.map((e) => (e.id === profile.id && e.shared ? { ...e, name: profile.name, token_enc: tokenEnc, expires, error: '' } : e)));
  }
}
const fbNameOf = async (u) => (await db.getUserSetting(u.fb_id, 'fbName', '')) || u.name;

app.post('/auth/logout', (req, res) => { req.session = null; res.json({ ok: true }); });

// ---------- Username + password (src/logins.js) ----------
// The login opens the same session a Facebook login (PM) or a Telegram link (media buyer) would, so everything after it is unchanged.
const LOGINS = () => require('./src/logins');
app.post('/auth/login', wrap(async (req, res) => {
  const b = req.body || {};
  let rec; try { rec = await LOGINS().verify(b.username, b.password); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  req.session = { loginId: rec.username };
  if (rec.role === 'mb') {
    if (!(await MB().get(rec.mbId))) { req.session = null; return res.status(403).json({ error: 'This media buyer was removed from the team. Ask your PM.' }); }
    req.session.mb = rec.mbId; req.session.mbAt = Date.now();
    return res.json({ ok: true, next: '/mediabuyer#dashboard', must: !!rec.must });
  }
  if (rec.fbId) {
    if ((await db.blockedUsers())[rec.fbId]) { req.session = null; return res.status(403).json({ error: 'This account\'s access to Boost Desk was removed. Ask the app owner.' }); }
    const u = await db.getUser(rec.fbId);
    if (u) { req.session.fbId = u.fb_id; req.session.name = u.name; return res.json({ ok: true, next: '/', must: !!rec.must }); }
  }
  res.json({ ok: true, next: '/welcome', must: !!rec.must }); // no workspace yet: connect Facebook once
}));
// First login of a new PM: connect the Facebook account that manages their ad accounts.
app.get('/welcome', wrap(async (req, res) => {
  const rec = req.session && req.session.loginId ? await LOGINS().get(req.session.loginId) : null;
  if (!rec) return res.redirect('/login');
  if (req.session.fbId && (await db.getUser(req.session.fbId))) return res.redirect('/');
  const err = String(req.query.error || '').slice(0, 300).replace(/[<>&"]/g, '');
  res.set('Cache-Control', 'no-store').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect Facebook · Ads Box</title><link rel="icon" href="/assets/logo.svg"><style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:Inter,system-ui,sans-serif;background:#f6f7f9;color:#0f172a}main{background:#fff;border:1px solid #e5e7eb;border-radius:20px;padding:32px 28px;max-width:440px;margin:16px;box-shadow:0 20px 50px rgba(15,23,42,.08)}h1{font-size:22px;margin:0 0 8px}p{color:#475569;line-height:1.5;margin:0 0 16px}ol{color:#334155;line-height:1.6;padding-left:20px;margin:0 0 20px}.fb{display:flex;align-items:center;justify-content:center;min-height:52px;border-radius:12px;background:#1877f2;color:#fff;text-decoration:none;font-weight:700;font-size:16px}.err{background:#fdecee;color:#a51d2f;border-radius:10px;padding:10px 12px;margin:0 0 16px;font-size:14px}a.out{display:block;text-align:center;margin-top:14px;color:#64748b;font-size:14px}</style></head><body><main><h1>Hello ${String(rec.name || rec.username).replace(/[<>&"]/g, '')} — one step left</h1><p>Connect the Facebook account that manages your clients' ad accounts. You do this once; after that you log in with your username and password.</p>${err ? `<div class="err">${err}</div>` : ''}<ol><li>Make sure facebook.com is logged in to the right account.</li><li>Tap the button. If that Facebook account already used Boost Desk, all its clients and settings are here waiting.</li></ol><a class="fb" href="/auth/facebook?claim=1">Connect Facebook</a><a class="out" href="#" onclick="fetch('/auth/logout',{method:'POST'}).then(()=>location.href='/login');return false">Log out</a></main></body></html>`);
}));

// ---------- Admin website (/admin): Google sign-in for people the owner allows ----------
// Allowed people live in the setting adminSite.people: { email, name, linkTo (a Boost Desk Facebook ID or ''), addedAt, addedBy, lastLogin }.
// Someone linked to a Boost Desk account acts as that account; anyone else is an admin viewer (Main Dashboard + Admin).
const siteCfg = async () => { const v = (await db.getSetting('adminSite', null)) || {}; return { people: Array.isArray(v.people) ? v.people : [] }; };
const normEmail = (e) => String(e || '').trim().toLowerCase();
async function sitePerson(email) { const e = normEmail(email); return e ? (await siteCfg()).people.find((p) => p.email === e) || null : null; }
const googleRedirect = () => cfg.baseUrl + '/auth/google/callback';
const adminLoginErr = (res, msg) => res.redirect('/admin/login?error=' + encodeURIComponent(msg));
app.get('/auth/google', (req, res) => {
  if (!cfg.googleClientId || !cfg.googleClientSecret) return adminLoginErr(res, 'Google sign-in is not set up yet. The app owner adds it in Admin → Settings → Admin website.');
  const q = new URLSearchParams({ client_id: cfg.googleClientId, redirect_uri: googleRedirect(), response_type: 'code', scope: 'openid email profile', state: newState(), prompt: 'select_account' });
  res.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + q);
});
app.get('/auth/google/callback', wrap(async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return adminLoginErr(res, error === 'access_denied' ? 'Google sign-in was cancelled.' : 'Google sign-in failed: ' + error);
  if (!code || !stateOk(state)) return adminLoginErr(res, 'That sign-in link expired. Tap Sign in with Google again.');
  let tok;
  try {
    const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: String(code), client_id: cfg.googleClientId, client_secret: cfg.googleClientSecret, redirect_uri: googleRedirect(), grant_type: 'authorization_code' }) });
    tok = await r.json(); if (!r.ok || !tok.id_token) throw new Error(tok.error_description || tok.error || 'no id_token');
  } catch (e) { return adminLoginErr(res, 'Google sign-in did not finish (' + e.message + '). Try again.'); }
  // The ID token comes straight from Google over HTTPS (not from the browser), so reading its claims is safe.
  let c; try { c = JSON.parse(Buffer.from(tok.id_token.split('.')[1], 'base64url').toString('utf8')); } catch (_) { return adminLoginErr(res, 'Google sent an answer we could not read. Try again.'); }
  if (c.aud !== cfg.googleClientId || !/^(https:\/\/)?accounts\.google\.com$/.test(c.iss || '') || !c.email || c.email_verified === false) return adminLoginErr(res, 'Google could not confirm this email address.');
  const email = normEmail(c.email), person = await sitePerson(email);
  if (!person) return adminLoginErr(res, `${email} is not allowed on the admin website. Ask the app owner to add it in Admin → Settings → Admin website.`);
  const site = await siteCfg(), me = site.people.find((x) => x.email === email); me.lastLogin = new Date().toISOString(); if (!me.name && c.name) me.name = String(c.name).slice(0, 80);
  await db.setSetting('adminSite', site);
  req.session.gEmail = email; req.session.gName = String(c.name || me.name || email).slice(0, 80); req.session.gPic = String(c.picture || '').slice(0, 400);
  res.redirect('/admin');
}));
require('./src/legal')(app); // public /privacy and /data-deletion (Meta app publishing)
app.get('/admin/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin-login.html')));
app.get('/admin/login/info', wrap(async (req, res) => res.json({ google: !!(cfg.googleClientId && cfg.googleClientSecret) })));

app.get('/login', wrap(async (req, res) => {
  if (await loggedIn(req)) return res.redirect('/'); // already logged in: go straight to the app
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
}));
// Public standalone AdsCheck Pro page (no Boost Desk login required):
app.get(['/adscheck', '/adscheck/', '/adscheck.html', '/check', '/smit'], (req, res) => {
  res.set('Cache-Control', 'no-cache').sendFile(path.join(__dirname, 'public', 'adscheck.html'));
});
app.get(['/adscheck.js', '/adscheck/adscheck.js'], (req, res) => {
  res.set('Cache-Control', 'no-cache').sendFile(path.join(__dirname, 'public', 'adscheck.js'));
});
// Always revalidate so a new deploy shows up on the next refresh.
app.use('/assets', express.static(path.join(__dirname, 'public', 'assets'), { maxAge: 0, etag: true, setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));
app.get(['/adscheck-connect-extension.zip', '/assets/adscheck-connect-extension.zip', '/AdsCheck-Pro-NoLogin-Extension.zip'], (req, res) => {
  res.download(path.join(__dirname, 'public', 'adscheck-connect-extension.zip'), 'AdsCheck-Pro-NoLogin-Extension.zip');
});

app.use(health.middleware);
// ---- Public read-only API: boost spend per Page per day, for adsbox.biz (or any outside site) ----
// Auth with a key made in Admin → Settings (X-API-Key, Authorization: Bearer, or ?api_key=). Keys are kept as
// SHA-256 only. Numbers only: date, Page ID, spend.
const sha = (x) => crypto.createHash('sha256').update(String(x)).digest('hex');
app.get('/public-api/spend', wrap(async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const key = String(req.get('x-api-key') || (req.get('authorization') || '').replace(/^Bearer\s+/i, '') || req.query.api_key || '').trim();
  const keys = (await db.getSetting('spendApiKeys', [])) || [];
  const k = key && keys.find((x) => x.hash === sha(key) && x.active !== false);
  if (!k) return res.status(401).json({ ok: false, error: 'API key missing or not valid.' });
  const today = sync.todayIn();
  const to = isDay(req.query.to) ? req.query.to : today, from = isDay(req.query.from) ? req.query.from : sync.addDays(to, -6);
  if (from > to) return res.status(400).json({ ok: false, error: '"from" is after "to".' });
  if ((Date.parse(to) - Date.parse(from)) / 864e5 > 185) return res.status(400).json({ ok: false, error: 'At most 185 days per call.' });
  const pid = String(req.query.page_id || '').trim();
  if (pid && !/^\d{5,25}$/.test(pid)) return res.status(400).json({ ok: false, error: 'page_id must be numeric.' });
  let { list } = await orders.spendRows(from, to);
  if (pid) list = list.filter((r) => r.page_id === pid);
  list.sort((a, b) => a.date.localeCompare(b.date) || a.page_id.localeCompare(b.page_id));
  k.calls = (k.calls || 0) + 1; k.lastUsed = new Date().toISOString(); k.lastIp = String(req.ip || '').slice(0, 45);
  db.setSetting('spendApiKeys', keys).catch(() => {});
  res.json({ ok: true, from, to, timezone: cfg.tz, currency: 'USD', totals: { spend: Math.round(list.reduce((t, r) => t + r.spend, 0) * 100) / 100 }, count: list.length, rows: list });
}));
// ---- Check My Ads browser extension → billing thresholds ----
// The extension reads each account's automatic-payment ("billing") threshold from the user's own
// logged-in Facebook session and pushes the numbers here. Meta does not expose this field to the
// Marketing API, so this is the only way Boost Desk can show it. Only the numbers travel — never
// Facebook cookies or tokens. Auth is a per-user extension key (not a browser cookie), so CORS is
// open: the key is the credential.
function extCors(res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, Authorization');
}
app.options('/public-api/thresholds', (req, res) => { extCors(res); res.sendStatus(204); });
app.post('/public-api/thresholds', wrap(async (req, res) => {
  extCors(res);
  const key = String(req.get('x-api-key') || (req.get('authorization') || '').replace(/^Bearer\s+/i, '') || (req.body || {}).key || '').trim();
  const idx = (await db.getSetting('extKeyIndex', {})) || {};
  const owner = key ? idx[sha(key)] : null;
  if (!owner) return res.status(401).json({ ok: false, error: 'Extension key missing or not valid.' });
  const items = Array.isArray((req.body || {}).thresholds) ? req.body.thresholds : [];
  const map = (await db.getUserSetting(owner, 'extThresholds', {})) || {};
  let stored = 0;
  for (const it of items) {
    const rawId = String((it && (it.id || it.account_id || it.accountId || it.meta_account_id)) || '').trim();
    const id = rawId.startsWith('act_') ? rawId : (rawId ? 'act_' + rawId : '');
    if (!/^act_\d{5,25}$/.test(id)) continue;
    const prev = map[id] || {};
    const v = it.threshold != null ? Number(it.threshold) : prev.v;
    const card = String(it.card || it.payment_card || it.paymentMethods || prev.card || '').trim().slice(0, 80) || null;
    const dailyLimit = it.dailyLimit != null || it.daily_limit != null ? Number(it.dailyLimit ?? it.daily_limit) : (prev.dailyLimit ?? null);
    const business = String(it.business || it.business_name || it.businessName || prev.business || '').trim().slice(0, 120) || null;
    const role = String(it.role || prev.role || '').trim().slice(0, 40) || null;
    const nextBillDate = String(it.nextBillDate || it.pay_date || prev.nextBillDate || '').trim().slice(0, 40) || null;
    if (it.threshold === null && !card && dailyLimit == null) {
      delete map[id];
      continue;
    }
    map[id] = {
      v: isFinite(v) && v >= 0 && v <= 1e9 ? Math.round(v * 100) / 100 : (prev.v ?? null),
      cur: (String(it.currency || prev.cur || '').slice(0, 8) || null),
      card,
      dailyLimit: isFinite(dailyLimit) && dailyLimit > 0 ? Math.round(dailyLimit * 100) / 100 : null,
      business,
      role,
      nextBillDate,
      at: new Date().toISOString()
    };
    stored++;
  }
  await db.setUserSetting(owner, 'extThresholds', map);
  res.json({ ok: true, stored, accounts: Object.keys(map).length });
}));

const lastSeenMem = new Map();
// Everything below needs a logged-in user.
// ---------- Media buyer dashboard (/mb) ----------
// Media buyers have no Boost Desk account: the Telegram bot gives them a signed link (60 days) that opens
// their own page — today's tasks, target, monthly KPI, clients and history. They can tick tasks and type
// what they reached, the same as tapping ✅ Done in Telegram.
const MB = () => require('./src/buyers');
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
  const html = require('fs').readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8').replace('<body>', '<body data-site="mb">').replace(/<title>[^<]*<\/title>/, '<title>Ads Box · Media buyer</title>');
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
// adsbox.biz → Boost Desk webhook (no login; the shared secret from the Orders → adsbox.biz dialog).
app.post('/hooks/adsbox', wrap(async (req, res) => {
  const given = String(req.get('X-Webhook-Secret') || (req.query || {}).secret || (req.body || {}).secret || ''), want = await orders.hookSecret();
  if (!given || given.length !== want.length || !require('crypto').timingSafeEqual(Buffer.from(given), Buffer.from(want))) return res.status(401).json({ error: 'Bad webhook secret.' });
  res.json(await orders.receiveHook(req.body));
}));
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
      if (t.repeat) { if (t.day > day) continue; out.push({ ...base, done: doneDay === day, doneAt: doneDay === day ? t.doneAt : null, late: false, ...tgt(t, day) }); continue; }
      const late = t.day < day && !t.done && day === today;
      if (t.day !== day && !late && !(doneDay === day)) continue;
      out.push({ ...base, done: !!t.done, doneAt: t.doneAt || null, late, ...tgt(t, t.day) });
    }
  }
  // KPI names for chips
  for (const key of new Set(out.map((t) => t.owner))) { try { for (const k of await KPI().getList(buyer.id, today.slice(0, 7))) kpiNames[k.id] = k.name; } catch (_) {} }
  out.sort((a, b) => (a.done - b.done) || (b.late - a.late) || a.client.localeCompare(b.client));
  return { tasks: out.map((t) => ({ ...t, kpiName: kpiNames[t.kpi] || '' })), all, logs, clients: cl };
}
app.get(['/mb/api/me', '/api/mb/me'], mbOnly, wrap(async (req, res) => {
  const b = req.buyer, today = sync.todayIn(), ym = today.slice(0, 7);
  const { tasks, all, logs, clients } = await buyerTasks(b, today);
  const counts = { done: tasks.filter((t) => t.done).length, open: tasks.filter((t) => !t.done).length, late: tasks.filter((t) => t.late).length };
  const tg = tasks.filter((t) => Number(t.target) > 0), target = { total: tg.reduce((s, t) => s + t.target, 0), reached: tg.reduce((s, t) => s + Math.min(t.reached || 0, t.target), 0), tasks: tg.length };
  target.pct = target.total ? Math.round(target.reached / target.total * 100) : null;
  let kpis = []; try { kpis = await KPI().results(b.id, ym, true); } catch (_) {}
  const scored = kpis.filter((k) => k.target > 0), kpiAvg = scored.length ? Math.round(scored.reduce((s, k) => s + Math.min(k.score, 150), 0) / scored.length) : null;
  // my clients: every client with a task for me, with its boost plan summary
  const plan = require('./src/plan');
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
  const w = await AI().workbook(owner, cid), t = (w.tasks || []).find((x) => x.id === tid);
  if (!t || !t.to || t.to.id !== b.id) return res.status(404).json({ error: 'This task is not yours.' });
  const day = sync.todayIn(), body = req.body || {};
  if (body.reached != null && Number(t.target) > 0) { t.hit = t.hit || {}; t.hit[day] = Math.max(0, Number(body.reached) || 0); }
  if (body.done != null) {
    const lid = 't:' + t.id + ':' + day; w.log = (w.log || []).filter((x) => x.id !== lid);
    if (body.done) { const at = new Date().toISOString(); t.done = true; t.doneAt = at; t.doneBy = b.name; w.log.push({ id: lid, day, at, by: b.name, text: t.text, kind: t.repeat ? 'repeat' : 'me' }); }
    else { t.done = false; t.doneAt = null; t.doneBy = null; }
  }
  await AI().saveWorkbook(owner, cid, w);
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
  // daily client work like their PM: Sync from Meta, client settings, ad accounts, the weekly strategy. (Connecting Pages for orders needs a Facebook login, so it stays with the PM.)
  if (!user && req.session.mb) {
    const b = await MB().get(req.session.mb);
    const pmId = b && (b.addedById || Object.fromEntries((await db.allUsers()).map((u) => [u.name, u.fb_id]))[b.addedBy]);
    const pm = pmId && (await db.getUser(pmId));
    if (b && pm) {
      if (req.method !== 'GET' && req.path.startsWith('/api/') && (
        /^\/api\/(admin|auto-sync|profit|media-buyers|kpis|main|company|team|targets)/.test(req.path)
        || (req.method === 'DELETE' && /^\/api\/clients\/\d+$/.test(req.path))
        || (req.method === 'PATCH' && /^\/api\/clients\/\d+$/.test(req.path) && req.body && 'archived' in req.body) // pausing a client stays with the PM
      )) return res.status(403).json({ error: 'Media buyers can\'t do this — ask your PM.' });
      if (req.path.startsWith('/api/') && /^\/api\/(admin|profit|main|company|auto-sync|kpis\/people|admin\/)/.test(req.path)) return res.status(403).json({ error: 'Not available on the media buyer site.' });
      if (!req.path.startsWith('/api/') && !req.path.startsWith('/mediabuyer') && !req.path.startsWith('/mb')) return res.redirect('/mediabuyer');
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
  if ((await roleOf(req.user.fb_id)) === 'mb') return res.redirect('/mediabuyer');
  res.redirect('/projectmanager');
}));
// /owner: the app owner's site — every page (Work + Admin). Anyone else is sent to their own site.
app.get(['/owner', '/owner/'], wrap(async (req, res) => {
  if (req.user.google || (await db.ownerId()) !== req.user.fb_id) return res.redirect('/');
  const html = require('fs').readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8').replace('<body>', '<body data-site="owner">').replace(/<title>[^<]*<\/title>/, '<title>Ads Box · Owner</title>');
  res.set('Cache-Control', 'no-cache').send(html);
}));
app.get(['/projectmanager', '/projectmanager/'], wrap(async (req, res) => {
  if (!req.user.google && (await roleOf(req.user.fb_id)) === 'mb') return res.redirect('/mediabuyer');
  const html = require('fs').readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8').replace('<body>', '<body data-site="pm">').replace(/<title>[^<]*<\/title>/, '<title>Ads Box · Project Manager</title>');
  res.set('Cache-Control', 'no-cache').send(html);
}));
// The admin website: the same app, showing only the Main Dashboard and Admin.
app.get(['/admin', '/admin/'], wrap(async (req, res) => {
  if (!req.user.google && !(await canSeeAdmin(req.user.fb_id))) return res.redirect('/projectmanager'); // a PM's site is /projectmanager
  const html = require('fs').readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8').replace('<body>', '<body data-site="admin">').replace(/<title>[^<]*<\/title>/, '<title>Ads Box · Admin</title>');
  res.set('Cache-Control', 'no-cache').send(html);
}));

// ---------- API ----------
const api = express.Router();
// ---- Activity log: who changed what (leaders read it in Admin › Activity). Only the action and the person's name are
// kept — never what was typed, and nothing about a client's customers. The last 400 lines live in one settings row.
const AUDIT = [
  [/^POST \/clients$/, 'Added a client'], [/^PATCH \/clients\/\d+$/, 'Changed a client\'s details'], [/^DELETE \/clients\/\d+$/, 'Deleted a client'],
  [/^PUT \/clients\/\d+\/boost-plan$/, 'Changed a client\'s boost plan'], [/^PUT \/kpis$/, 'Changed KPIs'], [/^POST \/kpis\/copy/, 'Copied KPIs to other people'],
  [/^POST \/media-buyers$/, 'Added a media buyer'], [/^DELETE \/media-buyers\/[^/]+$/, 'Removed a media buyer'], [/^POST \/media-buyers\/[^/]+\/make-pm$/, 'Marked a media buyer\'s Telegram as the PM'],
  [/^PATCH \/media-buyers\//, 'Changed a media buyer'], [/^POST \/nudge$/, 'Sent a reminder on Telegram'], [/^POST \/clients\/\d+\/checked$/, 'Checked a client'], [/^POST \/clients\/\d+\/merge-from$/, 'Merged a duplicate client'], [/^POST \/clients\/\d+\/strategy\/send$/, 'Sent a weekly strategy to a client'], [/^PUT \/clients\/\d+\/strategy$/, 'Changed a client\'s weekly strategy'], [/^POST \/clients\/\d+\/on-it$/, 'Took a client\'s problem'], [/^POST \/nudge\/no-plan$/, 'Reminded everyone without a plan'],
  [/^(POST|PUT|DELETE) \/menu\/(item|reset)/, 'Changed a task menu'], [/^PUT \/admin\/menu$/, 'Changed the standard task menu'],
  [/^POST \/logins$/, 'Made a username'], [/^POST \/logins\/[^/]+\/reset$/, 'Reset a password'], [/^DELETE \/logins\//, 'Removed a username'], [/^POST \/me\/password$/, 'Changed their own password'],
  [/^DELETE \/fb-accounts\//, 'Removed a Facebook account from the team'], [/^POST \/admin\/merge$/, 'Merged two accounts'], [/^POST \/admin\/teams\/share-fb$/, 'Shared a Facebook account with a team'],
  [/^(POST|PUT|PATCH|DELETE) \/admin\/teams/, 'Changed teams'], [/^POST \/admin\/users\/[^/]+\/rename$/, 'Renamed an account'], [/^(POST|PUT|PATCH|DELETE) \/admin\/users/, 'Changed a user or a role'], [/^(POST|PUT|PATCH|DELETE) \/admin\//, 'Changed an Admin setting'],
  [/^POST \/invoices$/, 'Made an invoice'], [/^POST \/invoices\/\d+\/send$/, 'Sent an invoice'], [/^PUT \/invoice-profile$/, 'Changed invoice settings'], [/^PUT \/handoff\/prefs$/, 'Changed handoff messages'],
];
let auditBuf = [], auditBusy = false;
async function auditFlush() {
  if (auditBusy || !auditBuf.length) return; auditBusy = true; const add = auditBuf; auditBuf = [];
  try { const cur = await db.getSetting('auditLog', []); await db.setSetting('auditLog', [...(Array.isArray(cur) ? cur : []), ...add].slice(-400)); } catch (_) { auditBuf = [...add, ...auditBuf].slice(-400); }
  auditBusy = false;
}
{ const t = setInterval(auditFlush, 20000); if (t.unref) t.unref(); }
api.use((req, res, next) => {
  if (req.method === 'GET' || !req.user) return next();
  const key = `${req.method} ${req.path}`, hit = AUDIT.find(([re]) => re.test(key)); if (!hit) return next();
  const by = req.user.buyer ? req.user.buyer.name : req.user.name, role = req.user.buyer ? 'Media buyer' : '';
  res.on('finish', () => { if (res.statusCode < 400) auditBuf.push({ at: new Date().toISOString(), by, role, what: hit[1], where: req.path.replace(/^\/clients\/(\d+).*/, 'client #$1').replace(/^\/(admin\/)?/, '').slice(0, 60), for: req.user.actingFor || '' }); });
  next();
});
// Admins (CEO / COO / owner) can see and add tasks for any person: ?as=<fbId> on these routes acts on that person's clients and tasks (ticks are signed with the admin's name).
const AS_ROUTES = /^\/(tasks\/mine|tasks\/month|clients(\/\d+\/(tasks(\/[^/]+)?|tick))?)$/;
api.use(wrap(async (req, res, next) => {
  const as = String(req.query.as || (req.body && req.body.as) || '').trim();
  if (!as || !AS_ROUTES.test(req.path) || req.user.buyer) return next();
  if (!(await canSeeAdmin(req.user.fb_id))) return res.status(403).json({ error: 'Only admins can act for another person.' });
  const u = (await db.allUsers()).find((x) => x.fb_id === as); if (!u) return res.status(404).json({ error: 'Person not found.' });
  req.user = { ...req.user, fb_id: u.fb_id, actingFor: u.name };
  next();
}));

api.get('/me', wrap(async (req, res) => {
  res.json({
    id: req.user.fb_id, name: req.user.name, tokenExpires: req.user.token_expires,
    isOwner: await isFull(req), isAppOwner: (await db.ownerId()) === req.user.fb_id, fullAdmin: await isFull(req),
    tasksOff: TASKS_OFF,
    canAdmin: !req.user.buyer && await canSeeAdmin(req.user.fb_id), role: req.user.buyer ? 'buyer' : await roleOf(req.user.fb_id), buyer: req.user.buyer || null,
    fbWarn: await (async () => { if (req.user.buyer || req.user.google) return null; const now = Date.now(), exp = req.user.token_expires ? Date.parse(req.user.token_expires) : 0, days = exp ? Math.floor((exp - now) / 864e5) : null;
      const bad = (await sync.extraLogins(req.user.fb_id)).filter((e) => e.error || (e.expires && Date.parse(e.expires) < now)).map((e) => e.name);
      return (days !== null && days < 7) || bad.length ? { days, expired: days !== null && exp < now, extras: bad } : null; })(),
    login: await (async () => { const L = LOGINS(), r = req.user.buyer ? await L.forMb(req.user.buyer.id) : req.user.google ? null : await L.forFb(req.user.fb_id); return r ? { username: r.username, must: !!r.must } : null; })(),
    profitRole: null, // the Profit panel was removed
    google: req.session.gEmail ? { email: req.session.gEmail, picture: req.session.gPic || '' } : null, viewOnly: !!req.user.google,
    taxRate: sync.TAX_RATE, aiOn: (await db.getUserSetting(req.user.fb_id, 'aiOn', true)) !== false,
    today: sync.todayIn(), tz: cfg.tz,
    telegram: { configured: telegram.configured(), bot: telegram.hasBot(), time: cfg.reportTime },
  });
}));

// Profit tab (monthly ad accounts, clients and profit split) — its own access list.
// Profit panel removed (Nov 2026): the router stays in src/profit.js and its tables are kept, but nothing is mounted.

// Auto sync control — only the app owner can see or change it, for every account that logged in.
// Full admin = the app owner, a Facebook account the owner marked "Full admin" (setting fullAdmins), or a Gmail person on the
// admin website with the Full admin tick. They can do everything the owner can in Admin, except change the owner's own role.
const fullAdmins = async () => new Set((await db.getSetting('fullAdmins', [])) || []);
async function isFull(req) {
  if (!req.user || req.user.buyer) return false;
  if ((await db.ownerId()) === req.user.fb_id) return true;
  if ((await fullAdmins()).has(req.user.fb_id)) return true;
  if (LEAD.has((await roleMap())[req.user.fb_id])) return true; // CEO / COO / CMO set in Admin → Users control everything
  if (req.session && req.session.gEmail) { const p = await sitePerson(req.session.gEmail); if (p && p.full) return true; }
  return false;
}
const ownerOnly = wrap(async (req, res, next) => {
  if (!(await isFull(req))) return res.status(403).json({ error: 'Only the app owner (or a full admin) can do this.' });
  next();
});
api.get('/auto-sync', ownerOnly, wrap(async (req, res) => res.json({ on: process.env.AUTO_SYNC !== 'off', users: await jobs.statusAll() })));
api.put('/auto-sync/:id', ownerOnly, wrap(async (req, res) => {
  if (!(await db.getUser(req.params.id))) return res.status(404).json({ error: 'Account not found.' });
  await jobs.setEnabled(req.params.id, !!req.body.enabled);
  res.json({ ok: true });
}));
api.put('/auto-sync', ownerOnly, wrap(async (req, res) => {
  for (const u of await db.allUsers()) await jobs.setEnabled(u.fb_id, !!req.body.enabled);
  res.json({ ok: true });
}));
// Admin overview: every account's spend for a period (owner, or people the owner allowed).
const adminViewers = async () => new Set(await db.getSetting('adminViewers', []));
// Company roles: ceo (the app owner, or anyone given it), coo (sees everything, like an admin), pm (own clients).
// Stored in the setting roles = { fbId: 'ceo'|'coo'|'pm' }; ceo/coo are also admin viewers so every older check holds.
const ROLES = ['ceo', 'coo', 'cmo', 'pm', 'mb']; // mb = a media buyer who logs in with Facebook: /mediabuyer site, media buyer task menu
const LEAD = new Set(['ceo', 'coo', 'cmo']); // top leadership: control everything, like the owner
const roleMap = async () => (await db.getSetting('roles', {})) || {};
async function roleOf(id) {
  if ((await db.ownerId()) === id) return 'ceo';
  const r = (await roleMap())[id]; if (ROLES.includes(r)) return r;
  return (await adminViewers()).has(id) ? 'coo' : 'pm';
}
const canSeeAdmin = async (id) => (String(id).startsWith('g:') && !!(await sitePerson(String(id).slice(2)))) || (await db.ownerId()) === id || (await adminViewers()).has(id);
const adminOnly = wrap(async (req, res, next) => {
  if (!(await canSeeAdmin(req.user.fb_id))) return res.status(403).json({ error: 'Only the app owner and people they allow can see the Admin dashboard.' });
  next();
});
api.put('/admin/viewers/:id', ownerOnly, wrap(async (req, res) => {
  const v = await adminViewers();
  if (req.body && req.body.enabled) v.add(req.params.id); else v.delete(req.params.id);
  await db.setSetting('adminViewers', [...v]);
  res.json({ ok: true });
}));
// Teams (groups of accounts shown together on the Admin dashboard). The owner manages them.
const getTeams = () => db.getSetting('teams', []);
const saveTeams = (t) => db.setSetting('teams', t);
api.get('/admin/teams', adminOnly, wrap(async (req, res) => {
  const owner = await db.ownerId(), bl = await MB().all(), byName = {};
  const users = await db.allUsers(); for (const u of users) byName[u.name] = u.fb_id;
  const mbs = bl.map((b) => ({ id: b.id, name: b.name, pm: b.addedById || byName[b.addedBy] || null, linked: !!(b.linked || b.chat) })); // all() gives the public shape: `linked`, never the chat id
  const roles = await roleMap(), av = await adminViewers(), now = Date.now(), logins = await LOGINS().list();
  const counts = Object.fromEntries((await db.pool.query(`SELECT owner, count(*) FILTER (WHERE NOT archived)::int AS n FROM clients GROUP BY owner`)).rows.map((r) => [r.owner, r.n]));
  const accts = Object.fromEntries((await db.pool.query(`SELECT owner, count(*)::int AS n FROM ad_accounts GROUP BY owner`)).rows.map((r) => [r.owner, r.n]));
  const out = [];
  for (const u of users) {
    const exp = u.token_expires ? Date.parse(u.token_expires) : 0, chat = await db.getUserSetting(u.fb_id, 'tgChat', null), lg = logins.find((l) => l.fbId === u.fb_id);
    out.push({ id: u.fb_id, name: u.name, role: u.fb_id === owner ? 'owner' : ROLES.includes(roles[u.fb_id]) ? roles[u.fb_id] : av.has(u.fb_id) ? 'coo' : 'pm',
      buyers: mbs.filter((m) => m.pm === u.fb_id).map((m) => m.name), mbs: mbs.filter((m) => m.pm === u.fb_id).map((m) => ({ id: m.id, name: m.name, linked: m.linked })),
      clients: counts[u.fb_id] || 0, adAccounts: accts[u.fb_id] || 0, username: lg ? lg.username : '',
      facebook: { name: await fbNameOf(u), expired: !!(exp && exp < now), daysLeft: exp ? Math.floor((exp - now) / 864e5) : null },
      extras: (await sync.extraLogins(u.fb_id)).map((e) => ({ id: e.id, name: e.name, expired: !!(e.error || (e.expires && Date.parse(e.expires) < now)), shared: !!e.shared })),
      telegram: { linked: !!(chat && chat.id), name: chat ? chat.name || '' : '' } });
  }
  res.json({ teams: await getTeams(), users: out, canEdit: await isFull(req), bot: telegram.hasBot() });
}));
// A leader (owner / CEO / COO / CMO) keeps their own sign-in, and their Facebook login is ALSO used by a team to reach
// its ad accounts: it is added to that team's Facebook accounts. (An ordinary second account is merged instead.)
api.post('/admin/teams/share-fb', ownerOnly, wrap(async (req, res) => {
  const b = req.body || {}, from = String(b.from || ''), into = String(b.into || '');
  const src = await db.getUser(from), dst = await db.getUser(into); if (!src || !dst || from === into) return res.status(404).json({ error: 'Choose two different accounts.' });
  const roles = await roleMap(), lead = from === (await db.ownerId()) || LEAD.has(roles[from]) || (await fullAdmins()).has(from);
  if (!lead) return res.status(400).json({ error: `${src.name} is an ordinary account — use Merge into… so its clients move too.` });
  const list = (await sync.extraLogins(into)).filter((x) => x.id !== from);
  if (list.length + 2 > require('./src/merge').MAX_FB) return res.status(400).json({ error: `${dst.name} already has the most Facebook accounts a workspace can hold.` });
  list.push({ id: from, name: await fbNameOf(src), token_enc: src.token_enc, expires: src.token_expires, addedAt: new Date().toISOString(), shared: true });
  await db.setUserSetting(into, 'fbExtras', list);
  let n = 0; try { await sync.refreshAccounts(dst); n = (await db.listAccounts(into)).filter((a) => (a.info || {}).via === from).length; } catch (e) { console.error('[share fb] account list failed:', e.message); }
  console.log('[teams]', await fbNameOf(src), 'Facebook shared with', dst.name, 'by', req.user.name);
  res.json({ ok: true, name: await fbNameOf(src), into: dst.name, found: n });
}));
api.post('/admin/teams', ownerOnly, wrap(async (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: 'Give the team a name.' });
  const teams = await getTeams();
  const t = { id: 't' + Date.now().toString(36), name, members: [] };
  teams.push(t); await saveTeams(teams); res.json(t);
}));
api.patch('/admin/teams/:id', ownerOnly, wrap(async (req, res) => {
  const teams = await getTeams(), t = teams.find((x) => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'Team not found.' });
  if (req.body?.name != null) { const n = String(req.body.name).trim().slice(0, 60); if (n) t.name = n; }
  if (req.body?.add) { const id = String(req.body.add); for (const x of teams) x.members = x.members.filter((m) => m !== id); t.members.push(id); } // one team per person
  if (req.body?.remove) t.members = t.members.filter((m) => m !== String(req.body.remove));
  await saveTeams(teams); res.json(t);
}));
api.delete('/admin/teams/:id', ownerOnly, wrap(async (req, res) => {
  await saveTeams((await getTeams()).filter((x) => x.id !== req.params.id)); res.json({ ok: true });
}));
// Main Dashboard: each account's to-do list and suggestions for today (the same list each person sees on their Dashboard).
api.get('/main/suggestions', adminOnly, wrap(async (req, res) => {
  const out = {};
  await Promise.all((await db.allUsers()).map(async (u) => {
    try { const t = await pm.todo({ fb_id: u.fb_id, name: u.name }); out[u.fb_id] = { items: t.items || [], tips: t.tips || [] }; }
    catch (e) { out[u.fb_id] = { items: [], tips: [], error: e.message }; }
  }));
  res.json({ today: sync.todayIn(), users: out });
}));
// Main Dashboard: everyone's client tasks for one day (AI daily plan tasks + their own), read-only for the COO.
// Includes tasks left open from earlier days (only when looking at today) and earlier tasks finished on this day.
// A task's target for one day: { target, unit, reached } (reached is typed by the person; per day for every-day tasks).
const tgt = (t, day) => (Number(t.target) > 0 ? { target: Number(t.target), unit: String(t.unit || ''), reached: Number((t.hit || {})[day]) || 0 } : {});
const AI_TASK_DAYS = 3; // unticked AI plan tasks drop off after this many days
async function dayTasks(day) {
  const today = sync.todayIn();
  const users = await db.allUsers(), out = {};
  for (const u of users) out[u.fb_id] = { name: u.name, tasks: [], plans: 0, clients: 0 };
  const cl = (await db.pool.query('SELECT id, name, owner, archived FROM clients')).rows, cName = {};
  for (const c of cl) { cName[c.id] = c.name; if (!c.archived && out[c.owner]) out[c.owner].clients++; }
  const rows = (await db.pool.query(`SELECT key, value FROM settings WHERE key ~ '^[^:]+:cwb:[0-9]+$'`)).rows;
  const localDay = (iso) => { try { return sync.todayIn(undefined, new Date(iso)); } catch (_) { return ''; } };
  for (const r of rows) {
    const [owner, , cid] = r.key.split(':'), o = out[owner]; if (!o || !cName[cid]) continue;
    const w = r.value || {};
    if (w.ai && w.ai.day === day) o.plans++;
    for (const t of w.tasks || []) {
      const doneDay = t.done && t.doneAt ? localDay(t.doneAt) : '';
      if (t.repeat) { // every day from the day it was added: done only if ticked that day
        if (t.day > day || day > today) continue;
        o.tasks.push({ id: t.id, text: t.text, from: 'me', day, done: doneDay === day, doneAt: doneDay === day ? t.doneAt : null, doneBy: doneDay === day ? t.doneBy || null : null, late: false, repeat: true, client: cName[cid], clientId: Number(cid), ...tgt(t, day), to: t.to ? { id: t.to.id, name: t.to.name } : null, sentAt: t.sentAt || null, kpi: t.kpi || '' });
        continue;
      }
      const late = t.day < day && ((!t.done && day === today) || doneDay === day);
      if (t.day !== day && !late) continue;
      if (t.from === 'ai' && !t.done && t.day < sync.addDays(day, -AI_TASK_DAYS)) continue; // an AI idea nobody ticked in 3 days has expired
      o.tasks.push({ id: t.id, text: t.text, from: t.from === 'ai' ? 'ai' : 'me', day: t.day, done: !!t.done, doneAt: t.doneAt || null, doneBy: t.doneBy || null, late: t.day < day, client: cName[cid], clientId: Number(cid), ...tgt(t, t.day), to: t.to ? { id: t.to.id, name: t.to.name } : null, sentAt: t.sentAt || null, kpi: t.kpi || '' });
    }
  }
  // Today's work (the same rule-based list each person sees in Clients: send report, unpaid, quiet client…), ticked or not.
  if (day === today) {
    const wb = {}; for (const r of rows) wb[r.key] = r.value || {};
    await Promise.all(users.map(async (u) => {
      let t; try { t = await pm.todo({ fb_id: u.fb_id, name: u.name }); } catch (_) { return; }
      for (const x of [...(t.items || []), ...(t.tips || [])]) {
        if (!x.clientId || !cName[x.clientId]) continue;
        const wbk = wb[`${u.fb_id}:cwb:${x.clientId}`] || {};
        const tk = (wbk.ticks || {})[`${day}:${x.kind}`];
        out[u.fb_id].tasks.push({ id: `w:${x.clientId}:${x.kind}`, text: x.title, detail: x.detail || '', from: 'work', kind: x.kind, level: x.level || '', day, done: !!tk, doneAt: tk ? tk.at : null, doneBy: tk ? tk.by : null, late: false, client: cName[x.clientId], clientId: Number(x.clientId) });
      }
    }));
  }
  const ord = { work: 0, ai: 1, me: 2 };
  for (const o of Object.values(out)) o.tasks.sort((a, b) => a.client.localeCompare(b.client) || (a.done - b.done) || (ord[a.from] - ord[b.from]) || a.day.localeCompare(b.day));
  return { day, today, users: out };
}
api.get('/main/tasks', adminOnly, wrap(async (req, res) => {
  const day = isDay(req.query.day) ? req.query.day : sync.todayIn();
  res.json({ ...(await dayTasks(day)), teams: (await getTeams()).map((t) => ({ id: t.id, name: t.name, members: t.members })) });
}));
// Clients Board: every client of every person — this month's money (+ yesterday) and today's work & tasks.
// The money part is kept for 2 minutes (it reads every account); tasks are always fresh.
let boardMoney = { at: 0, key: '', data: null };
async function clientMoney(today) {
  if (boardMoney.data && boardMoney.key === today && Date.now() - boardMoney.at < 120e3) return boardMoney.data;
  const from = today.slice(0, 8) + '01', yest = sync.addDays(today, -1), out = {};
  const nm = (x) => String(x || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const cpoPart = async (owner, f, t) => {
    const [d, pages, oc] = await Promise.all([sync.dashboard(owner, f, t), sync.pageSpend(owner, f, t), orders.byClient(owner, f, t)]);
    const r = {};
    for (const c of d.clients) {
      const o = oc.clients[c.id] || { orders: 0, pages: {} };
      const pg = sync.scalePages(pages[c.id] || [], c.spend).map((p) => ({ spend: p.spend, orders: o.pages[p.pageId] || o.pages['name:' + nm(p.page)] || 0 }));
      const top = (pages[c.id] || []).filter((p) => p.pageId).sort((a, b) => b.spend - a.spend)[0];
      r[c.id] = { pageId: top ? String(top.pageId) : '', spend: c.spend, orders: o.orders, ordSpend: sync.orderSpend(pg, o.orders, c.spend), lives: c.lives || 0, liveSpend: c.liveSpend || 0, postSpend: c.postSpend || 0, days: c.days || 0 };
    }
    return r;
  };
  for (const u of await db.allUsers()) {
    try { const [m, y] = await Promise.all([cpoPart(u.fb_id, from, today), cpoPart(u.fb_id, yest, yest)]); out[u.fb_id] = { m, y }; } catch (_) { out[u.fb_id] = { m: {}, y: {} }; }
  }
  boardMoney = { at: Date.now(), key: today, data: { from, to: today, out } };
  return boardMoney.data;
}
api.get('/main/board', adminOnly, wrap(async (req, res) => {
  const today = sync.todayIn();
  const [money, tasks, teams, users, cl] = await Promise.all([clientMoney(today), dayTasks(today), getTeams(), db.allUsers(), db.pool.query('SELECT id, name, owner, type, archived, telegram, telegram_title, pages FROM clients ORDER BY name').then((r) => r.rows)]);
  // each client's AI plan (the same "Today's plan" its owner sees; notes stay private)
  const wb = {}; for (const r of (await db.pool.query(`SELECT key, value FROM settings WHERE key ~ '^[^:]+:cwb:[0-9]+$'`)).rows) wb[r.key] = r.value || {};
  const uName = Object.fromEntries(users.map((u) => [u.fb_id, u.name])), teamOf = {};
  for (const t of teams) for (const m of t.members) teamOf[m] = t.id;
  const clients = [];
  for (const c of cl) {
    if (!uName[c.owner]) continue;
    const mm = ((money.out[c.owner] || {}).m || {})[c.id], yy = ((money.out[c.owner] || {}).y || {})[c.id];
    if (c.archived && !(mm && mm.spend > 0)) continue;
    const ts = ((tasks.users[c.owner] || {}).tasks || []).filter((t) => t.clientId === c.id).map(({ client, clientId, ...t }) => t);
    clients.push({ id: c.id, name: c.name, type: c.type, group: c.telegram_title || '', archived: !!c.archived, owner: c.owner, ownerName: uName[c.owner], team: teamOf[c.owner] || null,
      month: mm || { spend: 0, orders: 0, ordSpend: 0, lives: 0, liveSpend: 0, postSpend: 0, days: 0 }, yest: yy || { spend: 0, orders: 0, ordSpend: 0 }, tasks: ts,
      pageId: (mm && mm.pageId) || ((Array.isArray(c.pages) ? c.pages : []).map(String).find((x) => /^\d{5,20}$/.test(x)) || ''),
      hasGroup: !!c.telegram, plan: (() => { const a = (wb[`${c.owner}:cwb:${c.id}`] || {}).ai; return a && a.text ? { day: a.day, lang: a.lang, at: a.at, text: String(a.text).slice(0, 6000) } : null; })() });
  }
  res.json({ today, from: money.from, to: money.to, taxRate: sync.TAX_RATE, teams: teams.map((t) => ({ id: t.id, name: t.name, members: t.members })), people: users.map((u) => ({ id: u.fb_id, name: u.name, team: teamOf[u.fb_id] || null })), clients });
}));
// Main Dashboard (COO view): every account, every Page it boosts, spend and adsbox.biz orders per Page.
api.get('/main/overview', adminOnly, wrap(async (req, res) => {
  const { from, to } = req.query;
  if (!isDay(from) || !isDay(to) || from > to || (Date.parse(to) - Date.parse(from)) / 864e5 > 366) return res.status(400).json({ error: 'Pick a valid period (at most one year).' });
  const nm = (x) => String(x || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const ordRows = (await db.pool.query('SELECT page_id, max(page_name) AS page_name, sum(orders)::int AS orders FROM page_orders WHERE day BETWEEN $1 AND $2 GROUP BY page_id', [from, to])).rows;
  const byId = {}, byName = {};
  for (const r of ordRows) { byId[String(r.page_id)] = r.orders; if (r.page_name) byName[nm(r.page_name)] = (byName[nm(r.page_name)] || 0) + r.orders; }
  const users = [], seenPages = new Map();
  for (const u of await db.allUsers()) {
    const [ps, clients, dash, unl] = await Promise.all([sync.pageSpend(u.fb_id, from, to), db.listClients(u.fb_id), sync.dashboard(u.fb_id, from, to), sync.unmatchedSpend(u.fb_id, from, to)]);
    const cName = Object.fromEntries(clients.map((c) => [c.id, c.name]));
    const pages = [];
    // Spend per client = the saved entries (same as the Dashboard); Pages are scaled to add up to it.
    const per = {};
    for (const dc of dash.clients) {
      if (!(dc.spend > 0)) continue;
      const raw = ps[dc.id] || [];
      per[dc.id] = raw.length ? sync.scalePages(raw, dc.spend)
        : [{ page: dc.name + ' (Page not known)', pageId: '', named: true, spend: dc.spend, live: dc.liveSpend, post: dc.postSpend, list: [{ id: `entry:${u.fb_id}:${dc.id}`, spend: dc.spend }] }];
    }
    for (const [cid, list] of Object.entries(per)) for (const p of list) {
      const orders = (p.pageId && byId[String(p.pageId)]) || byName[nm(p.page)] || byName[nm(p.guess)] || 0;
      // Campaign IDs with their spend: two people syncing the same ad account see the same campaigns,
      // so team and company totals count each campaign once.
      const camps = (p.list || []).map((x, i) => [x.id ? String(x.id) : `${u.fb_id}:${p.page}:${i}`, x.spend]);
      pages.push({ page: p.page, pageId: p.pageId, named: p.named, guess: p.guess || '', client: cName[cid] || '', clientId: Number(cid), spend: p.spend, live: p.live, post: p.post, orders, camps });
      const key = p.pageId || nm(p.page);
      const s = seenPages.get(key) || { orders, camps: new Map() };
      for (const [id, v] of camps) if (!s.camps.has(id)) s.camps.set(id, v);
      seenPages.set(key, s);
    }
    pages.sort((a, b) => b.spend - a.spend);
    const spend = pages.reduce((t, p) => t + p.spend, 0), orders = pages.reduce((t, p) => t + p.orders, 0);
    const ordSpend = pages.filter((p) => p.orders > 0).reduce((t, p) => t + p.spend, 0);
    if (!pages.length && !clients.length && !unl.spend) continue;
    users.push({ id: u.fb_id, name: u.name, you: u.fb_id === req.user.fb_id, spend: Math.round(spend * 100) / 100, orders, ordSpend: Math.round(ordSpend * 100) / 100, clients: clients.filter((c) => !c.archived).length, pages, unlinked: { spend: unl.spend, pages: unl.pages.slice(0, 12) }, _unl: unl.pages });
  }
  users.sort((a, b) => b.spend - a.spend || a.name.localeCompare(b.name));
  // Totals: a Page boosted from two accounts has its orders counted once.
  const tot = { spend: 0, orders: 0, ordSpend: 0, pages: seenPages.size, users: users.filter((u) => u.spend > 0).length };
  let added = 0; for (const u of users) added += u.spend;
  for (const v of seenPages.values()) { const sp = [...v.camps.values()].reduce((a, b) => a + b, 0); tot.spend += sp; tot.orders += v.orders; if (v.orders > 0) tot.ordSpend += sp; }
  tot.shared = Math.max(0, Math.round((added - tot.spend) * 100) / 100);
  tot.spend = Math.round(tot.spend * 100) / 100; tot.ordSpend = Math.round(tot.ordSpend * 100) / 100;
  const unlinked = { spend: 0 }; { const seen = new Map(); for (const u of users) for (const p of u._unl) for (const [id, v] of p.camps || []) if (!seen.has(id)) seen.set(id, v); unlinked.spend = Math.round([...seen.values()].reduce((a, b) => a + b, 0) * 100) / 100; }
  for (const u of users) { delete u._unl; u.unlinked.pages = u.unlinked.pages.map(({ camps, ...p }) => p); }
  tot.unlinked = unlinked.spend;
  res.json({ from, to, totals: tot, users, quality: await orders.periodQuality(from, to), teams: (await getTeams()).map((t) => ({ id: t.id, name: t.name, members: t.members })) });
}));
// Company dashboard (CEO / COO): one month of the whole company.
const company = require('./src/company');
api.get('/company/summary', adminOnly, wrap(async (req, res) => {
  res.json(await company.summary({ month: req.query.month, getTeams, dayTasks, clientMoney }));
}));
api.get('/admin/overview', adminOnly, wrap(async (req, res) => {
  const { from, to } = req.query;
  if (!isDay(from) || !isDay(to) || from > to || (Date.parse(to) - Date.parse(from)) / 864e5 > 366) return res.status(400).json({ error: 'Pick a valid period (at most one year).' });
  const users = await db.allUsers();
  const out = [];
  // Orders from adsbox.biz for the period (live), counted per account through its clients' Pages.
  const given = null; // kept daily counts (see orders.js)
  for (const u of users) {
    const d = await sync.dashboard(u.fb_id, from, to);
    let ord = 0, ordSpend = 0;
    try { const oc = await orders.byClient(u.fb_id, from, to, 'all', given); for (const c of d.clients) { const o = oc.clients[c.id]; if (o && o.orders) { ord += o.orders; ordSpend += c.spend; } } } catch (_) {}
    const last = (await db.pool.query('SELECT max(synced_at) AS at FROM day_meta WHERE owner=$1', [u.fb_id])).rows[0];
    out.push({
      id: u.fb_id, name: u.name, you: u.fb_id === req.user.fb_id,
      expired: !!(u.token_expires && new Date(u.token_expires) < new Date()),
      lastSync: last && last.at, totals: d.totals, orders: ord, orderSpend: Math.round(ordSpend * 100) / 100,
      clientCount: d.clients.filter((c) => !c.archived).length,
      clients: d.clients.filter((c) => c.spend > 0 || !c.archived).map((c) => ({ id: c.id, name: c.name, type: c.type, lives: c.lives, liveSpend: c.liveSpend, postSpend: c.postSpend, spend: c.spend, days: c.days })),
    });
  }
  out.sort((a, b) => b.totals.spend - a.totals.spend || a.name.localeCompare(b.name));
  const totals = out.reduce((t, u) => ({ spend: t.spend + u.totals.spend, live: t.live + u.totals.live, post: t.post + u.totals.post, lives: t.lives + u.totals.lives, clients: t.clients + u.totals.active, accounts: t.accounts + (u.totals.spend > 0 ? 1 : 0) }), { spend: 0, live: 0, post: 0, lives: 0, clients: 0, accounts: 0 });
  const teams = await getTeams();
  for (const u of out) { const t = teams.find((x) => x.members.includes(u.id)); u.team = t ? t.id : null; }
  // Team and all-account totals count each Meta campaign once (two people can sync the same ad account).
  const teamTotals = {};
  for (const t of teams) {
    const ids = out.filter((u) => u.team === t.id).map((u) => u.id);
    const sum = out.filter((u) => u.team === t.id).reduce((a, u) => a + u.totals.spend, 0);
    teamTotals[t.id] = { ...(await sync.uniqueTotals(ids, from, to)), added: Math.round(sum * 100) / 100 };
  }
  const uniq = await sync.uniqueTotals(out.map((u) => u.id), from, to);
  const allTotals = { ...totals, spend: uniq.spend, live: uniq.live, post: uniq.post, lives: uniq.lives, clients: uniq.clients, added: Math.round(totals.spend * 100) / 100 };
  allTotals.orders = out.reduce((t, u) => t + u.orders, 0); allTotals.orderSpend = out.reduce((t, u) => t + u.orderSpend, 0);
  res.json({ from, to, users: out, totals: allTotals, teams, teamTotals, taxRate: sync.TAX_RATE });
}));
// ---- Admin panel: users, health, settings ----
api.get('/admin/users', adminOnly, wrap(async (req, res) => {
  const owner = await db.ownerId(), viewers = await adminViewers(), teams = await getTeams();
  const status = await jobs.statusAll();
  const users = await db.allUsers();
  const out = [];
  for (const st of status) {
    const u = users.find((x) => x.fb_id === st.id) || {};
    const t = teams.find((x) => x.members.includes(st.id));
    out.push({ ...st, role: st.id === owner ? 'owner' : viewers.has(st.id) ? 'admin' : 'member', company: await roleOf(st.id), team: t ? t.name : '', lastLogin: u.updated_at || null,
      lastSeen: await db.getUserSetting(st.id, 'lastSeen', null), autoReport: await db.getUserSetting(st.id, 'autoReport', null) });
  }
  out.sort((a, b) => ({ owner: 0, admin: 1, member: 2 }[a.role] - { owner: 0, admin: 1, member: 2 }[b.role]) || String(a.name).localeCompare(String(b.name)));
  const full = await isFull(req), fa = await fullAdmins(); for (const u of out) if (u.role !== 'owner' && fa.has(u.id) && !LEAD.has(u.company)) u.company = 'full'; // CEO/COO/CMO keep their title; 'full' is for others with owner rights
  res.json({ users: out, canEdit: full, me: req.user.fb_id, autoSyncServer: process.env.AUTO_SYNC !== 'off', blocked: full ? await db.blockedUsers() : {} });
}));
api.put('/admin/role/:id', ownerOnly, wrap(async (req, res) => {
  const id = req.params.id; if (id === req.user.fb_id) return res.status(400).json({ error: 'You can\'t change your own role.' });
  if (id === (await db.ownerId())) return res.status(400).json({ error: 'The app owner\'s role can\'t be changed.' });
  if (!(await db.getUser(id))) return res.status(404).json({ error: 'Account not found.' });
  const role = String((req.body || {}).role || ''), map = await roleMap();
  // ceo / coo see everything (admin viewers); pm and the older "member" see only their own clients; full = everything the owner can do.
  const v = await adminViewers(); if (role === 'admin' || LEAD.has(role) || role === 'full') v.add(id); else v.delete(id);
  const fa = await fullAdmins(); if (role === 'full' || LEAD.has(role)) fa.add(id); else fa.delete(id); await db.setSetting('fullAdmins', [...fa]);
  if (ROLES.includes(role)) map[id] = role; else if (role === 'full') map[id] = 'ceo'; else delete map[id];
  await db.setSetting('roles', map); await db.setSetting('adminViewers', [...v]); res.json({ ok: true, role: role === 'full' ? 'full' : await roleOf(id) });
}));
// Everything that needs attention, worst first.
api.get('/admin/health', adminOnly, wrap(async (req, res) => {
  const items = [], now = Date.now(), day = 864e5, today = sync.todayIn();
  const add = (level, area, title, detail, action) => items.push({ level, area, title, detail, action: action || null });
  const status = await jobs.statusAll();
  for (const u of status) {
    const exp = u.tokenExpires ? Date.parse(u.tokenExpires) : 0;
    if (u.expired) add('bad', 'Login', `${u.name}'s Facebook login has expired`, 'Nothing syncs for this account until they log in to Boost Desk again.', null);
    else if (exp && exp - now < 7 * day) add('warn', 'Login', `${u.name}'s Facebook login expires in ${Math.max(1, Math.round((exp - now) / day))} day(s)`, 'Ask them to log out and log in again to renew it.', null);
    const lr = u.lastRun;
    if (lr && lr.error) add('bad', 'Sync', `Auto sync failed for ${u.name}`, `${lr.error} · ${new Date(lr.at).toLocaleString('en-GB', { timeZone: cfg.tz, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`, { kind: 'run', id: u.id });
    else if (lr && lr.errors) add('warn', 'Sync', `${u.name}: ${lr.errors} ad account(s) failed in the last sync`, 'Check Ad accounts for disabled or unpaid accounts.', { kind: 'run', id: u.id });
    if (!u.expired && u.enabled && !u.synced) add('info', 'Sync', `${u.name} has never synced`, 'Auto sync starts after they tap Sync from Meta once.', null);
    if (!u.expired && u.enabled && u.synced && lr && lr.at && now - Date.parse(lr.at) > 3 * 3600e3) add('warn', 'Sync', `No auto sync for ${u.name} in ${Math.round((now - Date.parse(lr.at)) / 3600e3)} hours`, 'Usually it runs every hour.', { kind: 'run', id: u.id });
    const na = Object.values((await db.getUserSetting(u.id, 'acctNoAccess', {})) || {});
    if (na.length) add('warn', 'Sync', `${u.name}: ${na.length} ad account(s) Boost Desk can't read`, `${na.map((x) => x.name).join(', ')} — Meta says no permission. Untick it in Ad accounts, or ask the account's owner to give ${u.name} access again. Boost Desk retries every 6 hours.`, null);
    const ar = await db.getUserSetting(u.id, 'autoReportLast', null);
    if (ar && ar.failed && ar.failed.length) add('bad', 'Reports', `${ar.failed.length} auto report(s) failed for ${u.name}`, ar.failed.slice(0, 3).map((f) => `${f.name}: ${f.error}`).join(' · '), null);
  }
  if (!telegram.hasBot()) add('bad', 'Telegram', 'The Telegram bot is not set up', 'Add TELEGRAM_BOT_TOKEN in Railway so reports can be sent.', null);
  const oc = await orders.publicConfig();
  if (oc.own && oc.own.on) {
    const pg = (await db.pool.query(`SELECT count(*)::int AS n, count(*) FILTER (WHERE NOT subscribed OR last_error <> '')::int AS bad FROM page_links`)).rows[0];
    if (!pg.n) add('info', 'Orders', 'No Facebook Page is connected for orders', 'Orders → Connect Pages, so Boost Desk can count orders from Messenger and comments.', { kind: 'orders' });
    else if (pg.bad) add('warn', 'Orders', `${pg.bad} connected Page${pg.bad === 1 ? ' has' : 's have'} a problem`, 'Open Orders → Pages to see which one and connect it again.', { kind: 'orders' });
  } else if (!oc.hasKey) add('info', 'Orders', 'adsbox.biz is not connected', 'Connect it to see cost per order.', { kind: 'orders' });
  else if (oc.lastError) add('bad', 'Orders', 'Getting orders from adsbox.biz failed', oc.lastError.message, { kind: 'orders' });
  else if (oc.last && now - Date.parse(oc.last.at) > 2 * 3600e3) add('warn', 'Orders', 'Orders from adsbox.biz have not updated in ' + Math.round((now - Date.parse(oc.last.at)) / 3600e3) + ' hours', 'Usually every 30 minutes.', { kind: 'orders' });
  const ps = await orders.pushStatus();
  if (ps.on && ps.last && ps.last.error) add('bad', 'Orders', 'Sending spend to adsbox.biz failed', ps.last.error, { kind: 'orders' });
  else if (ps.on && ps.last && ps.last.noPage) add('info', 'Orders', `${ps.last.noPage} campaign(s) sent to adsbox.biz without a Page`, 'adsbox.biz can only match spend to orders when the Page is known.', null);
  if (process.env.AUTO_SYNC === 'off') add('warn', 'Sync', 'Auto sync is switched off on the server', 'AUTO_SYNC=off is set in Railway.', null);
  const order = { bad: 0, warn: 1, info: 2 };
  items.sort((a, b) => order[a.level] - order[b.level]);
  const ok = [];
  if (telegram.hasBot()) ok.push('Telegram bot is set up');
  if (oc.hasKey && !oc.lastError) ok.push('adsbox.biz orders are connected' + (oc.last ? ' · last update ' + new Date(oc.last.at).toLocaleTimeString('en-GB', { timeZone: cfg.tz, hour: '2-digit', minute: '2-digit' }) : ''));
  const running = status.filter((u) => u.enabled && u.synced && !u.expired).length;
  ok.push(`Auto sync running for ${running} of ${status.length} account(s)`);
  res.json({ items, ok, checkedAt: new Date().toISOString(), today });
}));
// System health (server, database, jobs, outside services, errors) and owner alerts.
api.get('/admin/system', adminOnly, wrap(async (req, res) => {
  const snap = await health.snapshot(db);
  const chat = await db.getSetting('alertChat', null), isOwner = await isFull(req);
  res.json({ ...snap, problems: health.problems(snap), alerts: { on: !!(chat && chat.id), name: chat ? chat.name : '', at: chat ? chat.at : null, bot: await telegram.username(), code: isOwner ? await linkCode(req.user.fb_id) : '', canEdit: isOwner } });
}));
api.delete('/admin/alerts', ownerOnly, wrap(async (req, res) => { await db.setSetting('alertChat', null); res.json({ ok: true }); }));
api.post('/admin/alerts/test', ownerOnly, wrap(async (req, res) => {
  const chat = await db.getSetting('alertChat', null); if (!chat || !chat.id) return res.status(400).json({ error: 'Connect your Telegram first.' });
  await telegram.send('🩺 Boost Desk test alert — alerts are working.', chat.id); res.json({ ok: true });
}));
// Keys for the public spend API (owner only). The key is shown once, at creation.
const pubKeys = (list) => list.map((k) => ({ id: k.id, name: k.name, prefix: k.prefix, at: k.at, by: k.by, calls: k.calls || 0, lastUsed: k.lastUsed || null }));
api.get('/admin/spend-keys', ownerOnly, wrap(async (req, res) => res.json({ keys: pubKeys((await db.getSetting('spendApiKeys', [])) || []), base: cfg.baseUrl })));
api.post('/admin/spend-keys', ownerOnly, wrap(async (req, res) => {
  const name = String((req.body || {}).name || 'adsbox.biz').trim().slice(0, 60) || 'adsbox.biz';
  const plain = 'bd_' + crypto.randomBytes(24).toString('hex');
  const keys = (await db.getSetting('spendApiKeys', [])) || [];
  keys.push({ id: 'k' + Date.now().toString(36), name, prefix: plain.slice(0, 10), hash: sha(plain), at: new Date().toISOString(), by: req.user.name, calls: 0 });
  await db.setSetting('spendApiKeys', keys);
  res.json({ key: plain, keys: pubKeys(keys), base: cfg.baseUrl });
}));
api.delete('/admin/spend-keys/:id', ownerOnly, wrap(async (req, res) => {
  const keys = ((await db.getSetting('spendApiKeys', [])) || []).filter((k) => k.id !== req.params.id);
  await db.setSetting('spendApiKeys', keys); res.json({ keys: pubKeys(keys) });
}));
// ---- Facebook Page profile pictures: /api/page-pic/<page id> sends the browser to the picture (kept 12 hours) ----
const picCache = new Map(); // page id -> { url | null, at }
const picWait = new Map();
async function pagePicUrl(id, prefer) {
  const hit = picCache.get(id);
  if (hit && Date.now() - hit.at < (hit.url ? 12 : 2) * 3600e3) return hit.url;
  if (picWait.has(id)) return picWait.get(id);
  const job = (async () => {
    const owner = await db.ownerId(), users = await db.activeUsers();
    const order = [prefer, owner, ...users.map((u) => u.fb_id)].filter((x, i, a) => x && a.indexOf(x) === i).slice(0, 4);
    let url = null;
    for (const uid of order) {
      try { const u = await db.getUser(uid); if (!u) continue; const r = await meta.get(`/${id}/picture`, { redirect: 0, type: 'normal', width: 120, height: 120 }, await sync.tokenFor(u)); url = (r.data && !r.data.is_silhouette && r.data.url) || null; break; }
      catch (_) { /* try the next person's login */ }
    }
    picCache.set(id, { url, at: Date.now() }); if (picCache.size > 3000) picCache.delete(picCache.keys().next().value);
    return url;
  })().finally(() => picWait.delete(id));
  picWait.set(id, job);
  return job;
}
api.get('/page-pic/:id', wrap(async (req, res) => {
  const id = String(req.params.id); if (!/^\d{5,20}$/.test(id)) return res.status(404).end();
  const url = await pagePicUrl(id, req.user.google ? null : req.user.fb_id);
  if (!url) { res.set('Cache-Control', 'private, max-age=3600'); return res.status(404).end(); }
  res.set('Cache-Control', 'private, max-age=21600').redirect(302, url);
}));
// ---- Every ad account of every person (Admin → Ad accounts) ----
api.get('/admin/ad-accounts', adminOnly, wrap(async (req, res) => {
  const [rows, users, teams] = await Promise.all([db.pool.query('SELECT owner, id, name, enabled, info, seen_at FROM ad_accounts ORDER BY lower(name)').then((r) => r.rows), db.allUsers(), getTeams()]);
  const uName = Object.fromEntries(users.map((u) => [u.fb_id, u.name])), teamOf = {};
  for (const t of teams) for (const m of t.members) teamOf[m] = t.name;
  const map = new Map();
  for (const r of rows) {
    if (!uName[r.owner]) continue;
    const i = r.info || {}, a = map.get(r.id) || { id: r.id, name: r.name, status: '', statusCode: null, disableReason: '', balance: 0, threshold: null, spendCap: 0, amountSpent: 0, currency: '', business: '', todaySpend: null, todayAt: null, seenAt: null, people: [] };
    // the newest snapshot wins for the account's numbers
    if (!a.seenAt || new Date(r.seen_at) > new Date(a.seenAt)) Object.assign(a, { name: r.name, status: i.status || '', statusCode: i.statusCode ?? null, disableReason: i.disableReason || '', balance: i.balance || 0, threshold: i.threshold ?? null, spendCap: i.spendCap || 0, amountSpent: i.amountSpent || 0, currency: i.currency || '', business: i.business || '', seenAt: r.seen_at });
    if (i.todaySpend != null && (a.todaySpend == null || (i.todayAt || '') > (a.todayAt || ''))) { a.todaySpend = i.todaySpend; a.todayAt = i.todayAt || null; }
    a.people.push({ id: r.owner, name: uName[r.owner], team: teamOf[r.owner] || '', enabled: !!r.enabled });
    map.set(r.id, a);
  }
  // Spend per account per day (last 14 days) and its Pages (last 7 days) from the synced campaign rows;
  // a campaign synced by two people counts once.
  const today = sync.todayIn(), from14 = sync.addDays(today, -13), from7 = sync.addDays(today, -6);
  const camp = (await db.pool.query(`SELECT to_char(day,'YYYY-MM-DD') AS day, r->>'accountId' AS acc, coalesce(r->>'campaignId', r->>'name') AS cid, max((r->>'spend')::numeric) AS spend, max(r->>'page') AS page, max(r->>'pageId') AS pid
    FROM raw_rows, jsonb_array_elements(rows) r WHERE day >= $1 AND r ? 'accountId' GROUP BY 1,2,3`, [from14]).catch(() => ({ rows: [] }))).rows;
  for (const r of camp) {
    const a = map.get(r.acc); if (!a) continue;
    const v = Number(r.spend) || 0; a.daily = a.daily || {}; a.daily[r.day] = Math.round(((a.daily[r.day] || 0) + v) * 100) / 100;
    if (r.day >= from7) { a.week = (a.week || 0) + v; a.camps = (a.camps || 0) + (v > 0 ? 1 : 0); const k = r.pid || r.page || '?'; a._pg = a._pg || {}; const pg = a._pg[k] || (a._pg[k] = { page: r.page || '', pageId: r.pid || '', spend: 0 }); pg.spend += v; }
  }
  // Today's spend comes from today's sync (the saved account snapshot only has it for accounts nobody syncs).
  const synced = Object.fromEntries((await db.pool.query(`SELECT owner, max(synced_at) AS at FROM day_meta WHERE day = $1 GROUP BY owner`, [today])).rows.map((r) => [r.owner, r.at]));
  for (const a of map.values()) {
    const on = a.people.filter((p) => p.enabled), at = on.map((p) => synced[p.id]).filter(Boolean).sort().pop();
    if (on.length && (at || (a.daily && a.daily[today] != null))) { a.todaySpend = (a.daily && a.daily[today]) || 0; a.todayAt = at ? new Date(at).toISOString() : a.todayAt; }
  }
  for (const a of map.values()) { a.week = Math.round((a.week || 0) * 100) / 100; a.pages = Object.values(a._pg || {}).sort((x, y) => y.spend - x.spend).slice(0, 12).map((x) => ({ ...x, spend: Math.round(x.spend * 100) / 100 })); delete a._pg; }
  const teamId = {}; for (const t of teams) for (const m of t.members) teamId[m] = t.id;
  for (const a of map.values()) for (const p of a.people) p.teamId = teamId[p.id] || null;
  res.json({ today, from14, accounts: [...map.values()], teams: teams.map((t) => ({ id: t.id, name: t.name })), users: users.map((u) => ({ id: u.fb_id, name: u.name, team: teamOf[u.fb_id] || '', teamId: teamId[u.fb_id] || null })), canEdit: (await db.ownerId()) === req.user.fb_id });
}));
// Add an ad account by ID to someone's workspace — checked through their own Facebook login.
api.post('/admin/ad-accounts', ownerOnly, wrap(async (req, res) => {
  const raw = String((req.body || {}).account || '').trim().replace(/\s+/g, ''), owner = String((req.body || {}).owner || '');
  const m = raw.match(/(?:act_|act=|act%3D)?(\d{6,20})/i); if (!m) return res.status(400).json({ error: 'Paste the ad account ID (numbers, like 1234567890 or act_1234567890).' });
  const user = await db.getUser(owner); if (!user) return res.status(400).json({ error: 'Pick who uses this ad account.' });
  const act = 'act_' + m[1];
  let acc;
  try { acc = await meta.adAccount(await sync.tokenFor(user), act); }
  catch (e0) { let e = e0; // not on their main login: try the extra Facebook accounts connected to their workspace
    for (const x of await sync.extraLogins(owner)) { try { acc = { ...(await meta.adAccount(require('./src/crypto').decrypt(x.token_enc), act)), via: x.id, viaName: x.name }; break; } catch (e2) { e = e0; } }
    if (!acc) return res.status(400).json({ error: e.needsLogin ? `${user.name}'s Facebook login has expired — they need to log in to Boost Desk again first.` : `${user.name}'s Facebook login can't open ${act} (${e.message}). Give them access to this ad account in Business Manager, then try again.` }); }

  await db.saveAccounts(owner, [acc]);
  await db.pool.query('UPDATE ad_accounts SET enabled=true WHERE owner=$1 AND id=$2', [owner, act]);
  res.json({ ok: true, account: { id: act, name: acc.name, status: acc.status }, owner: user.name });
}));
api.patch('/admin/ad-accounts/:owner/:id', ownerOnly, wrap(async (req, res) => {
  await db.setAccountEnabled(req.params.owner, req.params.id, !!(req.body || {}).enabled); res.json({ ok: true });
}));
// Ask Facebook again for everyone's ad account list (new accounts, status, balance).
api.post('/admin/ad-accounts/refresh', adminOnly, wrap(async (req, res) => {
  let ok = 0; const failed = [];
  for (const u of await db.activeUsers()) {
    try { await sync.refreshAccounts(u); ok++; } catch (e) { failed.push(`${u.name}: ${e.message}`); if (e.rateLimited) break; }
  }
  res.json({ ok, failed });
}));
// ---- Admin website: who can sign in with Google (owner) ----
api.get('/admin/site-access', ownerOnly, wrap(async (req, res) => {
  const users = (await db.allUsers()).map((u) => ({ id: u.fb_id, name: u.name }));
  res.json({ google: !!(cfg.googleClientId && cfg.googleClientSecret), url: cfg.baseUrl + '/admin', redirectUri: googleRedirect(), people: (await siteCfg()).people, users });
}));
api.post('/admin/site-access', ownerOnly, wrap(async (req, res) => {
  const email = normEmail((req.body || {}).email), linkTo = String((req.body || {}).linkTo || '');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Type a full email address, like name@gmail.com.' });
  if (linkTo && !(await db.getUser(linkTo))) return res.status(400).json({ error: 'That Boost Desk account was not found.' });
  const site = await siteCfg(), old = site.people.find((p) => p.email === email);
  const full = (req.body || {}).full == null ? (old ? !!old.full : false) : !!(req.body || {}).full;
  if (old) Object.assign(old, { linkTo, full, name: String((req.body || {}).name || old.name || '').slice(0, 80) });
  else site.people.push({ email, name: String((req.body || {}).name || '').slice(0, 80), linkTo, full, addedAt: new Date().toISOString(), addedBy: req.user.name, lastLogin: null });
  await db.setSetting('adminSite', site); res.json({ people: site.people });
}));
api.delete('/admin/site-access/:email', ownerOnly, wrap(async (req, res) => {
  const site = await siteCfg(); site.people = site.people.filter((p) => p.email !== normEmail(req.params.email));
  await db.setSetting('adminSite', site); res.json({ people: site.people });
}));
// ---- Security (secret rotation checklist) and database backups — owner only ----
api.get('/admin/security', ownerOnly, wrap(async (req, res) => res.json(await require('./src/security').status())));
api.post('/admin/security/done', ownerOnly, wrap(async (req, res) => {
  const k = String((req.body || {}).key || ''); if (!/^[a-z]{2,20}$/.test(k)) return res.status(400).json({ error: 'Unknown step.' });
  const r = await db.getSetting('secretsRotated', {}); if ((req.body || {}).done === false) delete r[k]; else r[k] = new Date().toISOString();
  await db.setSetting('secretsRotated', r); res.json({ rotated: r });
}));
api.post('/admin/backup', ownerOnly, wrap(async (req, res) => {
  const r = await require('./src/backup').run(telegram); delete r.gz; res.json(r);
}));
api.get('/admin/backup/download', ownerOnly, wrap(async (req, res) => {
  const b = await require('./src/backup').make();
  res.set({ 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="${b.name}"`, 'Cache-Control': 'no-store' });
  res.send(b.gz);
}));
// Settings overview for the admin panel.
api.get('/admin/settings', adminOnly, wrap(async (req, res) => {
  const prof = invoice.profileOf(await db.getUserSetting(req.user.fb_id, 'invoiceProfile', {}));
  res.json({
    telegram: { bot: telegram.hasBot(), username: await telegram.username(), teamGroup: !!cfg.telegramChatId },
    orders: await orders.publicConfig(),
    invoice: { company: prof.company, bankName: prof.bankName, accountName: prof.accountName, accountNo: prof.accountNo, qr: prof.qr },
    autoSyncServer: process.env.AUTO_SYNC !== 'off', tz: cfg.tz, taxRate: sync.TAX_RATE,
    canEdit: await isFull(req),
    ai: await require('./src/ai').publicConfig(),
  });
}));
api.put('/admin/invoice-qr', ownerOnly, wrap(async (req, res) => {
  const qr = String((req.body || {}).qr || '');
  if (qr && (!/^data:image\/(png|jpe?g);base64,/.test(qr) || qr.length > 450000)) return res.status(400).json({ error: 'The QR must be a PNG or JPG, up to about 300 KB.' });
  await db.setSetting('invoiceQr', qr); invoice.setQr(qr); res.json({ ok: true });
}));
api.get('/blocked', ownerOnly, wrap(async (req, res) => res.json(await db.blockedUsers())));
api.delete('/users/:id', ownerOnly, wrap(async (req, res) => {
  const id = req.params.id;
  if (id === req.user.fb_id) return res.status(400).json({ error: "You can't remove your own account." });
  const u = await db.getUser(id);
  if (!u) return res.status(404).json({ error: 'Account not found.' });
  if (sync.isBusy(id)) return res.status(409).json({ error: `${u.name} is syncing right now. Try again in a minute.` });
  await db.setBlocked(id, u.name, true);
  await db.removeUser(id);
  res.json({ ok: true });
}));
// Merge two workspaces of one team (src/merge.js). The plan only counts; the merge itself needs the typed name and a fresh backup.
api.get('/admin/merge/plan', ownerOnly, wrap(async (req, res) => res.json(await require('./src/merge').plan(String(req.query.from || ''), String(req.query.into || '')))));
api.post('/admin/merge', ownerOnly, wrap(async (req, res) => {
  const b = req.body || {}, M = require('./src/merge'), p = await M.plan(String(b.from || ''), String(b.into || ''));
  if (String(b.confirm || '').trim().toLowerCase() !== p.from.name.trim().toLowerCase()) return res.status(400).json({ error: `Type "${p.from.name}" to confirm.` });
  if (p.from.id === req.user.fb_id) return res.status(400).json({ error: 'You are signed in as the account that would go away. Sign in as the other one, or ask another admin.' });
  // a backup first, so the merge can be undone by hand: sent to the owner's Telegram like the nightly one
  const bk = await require('./src/backup').run(telegram);
  if (!bk.sent && !b.noBackup) return res.status(409).json({ error: 'A backup could not be sent first (' + (bk.error || 'unknown reason') + '). Fix that, or download a backup in Admin → Settings and tick "I have a backup".', needBackup: true });
  const out = await M.run(p.from.id, p.into.id, req.user.name);
  console.log('[merge]', p.from.name, '→', p.into.name, 'by', req.user.name, '·', p.clients, 'clients,', p.adAccounts, 'ad accounts');
  const into = await db.getUser(p.into.id); sync.refreshAccounts(into).catch((e) => console.error('[merge] account refresh:', e.message));
  dedupeClients(into).catch((e) => console.error('[merge] dedupe:', e.message)); // the same client in both accounts becomes one
  res.json(out);
}));
api.delete('/blocked/:id', ownerOnly, wrap(async (req, res) => { await db.setBlocked(req.params.id, '', false); res.json({ ok: true }); }));
api.post('/auto-sync/:id/run', ownerOnly, wrap(async (req, res) => { await jobs.runNow(req.params.id); res.json({ ok: true }); }));

// Clients
const cleanClient = (b) => {
  const c = {};
  if (b.name != null) c.name = String(b.name).trim().slice(0, 120);
  if (b.match != null) c.match = String(b.match).trim().slice(0, 120);
  if (b.type != null) c.type = ['live', 'post', 'both'].includes(b.type) ? b.type : 'live';
  if (b.budget != null) c.budget = Math.max(0, Number(b.budget) || 0);
  if (b.lives != null) c.lives = Math.min(6, Math.max(1, parseInt(b.lives, 10) || 2));
  if (b.account != null) c.account = String(b.account).trim().slice(0, 120);
  if (b.telegram != null) c.telegram = String(b.telegram).trim().slice(0, 40);
  if (b.telegram_title != null) c.telegram_title = String(b.telegram_title).trim().slice(0, 150);
  if (Array.isArray(b.pages)) c.pages = [...new Set(b.pages.map((x) => String(x).trim().slice(0, 150)).filter(Boolean))].slice(0, 20);
  if (b.archived != null) c.archived = !!b.archived;
  if (b.topics && typeof b.topics === 'object') { // Telegram topic for each Page: { page: { id, title } }
    c.topics = {};
    for (const [pg, v] of Object.entries(b.topics).slice(0, 20)) if (v && /^-?\d+(:\d+)?$/.test(String(v.id || ''))) c.topics[String(pg).slice(0, 150)] = { id: String(v.id), title: String(v.title || '').slice(0, 150) };
  }
  if (b.service && typeof b.service === 'object') { // service fee + bill-to details (Payments tab)
    const v = b.service, str = (x, n) => String(x == null ? '' : x).trim().slice(0, n);
    c.service = { price: Math.max(0, Math.round((Number(v.price) || 0) * 100) / 100), day: Math.min(31, Math.max(0, parseInt(v.day, 10) || 0)), description: str(v.description, 160), customer: str(v.customer, 120), company: str(v.company, 120), phone: str(v.phone, 40) };
  }
  return c;
};
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
const unesc = (x) => String(x || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
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
    plan = require('./src/plan').clean(b, cur);
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
  const P = require('./src/plan'), c = (await db.listClients(req.user.fb_id)).find((x) => x.id === Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'Client not found.' });
  const only = String(req.query.only || '') ? String(req.query.only).split(',').map(Number) : null, pl = P.subset(c.plan, only).plan;
  if (!P.totals(pl).budget) return res.status(400).json({ error: 'Add at least one post with a daily budget first.' });
  res.json({ text: P.message(c, pl, req.query.lang === 'km' ? 'km' : 'en'), teamGroup: !!cfg.telegramChatId });
}));
api.get('/clients/:id/boost-plan/progress', wrap(async (req, res) => {
  const c = (await db.listClients(req.user.fb_id)).find((x) => x.id === Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'Client not found.' });
  res.json(await require('./src/plan').progress(req.user.fb_id, c));
}));
api.post('/clients/:id/boost-plan/send', wrap(async (req, res) => {
  const c = (await db.listClients(req.user.fb_id)).find((x) => x.id === Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'Client not found.' });
  const b = req.body || {};
  res.json(await require('./src/plan').send(req.user.fb_id, c, { to: b.to === 'team' ? 'team' : 'client', lang: b.lang === 'km' ? 'km' : 'en', topic: String(b.topic || ''), only: Array.isArray(b.only) ? b.only.slice(0, 30) : null }));
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
  const e = deepMerge(await db.getEntry(day, Number(clientId)), req.body || {});
  await db.putEntry(day, Number(clientId), e);
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
// ---- Payments: service fees and invoices ----
const lastOfMonth = (ym) => `${ym}-${String(new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0).getDate()).padStart(2, '0')}`;
const IMG = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/;
async function invoiceProfile(owner) { return invoice.profileOf(await db.getUserSetting(owner, 'invoiceProfile', {})); }
api.get('/payments', wrap(async (req, res) => {
  const ym = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : sync.todayIn().slice(0, 7);
  const [clients, invoices] = await Promise.all([db.listClients(req.user.fb_id), db.listInvoices(req.user.fb_id, ym + '-01', lastOfMonth(ym))]);
  res.json({
    month: ym, today: sync.todayIn(),
    clients: clients.filter((c) => !c.archived).map((c) => ({ id: c.id, name: c.name, pages: c.pages, telegram: c.telegram, telegramTitle: c.telegram_title, service: c.service })),
    invoices, bot: telegram.hasBot(),
    tgSent: Object.fromEntries(Object.entries(await sentInvoices(req.user.fb_id)).map(([k, v]) => [k, { at: v.at, to: v.to }])),
  });
}));
// Invoices sent to Telegram in the last 48 hours (a bot can delete its own messages only that long).
async function sentInvoices(owner) {
  const all = (await db.getUserSetting(owner, 'sentInvoices', {})) || {}, out = {};
  for (const [k, v] of Object.entries(all)) if (v && Date.now() - Date.parse(v.at) < 48 * 3600e3) out[k] = v;
  return out;
}
api.post('/invoices/:id/unsend', wrap(async (req, res) => {
  const inv = await db.getInvoice(req.user.fb_id, Number(req.params.id)); if (!inv) return res.status(404).json({ error: 'Invoice not found.' });
  const all = await sentInvoices(req.user.fb_id), rec = all[inv.id];
  if (!rec) return res.status(404).json({ error: 'This invoice was not sent in the last 48 hours — delete it in Telegram instead (group admins can).' });
  let ok = 0;
  for (const m of rec.msgs) if (await telegram.remove(m.chat, m.id)) ok++;
  delete all[inv.id]; await db.setUserSetting(req.user.fb_id, 'sentInvoices', all);
  await db.markInvoice(req.user.fb_id, inv.id, { sent: false });
  res.json({ ok: true, deleted: ok, failed: rec.msgs.length - ok });
}));
const withMessage = async (owner) => { const saved = await db.getUserSetting(owner, 'invoiceProfile', {}); return { ...(await invoiceProfile(owner)), message: saved.message || invoice.DEFAULT_MESSAGE, defaultMessage: invoice.DEFAULT_MESSAGE }; };
api.get('/invoice-profile', wrap(async (req, res) => res.json(await withMessage(req.user.fb_id))));
api.put('/invoice-profile', wrap(async (req, res) => {
  const b = req.body || {}, cur = await db.getUserSetting(req.user.fb_id, 'invoiceProfile', {}), next = { ...cur };
  for (const k of ['company', 'address1', 'address2', 'phone', 'bankName', 'accountName', 'accountNo', 'seller', 'issuedBy']) if (b[k] != null) next[k] = String(b[k]).trim().slice(0, 160);
  for (const k of ['logo', 'qr', 'sign']) if (b[k] != null) { if (b[k] !== '' && (!IMG.test(b[k]) || b[k].length > 450000)) return res.status(400).json({ error: 'Pictures must be PNG or JPG, up to about 300 KB each.' }); next[k] = b[k]; }
  if (b.message != null) { const m = String(b.message).replace(/\r/g, '').slice(0, 900); next.message = m.trim() && m !== invoice.DEFAULT_MESSAGE ? m : ''; }
  await db.setUserSetting(req.user.fb_id, 'invoiceProfile', next);
  if (b.nextNumber != null && (await isFull(req))) { const n = parseInt(b.nextNumber, 10); if (n > 0 && n < 1e7) await db.setSetting('invoiceSeq', n - 1); }
  res.json(await withMessage(req.user.fb_id));
}));
const autoNumber = async (date) => `IN${String(date || sync.todayIn()).slice(2, 4)}-${String((Number(await db.getSetting('invoiceSeq', 0)) || 0) + 1).padStart(4, '0')}`;
const cleanNumber = (v) => String(v == null ? '' : v).replace(/[^\p{L}\p{N} ._/#-]+/gu, '').trim().slice(0, 30);
api.get('/invoice-next', wrap(async (req, res) => res.json({ next: (Number(await db.getSetting('invoiceSeq', 0)) || 0) + 1, number: await autoNumber(isDay(req.query.date) ? req.query.date : ''), canSet: await isFull(req) })));
function cleanInvoice(b, c) {
  const str = (x, n) => String(x == null ? '' : x).trim().slice(0, n);
  const items = (Array.isArray(b.items) ? b.items : []).slice(0, 6).map((it) => ({ description: str(it.description, 160), qty: Math.max(0, Number(it.qty) || 0), price: Math.max(0, Number(it.price) || 0) })).filter((it) => it.description || it.price);
  const data = { customer: str(b.customer, 120) || c.service.customer || c.name, company: str(b.company, 120), phone: str(b.phone, 40), items, discount: Math.max(0, Number(b.discount) || 0) };
  const t = invoice.totals(data); data.discount = t.discount;
  return { data, total: t.total };
}
api.post('/invoices/preview', wrap(async (req, res) => { // PNG of an invoice that isn't saved yet
  const b = req.body || {}, c = (await db.listClients(req.user.fb_id)).find((x) => x.id === Number(b.clientId));
  if (!c) return res.status(404).json({ error: 'Client not found.' });
  if (!isDay(b.date)) return res.status(400).json({ error: 'Pick the invoice date.' });
  const { data } = cleanInvoice(b, c);
  const next = cleanNumber(b.number) || await autoNumber(b.date);
  res.set('content-type', 'image/png').set('cache-control', 'no-store').send(await invoice.png({ ...data, number: next, date: b.date }, await db.getUserSetting(req.user.fb_id, 'invoiceProfile', {})));
}));
api.post('/invoices', wrap(async (req, res) => {
  const b = req.body || {}, c = (await db.listClients(req.user.fb_id)).find((x) => x.id === Number(b.clientId));
  if (!c) return res.status(404).json({ error: 'Client not found.' });
  if (!isDay(b.date)) return res.status(400).json({ error: 'Pick the invoice date.' });
  const { data, total } = cleanInvoice(b, c);
  if (!data.items.length) return res.status(400).json({ error: 'Add at least one line with a description or price.' });
  // A typed invoice number is used as it is; left as suggested (or empty), the next running number is taken.
  let number = cleanNumber(b.number);
  if (number && number === await autoNumber(b.date)) number = '';
  if (number && await db.invoiceNumberUsed(number)) return res.status(409).json({ error: `Invoice number ${number} is already used. Type a different one.` });
  res.json(await db.createInvoice(req.user.fb_id, { clientId: c.id, date: b.date, data, total, number }, req.user.name));
}));
const invFile = (inv) => `${String(inv.company || inv.customer || 'Invoice').replace(/[^\p{L}\p{N} ._-]+/gu, '').trim() || 'Invoice'} ${inv.number}.pdf`;
api.get('/invoices/:id/pdf', wrap(async (req, res) => {
  const inv = await db.getInvoice(req.user.fb_id, Number(req.params.id)); if (!inv) return res.status(404).json({ error: 'Invoice not found.' });
  const buf = await invoice.pdf(inv, await db.getUserSetting(req.user.fb_id, 'invoiceProfile', {}));
  res.set('content-type', 'application/pdf').set('content-disposition', `${req.query.download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(invFile(inv))}`).send(buf);
}));
api.get('/invoices/:id/png', wrap(async (req, res) => {
  const inv = await db.getInvoice(req.user.fb_id, Number(req.params.id)); if (!inv) return res.status(404).json({ error: 'Invoice not found.' });
  res.set('content-type', 'image/png').set('cache-control', 'no-store').send(await invoice.png(inv, await db.getUserSetting(req.user.fb_id, 'invoiceProfile', {})));
}));
api.post('/invoices/:id/send', wrap(async (req, res) => {
  const inv = await db.getInvoice(req.user.fb_id, Number(req.params.id)); if (!inv) return res.status(404).json({ error: 'Invoice not found.' });
  const c = (await db.listClients(req.user.fb_id)).find((x) => x.id === inv.clientId);
  if (!c || !c.telegram) return res.status(400).json({ error: `${c ? c.name : 'This client'} has no Telegram group yet. Pick one in the Clients tab.` });
  // The invoice goes to the group as a picture (opens right in the chat); the PDF stays available in the app.
  const buf = await invoice.png(inv, await db.getUserSetting(req.user.fb_id, 'invoiceProfile', {}), 1654);
  // Message sent with the picture: the account's own template (Invoice settings), or the default Khmer reminder.
  const saved = await db.getUserSetting(req.user.fb_id, 'invoiceProfile', {});
  const caption = invoice.fillMessage(saved.message, invoice.messageValues(inv, c.service && c.service.day));
  const track = [];
  await telegram.sendPhoto(buf, caption, c.telegram, track);
  if (track.length) {
    const all = await sentInvoices(req.user.fb_id), old = all[inv.id] ? all[inv.id].msgs : [];
    all[inv.id] = { at: new Date().toISOString(), to: c.telegram_title || c.telegram, msgs: [...old, ...track].slice(-20) };
    await db.setUserSetting(req.user.fb_id, 'sentInvoices', all);
  }
  res.json({ ...(await db.markInvoice(req.user.fb_id, inv.id, { sent: true })), sentTo: c.telegram_title || c.telegram });
}));
api.patch('/invoices/:id', wrap(async (req, res) => {
  const inv = await db.getInvoice(req.user.fb_id, Number(req.params.id)); if (!inv) return res.status(404).json({ error: 'Invoice not found.' });
  const b = req.body || {};
  if (b.number !== undefined) {
    const number = cleanNumber(b.number);
    if (!number) return res.status(400).json({ error: 'Type the invoice number.' });
    if (await db.invoiceNumberUsed(number, inv.id)) return res.status(409).json({ error: `Invoice number ${number} is already used. Type a different one.` });
    if (number !== inv.number) await db.renumberInvoice(req.user.fb_id, inv.id, number);
  }
  res.json(await db.markInvoice(req.user.fb_id, inv.id, { paid: b.paid === undefined ? undefined : !!b.paid }));
}));
api.delete('/invoices/:id', wrap(async (req, res) => { await db.deleteInvoice(req.user.fb_id, Number(req.params.id)); res.json({ ok: true }); }));

// ---- Live videos ----
api.get('/lives', wrap(async (req, res) => {
  const { from, to } = req.query;
  if (!rangeOk(from, to)) return res.status(400).json({ error: 'Pick a valid period (at most one year).' });
  const list = await lives.listLives(req.user.fb_id, from, to);
  const setups = await lives.setupsFor(req.user, list.flatMap((l) => l.campaigns), { fetch: false });
  res.json({ lives: list, setups, saved: await db.getUserSetting(req.user.fb_id, 'liveSetups', []) });
}));
api.post('/lives/setups', wrap(async (req, res) => {
  const camps = (Array.isArray(req.body?.campaigns) ? req.body.campaigns : []).slice(0, 200)
    .filter((c) => c && /^\d+$/.test(String(c.id)) && /^act_\d+$/.test(String(c.accountId))).map((c) => ({ id: String(c.id), accountId: String(c.accountId) }));
  res.json(await lives.setupsFor(req.user, camps));
}));
api.post('/live-setups', wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.setup || typeof b.sig !== 'string') return res.status(400).json({ error: 'Nothing to save.' });
  const list = await db.getUserSetting(req.user.fb_id, 'liveSetups', []);
  if (list.some((x) => x.sig === b.sig)) return res.json(list);
  list.unshift({ id: Date.now().toString(36), name: String(b.name || 'Saved setup').slice(0, 80), sig: b.sig, setup: b.setup, from: b.from || null, savedAt: new Date().toISOString() });
  await db.setUserSetting(req.user.fb_id, 'liveSetups', list.slice(0, 50));
  res.json(list.slice(0, 50));
}));
api.patch('/live-setups/:id', wrap(async (req, res) => {
  const list = await db.getUserSetting(req.user.fb_id, 'liveSetups', []);
  const x = list.find((y) => y.id === req.params.id); if (!x) return res.status(404).json({ error: 'Not found.' });
  if (req.body?.name) x.name = String(req.body.name).slice(0, 80);
  await db.setUserSetting(req.user.fb_id, 'liveSetups', list); res.json(list);
}));
api.delete('/live-setups/:id', wrap(async (req, res) => {
  const list = (await db.getUserSetting(req.user.fb_id, 'liveSetups', [])).filter((x) => x.id !== req.params.id);
  await db.setUserSetting(req.user.fb_id, 'liveSetups', list); res.json(list);
}));

api.get('/dashboard/pages', wrap(async (req, res) => {
  const { from, to } = req.query;
  if (!rangeOk(from, to)) return res.status(400).json({ error: 'Pick a valid date or month.' });
  res.json(await sync.pageSpend(req.user.fb_id, from, to));
}));
// Names for Page IDs (saved names first, then names Meta gave us), for the client window.
api.get('/page-names', wrap(async (req, res) => {
  const ids = String(req.query.ids || '').split(',').filter((x) => /^\d{5,25}$/.test(x)).slice(0, 100);
  const saved = await db.getSetting('pageNames', {}), known = meta.knownPageNames();
  res.json(Object.fromEntries(ids.map((id) => [id, saved[id] || known[id] || ''])));
}));
// Ask Meta once more for a Page's real name (a name typed by a person is otherwise kept for good).
api.post('/page-names/:id/ask', wrap(async (req, res) => {
  const id = String(req.params.id); if (!/^\d{5,25}$/.test(id)) return res.status(400).json({ error: 'Not a Page ID.' });
  let name = '';
  try { name = String((await meta.get(`/${id}`, { fields: 'name' }, await sync.tokenFor(req.user))).name || '').trim().slice(0, 120); } catch (e) { if (e.needsLogin) throw e; }
  if (name) { const names = await db.getSetting('pageNames', {}); names[id] = name; await db.setSetting('pageNames', names); meta.rememberPageNames({ [id]: name }, true); }
  res.json({ ok: true, name });
}));
// Name a Page that Meta won't name (client Pages you don't manage). Saved for everyone, used by every sync.
api.put('/page-names/:id', wrap(async (req, res) => {
  const id = String(req.params.id), name = String((req.body || {}).name || '').trim().slice(0, 120);
  if (!/^\d{5,25}$/.test(id)) return res.status(400).json({ error: 'Not a Page ID.' });
  const names = await db.getSetting('pageNames', {});
  if (name) names[id] = name; else delete names[id];
  await db.setSetting('pageNames', names);
  if (name) meta.rememberPageNames({ [id]: name }, true);
  res.json({ ok: true });
}));
api.get('/dashboard', wrap(async (req, res) => {
  const { from, to } = req.query;
  if (!isDay(from) || !isDay(to) || from > to) return res.status(400).json({ error: 'Pick a valid date or month.' });
  if ((Date.parse(to) - Date.parse(from)) / 864e5 > 366) return res.status(400).json({ error: 'Pick at most one year.' });
  res.json(await sync.dashboard(req.user.fb_id, from, to));
}));

// Ad accounts
// Today's spend per ad account comes from the campaign rows the last sync saved for today
// (Sync, auto sync every hour / on new campaigns), so it stays current without extra Meta calls.
const FAKE_DEMO_CARDS = new Set([
  'Visa •••• 4829',
  'Mastercard •••• 7741',
  'Visa •••• 3104',
  'Mastercard •••• 9912',
  'Amex •••• 1008',
  'Visa •••• 6590',
]);
const cleanCard = (c) => {
  const s = String(c || '').trim().slice(0, 80);
  return s && !FAKE_DEMO_CARDS.has(s) ? s : null;
};

async function accountsWithToday(owner) {
  const list = await db.listAccounts(owner);
  const day = sync.todayIn();
  const rows = await db.getRaw(owner, day);
  const meta0 = (await db.getDay(owner, day)).meta;
  const ext = (await db.getUserSetting(owner, 'extThresholds', {})) || {};
  const byAcct = {};
  for (const r of rows || []) byAcct[r.accountId] = (byAcct[r.accountId] || 0) + (Number(r.spend) || 0);
  for (const a of list) {
    const i = a.info || (a.info = {});
    if (rows && a.enabled) { i.todaySpend = Math.round((byAcct[a.id] || 0) * 100) / 100; i.todayAt = meta0?.synced_at || null; delete i.todayError; }
    // Meta's API doesn't return the billing threshold; use what the browser extension pushed when
    // the API left it blank. Flagged so the UI can note where it came from.
    if (ext[a.id]) {
      if (ext[a.id].v != null && ext[a.id].v > 0) { i.threshold = ext[a.id].v; i.thresholdExt = true; }
      const c = cleanCard(ext[a.id].card);
      if (c) i.card = c; else delete i.card;
      if (ext[a.id].dailyLimit != null && ext[a.id].dailyLimit > 0) i.dailyLimit = ext[a.id].dailyLimit;
      if (ext[a.id].business && !i.business) i.business = ext[a.id].business;
      if (ext[a.id].originalId && !i.originalId) i.originalId = ext[a.id].originalId;
      if (ext[a.id].role) i.role = ext[a.id].role;
      if (ext[a.id].nextBillDate && ext[a.id].nextBillDate !== '—') i.nextBillDate = ext[a.id].nextBillDate;
    }
  }
  return list;
}
// Direct Web-to-Extension Bridge Sync (saves Thresholds, Payment Cards, Daily Limits & BMs from AdsCheck Connect Pro)
api.post('/accounts/ext-sync', wrap(async (req, res) => {
  const owner = req.user.fb_id;
  const items = Array.isArray((req.body || {}).accounts) ? req.body.accounts : (Array.isArray((req.body || {}).thresholds) ? req.body.thresholds : []);
  const map = (await db.getUserSetting(owner, 'extThresholds', {})) || {};
  let stored = 0;
  for (const it of items) {
    const rawId = String((it && (it.id || it.account_id || it.accountId || it.meta_account_id)) || '').trim();
    const id = rawId.startsWith('act_') ? rawId : (rawId ? 'act_' + rawId : '');
    if (!/^act_\d{5,25}$/.test(id)) continue;
    const rawThr = it.threshold != null && it.threshold !== '' ? Number(it.threshold) : null;
    const v = rawThr != null && isFinite(rawThr) && rawThr > 0 && rawThr <= 1e9 ? Math.round(rawThr * 100) / 100 : null;
    const card = cleanCard(it.card || it.payment_card || it.paymentMethods);
    const rawDsl = it.dailyLimit != null || it.daily_limit != null ? Number(it.dailyLimit ?? it.daily_limit) : null;
    const dailyLimit = rawDsl != null && isFinite(rawDsl) && rawDsl > 0 ? Math.round(rawDsl * 100) / 100 : null;
    const business = String(it.business || it.business_name || it.businessName || '').trim().slice(0, 120) || null;
    const originalId = String(it.originalId || it.businessId || it.business_id || '').trim().slice(0, 40) || null;
    const role = String(it.role || '').trim().slice(0, 40) || null;
    const nextBillDate = String(it.nextBillDate || it.pay_date || '').trim().slice(0, 40) || null;
    map[id] = {
      v,
      cur: (String(it.currency || '').slice(0, 8) || null),
      card,
      dailyLimit,
      business,
      originalId,
      role,
      nextBillDate: nextBillDate && nextBillDate !== '—' ? nextBillDate : null,
      at: new Date().toISOString()
    };
    stored++;
  }
  await db.setUserSetting(owner, 'extThresholds', map);
  res.json({ ok: true, stored, accounts: await accountsWithToday(owner) });
}));
// The logged-in user's key + endpoint for the Check My Ads extension to push thresholds (lazily created).
api.get('/ext/key', wrap(async (req, res) => {
  const owner = req.user.fb_id;
  let key = await db.getUserSetting(owner, 'extKey', null);
  if (!key) {
    key = 'bd_ext_' + crypto.randomBytes(20).toString('hex');
    await db.setUserSetting(owner, 'extKey', key);
    const idx = (await db.getSetting('extKeyIndex', {})) || {};
    idx[sha(key)] = owner;
    await db.setSetting('extKeyIndex', idx);
  }
  res.json({ key, url: cfg.baseUrl + '/public-api/thresholds' });
}));
api.get('/accounts', wrap(async (req, res) => res.json(await accountsWithToday(req.user.fb_id))));
api.post('/accounts/refresh', wrap(async (req, res) => {
  const me = req.user.fb_id;
  // Pull today's spend for the ticked accounts (updates Home too); unticked ones get a quick total.
  const r = await sync.exclusive(me, () => sync.syncDay(sync.todayIn(), req.user));
  if (r === null) return res.status(409).json({ error: 'A sync is running right now. Try again in a moment.' });
  res.json(await accountsWithToday(me)); // syncDay already refreshed the unticked accounts' totals
}));
// Tick / untick: an unticked account stops syncing and its past spend drops out of every page (a rematch runs in the background).
api.patch('/accounts/:id', wrap(async (req, res) => { await db.setAccountEnabled(req.user.fb_id, req.params.id, req.body?.enabled); res.json({ ok: true }); sync.exclusive(req.user.fb_id, () => sync.rematch(req.user)).catch((e) => console.error('[accounts] rematch:', e.message)); }));

// Reports
const rangeOk = (from, to) => isDay(from) && isDay(to) && from <= to && (Date.parse(to) - Date.parse(from)) / 864e5 <= 366;
// Telegram groups are private per account: a group belongs to the account whose link code was sent
// in it ("/link CODE"), or to the account that already uses it for one of its clients.
const newCode = () => { const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', r = require('crypto').randomBytes(8); return Array.from(r.subarray(0, 8), (b) => A[b % 32]).join(''); }; // 8 chars, crypto RNG
async function linkCode(fbId) {
  let c = await db.getUserSetting(fbId, 'tgCode', null);
  if (!c) { c = newCode(); await db.setUserSetting(fbId, 'tgCode', c); }
  return c;
}
// One refresh at a time, so two requests never handle the same /link message twice.
let chatsBusy = Promise.resolve();
// Read new Telegram messages every minute, so /link works without opening the website and nothing expires.
if (telegram.hasBot()) { health.register('Telegram check', 1, 'every minute'); setInterval(() => health.track('Telegram check', () => refreshChats()).catch((e) => console.error('[telegram] refresh:', e.message)), 15000).unref(); } // every 15 s so "Done" taps show quickly
let chatsAt = 0; // when Telegram was last read
function refreshChats() { const run = chatsBusy.then(refreshChatsNow, refreshChatsNow).then((r) => { chatsAt = Date.now(); return r; }); chatsBusy = run.catch(() => {}); return run; }
// The saved list is at most ~15 s old (background check), so pages use it instead of waiting 3 s on Telegram every time.
const chatsNow = async () => (Date.now() - chatsAt < 25000 ? db.getSetting('telegramChats', []) : refreshChats());
async function refreshChatsNow() {
  const saved = await db.getSetting('telegramChats', []);
  const byId = new Map(saved.map((c) => [c.id, c]));
  let fresh = { chats: [], links: [], moved: [] };
  const offset = await db.getSetting('telegramOffset', 0);
  try { fresh = await telegram.listChats(offset); } catch (e) { if (!saved.length) throw e; }
  // Groups that became supergroups: move the saved group, its topics and every client to the new id.
  for (const mv of fresh.moved || []) {
    for (const c of [...byId.values()]) {
      const [g, th] = String(c.id).split(':'); if (g !== mv.from) continue;
      const id = th ? `${mv.to}:${th}` : mv.to; byId.delete(c.id); byId.set(id, { ...c, id, ...(c.chat ? { chat: mv.to } : {}) });
    }
    await db.pool.query(`UPDATE clients SET telegram = $2 || substr(telegram, length($1) + 1) WHERE telegram = $1 OR telegram LIKE $1 || ':%'`, [mv.from, mv.to]);
    await db.pool.query(`UPDATE clients SET topics = replace(topics::text, '"' || $1 || ':', '"' || $2 || ':')::jsonb WHERE topics::text LIKE '%"' || $1 || ':%'`, [mv.from, mv.to]);
    console.log('[telegram] group moved', mv.from, '→', mv.to);
  }
  for (const c of fresh.chats) {
    const old = byId.get(c.id) || {};
    // A topic seen without its name (e.g. "Topic 45") keeps the name found earlier.
    byId.set(c.id, { ...old, ...c, ...(c.type === 'topic' && !c.topic && old.topic ? { topic: old.topic, title: old.title } : {}) });
  }
  // A group can be linked to several accounts: everyone who sent "/link CODE" there, until "/unlink CODE".
  // Each /link message is handled once (by its time), so nothing repeats or flips between people.
  for (const c of byId.values()) { if (!c.owners) c.owners = c.owner ? [c.owner] : []; if (!c.seen) c.seen = {}; }
  if (fresh.links.length) {
    const users = await db.allUsers(), byCode = {};
    for (const u of users) byCode[await linkCode(u.fb_id)] = u;
    for (const l of fresh.links) {
      const u = byCode[l.code], c = byId.get(l.id); if (!u || !c) continue;
      if ((c.seen[u.fb_id] || 0) >= l.at) continue; // this message was already handled
      c.seen[u.fb_id] = l.at;
      const has = c.owners.includes(u.fb_id);
      // The group belongs to the client too, so the bot's reply is short, names no one, and is cleaned up
      // (with the /link command) after a minute.
      const where = c.type === 'topic' ? 'Topic' : 'ក្រុម';
      let text = '';
      if (l.unlink && has) {
        c.owners = c.owners.filter((x) => x !== u.fb_id);
        if (!c.owners.length) text = `🔕 ${where}នេះ នឹងលែងទទួលរបាយការណ៍ Boost ទៀតហើយ។\nThis ${c.type === 'topic' ? 'topic' : 'group'} will no longer receive boost reports.`;
      } else if (!l.unlink && !has) {
        c.owners.push(u.fb_id);
        text = `✅ ${where}នេះ ត្រូវបានភ្ជាប់ ដើម្បីទទួលរបាយការណ៍ Boost ប្រចាំថ្ងៃពី Ads Box។\nThis ${c.type === 'topic' ? 'topic' : 'group'} is set up to receive daily boost reports from Ads Box.`;
      }
      const tidy = async (botMsg) => setTimeout(() => { telegram.remove(c.id, botMsg); telegram.remove(c.id, l.msgId); }, 60000);
      if (text) telegram.send(text, c.id).then(tidy).catch(() => {});
      else tidy(null);
    }
  }
  for (const c of byId.values()) c.owner = c.owners[0] || '';
  // Groups with no owner yet: give them to the account whose clients already use them.
  const unowned = [...byId.values()].filter((c) => !c.owner);
  if (unowned.length) {
    const rows = (await db.pool.query("SELECT DISTINCT owner, telegram FROM clients WHERE telegram <> ''")).rows;
    for (const c of unowned) { const users = [...new Set(rows.filter((r) => r.telegram === c.id).map((r) => r.owner))]; if (users.length) { c.owners = users; c.owner = users[0]; } }
  }
  // "/alerts CODE" sent to the bot in a private chat by the owner: system alerts go to that chat.
  if ((fresh.alerts || []).length) {
    const owner = await db.ownerId(), code = owner && (await linkCode(owner));
    for (const al of fresh.alerts) if (code && al.code === code) {
      await db.setSetting('alertChat', { id: al.id, name: al.name, at: new Date().toISOString() });
      telegram.send('✅ Boost Desk system alerts will come to this chat. Send /alerts again from another chat to move them.', al.id).catch(() => {});
    }
  }
  try { await require('./src/status').onTelegram(fresh); } catch (e) { console.error('[telegram] client status:', e.message); }
  try { await require('./src/buyers').onTelegram(fresh, AI); } catch (e) { console.error('[telegram] media buyers:', e.message); }
  try { await require('./src/handoff').onTelegram(fresh); } catch (e) { console.error('[telegram] handoff:', e.message); }
  // PMs / owner connecting their own Telegram (t.me/<bot>?start=pm_CODE) for plan / result alerts from their media buyers.
  for (const st of fresh.pmStarts || []) {
    try {
      const users = await db.allUsers(); let hit = null;
      for (const x of users) { const c = String(await db.getUserSetting(x.fb_id, 'tgCode', '') || '').toUpperCase(); if (c && c === String(st.code).toUpperCase()) { hit = x; break; } }
      if (!hit) continue;
      await db.setUserSetting(hit.fb_id, 'tgChat', { id: st.id, name: st.name, at: new Date().toISOString() });
      const known = await db.getSetting('tgPmChats', {}); known[st.id] = hit.fb_id; await db.setSetting('tgPmChats', known);
      telegram.send(`✅ Hi ${hit.name}! Boost Desk alerts come here now: when your media buyers submit their plan in the morning and their result in the evening.`, st.id).catch(() => {});
    } catch (e) { console.error('[telegram] pm link:', e.message); }
  }
  // /password in a private chat: a new temporary password for the username that belongs to this Telegram (a PM's linked chat, or a media buyer's).
  for (const ask of fresh.pwAsks || []) {
    try {
      const L = LOGINS(), last = (await db.getSetting('pwAskAt', {})) || {};
      if (last[ask.id] && Date.now() - last[ask.id] < 10 * 60e3) { telegram.send('A new password was sent a few minutes ago. Wait 10 minutes before asking again.', ask.id).catch(() => {}); continue; }
      const mb = (await MB().list()).find((x) => x.chat === ask.id), pmId = !mb && ((await db.getSetting('tgPmChats', {})) || {})[ask.id];
      const stillPm = pmId && String(((await db.getUserSetting(pmId, 'tgChat', null)) || {}).id || '') === ask.id; // the link may have been removed since
      const rec = mb ? await L.forMb(mb.id) : stillPm ? await L.forFb(pmId) : null;
      if (!rec) { telegram.send(mb || stillPm ? 'You have no Boost Desk username yet. ' + (mb ? 'Ask your PM to make one (Settings → My media buyers → 🔑 Username).' : 'Make one in Boost Desk → Settings → Username & password.') : 'This Telegram is not linked to a Boost Desk person, so I can\'t send a password here.', ask.id).catch(() => {}); continue; }
      const r = await L.reset(rec.username); last[ask.id] = Date.now(); await db.setSetting('pwAskAt', last);
      await telegram.send(`🔑 Boost Desk\nUsername: ${r.login.username}\nNew password: ${r.password}\n\nLog in at ${cfg.baseUrl}/login and choose your own password in Settings. Delete this message afterwards.`, ask.id);
    } catch (e) { console.error('[telegram] password ask:', e.message); }
  }
  const all = [...byId.values()].sort((a, b) => String(a.title).localeCompare(String(b.title)));
  await db.setSetting('telegramChats', all);
  if (fresh.next && fresh.next !== offset) await db.setSetting('telegramOffset', fresh.next); // only after everything above is saved
  return all;
}
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
  const rts = c ? reports.routes(c) : [];
  if (rts.length > 1) { // Pages that report to their own topics: one text per Page
    const list = await reports.preview(req.user.fb_id, c, from, to, { kind, parts, skip, orders });
    const r = await sync.clientReport(req.user.fb_id, req.params.id, from, to, kind, parts, skipScope(skip), { orders });
    return res.json({ ...r, routes: list });
  }
  res.json(await sync.clientReport(req.user.fb_id, req.params.id, from, to, kind, parts, skipScope(skip), { orders }));
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
  if (from === to && isDay(from)) { const id = Number(req.params.id); await db.putEntry(from, id, deepMerge(await db.getEntry(from, id), { reportSent: null })); }
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
    if (from === to && isDay(from) && (page == null || page === '')) await db.putEntry(from, cl.id, deepMerge(await db.getEntry(from, cl.id), { reportSent: { at: sentAt, by: req.user.name } }));
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
    await db.putEntry(from, id, deepMerge(await db.getEntry(from, id), { reportSent: { at: sentAt, by: req.user.name } }));
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

// ---------- auto daily report ----------
api.get('/auto-report', wrap(async (req, res) => res.json({ ...(await extras.autoSettings(req.user.fb_id)), last: await db.getUserSetting(req.user.fb_id, 'autoReportLast', null), bot: telegram.hasBot(), tz: cfg.tz })));
api.put('/auto-report', wrap(async (req, res) => res.json({ ...(await extras.saveAutoSettings(req.user.fb_id, req.body || {})), last: await db.getUserSetting(req.user.fb_id, 'autoReportLast', null) })));
// One workspace's clients for one day: spend, orders, and whether each report went out.
async function reportStatus(owner, day) {
  const clients = (await db.listClients(owner)).filter((c) => !c.archived), set = await extras.autoSettings(owner);
  let oc = { clients: {} }; try { oc = await require('./src/orders').byClient(owner, day, day); } catch (_) { /* orders not connected */ }
  const live = (c) => c.type === 'live' || c.type === 'both', post = (c) => c.type === 'post' || c.type === 'both' || !c.type;
  const rows = [];
  for (const c of clients) {
    const e = await db.getEntry(day, c.id), lives = live(c) ? Object.values(e.lives || {}).filter((l) => Number(l && l.spend) > 0) : [];
    const liveSpend = lives.reduce((t, l) => t + Number(l.spend), 0), postSpend = post(c) ? Number((e.post || {}).spend) || 0 : 0, spend = Math.round((liveSpend + postSpend) * 100) / 100;
    const routes = reports.routes(c), chat = routes.find((r) => r.chat), o = (oc.clients || {})[c.id], orders = o ? o.orders : null;
    const sent = e.reportSent && e.reportSent.at ? { at: e.reportSent.at, by: e.reportSent.by || '' } : null;
    rows.push({ id: c.id, name: c.name, type: c.type || 'post', page: (c.pages || []).find((p) => /^\d{5,20}$/.test(String(p))) || '', group: chat ? (chat.title || c.telegram_title || 'Telegram group') : '', hasGroup: !!chat,
      spend, lives: lives.length, orders, cpo: orders > 0 && spend > 0 ? Math.round(spend / orders * 100) / 100 : null, sent, auto: !set.skip.includes(c.id),
      status: sent ? 'sent' : !chat ? 'nogroup' : spend > 0 ? 'unsent' : 'nospend' });
  }
  const rank = { unsent: 0, nogroup: 1, sent: 2, nospend: 3 }; rows.sort((a, b) => rank[a.status] - rank[b.status] || b.spend - a.spend || a.name.localeCompare(b.name));
  return { rows, auto: { on: !!set.on, time: set.time }, anyOrders: rows.some((r) => r.orders != null), totals: reportTotals(rows) };
}
function reportTotals(rows) {
  const cnt = (k) => rows.filter((r) => r.status === k).length, tot = (k) => rows.reduce((t, r) => t + (Number(r[k]) || 0), 0), spend = Math.round(tot('spend') * 100) / 100, orders = tot('orders');
  return { clients: rows.length, spend, orders, cpo: orders > 0 && spend > 0 ? Math.round(spend / orders * 100) / 100 : null, sent: cnt('sent'), unsent: cnt('unsent'), nogroup: cnt('nogroup'), nospend: cnt('nospend') };
}
// Reports page: every client of this account for one day.
api.get('/reports/status', wrap(async (req, res) => {
  const today = sync.todayIn(), day = isDay(req.query.day) && req.query.day <= today ? req.query.day : today;
  res.json({ day, today, bot: telegram.hasBot(), ...(await reportStatus(req.user.fb_id, day)) });
}));
// Team reports (leaders): the same day for every team, one group per Project Manager. Read only.
api.get('/admin/reports', adminOnly, wrap(async (req, res) => {
  const today = sync.todayIn(), day = isDay(req.query.day) && req.query.day <= today ? req.query.day : today;
  const users = await db.allUsers(), tms = await getTeams(), teamOf = {}; for (const t of tms) for (const m of t.members) teamOf[m] = t.name;
  let buyers = []; try { buyers = await MB().all(); } catch (_) { /* no media buyers yet */ }
  const teams = [];
  for (const u of users) {
    const r = await reportStatus(u.fb_id, day); if (!r.rows.length) continue;
    teams.push({ owner: u.fb_id, name: u.name, team: teamOf[u.fb_id] || '', buyers: buyers.filter((b) => b.addedById === u.fb_id).map((b) => b.name), ...r });
  }
  teams.sort((a, b) => b.totals.unsent - a.totals.unsent || b.totals.nogroup - a.totals.nogroup || b.totals.spend - a.totals.spend || a.name.localeCompare(b.name));
  const all = teams.flatMap((t) => t.rows);
  res.json({ day, today, bot: telegram.hasBot(), teams, anyOrders: teams.some((t) => t.anyOrders), totals: { ...reportTotals(all), teams: teams.length, teamsDone: teams.filter((t) => !t.totals.unsent).length } });
}));
// ---------- Handoff: notes between the media buyer (morning) and the PM (evening), and the Telegram brief / digest ----------
const HANDOFF_DEPS = { reportStatus, dayTasks };
api.get('/handoff', wrap(async (req, res) => res.json(await require('./src/handoff').card(req.user, HANDOFF_DEPS))));
api.post('/handoff', wrap(async (req, res) => {
  const HO = require('./src/handoff'), b = req.user.buyer;
  const note = await HO.addNote(req.user.fb_id, { kind: b ? 'mb' : 'pm', by: b ? b.name : req.user.name, byId: b ? b.id : req.user.fb_id, text: (req.body || {}).text });
  if (b) HO.pingPm(req.user.fb_id, note); // the PM hears about it on Telegram straight away
  res.json(await HO.card(req.user, HANDOFF_DEPS));
}));
api.get('/handoff/preview', wrap(async (req, res) => res.json(await require('./src/handoff').preview(req.user, HANDOFF_DEPS))));
api.put('/handoff/prefs', wrap(async (req, res) => { if (req.user.buyer) return res.status(403).json({ error: 'Your PM switches these messages on or off.' }); res.json(await require('./src/handoff').savePrefs(req.user.fb_id, req.body || {})); }));
api.post('/auto-report/run', wrap(async (req, res) => {
  if (!telegram.hasBot()) return res.status(400).json({ error: 'Telegram is not set up. Add TELEGRAM_BOT_TOKEN in Railway.' });
  const today = sync.todayIn(), pick = (req.body || {}).day;
  if (isDay(pick) && pick < today) return res.json(await extras.sendClientReports(req.user, pick, { refresh: false })); // an earlier day from the Reports page: send what is saved, keep "last auto run" as it was
  const r = await extras.sendClientReports(req.user, today);
  await db.setUserSetting(req.user.fb_id, 'autoReportLast', r);
  res.json(r);
}));
// ---------- today's to-do ----------
api.get('/todo', wrap(async (req, res) => res.json(await pm.todo(req.user))));

// ---------- Orders page (adsbox.biz API) ----------
api.get('/orders/api', wrap(async (req, res) => { const c = await orders.publicConfig(); if (!(await canSeeAdmin(req.user.fb_id))) { delete c.keyHint; delete c.url; delete c.savedBy; c.url = c.hasKey ? 'set' : ''; } res.json(c); })); // non-admins only learn whether it is connected
api.put('/orders/api', adminOnly, wrap(async (req, res) => res.json(await orders.saveApiConfig(req.body || {}, req.user.name))));
api.get('/orders/hook', adminOnly, wrap(async (req, res) => res.json({ url: `${req.protocol}://${req.get('host')}/hooks/adsbox`, secret: await orders.hookSecret(), last: ((await db.getSetting('adsboxApi', null)) || {}).hookLast || null })));
api.post('/orders/hook/renew', adminOnly, wrap(async (req, res) => res.json({ secret: await orders.hookSecret(true) })));
api.get('/orders/push', adminOnly, wrap(async (req, res) => res.json(await orders.pushStatus())));
api.put('/orders/push', adminOnly, wrap(async (req, res) => res.json(await orders.setPush(!!(req.body || {}).on))));
api.post('/orders/push', adminOnly, wrap(async (req, res) => { await orders.setPush(true); res.json(await orders.pushSpend(Math.min(31, Number((req.body || {}).days) || 7))); }));
// AI advice for one client (Claude API). The owner adds the key in Admin → Settings.
api.post('/ai/client/:id', wrap(async (req, res) => {
  const b = req.body || {};
  if (!isDay(b.from) || !isDay(b.to) || b.from > b.to || (Date.parse(b.to) - Date.parse(b.from)) / 864e5 > 185) return res.status(400).json({ error: 'Pick a period of up to 6 months.' });
  try { res.json(await require('./src/ai').clientAdvice(req.user.fb_id, req.params.id, { from: b.from, to: b.to, lang: b.lang === 'km' ? 'km' : 'en', question: String(b.question || ''), fresh: !!b.fresh })); }
  catch (e) { if (e.status) return res.status(e.status).json({ error: e.message, notSetUp: !!e.notSetUp }); throw e; }
}));
// Client workbook: today's AI plan (per Page + tasks), the user's notes and tasks, and ticks on today's work.
const AI = () => require('./src/ai');
const ownClient = async (req) => (await db.listClients(req.user.fb_id)).find((x) => x.id === Number(req.params.id));
// Open tasks and today's ticks for every client (for the badges in the Clients list).
// Monthly KPIs (per person or media buyer). person = a user id, or mb:<media buyer id>.
const KPI = () => require('./src/kpi');
// A media buyer of mine (I added them), or any media buyer for leaders. A media buyer session is never "mine".
const ownsBuyer = async (req, id) => { if (req.user.buyer) return false; if (await canSeeAdmin(req.user.fb_id)) return true; const b = await MB().get(String(id)); return !!b && (b.addedById === req.user.fb_id || (!b.addedById && b.addedBy === req.user.name)); };
// Whose KPIs: a media buyer sees only their own; a PM their own and their media buyers'; leaders anyone's.
const kpiPerson = async (req, raw) => {
  if (req.user.buyer) { const own = 'mb:' + req.user.buyer.id; if (raw && String(raw) !== own) return null; return { id: own, name: req.user.buyer.name, buyer: true, canEdit: false }; }
  const p = String(raw || req.user.fb_id);
  if (p.startsWith('mb:')) { if (!(await ownsBuyer(req, p.slice(3)))) return null; const b = await require('./src/buyers').get(p.slice(3)); return b ? { id: p, name: b.name, buyer: true, canEdit: true } : null; }
  if (p === req.user.fb_id) return { id: p, name: req.user.name, buyer: false, canEdit: true };
  if (!(await canSeeAdmin(req.user.fb_id))) return null;
  const u = await db.getUser(p); return u ? { id: p, name: u.name, buyer: false, canEdit: true } : null;
};
api.get('/kpis', wrap(async (req, res) => {
  const who = await kpiPerson(req, req.query.person); if (!who) return res.status(404).json({ error: 'Person not found.' });
  const month = /^\d{4}-\d{2}$/.test(req.query.month) ? req.query.month : sync.todayIn().slice(0, 7);
  const K = KPI(), kpis = await K.results(who.buyer ? who.id.slice(3) : who.id, month, who.buyer), ms = await K.months(who.buyer ? who.id.slice(3) : who.id);
  const prev = ms.filter((m) => m < month).pop() || '';
  res.json({ person: who, month, kpis, months: ms, prev, today: sync.todayIn() });
}));
api.put('/kpis', wrap(async (req, res) => {
  const who = await kpiPerson(req, (req.body || {}).person); if (!who) return res.status(404).json({ error: 'Person not found.' });
  const month = /^\d{4}-\d{2}$/.test((req.body || {}).month) ? req.body.month : sync.todayIn().slice(0, 7);
  await KPI().putList(who.buyer ? who.id.slice(3) : who.id, month, (req.body || {}).kpis);
  res.json({ ok: true });
}));
// 💡 Suggested daily actions for one KPI (AI). The person's menu and other KPIs give it context.
api.post('/kpis/suggest', wrap(async (req, res) => {
  const b = req.body || {}, who = await kpiPerson(req, b.person); if (!who) return res.status(404).json({ error: 'Person not found.' });
  const k = b.kpi || {}; if (!String(k.name || '').trim()) return res.status(400).json({ error: 'Which KPI?' });
  const month = /^\d{4}-\d{2}$/.test(b.month) ? b.month : sync.todayIn().slice(0, 7);
  const pid = who.buyer ? who.id.slice(3) : who.id, role = who.buyer ? 'mb' : 'pm';
  let menu = [], others = [];
  try { menu = (await MENU().listOf(pid, role)).map((x) => x.text); } catch (_) {}
  try { others = (await KPI().getList(pid, month)).filter((x) => x.id !== k.id).map((x) => `${x.name} (${x.target} ${x.unit})`); } catch (_) {}
  try { res.json(await AI().kpiSuggest(req.user.fb_id, { name: String(k.name).slice(0, 120), target: Number(k.target) || 0, unit: String(k.unit || '').slice(0, 12), role, menu, others, lang: b.lang === 'en' ? 'en' : 'km', fresh: !!b.fresh })); }
  catch (e) { res.status(e.status || 500).json({ error: e.message, notSetUp: !!e.notSetUp }); }
}));
// People whose KPIs an admin can open: every user and every media buyer.
api.get('/kpis/people', adminOnly, wrap(async (req, res) => {
  const users = (await db.allUsers()).map((u) => ({ id: u.fb_id, name: u.name, kind: 'PM' }));
  const byName = Object.fromEntries(users.map((u) => [u.name, u.id]));
  const buyers = (await require('./src/buyers').all()).map((b) => ({ id: 'mb:' + b.id, name: b.name, kind: 'Media buyer', pm: b.addedById || byName[b.addedBy] || null }));
  res.json({ people: [...users, ...buyers] });
}));
// Admin My Task page: every person with today's task counts and this month's KPI score (users and media buyers).
api.get('/admin/people-today', adminOnly, wrap(async (req, res) => {
  const today = sync.todayIn(), ym = today.slice(0, 7), owner = await db.ownerId(), roles = await roleMap(), av = await adminViewers();
  const users = await db.allUsers(), byName = Object.fromEntries(users.map((u) => [u.name, u.fb_id]));
  const bl = await MB().all(), teams = await getTeams(), teamOf = {}; for (const t of teams) for (const m of t.members) teamOf[m] = t.name;
  const dt = await dayTasks(today), K = KPI();
  const kpiAvg = async (id, buyer) => { try { const rs = (await K.results(id, ym, buyer)).filter((k) => k.target > 0); return rs.length ? Math.round(rs.reduce((t, k) => t + Math.min(k.score, 100), 0) / rs.length) : null; } catch (_) { return null; } };
  const count = (list) => ({ done: list.filter((t) => t.done).length, open: list.filter((t) => !t.done).length, late: list.filter((t) => !t.done && t.late).length });
  const people = [];
  for (const u of users) {
    const ts = ((dt.users[u.fb_id] || {}).tasks || []).filter((t) => t.from !== 'work' && t.from !== 'ai');
    const RN = { ceo: 'CEO', coo: 'COO', cmo: 'CMO', pm: 'Project Manager', mb: 'Media buyer' }, role = u.fb_id === owner ? 'CEO · Owner' : RN[ROLES.includes(roles[u.fb_id]) ? roles[u.fb_id] : av.has(u.fb_id) ? 'coo' : 'pm'];
    const isMb = ROLES.includes(roles[u.fb_id]) && roles[u.fb_id] === 'mb', mn = await MENU().dayOf(u.fb_id, isMb ? 'mb' : 'pm', today);
    people.push({ id: u.fb_id, name: u.name, kind: isMb ? 'Media buyer' : 'PM', role, team: teamOf[u.fb_id] || '', done: mn.done, open: mn.total - mn.done, late: 0, pct: mn.pct, planAt: mn.plan ? mn.plan.at : null, resultAt: mn.result ? mn.result.at : null, tasks: count(ts), kpi: await kpiAvg(u.fb_id, false), buyers: bl.filter((b) => (b.addedById || byName[b.addedBy]) === u.fb_id).length });
  }
  for (const b of bl) {
    const pm = b.addedById || byName[b.addedBy] || null, ts = pm ? ((dt.users[pm] || {}).tasks || []).filter((t) => t.to && t.to.id === b.id) : [];
    const mn = await MENU().dayOf(b.id, 'mb', today);
    people.push({ id: 'mb:' + b.id, name: b.name, kind: 'Media buyer', role: 'Media buyer', pm, pmName: pm ? (users.find((u) => u.fb_id === pm) || {}).name || '' : '', team: pm ? teamOf[pm] || '' : '', linked: !!(b.linked || b.chat), photo: !!b.photo, done: mn.done, open: mn.total - mn.done, late: 0, pct: mn.pct, planAt: mn.plan ? mn.plan.at : null, resultAt: mn.result ? mn.result.at : null, tasks: count(ts), kpi: await kpiAvg(b.id, true) });
  }
  // yesterday's menu result of the same people, for the calm "before the working day" view
  const yd = sync.addDays(today, -1), yest = { done: 0, total: 0 };
  for (const p of people) { if (p.role !== 'Project Manager' && p.kind !== 'Media buyer') continue; try { const d = await MENU().dayOf(p.id.startsWith('mb:') ? p.id.slice(3) : p.id, p.kind === 'Media buyer' ? 'mb' : 'pm', yd); yest.done += d.done; yest.total += d.total; } catch (_) {} }
  res.json({ today, month: ym, people, teams: teams.map((t) => t.name), hour: hourNow(), shift: SHIFT, yesterday: yest });
}));
// Leader's "This month" board: every Project Manager and media buyer with each KPI's score, and how many days
// they sent a plan and a result and how much of the daily menu they ticked. Read only; no personal data of clients.
api.get('/admin/people-month', adminOnly, wrap(async (req, res) => {
  const today = sync.todayIn(), month = /^\d{4}-\d{2}$/.test(req.query.month) && req.query.month <= today.slice(0, 7) ? req.query.month : today.slice(0, 7);
  const owner = await db.ownerId(), roles = await roleMap(), av = await adminViewers(), users = await db.allUsers(), byName = Object.fromEntries(users.map((u) => [u.name, u.fb_id]));
  const bl = await MB().all(), teams = await getTeams(), teamOf = {}; for (const t of teams) for (const m of t.members) teamOf[m] = t.name;
  const K = KPI(), [y, m] = month.split('-').map(Number), last = new Date(Date.UTC(y, m, 0)).getUTCDate(), dayNo = month === today.slice(0, 7) ? Number(today.slice(8)) : last;
  const one = async (id, buyer) => {
    let kpis = []; try { kpis = (await K.results(id, month, buyer)).filter((k) => k.target > 0).map((k) => ({ name: k.name, unit: k.unit, target: k.target, result: k.result, score: Math.round(k.score) })); } catch (_) {}
    let days = 0, plans = 0, results = 0, pctSum = 0;
    try { const mo = await MENU().monthOf(id, buyer ? 'mb' : 'pm', month); for (const d of Object.values(mo.days)) { if (!d.total) continue; days++; pctSum += d.pct || 0; if (d.planAt || d.resultAt) plans++; if (d.resultAt) results++; } } catch (_) {}
    return { kpis, avg: kpis.length ? Math.round(kpis.reduce((t, k) => t + Math.min(k.score, 100), 0) / kpis.length) : null, days, plans, results, menuPct: days ? Math.round(pctSum / days) : null };
  };
  const people = [];
  for (const u of users) {
    const r = ROLES.includes(roles[u.fb_id]) ? roles[u.fb_id] : av.has(u.fb_id) ? 'coo' : 'pm';
    if (u.fb_id === owner || LEAD.has(r)) continue; // leaders compare the teams; they are not compared
    people.push({ id: u.fb_id, name: u.name, kind: r === 'mb' ? 'Media buyer' : 'PM', team: teamOf[u.fb_id] || '', ...(await one(u.fb_id, false)) });
  }
  for (const b of bl) { const pm = b.addedById || byName[b.addedBy] || null; people.push({ id: 'mb:' + b.id, name: b.name, kind: 'Media buyer', pm, team: pm ? teamOf[pm] || '' : '', photo: !!b.photo, ...(await one(b.id, true)) }); }
  res.json({ today, month, dayNo, daysInMonth: last, pace: Math.round(dayNo / last * 100), people });
}));
api.get('/admin/audit', adminOnly, wrap(async (req, res) => { await auditFlush(); const log = await db.getSetting('auditLog', []); res.json({ log: (Array.isArray(log) ? log : []).slice(-300).reverse() }); }));
// 🔔 Nudge: a short Telegram reminder with today's progress. A PM nudges their own media buyers; leaders nudge anyone.
// One nudge per person every 10 minutes, so nobody gets flooded.
const nudged = new Map();
// Working day starts (Phnom Penh time): media buyers in the morning, Project Managers in the afternoon.
const SHIFT = { mb: 8, pm: 13 };
const hourNow = () => Number(new Date().toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: cfg.tz || 'Asia/Phnom_Penh' })) % 24;
// Send one reminder. Returns { ok, name } or { ok:false, name, why: 'telegram' | 'wait' | 'missing', wait }.
async function nudgeOne(fromName, p) {
  const today = sync.todayIn(); let chat = null, name = '', day = null, site = '/projectmanager#mytasks';
  if (p.startsWith('mb:')) { const b = await MB().get(p.slice(3)); if (!b) return { ok: false, why: 'missing' }; chat = b.chat || null; name = b.name; day = await MENU().dayOf(b.id, 'mb', today); site = '/mediabuyer#mytasks'; }
  else { const u = await db.getUser(p); if (!u) return { ok: false, why: 'missing' }; chat = (await db.getUserSetting(u.fb_id, 'tgChat', null) || {}).id || null; name = u.name; day = await MENU().dayOf(u.fb_id, (await roleOf(u.fb_id)) === 'mb' ? 'mb' : 'pm', today); }
  if (!chat) return { ok: false, name, why: 'telegram' };
  const wait = Math.ceil(((nudged.get(p) || 0) + 10 * 60e3 - Date.now()) / 60e3); if (wait > 0) return { ok: false, name, why: 'wait', wait };
  const open = day.items.filter((x) => !x.done), lines = [`🔔 ${fromName} សូមរំលឹក`, ''];
  if (!day.total) lines.push('ថ្ងៃនេះមិនទាន់មាន Task menu ទេ។ សូមបើក Boost Desk ហើយរៀបចំ។');
  else {
    lines.push(`Task ថ្ងៃនេះ៖ រួច ${day.done} / ${day.total} (${day.pct}%)`);
    if (!day.plan && !day.result) lines.push('⚠ មិនទាន់ផ្ញើ Plan');
    if (open.length) { lines.push('', 'នៅសល់៖'); for (const x of open.slice(0, 6)) lines.push(`☐ ${x.text}`); if (open.length > 6) lines.push(`… +${open.length - 6} ទៀត`); }
    else if (!day.result) lines.push('Task រួចអស់ហើយ ✅ សូមផ្ញើ Result។');
  }
  lines.push('', `${cfg.baseUrl}${site}`);
  await telegram.send(lines.join('\n'), chat); nudged.set(p, Date.now());
  return { ok: true, name };
}
api.post('/nudge', wrap(async (req, res) => {
  if (TASKS_OFF) return res.status(410).json({ error: 'Daily task reminders were moved to GenZ KPI.' });
  if (req.user.buyer) return res.status(403).json({ error: 'Only a PM or a leader can send a reminder.' });
  if (!telegram.hasBot()) return res.status(400).json({ error: 'Telegram is not set up yet.' });
  const p = String((req.body || {}).person || '');
  if (p.startsWith('mb:')) { if (!(await ownsBuyer(req, p.slice(3)))) return res.status(403).json({ error: 'Only this media buyer\'s PM or a leader can do this.' }); }
  else if (!(await canSeeAdmin(req.user.fb_id))) return res.status(403).json({ error: 'Only a leader can remind a Project Manager.' });
  let r; try { r = await nudgeOne(req.user.name, p); } catch (e) { return res.status(502).json({ error: 'Telegram did not take the message: ' + e.message }); }
  if (r.ok) return res.json(r);
  if (r.why === 'telegram') return res.status(400).json({ error: `${r.name} has not connected Telegram yet.` });
  if (r.why === 'wait') return res.status(429).json({ error: `${r.name} was reminded a moment ago. Try again in ${r.wait} minute${r.wait === 1 ? '' : 's'}.` });
  res.status(404).json({ error: 'Person not found.' });
}));
// Leaders: remind everyone whose working day has started and who has not sent today's plan. ?dry=1 only counts.
api.post('/nudge/no-plan', adminOnly, wrap(async (req, res) => {
  if (TASKS_OFF) return res.status(410).json({ error: 'Daily task reminders were moved to GenZ KPI.' });
  const today = sync.todayIn(), h = hourNow(), owner = await db.ownerId(), roles = await roleMap(), av = await adminViewers(), list = [];
  for (const u of await db.allUsers()) { const r = ROLES.includes(roles[u.fb_id]) ? roles[u.fb_id] : av.has(u.fb_id) ? 'coo' : 'pm'; if (u.fb_id === owner || LEAD.has(r)) continue; list.push({ p: u.fb_id, id: u.fb_id, role: r === 'mb' ? 'mb' : 'pm', name: u.name }); }
  for (const b of await MB().all()) list.push({ p: 'mb:' + b.id, id: b.id, role: 'mb', name: b.name });
  const due = []; let early = 0;
  for (const x of list) { const d = await MENU().dayOf(x.id, x.role, today); if (!d.total || d.plan || d.result) continue; if (h < SHIFT[x.role]) { early++; continue; } due.push(x); }
  if (req.query.dry || (req.body || {}).dry) return res.json({ dry: true, due: due.map((x) => x.name), early });
  if (!telegram.hasBot()) return res.status(400).json({ error: 'Telegram is not set up yet.' });
  const sent = [], noTelegram = [], waiting = [], failed = [];
  for (const x of due) { try { const r = await nudgeOne(req.user.name, x.p); (r.ok ? sent : r.why === 'telegram' ? noTelegram : r.why === 'wait' ? waiting : failed).push(r.name || x.name); } catch (_) { failed.push(x.name); } }
  res.json({ sent, noTelegram, waiting, failed, early });
}));
// Leaders rename a team account (the person's own name, e.g. the PM's — not the Facebook account's name, which is kept).
api.post('/admin/users/:id/rename', ownerOnly, wrap(async (req, res) => {
  const u = await db.getUser(String(req.params.id)); if (!u) return res.status(404).json({ error: 'Account not found.' });
  const name = String((req.body || {}).name || '').trim().replace(/\s+/g, ' ').slice(0, 80); if (!name) return res.status(400).json({ error: 'Type the name.' });
  if (name === u.name) return res.json({ ok: true, name });
  if (!(await db.getUserSetting(u.fb_id, 'fbName', ''))) await db.setUserSetting(u.fb_id, 'fbName', u.name); // remember the Facebook account's own name
  // media buyers that were tied to this account by its old name keep their PM
  const B = MB(), all = await B.list(); let touched = false;
  for (const b of all) if (b.addedById === u.fb_id || (!b.addedById && b.addedBy === u.name)) { b.addedById = u.fb_id; b.addedBy = name; touched = true; }
  if (touched) await B.save(all);
  await db.pool.query('UPDATE users SET name=$2 WHERE fb_id=$1', [u.fb_id, name]);
  const lg = await LOGINS().forFb(u.fb_id); if (lg) { lg.name = name; await LOGINS().save(lg); }
  res.json({ ok: true, name, was: u.name });
}));
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
// ---- Boosts (20 Nov 2026): one row per post in a boost plan, across every client — the team's old status sheet, filled by itself ----
// A row's state comes from its dates (new / active / ended); "no spend" is the client's status finding (plan runs, nothing spent).
// Spend is known per client, not per post, so the plan's progress is the client's and is the same on each of its rows.
api.get('/boosts', wrap(async (req, res) => {
  const owner = req.user.fb_id, today = sync.todayIn(), st = await STATUS().forOwner({ fb_id: owner, name: req.user.name }), by = Object.fromEntries(st.clients.map((x) => [x.id, x])), rows = [];
  // today's campaigns from Meta (as synced): a post linked to its campaign gets its own spend, and post campaigns that are in
  // no plan yet are offered as "found on Meta" so a plan line can be added in one step
  const raw = {}; try { for (const r of (await db.getRaw(owner, today)) || []) if (r.campaignId) raw[String(r.campaignId)] = r; } catch (_) {}
  const all = (await db.listClients(owner)).filter((x) => !x.archived), linked = new Set(all.flatMap((c) => ((c.plan && c.plan.lines) || []).map((l) => l.camp).filter(Boolean))), found = [];
  for (const c of all) {
    const x = by[c.id] || {}, lines = (c.plan && c.plan.lines) || [];
    try { const e = await db.getEntry(today, c.id); for (const id of ((e && e.post && e.post.ids) || []).map(String)) { const r = raw[id]; if (r && !linked.has(id) && Number(r.spend) > 0) found.push({ clientId: c.id, client: c.name, camp: id, name: r.name || '', account: r.accountId || '', accountName: r.account || '', spend: Math.round(Number(r.spend) * 100) / 100 }); } } catch (_) {}
    lines.forEach((l, i) => {
      const end = l.start ? sync.addDays(l.start, Math.max(1, Number(l.days) || 1) - 1) : '', state = !l.start ? 'nodate' : l.start > today ? 'new' : end < today ? 'ended' : 'active';
      rows.push({ clientId: c.id, client: c.name, i, post: l.post || `Post ${i + 1}`, link: l.link || '', daily: Number(l.daily) || 0, days: Number(l.days) || 0, budget: Math.round((Number(l.daily) || 0) * (Number(l.days) || 0) * 100) / 100,
        account: l.accountName || l.account || '', start: l.start || '', end, left: end ? Math.round((Date.parse(end) - Date.parse(today)) / 864e5) : null, state,
        noSpend: state === 'active' && (x.reasons || []).some((r) => r.kind === 'noboost'), sent: l.sent || (c.plan.sentAt && !lines.some((y) => y.sent) ? c.plan.sentAt : ''),
        camp: l.camp || '', auto: l.auto || '', campSpend: l.camp && raw[l.camp] ? Math.round(Number(raw[l.camp].spend) * 100) / 100 : null, postToday: x.postToday || 0, level: x.level || 'ok', planPct: x.plan ? x.plan.pct : null, planSpent: x.plan ? x.plan.spent : null, planBudget: x.plan ? x.plan.budget : null, telegram: !!c.telegram });
    });
  }
  const noPlan = st.clients.filter((x) => x.level !== 'idle' && !(rows.some((r) => r.clientId === x.id && (r.state === 'active' || r.state === 'new')))).map((x) => ({ id: x.id, name: x.name, spend: x.spend }));
  res.json({ today, rows, noPlan, found: found.sort((a, b) => b.spend - a.spend) });
}));
// ---- Client status (19 Nov 2026): fine / watch / problem per client, "checked today", "I'm on it", Telegram alerts ----
const STATUS = () => require('./src/status');
const whoAmI = (req) => (req.user.buyer ? req.user.buyer.name : req.user.name);
// My team's clients with their status (a media buyer sees their PM's clients).
api.get('/clients-status', wrap(async (req, res) => res.json(await STATUS().forOwner({ fb_id: req.user.fb_id, name: req.user.name }))));
api.post('/clients/:id/checked', wrap(async (req, res) => {
  if (!(await ownClient(req))) return res.status(404).json({ error: 'Client not found.' });
  res.json(await STATUS().mark(req.user.fb_id, Number(req.params.id), 'checked', whoAmI(req), (req.body || {}).on !== false));
}));
api.post('/clients/:id/on-it', wrap(async (req, res) => {
  if (!(await ownClient(req))) return res.status(404).json({ error: 'Client not found.' });
  res.json(await STATUS().mark(req.user.fb_id, Number(req.params.id), 'onIt', whoAmI(req), (req.body || {}).on !== false));
}));
// Leaders: every team's clients by status.
api.get('/admin/clients-today', adminOnly, wrap(async (req, res) => {
  const teams = await getTeams(), teamOf = {}; for (const t of teams) for (const m of t.members) teamOf[m] = t.name;
  const bl = await MB().all(), out = [];
  for (const u of await db.allUsers()) {
    let s; try { s = await STATUS().forOwner({ fb_id: u.fb_id, name: u.name }); } catch (e) { s = { clients: [], error: e.message }; }
    if (!s.clients.length) continue;
    out.push({ id: u.fb_id, account: u.name, team: teamOf[u.fb_id] || u.name, mbs: bl.filter((b) => (b.addedById || '') === u.fb_id).map((b) => b.name), clients: s.clients });
  }
  res.json({ today: sync.todayIn(), hour: STATUS().hourNow(), teams: out });
}));
// Telegram for red clients: every 5 minutes (8:00–21:00). Leaders = the alert chat and every CEO / COO / CMO with Telegram.
async function leaderChats() {
  const out = new Set(); const a = await db.getSetting('alertChat', null); if (a && a.id) out.add(String(a.id));
  const roles = await roleMap(), owner = await db.ownerId();
  for (const u of await db.allUsers()) { if (u.fb_id !== owner && !LEAD.has(roles[u.fb_id])) continue; const c = await db.getUserSetting(u.fb_id, 'tgChat', null); if (c && c.id) out.add(String(c.id)); }
  return [...out];
}
if (telegram.hasBot()) {
  health.register('Client status alerts', 5, 'every 5 minutes, 8:00–21:00');
  setInterval(() => health.track('Client status alerts', () => STATUS().tick({ leaders: leaderChats, log: (...a) => console.log('[status]', ...a) })).then((n) => { if (n) console.log('[status] client alerts sent:', n); }).catch((e) => console.error('[status]', e.message)), 5 * 60e3).unref();
}
// Copy one person's KPI list for a month to others, replacing theirs:
//   scope 'team' — the other Project Managers of the same team (a team's KPI is its PM's KPI)
//   scope 'pms'  — every Project Manager;   scope 'mbs' — every media buyer (from a media buyer's list)
// Only name, target and unit travel. A person who already has a KPI of the same name keeps its id (so the tasks
// linked to it stay linked) and the result they typed; nobody receives someone else's typed result.
const kpiCopy = wrap(async (req, res) => {
  const b = req.body || {}, who = await kpiPerson(req, b.person); if (!who) return res.status(404).json({ error: 'Person not found.' });
  const scope = ['team', 'pms', 'mbs'].includes(b.scope) ? b.scope : 'team';
  const month = /^\d{4}-\d{2}$/.test(b.month) ? b.month : sync.todayIn().slice(0, 7), K = KPI();
  const roles = await roleMap(), owner = await db.ownerId(), users = await db.allUsers();
  const isPm = (id) => id !== owner && !LEAD.has(roles[id]) && roles[id] !== 'mb';
  let to = [], label = '';
  if (scope === 'mbs') {
    if (!who.buyer) return res.status(400).json({ error: 'Open a media buyer first — their KPIs are copied to the other media buyers.' });
    to = (await MB().all()).filter((x) => 'mb:' + x.id !== who.id).map((x) => ({ id: x.id, name: x.name })); label = 'media buyers';
  } else {
    if (who.buyer) return res.status(400).json({ error: 'Choose a Project Manager.' });
    if (scope === 'team') {
      const team = (await getTeams()).find((t) => t.members.includes(who.id)); if (!team) return res.status(400).json({ error: `${who.name} is not in a team yet.` });
      to = team.members.filter((m) => m !== who.id && isPm(m)).map((m) => users.find((u) => u.fb_id === m)).filter(Boolean).map((u) => ({ id: u.fb_id, name: u.name })); label = team.name;
    } else { to = users.filter((u) => u.fb_id !== who.id && isPm(u.fb_id)).map((u) => ({ id: u.fb_id, name: u.name })); label = 'Project Managers'; }
  }
  if (!to.length) return res.status(400).json({ error: 'There is nobody else to copy to.' });
  const src = await K.getList(who.buyer ? who.id.slice(3) : who.id, month);
  if (!src.length) return res.status(400).json({ error: 'Set the KPIs first, then copy them.' });
  const nm = (x) => String(x || '').trim().toLowerCase();
  for (const p of to) {
    const cur = await K.getList(p.id, month);
    await K.putList(p.id, month, src.map((k) => { const old = cur.find((c) => nm(c.name) === nm(k.name)); return { id: old ? old.id : '', name: k.name, target: k.target, unit: k.unit, manual: old ? old.manual : null }; }));
  }
  res.json({ ok: true, scope, label, month, count: src.length, to: to.map((p) => p.name) });
});
api.post('/kpis/copy', adminOnly, kpiCopy);
api.post('/kpis/copy-team', adminOnly, (req, res, next) => { req.body = { ...(req.body || {}), scope: 'team' }; kpiCopy(req, res, next); });
// My target tasks for a day: every task of mine with a target, with what I reached.
api.get('/targets/mine', wrap(async (req, res) => {
  const day = isDay(req.query.day) ? req.query.day : sync.todayIn(), out = [];
  for (const c of await db.listClients(req.user.fb_id)) {
    if (c.archived) continue;
    const w = (await db.getUserSetting(req.user.fb_id, `cwb:${c.id}`, null)) || {};
    for (const t of w.tasks || []) {
      if (!(Number(t.target) > 0)) continue;
      if (t.repeat ? t.day > day : t.day !== day) continue;
      out.push({ id: t.id, clientId: c.id, client: c.name, text: t.text, repeat: !!t.repeat, done: !!t.done, ...tgt(t, t.repeat ? day : t.day) });
    }
  }
  res.json({ day, today: sync.todayIn(), tasks: out });
}));
// My tasks today (every client): the same list each client page shows, in one place.
// ---------- Task menu: fixed daily duties per role (PM / media buyer), ticked day by day ----------
const MENU = () => require('./src/menu');
// Whose menu: a buyer's own, mine (pm), or — admins — anyone's via ?as=<fbId> or ?as=mb:<buyerId>.
async function menuPerson(req, raw) {
  if (req.user.buyer) return { person: req.user.buyer.id, role: 'mb', name: req.user.buyer.name };
  const as = String(raw || '').trim();
  if (as && as !== req.user.fb_id) {
    if (as.startsWith('mb:')) { // a PM may open the menus of the media buyers they added; admins any buyer's
      const b = await MB().get(as.slice(3)); if (!b) return null;
      const mine = b.addedById === req.user.fb_id || (!b.addedById && b.addedBy === req.user.name);
      if (!mine && !(await canSeeAdmin(req.user.fb_id))) return null;
      return { person: b.id, role: 'mb', name: b.name };
    }
    if (!(await canSeeAdmin(req.user.fb_id))) return null;
    const u = (await db.allUsers()).find((x) => x.fb_id === as); return u ? { person: u.fb_id, role: 'pm', name: u.name } : null;
  }
  // The role set in Admin → Users decides the menu: a Facebook login marked "Media buyer" gets the media buyer menu everywhere.
  return { person: req.user.fb_id, role: (await roleOf(req.user.fb_id)) === 'mb' ? 'mb' : 'pm', name: req.user.name };
}
// My profile for the Settings page: who I am, my Facebook login, my Telegram, my team.
api.get('/me/profile', wrap(async (req, res) => {
  const teams = await getTeams();
  if (req.user.buyer) {
    const b = await MB().get(req.user.buyer.id), pm = (await db.allUsers()).find((u) => u.fb_id === req.user.fb_id);
    return res.json({ buyer: true, name: b ? b.name : req.user.buyer.name, alias: b ? b.alias || '' : '', tgName: b ? b.tgName || '' : '', photo: !!(b && b.photo), id: req.user.buyer.id, pm: pm ? pm.name : (b ? b.addedBy : ''),
      team: (teams.find((t) => t.members.includes(req.user.fb_id)) || {}).name || '', telegram: { linked: !!(b && b.chat), bot: telegram.hasBot() ? await telegram.username() : '', link: b && telegram.hasBot() ? `https://t.me/${await telegram.username()}?start=mb_${b.code}` : '' }, roleName: 'Media buyer', site: '/mediabuyer' });
  }
  const me = req.user.fb_id, owner = (await db.ownerId()) === me, role = owner ? 'owner' : await roleOf(me);
  const RN = { owner: 'CEO · Owner', ceo: 'CEO', coo: 'COO', cmo: 'CMO', pm: 'Project Manager', mb: 'Media buyer' }, SITE = { owner: '/owner', ceo: '/admin', coo: '/admin', cmo: '/admin', pm: '/projectmanager', mb: '/mediabuyer' };
  const exp = req.user.token_expires ? Date.parse(req.user.token_expires) : 0, left = exp ? Math.round((exp - Date.now()) / 864e5) : null;
  const accounts = (await db.listAccounts(me)).length, clients = (await db.listClients(me)).filter((c) => !c.archived).length;
  const buyers = (await MB().all()).filter((b) => b.addedById === me || (!b.addedById && b.addedBy === req.user.name)).map((b) => ({ name: b.name, linked: !!(b.linked || b.chat) }));
  let code = await db.getUserSetting(me, 'tgCode', ''); if (!code) { code = newCode(); await db.setUserSetting(me, 'tgCode', code); }
  const chat = await db.getUserSetting(me, 'tgChat', null), bot = telegram.hasBot() ? await telegram.username() : '';
  const picture = req.user.google ? '' : `/api/fb-pic/${me}`; // the browser loads it on its own; the page never waits for Facebook
  const pages = (await db.listPagesSeen(me)).length, myAlerts = require('./src/myalerts');
  res.json({ buyer: false, id: me, name: req.user.name, picture, role, roleName: RN[role] || 'Project Manager', site: SITE[role] || '/projectmanager', team: (teams.find((t) => t.members.includes(me)) || {}).name || '',
    teams: teams.map((t) => t.name), isAdmin: await canSeeAdmin(me),
    username: ((await LOGINS().forFb(me)) || {}).username || '',
    facebook: { id: me, name: await fbNameOf(req.user), expires: req.user.token_expires || null, daysLeft: left, expired: left !== null && left <= 0, accounts, clients, pages, autoSync: (await db.enabledAccountIds(me)).length },
    telegram: { linked: !!(chat && chat.id), name: chat ? chat.name : '', at: chat ? chat.at : null, link: bot ? `https://t.me/${bot}?start=pm_${code}` : '', bot, code }, buyers,
    autoReport: await extras.autoSettings(me), alerts: await myAlerts.prefs(me), ai: { on: (await db.getUserSetting(me, 'aiOn', true)) !== false, lang: (await db.getUserSetting(me, 'aiLang', 'en')) === 'km' ? 'km' : 'en' },
    google: req.session.gEmail ? { email: req.session.gEmail } : null });
}));
// Getting started: what a new Project Manager still has to set up (shown on the Dashboard until every step is done).
api.get('/onboarding', wrap(async (req, res) => {
  if (req.user.buyer || req.user.google) return res.json({ show: false });
  const me = req.user.fb_id, accts = await db.listAccounts(me), clients = (await db.listClients(me)).filter((c) => !c.archived), month = sync.todayIn().slice(0, 7);
  const login = await LOGINS().forFb(me), chat = await db.getUserSetting(me, 'tgChat', null);
  let kpis = 0; try { kpis = (await KPI().getList(me, month)).filter((k) => String(k.name || '').trim()).length; } catch (_) {}
  const steps = [
    { key: 'login', done: !!login && !login.must, title: 'Choose your username and password', hint: 'So you can log in without Facebook.', go: '#settings', cta: 'Open Settings' },
    { key: 'accounts', done: accts.some((a) => a.enabled), title: 'Tick the ad accounts you boost with', hint: `${accts.length} ad account${accts.length === 1 ? '' : 's'} found on your Facebook. Have a second Facebook account? Add it in Settings.`, go: '#accounts', cta: 'Open Ad accounts' },
    { key: 'clients', done: clients.length > 0, title: 'Add your first client', hint: 'A client is matched to spend by its Facebook Page.', go: '#clients', cta: 'Open Clients' },
    { key: 'telegram', done: !!(chat && chat.id), title: 'Link your Telegram', hint: 'For alerts, and so reports can go to your clients\' groups.', go: '#settings', cta: 'Open Settings' },
    { key: 'groups', done: clients.length > 0 && clients.every((c) => reports.routes(c).some((r) => r.chat)), title: 'Give every client a Telegram group', hint: clients.length ? `${clients.filter((c) => !reports.routes(c).some((r) => r.chat)).length} client(s) have no group yet — their report can't be sent.` : 'After you add clients.', go: '#reports', cta: 'Open Reports' },
    ...(TASKS_OFF ? [] : [{ key: 'kpi', done: kpis > 0, title: 'Set this month\'s KPIs and your daily menu', hint: 'My Task → Monthly KPI, then ✨ Suggest from KPI.', go: '#mytasks', cta: 'Open My Task' }]),
  ];
  res.json({ show: steps.some((x) => !x.done), done: steps.filter((x) => x.done).length, total: steps.length, steps });
}));
// ---------- Usernames (logins) ----------
// Who may manage which: a full admin → every login; a PM → the logins of their own media buyers.
const myBuyerIds = async (req) => new Set((await MB().list()).filter((b) => b.addedById === req.user.fb_id || (!b.addedById && b.addedBy === req.user.name)).map((b) => b.id));
async function canManageLogin(req, rec) { if (req.user.buyer || req.user.google && !(await isFull(req))) return false; if (await isFull(req)) return true; return rec.role === 'mb' && (await myBuyerIds(req)).has(rec.mbId); }
const loginErr = (res, e) => res.status(e.status || 400).json({ error: e.message });
api.get('/logins', wrap(async (req, res) => {
  if (req.user.buyer) return res.status(403).json({ error: 'Ask your PM.' });
  const L = LOGINS(), full = await isFull(req), mine = await myBuyerIds(req);
  res.json({ full, logins: (await L.list()).filter((r) => full || (r.role === 'mb' && mine.has(r.mbId))).map(L.pub) });
}));
api.post('/logins', wrap(async (req, res) => {
  const b = req.body || {}, role = b.role === 'mb' ? 'mb' : 'pm';
  if (!(await canManageLogin(req, { role, mbId: String(b.mbId || '') }))) return res.status(403).json({ error: role === 'mb' ? 'You can only make usernames for your own media buyers.' : 'Only the owner (or a full admin) can make a username for a Project Manager.' });
  if (role === 'pm' && b.fbId && !(await db.getUser(String(b.fbId)))) return res.status(400).json({ error: 'That person is not in Boost Desk.' });
  if (role === 'mb' && !(await MB().get(b.mbId))) return res.status(400).json({ error: 'That media buyer is not on the list.' });
  const name = b.name || (role === 'mb' ? (await MB().get(b.mbId)).name : b.fbId ? (await db.getUser(String(b.fbId))).name : '');
  try { res.json(await LOGINS().create({ username: b.username, name, role, fbId: role === 'pm' ? b.fbId : '', mbId: role === 'mb' ? b.mbId : '', by: req.user.name })); } catch (e) { loginErr(res, e); }
}));
api.post('/logins/:u/reset', wrap(async (req, res) => {
  const rec = await LOGINS().get(req.params.u); if (!rec || !(await canManageLogin(req, rec))) return res.status(404).json({ error: 'No such username.' });
  try { res.json(await LOGINS().reset(rec.username)); } catch (e) { loginErr(res, e); }
}));
api.delete('/logins/:u', wrap(async (req, res) => {
  const rec = await LOGINS().get(req.params.u); if (!rec || !(await canManageLogin(req, rec))) return res.status(404).json({ error: 'No such username.' });
  await LOGINS().remove(rec.username); res.json({ ok: true });
}));
// Me: make my own username (I'm logged in with Facebook, so it opens this same workspace), or change my password.
api.post('/me/login', wrap(async (req, res) => {
  if (req.user.buyer || req.user.google) return res.status(403).json({ error: 'Ask your PM for a username.' });
  const b = req.body || {};
  try { const r = await LOGINS().create({ username: b.username, name: req.user.name, role: 'pm', fbId: req.user.fb_id, by: req.user.name, password: String(b.password || '') }); req.session.loginId = r.login.username; res.json(r); } catch (e) { loginErr(res, e); }
}));
api.put('/me/password', wrap(async (req, res) => {
  const L = LOGINS(), rec = req.user.buyer ? await L.forMb(req.user.buyer.id) : await L.forFb(req.user.fb_id), b = req.body || {};
  if (!rec) return res.status(404).json({ error: 'You have no username yet.' });
  try { await L.verify(rec.username, b.current); await L.setPassword(rec.username, b.next); res.json({ ok: true }); } catch (e) { loginErr(res, e.status === 401 ? Object.assign(e, { message: 'The current password is wrong.', status: 400 }) : e); }
}));
// Settings → Facebook accounts: the extra logins connected to my workspace.
// A Facebook account's profile picture (asked with that account's own token), remembered for an hour.
const fbPics = new Map();
async function fbPicture(id, token) {
  const hit = fbPics.get(id); if (hit && Date.now() - hit.at < 3600e3) return hit.url;
  let url = '';
  try { const r = await Promise.race([meta.get(`/${id}/picture`, { redirect: 0, type: 'normal', width: 160, height: 160 }, token), new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), 2500))]); url = (r.data && !r.data.is_silhouette && r.data.url) || ''; } catch (_) { /* no picture: the initials show */ }
  fbPics.set(id, { at: Date.now(), url }); return url;
}
// A connected Facebook account's profile picture: mine or one of my team's extra accounts. Redirects to Facebook's
// picture (cached an hour); 404 when there is none, and the page shows initials instead.
api.get('/fb-pic/:id', wrap(async (req, res) => {
  const me = req.user.fb_id, id = String(req.params.id); let token = '';
  try { if (id === me) token = await sync.tokenFor(req.user); else { const e = (await sync.extraLogins(me)).find((x) => x.id === id); if (e) token = require('./src/crypto').decrypt(e.token_enc); } } catch (_) {}
  const url = token ? await fbPicture(id, token) : '';
  if (!url) return res.status(404).end();
  res.set('Cache-Control', 'private, max-age=3600').redirect(url);
}));
api.get('/fb-accounts', wrap(async (req, res) => {
  const me = req.user.fb_id, accts = await db.listAccounts(me), now = Date.now();
  const exp = req.user.token_expires ? Date.parse(req.user.token_expires) : 0, mine = accts.filter((a) => !(a.info || {}).via);
  const xs = await sync.extraLogins(me), pics = { [me]: `/api/fb-pic/${me}` }; for (const e of xs) pics[e.id] = `/api/fb-pic/${e.id}`; // loaded by the browser, so this list never waits for Facebook
  res.json({ max: require('./src/merge').MAX_FB, main: { id: me, picture: pics[me] || '', name: await fbNameOf(req.user), expires: req.user.token_expires || null, expired: !!(exp && exp < now), daysLeft: exp ? Math.floor((exp - now) / 864e5) : null, accounts: mine.length, syncing: mine.filter((a) => a.enabled).length, pages: (await db.listPagesSeen(me)).length },
    extras: xs.map((e) => ({ id: e.id, picture: pics[e.id] || '', name: e.name, expires: e.expires || null, expired: !!(e.expires && Date.parse(e.expires) < now), addedAt: e.addedAt, error: e.error || '',
    accounts: accts.filter((a) => (a.info || {}).via === e.id).length, syncing: accts.filter((a) => (a.info || {}).via === e.id && a.enabled).length })) });
}));
api.delete('/fb-accounts/:id', wrap(async (req, res) => {
  if (req.user.buyer) return res.status(403).json({ error: 'Ask your PM.' });
  const me = req.user.fb_id, list = await sync.extraLogins(me), next = list.filter((e) => e.id !== String(req.params.id));
  if (next.length === list.length) return res.status(404).json({ error: 'That Facebook account is not connected.' });
  await db.setUserSetting(me, 'fbExtras', next);
  // Its ad accounts leave the workspace (saved spend stays on the clients); the next account refresh would drop them anyway.
  const gone = (await db.pool.query(`DELETE FROM ad_accounts WHERE owner=$1 AND info->>'via'=$2 RETURNING id`, [me, String(req.params.id)])).rows.length;
  res.json({ ok: true, removedAccounts: gone });
}));
// Settings → Profile: my display name and team.
api.put('/me/profile', wrap(async (req, res) => {
  if (req.user.buyer) return res.status(403).json({ error: 'Ask your PM to rename you.' });
  const b = req.body || {}, me = req.user.fb_id, name = String(b.name || '').trim().slice(0, 80);
  if (name && name !== req.user.name) {
    if (!(await db.getUserSetting(me, 'fbName', ''))) await db.setUserSetting(me, 'fbName', req.user.name); // remember the Facebook account's own name
    await db.pool.query('UPDATE users SET name=$2 WHERE fb_id=$1', [me, name]);
    const lg = await LOGINS().forFb(me); if (lg) { lg.name = name; await LOGINS().save(lg); }
  }
  if (b.team !== undefined) { // moving myself between teams (admins may pick any; others only leave or join by name)
    const teams = await getTeams(), want = String(b.team || '').trim();
    for (const t of teams) t.members = t.members.filter((x) => x !== me);
    const t = want ? teams.find((x) => x.name === want) : null; if (want && !t) return res.status(400).json({ error: 'No team with that name.' });
    if (t) t.members.push(me); await db.setSetting('teams', teams);
  }
  res.json({ ok: true, name: name || req.user.name });
}));
// Settings → Telegram: a test message to my own chat.
api.post('/me/telegram/test', wrap(async (req, res) => {
  const chat = req.user.buyer ? ((await MB().get(req.user.buyer.id)) || {}).chat : (await db.getUserSetting(req.user.fb_id, 'tgChat', null) || {}).id;
  if (!chat) return res.status(400).json({ error: 'Telegram is not linked yet.' });
  await telegram.send(`✅ Boost Desk test · ${req.user.name}\nYour Telegram is linked — alerts will arrive here.`, chat); res.json({ ok: true });
}));
// Settings → Alerts to my Telegram, and AI advice on/off.
api.get('/me/alerts', wrap(async (req, res) => res.json(await require('./src/myalerts').prefs(req.user.fb_id))));
api.put('/me/alerts', wrap(async (req, res) => res.json(await require('./src/myalerts').savePrefs(req.user.fb_id, req.body || {}))));
api.put('/me/ai', wrap(async (req, res) => {
  const b = req.body || {}; if (b.on !== undefined) await db.setUserSetting(req.user.fb_id, 'aiOn', !!b.on); if (b.lang) await db.setUserSetting(req.user.fb_id, 'aiLang', b.lang === 'km' ? 'km' : 'en');
  res.json({ on: (await db.getUserSetting(req.user.fb_id, 'aiOn', true)) !== false, lang: (await db.getUserSetting(req.user.fb_id, 'aiLang', 'en')) === 'km' ? 'km' : 'en' });
}));
// My Telegram: a PM / owner connects their own chat to get alerts (plan / result from their media buyers).
api.get('/me/telegram', wrap(async (req, res) => {
  if (req.user.buyer) return res.json({ buyer: true });
  let code = await db.getUserSetting(req.user.fb_id, 'tgCode', ''); if (!code) { code = newCode(); await db.setUserSetting(req.user.fb_id, 'tgCode', code); }
  const chat = await db.getUserSetting(req.user.fb_id, 'tgChat', null), bot = telegram.hasBot() ? await telegram.username() : '';
  res.json({ linked: !!(chat && chat.id), name: chat ? chat.name : '', at: chat ? chat.at : null, link: bot ? `https://t.me/${bot}?start=pm_${code}` : '', bot, code });
}));
api.delete('/me/telegram', wrap(async (req, res) => { if (!req.user.buyer) await db.setUserSetting(req.user.fb_id, 'tgChat', null); res.json({ ok: true }); }));
// A media buyer's menu also lists the client tasks their PM gave them for the day (ticked here or on the client page).
async function buyerClientItems(who, day) {
  if (who.role !== 'mb') return [];
  const b = await MB().get(who.person); if (!b) return [];
  const dt = await dayTasks(day), owner = b.addedById || Object.fromEntries((await db.allUsers()).map((u) => [u.name, u.fb_id]))[b.addedBy];
  return (((dt.users[owner] || {}).tasks || [])).filter((t) => t.to && t.to.id === b.id && t.from !== 'work')
    .map((t) => ({ id: `ct:${t.clientId}:${t.id}`, text: t.text, client: t.client, clientId: t.clientId, pm: true, done: !!t.done, at: t.doneAt || null, by: t.doneBy || null, late: !!t.late, target: t.target || 0, reached: t.reached || 0, unit: t.unit || '' }));
}
const withClientItems = async (who, d) => { const extra = await buyerClientItems(who, d.day); if (!extra.length) return d; const items = [...d.items, ...extra], done = items.filter((x) => x.done).length; return { ...d, items, total: items.length, done, pct: items.length ? Math.round(done / items.length * 100) : null }; };
api.get('/menu', wrap(async (req, res) => {
  const who = await menuPerson(req, req.query.as); if (!who) return res.status(404).json({ error: 'Person not found.' });
  const day = isDay(req.query.day) ? req.query.day : sync.todayIn();
  res.json({ ...(await withClientItems(who, await MENU().dayOf(who.person, who.role, day))), today: sync.todayIn(), name: who.name });
}));
api.post('/menu/tick', wrap(async (req, res) => {
  const b = req.body || {}, who = await menuPerson(req, b.as); if (!who) return res.status(404).json({ error: 'Person not found.' });
  const day = isDay(b.day) ? b.day : sync.todayIn(); if (day > sync.todayIn()) return res.status(400).json({ error: 'That day has not come yet.' });
  const byName = req.user.buyer ? req.user.buyer.name : req.user.name;
  const ct = String(b.id || '').match(/^ct:(\d+):([a-f0-9]{6,20})$/);
  if (ct) { // a client task from the PM: tick it in the client's workbook
    const cid = ct[1], tid = ct[2], owner = ((await db.pool.query('SELECT owner FROM clients WHERE id=$1', [cid])).rows[0] || {}).owner;
    if (!owner) return res.status(404).json({ error: 'Client not found.' });
    const w = await AI().workbook(owner, cid), t = (w.tasks || []).find((x) => x.id === tid); if (!t) return res.status(404).json({ error: 'Task not found.' });
    const lid = 't:' + t.id + ':' + day; w.log = (w.log || []).filter((x) => x.id !== lid);
    if (b.done) { const at = new Date().toISOString(); t.done = true; t.doneAt = at; t.doneBy = byName; w.log.push({ id: lid, day, at, by: byName, text: t.text, kind: t.repeat ? 'repeat' : 'me' }); } else { t.done = false; t.doneAt = null; t.doneBy = null; }
    if (b.reached != null && Number(t.target) > 0) { t.hit = t.hit || {}; t.hit[day] = Math.max(0, Number(b.reached) || 0); }
    await AI().saveWorkbook(owner, cid, w);
    return res.json(await withClientItems(who, await MENU().dayOf(who.person, who.role, day)));
  }
  if (!/^[a-f0-9]{8}$/.test(String(b.id || ''))) return res.status(400).json({ error: 'Which item?' });
  await MENU().tick(who.person, day, b.id, !!b.done, byName, b.amount);
  res.json(await withClientItems(who, await MENU().dayOf(who.person, who.role, day)));
}));
// Top 5 menu tasks from the person's KPIs (AI) — shown when a day's menu is empty, or on demand.
api.post('/menu/suggest', wrap(async (req, res) => {
  const b = req.body || {}, who = await menuPerson(req, b.as); if (!who) return res.status(404).json({ error: 'Person not found.' });
  const month = /^\d{4}-\d{2}$/.test(b.month) ? b.month : sync.todayIn().slice(0, 7);
  let kpis = [], menu = [];
  try { kpis = (await KPI().getList(who.person, month)).filter((k) => String(k.name || '').trim()).map((k) => ({ id: k.id, name: k.name, target: k.target, unit: k.unit })); } catch (_) {}
  try { menu = (await MENU().listOf(who.person, who.role)).map((x) => x.text); } catch (_) {}
  try { res.json(await AI().menuSuggest(req.user.fb_id, { kpis, menu, role: who.role, lang: b.lang === 'en' ? 'en' : 'km', fresh: !!b.fresh })); }
  catch (e) { res.status(e.status || 500).json({ error: e.message, notSetUp: !!e.notSetUp }); }
}));
api.post('/menu/item', wrap(async (req, res) => {
  const b = req.body || {}, who = await menuPerson(req, b.as); if (!who) return res.status(404).json({ error: 'Person not found.' });
  const day = b.once ? (isDay(b.day) ? b.day : sync.todayIn()) : null;
  try { const it = await MENU().addItem(who.person, who.role, b.text, day); if (b.kpi) await MENU().editItem(who.person, who.role, it.id, undefined, b.kpi); res.json(await MENU().dayOf(who.person, who.role, day || sync.todayIn())); } catch (e) { res.status(400).json({ error: e.message }); }
}));
api.put('/menu/item/:id', wrap(async (req, res) => {
  const b = req.body || {}, who = await menuPerson(req, b.as); if (!who) return res.status(404).json({ error: 'Person not found.' });
  try { res.json({ item: await MENU().editItem(who.person, who.role, req.params.id, b.text, b.kpi) }); } catch (e) { res.status(400).json({ error: e.message }); }
}));
api.delete('/menu/item/:id', wrap(async (req, res) => {
  const who = await menuPerson(req, req.query.as); if (!who) return res.status(404).json({ error: 'Person not found.' });
  await MENU().removeItem(who.person, who.role, req.params.id); res.json({ ok: true });
}));
api.post('/menu/reset', wrap(async (req, res) => {
  const who = await menuPerson(req, (req.body || {}).as); if (!who) return res.status(404).json({ error: 'Person not found.' });
  await MENU().resetList(who.person, who.role); res.json(await MENU().dayOf(who.person, who.role, sync.todayIn()));
}));
// Plan / result alerts go to the team Telegram group (TELEGRAM_CHAT_ID); a media buyer without a team group gets it in their own chat.
async function menuAlert(req, who, d, kind) {
  if (TASKS_OFF || !telegram.hasBot()) return;
  const roleName = who.role === 'mb' ? 'Media buyer' : 'Project Manager', when = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: cfg.tz });
  const dayLbl = new Date(d.day + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  let text;
  if (kind === 'plan') text = `📋 ផែនការថ្ងៃនេះ · ${who.name} (${roleName})\n🗓 ${dayLbl} · ${when}\n\n${d.items.map((x, i) => `${i + 1}. ${x.text}`).join('\n')}`;
  else {
    text = `✅ លទ្ធផលថ្ងៃនេះ · ${who.name} (${roleName})\n🗓 ${dayLbl} · ${when} · ${d.done} / ${d.total} (${d.pct}%)\n\n${d.items.map((x) => `${x.done ? '✔' : '✘'} ${x.text}`).join('\n')}`;
    // the Clients Task lines they ticked that day (per client), from the PM's workbooks
    try {
      const dt = await dayTasks(d.day), owner = req.user.fb_id, all = ((dt.users[owner] || {}).tasks || []).filter((t) => t.done);
      const mine = all.filter((t) => (req.user.buyer ? (t.to && t.to.id === who.person) : (!t.to || who.role !== 'mb')));
      if (mine.length) {
        const byClient = {}; for (const t of mine) (byClient[t.client] = byClient[t.client] || []).push(t);
        text += `\n\n📌 Clients Task · ${mine.length} done\n` + Object.entries(byClient).map(([c, ts]) => `${c}\n${ts.map((t) => `  ✔ ${t.text}${t.reached != null && t.target ? ` (${t.reached}/${t.target}${t.unit ? ' ' + t.unit : ''})` : ''}`).join('\n')}`).join('\n');
      }
      const open = ((dt.users[owner] || {}).tasks || []).filter((t) => !t.done && (req.user.buyer ? (t.to && t.to.id === who.person) : (!t.to || who.role !== 'mb')) && t.from !== 'work' && t.from !== 'ai');
      if (open.length) text += `\n\n⏳ Not done yet: ${open.length}\n${open.slice(0, 10).map((t) => `  ✘ ${t.client} — ${t.text}`).join('\n')}${open.length > 10 ? `\n  … +${open.length - 10} more` : ''}`;
    } catch (e) { console.error('[menu] client tasks:', e.message); }
    if (d.result && d.result.note) text += `\n\n📝 ${d.result.note}`;
  }
  const chats = new Set(); if (cfg.telegramChatId) chats.add(String(cfg.telegramChatId));
  if (who.role === 'mb') { // the media buyer's PM gets it in their own chat; without a team group the buyer gets a copy too
    let pmId = null;
    try { const b = await MB().get(who.person); if (b) { const byName = Object.fromEntries((await db.allUsers()).map((u) => [u.name, u.fb_id])); pmId = b.addedById || byName[b.addedBy] || null; if (!cfg.telegramChatId && b.chat) chats.add(String(b.chat)); } } catch (_) {}
    const addChat = async (id) => { const c = await db.getUserSetting(id, 'tgChat', null); if (c && c.id) chats.add(String(c.id)); };
    if (pmId) await addChat(pmId);
    if (req.user && req.user.fb_id) { await addChat(req.user.fb_id); // the submitter's own chat (a Facebook login marked Media buyer), or the PM behind a bot buyer
      if (!req.user.buyer) { const team = (await getTeams()).find((t) => t.members.includes(req.user.fb_id)); for (const m of (team ? team.members : []).filter((x) => x !== req.user.fb_id)) await addChat(m); } // their teammates (the PM)
    }
  }
  for (const chat of chats) { try { await telegram.send(text, chat); } catch (e) { console.error('[menu] telegram:', e.message); } }
}
// Morning: submit the plan (freezes today's list). Evening: submit the result (closes the day). Reopen undoes the result.
api.post('/menu/plan', wrap(async (req, res) => {
  const b = req.body || {}, who = await menuPerson(req, b.as); if (!who) return res.status(404).json({ error: 'Person not found.' });
  const day = isDay(b.day) ? b.day : sync.todayIn(); if (day > sync.todayIn()) return res.status(400).json({ error: 'That day has not come yet.' });
  try { await MENU().submitPlan(who.person, who.role, day, req.user.buyer ? req.user.buyer.name : req.user.name); const d = await MENU().dayOf(who.person, who.role, day); res.json(d); menuAlert(req, who, d, 'plan'); } catch (e) { res.status(400).json({ error: e.message }); }
}));
api.post('/menu/result', wrap(async (req, res) => {
  const b = req.body || {}, who = await menuPerson(req, b.as); if (!who) return res.status(404).json({ error: 'Person not found.' });
  const day = isDay(b.day) ? b.day : sync.todayIn(); if (day > sync.todayIn()) return res.status(400).json({ error: 'That day has not come yet.' });
  await MENU().submitResult(who.person, who.role, day, req.user.buyer ? req.user.buyer.name : req.user.name, b.note); const d = await MENU().dayOf(who.person, who.role, day); res.json(d); menuAlert(req, who, d, 'result');
}));
api.post('/menu/reopen', wrap(async (req, res) => {
  const b = req.body || {}, who = await menuPerson(req, b.as); if (!who) return res.status(404).json({ error: 'Person not found.' });
  const day = isDay(b.day) ? b.day : sync.todayIn(); await MENU().reopen(who.person, day); res.json(await MENU().dayOf(who.person, who.role, day));
}));
api.get('/menu/month', wrap(async (req, res) => {
  const who = await menuPerson(req, req.query.as); if (!who) return res.status(404).json({ error: 'Person not found.' });
  const ym = /^\d{4}-\d{2}$/.test(req.query.month) ? req.query.month : sync.todayIn().slice(0, 7);
  res.json(await MENU().monthOf(who.person, who.role, ym));
}));
api.get('/admin/menu', adminOnly, wrap(async (req, res) => res.json({ menu: await MENU().all(), canEdit: await canSeeAdmin(req.user.fb_id) })));
api.put('/admin/menu', adminOnly, wrap(async (req, res) => res.json({ menu: await MENU().save((req.body || {}).menu, req.user.name) })));
api.get('/admin/menu/defaults', adminOnly, wrap(async (req, res) => res.json({ menu: MENU().DEFAULT })));
// A month of one person's tasks (the ones people created — not the automatic suggestions), day by day, for the calendar.
// Buyers (and admins looking at a buyer: &buyer=<id>) see only the tasks assigned to that buyer.
api.get('/tasks/month', wrap(async (req, res) => {
  const today = sync.todayIn(), ym = /^\d{4}-\d{2}$/.test(req.query.month) ? req.query.month : today.slice(0, 7);
  const owner = req.user.fb_id, buyerId = req.user.buyer ? req.user.buyer.id : (req.query.as && req.query.buyer ? String(req.query.buyer) : '');
  const cl = (await db.pool.query('SELECT id, name FROM clients WHERE owner=$1', [owner])).rows, cName = Object.fromEntries(cl.map((c) => [c.id, c.name]));
  const rows = (await db.pool.query(`SELECT key, value FROM settings WHERE key LIKE $1`, [owner + ':cwb:%'])).rows;
  const localDay = (iso) => { try { return sync.todayIn(undefined, new Date(iso)); } catch (_) { return ''; } };
  const [y, m] = ym.split('-').map(Number), last = new Date(Date.UTC(y, m, 0)).getUTCDate(), days = {};
  for (let d = 1; d <= last; d++) days[`${ym}-${String(d).padStart(2, '0')}`] = [];
  for (const r of rows) {
    const cid = r.key.split(':')[2]; if (!cName[cid]) continue;
    for (const t of (r.value || {}).tasks || []) {
      if (t.from === 'ai') continue;
      if (buyerId && !(t.to && t.to.id === buyerId)) continue;
      const doneDay = t.done && t.doneAt ? localDay(t.doneAt) : '';
      const base = { id: t.id, text: t.text, client: cName[cid], clientId: Number(cid), to: t.to ? t.to.name : '', repeat: !!t.repeat };
      for (const day of Object.keys(days)) {
        if (t.repeat) { if (t.day <= day && day <= today) days[day].push({ ...base, done: doneDay === day, late: false, missed: day < today && doneDay !== day }); continue; }
        if (t.day === day) days[day].push({ ...base, done: !!t.done, late: false, missed: !t.done && day < today && !(doneDay && doneDay > day) });
        else if (t.day < day && ((!t.done && day === today) || doneDay === day)) days[day].push({ ...base, done: doneDay === day, late: true, missed: false, since: t.day });
      }
    }
  }
  const out = {};
  for (const [day, list] of Object.entries(days)) { const done = list.filter((t) => t.done).length; out[day] = { tasks: list, total: list.length, done, pct: list.length ? Math.round(done / list.length * 100) : null }; }
  res.json({ month: ym, today, days: out });
}));
api.get('/tasks/mine', wrap(async (req, res) => {
  const day = isDay(req.query.day) ? req.query.day : sync.todayIn();
  const dt = await dayTasks(day), mine = (dt.users[req.user.fb_id] || { tasks: [] }).tasks;
  res.json({ day, today: dt.today, tasks: mine });
}));
// PM dashboard: my team — media buyers I work with, today's tasks (done / open / overdue), what was sent to Telegram.
api.get('/team/mine', wrap(async (req, res) => {
  const today = sync.todayIn(), me = req.user.fb_id;
  const teams = await getTeams(), team = teams.find((t) => t.members.includes(me)) || null;
  const members = team ? team.members : [me], users = await db.allUsers(), uName = Object.fromEntries(users.map((u) => [u.fb_id, u.name]));
  const byName = Object.fromEntries(users.map((u) => [u.name, u.fb_id]));
  const bl = (await require('./src/buyers').all()).filter((b) => members.includes(b.addedById || byName[b.addedBy] || '') || (!team && !b.addedById && !byName[b.addedBy]));
  const dt = await dayTasks(today);
  const mine = (dt.users[me] || { tasks: [] }).tasks, counts = { done: 0, open: 0, overdue: 0, sent: 0, notSent: 0, buyerDone: 0, buyerOpen: 0 };
  const buyerTasks = [];
  for (const t of mine) {
    if (t.done) counts.done++; else counts.open++;
    if (t.late && !t.done) counts.overdue++;
    if (t.to) { if (t.sentAt) counts.sent++; else counts.notSent++; if (t.done) counts.buyerDone++; else counts.buyerOpen++; buyerTasks.push(t); }
  }
  const perBuyer = bl.map((b) => { const ts = buyerTasks.filter((t) => t.to && t.to.id === b.id); return { ...b, today: ts.length, done: ts.filter((t) => t.done).length, late: ts.filter((t) => t.late && !t.done).length, notSent: ts.filter((t) => !t.sentAt).length }; });
  // the KPI score of each media buyer this month (average of KPIs with a target)
  const K = KPI(); for (const b of perBuyer) { try { const rs = (await K.results(b.id, today.slice(0, 7), true)).filter((k) => k.target > 0); b.kpi = rs.length ? Math.round(rs.reduce((t, k) => t + Math.min(k.score, 150), 0) / rs.length) : null; } catch (_) { b.kpi = null; } }
  const teammates = members.filter((id) => id !== me && uName[id]).map((id) => { const o = dt.users[id] || { tasks: [] }; return { id, name: uName[id], done: o.tasks.filter((t) => t.done).length, open: o.tasks.filter((t) => !t.done).length, clients: o.clients || 0 }; });
  res.json({ today, team: team ? { id: team.id, name: team.name } : null, counts, buyers: perBuyer, teammates, buyerTasks: buyerTasks.slice(0, 30), clients: (dt.users[me] || {}).clients || 0 });
}));
// Admin: every team's target tasks for a day, with totals.
api.get('/admin/targets', adminOnly, wrap(async (req, res) => {
  const day = isDay(req.query.day) ? req.query.day : sync.todayIn();
  const { users } = await dayTasks(day), teams = await getTeams(), teamOf = {};
  for (const t of teams) for (const m of t.members) teamOf[m] = t.name;
  const people = Object.entries(users).map(([id, u]) => { const tasks = u.tasks.filter((t) => t.target > 0); return { id, name: u.name, team: teamOf[id] || '', tasks, target: tasks.reduce((s, t) => s + t.target, 0), reached: tasks.reduce((s, t) => s + Math.min(t.reached, t.target), 0), tasksTotal: u.tasks.filter((t) => t.from !== 'work').length, tasksDone: u.tasks.filter((t) => t.from !== 'work' && t.done).length }; });
  res.json({ day, today: sync.todayIn(), teams: teams.map((t) => t.name), people });
}));
api.get('/clients-work', wrap(async (req, res) => {
  const today = sync.todayIn(), out = {};
  for (const c of await db.listClients(req.user.fb_id)) {
    const w = (await db.getUserSetting(req.user.fb_id, `cwb:${c.id}`, null)) || {};
    out[c.id] = { openTasks: (w.tasks || []).filter((t) => !t.done && (t.day || '') <= today).length, // due today or earlier; tasks planned for later days are not "left" yet
       ticked: Object.keys(w.ticks || {}).filter((k) => k.startsWith(today + ':')).map((k) => k.slice(11)) };
  }
  res.json({ today, clients: out });
}));
api.get('/clients/:id/workbook', wrap(async (req, res) => { if (!(await ownClient(req))) return res.status(404).json({ error: 'Client not found.' }); res.json({ today: sync.todayIn(), ...(await AI().workbook(req.user.fb_id, req.params.id)) }); }));
api.post('/clients/:id/plan', wrap(async (req, res) => {
  if (!(await ownClient(req))) return res.status(404).json({ error: 'Client not found.' });
  const lang = (req.body || {}).lang === 'km' ? 'km' : 'en'; await db.setUserSetting(req.user.fb_id, 'aiLang', lang);
  try { await AI().dailyPlan(req.user.fb_id, req.params.id, { lang, force: !!(req.body || {}).force }); res.json({ today: sync.todayIn(), ...(await AI().workbook(req.user.fb_id, req.params.id)) }); }
  catch (e) { if (e.status) return res.status(e.status).json({ error: e.message, notSetUp: !!e.notSetUp }); throw e; }
}));
api.put('/clients/:id/notes', wrap(async (req, res) => {
  if (!(await ownClient(req))) return res.status(404).json({ error: 'Client not found.' });
  const w = await AI().workbook(req.user.fb_id, req.params.id); w.notes = String((req.body || {}).notes || '').slice(0, 5000); w.notesAt = new Date().toISOString();
  await AI().saveWorkbook(req.user.fb_id, req.params.id, w); res.json({ ok: true, notesAt: w.notesAt });
}));
api.post('/clients/:id/tasks', wrap(async (req, res) => {
  if (!(await ownClient(req))) return res.status(404).json({ error: 'Client not found.' });
  const text = String((req.body || {}).text || '').trim().slice(0, 200); if (!text) return res.status(400).json({ error: 'Type the task.' });
  const w = await AI().workbook(req.user.fb_id, req.params.id);
  const B = require('./src/buyers'), buyer = (req.body || {}).to ? await B.get(req.body.to) : null;
  if ((req.body || {}).to && !buyer) return res.status(400).json({ error: 'That media buyer was removed.' });
  const tg = Math.min(1e6, Math.max(0, Number((req.body || {}).target) || 0));
  const today = sync.todayIn(), askDay = String((req.body || {}).day || ''), day = isDay(askDay) && askDay > today && askDay <= sync.addDays(today, 60) ? askDay : today; // a task can be planned for a later day
  const t = { id: require('crypto').randomBytes(5).toString('hex'), text, from: 'me', day, done: false, by: req.user.name, ...((req.body || {}).repeat ? { repeat: true } : {}), ...(buyer ? { to: { id: buyer.id, name: buyer.name } } : {}), ...(tg ? { target: tg, unit: String((req.body || {}).unit || '').trim().slice(0, 20), hit: {} } : {}), ...(/^[a-f0-9]{8}$/.test(String((req.body || {}).kpi || '')) ? { kpi: req.body.kpi } : {}) };
  let warn = '';
  if (buyer && day === today) { // a later day: the bot sends it that morning
    const c = (await db.listClients(req.user.fb_id)).find((x) => x.id === Number(req.params.id));
    try { await B.notify(buyer, { client: c ? c.name : '', text, from: req.user.name, repeat: !!t.repeat, cid: req.params.id, tid: t.id }); t.sentAt = new Date().toISOString(); }
    catch (e) { warn = e.message; }
  }
  w.tasks.push(t);
  await AI().saveWorkbook(req.user.fb_id, req.params.id, w); res.json({ today: sync.todayIn(), ...w, ...(warn ? { warn } : {}) });
}));
// Media buyers (no login needed: they connect Telegram once from an invite link).
// A PM sees only the media buyers they added; the owner / CEO / COO see everyone's.
api.get('/media-buyers', wrap(async (req, res) => {
  const all = await require('./src/buyers').all(), me = req.user.fb_id, mine = all.filter((b) => b.addedById === me || (!b.addedById && b.addedBy === req.user.name));
  res.json({ buyers: (await canSeeAdmin(me)) ? all : mine, bot: telegram.hasBot() });
}));
// A media buyer's Telegram picture (synced when they connect and once a day).
app.get('/mb-pic/:id', wrap(async (req, res) => {
  const p = await require('./src/buyers').photoOf(req.params.id); if (!p) return res.status(404).end();
  const m = p.match(/^data:(image\/\w+);base64,(.+)$/); if (!m) return res.status(404).end();
  res.set('Content-Type', m[1]).set('Cache-Control', 'private, max-age=3600').send(Buffer.from(m[2], 'base64'));
}));
api.post('/media-buyers/:id/sync', wrap(async (req, res) => { // re-read name + picture from Telegram now
  const B = require('./src/buyers'), all = await B.list(), b = all.find((x) => x.id === req.params.id);
  if (!b) return res.status(404).json({ error: 'Media buyer not found.' });
  if (!(await ownsBuyer(req, b.id))) return res.status(403).json({ error: 'Only this media buyer\'s PM or an admin can do this.' });
  if (!b.chat) return res.status(400).json({ error: 'Not connected to Telegram yet.' });
  if (await B.syncProfile(b, '')) await B.save(all);
  res.json({ ok: true, name: b.name, photo: !!b.photo });
}));
api.post('/media-buyers', wrap(async (req, res) => { try { res.json(await require('./src/buyers').add((req.body || {}).name, req.user.name, req.user.fb_id)); } catch (e) { res.status(400).json({ error: e.message }); } }));
api.delete('/media-buyers/:id', wrap(async (req, res) => {
  if (!(await MB().get(req.params.id))) return res.status(404).json({ error: 'Media buyer not found.' });
  if (!(await ownsBuyer(req, req.params.id))) return res.status(403).json({ error: 'Only this media buyer\'s PM or an admin can remove them.' });
  await require('./src/buyers').remove(req.params.id); res.json({ ok: true });
}));
// "This is the PM": a Project Manager who connected Telegram as a media buyer (the old way in). Their Telegram becomes
// the team's PM chat, the media-buyer entry goes, tasks that were given to it become the PM's own, and a username made
// for it opens the team account as PM.
api.post('/media-buyers/:id/make-pm', wrap(async (req, res) => {
  const B = require('./src/buyers'), b = await B.get(req.params.id); if (!b) return res.status(404).json({ error: 'Media buyer not found.' });
  const users = await db.allUsers(), owner = b.addedById || (users.find((u) => u.name === b.addedBy) || {}).fb_id || '';
  if (!owner || !(await db.getUser(owner))) return res.status(400).json({ error: `${b.name} is not under a team account yet — choose the PM first.` });
  if (req.user.buyer || !((await isFull(req)) || req.user.fb_id === owner)) return res.status(403).json({ error: 'Only this team\'s PM or an admin can do this.' });
  if (!b.chat) return res.status(400).json({ error: `${b.name} has not connected Telegram yet.` });
  const prev = await db.getUserSetting(owner, 'tgChat', null);
  await db.setUserSetting(owner, 'tgChat', { id: String(b.chat), name: b.tgName || b.name, at: new Date().toISOString() });
  let moved = 0;
  for (const r of (await db.pool.query(`SELECT key, value FROM settings WHERE key LIKE $1`, [`${owner}:cwb:%`])).rows) {
    const w = r.value || {}; let ch = false;
    for (const t of w.tasks || []) if (t.to && t.to.id === b.id) { delete t.to; ch = true; moved++; }
    if (ch) await db.setSetting(r.key, w);
  }
  const L = LOGINS(), lg = await L.forMb(b.id); let username = '';
  if (lg) { if (await L.forFb(owner)) await L.remove(lg.username); else { lg.role = 'pm'; lg.fbId = owner; lg.mbId = ''; await L.save(lg); username = lg.username; } }
  await B.remove(b.id);
  console.log('[teams]', b.name, 'is now the PM Telegram of', (users.find((u) => u.fb_id === owner) || {}).name || owner, 'by', req.user.name);
  res.json({ ok: true, name: b.tgName || b.name, replaced: prev && prev.id && String(prev.id) !== String(b.chat) ? prev.name || 'another chat' : '', tasks: moved, username });
}));
// Admin: move a media buyer under another PM (keeps their Telegram link, KPIs and tasks).
api.patch('/media-buyers/:id', adminOnly, wrap(async (req, res) => {
  const B = require('./src/buyers'), pm = String((req.body || {}).pm || '').trim(), users = await db.allUsers(), u = users.find((x) => x.fb_id === pm);
  if (!u) return res.status(400).json({ error: 'Pick the PM.' });
  const all = await B.list(), b = all.find((x) => x.id === String(req.params.id)); if (!b) return res.status(404).json({ error: 'Media buyer not found.' });
  b.addedById = u.fb_id; b.addedBy = u.name; await B.save(all); res.json({ ok: true, pm: { id: u.fb_id, name: u.name } });
}));
api.patch('/clients/:id/tasks/:tid', wrap(async (req, res) => {
  if (!(await ownClient(req))) return res.status(404).json({ error: 'Client not found.' });
  const w = await AI().workbook(req.user.fb_id, req.params.id), t = w.tasks.find((x) => x.id === req.params.tid);
  if (!t) return res.status(404).json({ error: 'Task not found.' });
  if ((req.body || {}).done != null) {
    t.done = !!req.body.done; t.doneAt = t.done ? new Date().toISOString() : null; t.doneBy = t.done ? req.user.name : null;
    const day = sync.todayIn(), lid = 't:' + t.id + ':' + day; w.log = (w.log || []).filter((x) => x.id !== lid);
    if (t.done) w.log.push({ id: lid, day, at: t.doneAt, by: req.user.name, text: t.text, kind: t.repeat ? 'repeat' : t.from === 'ai' ? 'ai' : 'me' });
  }
  if (typeof (req.body || {}).text === 'string' && req.body.text.trim()) t.text = req.body.text.trim().slice(0, 200);
  if ((req.body || {}).repeat != null) { if (req.body.repeat) t.repeat = true; else delete t.repeat; }
  if ((req.body || {}).target != null) { const tg = Math.min(1e6, Math.max(0, Number(req.body.target) || 0)); if (tg) { t.target = tg; t.hit = t.hit || {}; } else { delete t.target; delete t.unit; delete t.hit; } }
  if (typeof (req.body || {}).unit === 'string' && t.target) t.unit = req.body.unit.trim().slice(0, 20);
  if ((req.body || {}).kpi !== undefined) { if (/^[a-f0-9]{8}$/.test(String(req.body.kpi || ''))) t.kpi = req.body.kpi; else delete t.kpi; }
  if ((req.body || {}).reached != null && t.target) { t.hit = t.hit || {}; const k = t.repeat ? sync.todayIn() : t.day; t.hit[k] = Math.min(1e7, Math.max(0, Number(req.body.reached) || 0)); }
  await AI().saveWorkbook(req.user.fb_id, req.params.id, w); res.json({ today: sync.todayIn(), ...w });
}));
api.delete('/clients/:id/tasks/:tid', wrap(async (req, res) => {
  if (!(await ownClient(req))) return res.status(404).json({ error: 'Client not found.' });
  const w = await AI().workbook(req.user.fb_id, req.params.id); w.tasks = w.tasks.filter((x) => x.id !== req.params.tid);
  await AI().saveWorkbook(req.user.fb_id, req.params.id, w); res.json({ today: sync.todayIn(), ...w });
}));
// Tick an item of "Today's work" (report to send, client not boosting…) as done for today.
api.put('/clients/:id/tick', wrap(async (req, res) => {
  if (!(await ownClient(req))) return res.status(404).json({ error: 'Client not found.' });
  const key = sync.todayIn() + ':' + String((req.body || {}).key || '').slice(0, 60);
  const w = await AI().workbook(req.user.fb_id, req.params.id); if ((req.body || {}).done) w.ticks[key] = { at: new Date().toISOString(), by: req.user.name }; else delete w.ticks[key];
  const lid = 'k:' + key; w.log = (w.log || []).filter((x) => x.id !== lid);
  if ((req.body || {}).done) w.log.push({ id: lid, day: sync.todayIn(), at: new Date().toISOString(), by: req.user.name, text: String(req.body.title || req.body.key || '').slice(0, 200), kind: String(req.body.key || '').slice(0, 30) });
  await AI().saveWorkbook(req.user.fb_id, req.params.id, w); res.json({ today: sync.todayIn(), ...w });
}));
api.get('/ai/status', wrap(async (req, res) => { const c = await require('./src/ai').publicConfig(); res.json({ hasKey: c.hasKey }); }));
api.put('/admin/ai', ownerOnly, wrap(async (req, res) => res.json(await require('./src/ai').saveKey((req.body || {}).key === null ? null : String((req.body || {}).key || ''), req.user.name))));
// Check one day against adsbox.biz (admins), and take adsbox's numbers for a period when they match its Sales Overview.
api.get('/orders/compare', adminOnly, wrap(async (req, res) => {
  const day = String(req.query.day || ''); if (!isDay(day)) return res.status(400).json({ error: 'Pick a day.' });
  const r = await orders.compareDay(day); if (!r) return res.status(400).json({ error: 'Connect the adsbox.biz API first.' }); res.json(r);
}));
api.post('/orders/use-live', adminOnly, wrap(async (req, res) => {
  const { from, to } = req.body || {}, today = sync.todayIn();
  if (!isDay(from) || !isDay(to) || from > to || (Date.parse(to) - Date.parse(from)) / 864e5 > 92) return res.status(400).json({ error: 'Pick up to 3 months.' });
  const n = await orders.useLive(from, to > today ? today : to); if (n === null) return res.status(400).json({ error: 'Connect the adsbox.biz API first.' }); res.json({ ok: true, rows: n });
}));
// Boost Desk's own order counting: connected Pages, and the switch between it and adsbox.biz.
api.get('/orders/pages', wrap(async (req, res) => { if (req.user.buyer) return res.status(403).json({ error: 'Ask your PM to connect Pages.' }); res.json(await pageOrders.list(req.user.fb_id, await canSeeAdmin(req.user.fb_id))); }));
api.delete('/orders/pages/:id', wrap(async (req, res) => {
  if (req.user.buyer) return res.status(403).json({ error: 'Ask your PM.' });
  const id = String(req.params.id || ''); if (!/^\d{5,30}$/.test(id)) return res.status(400).json({ error: 'Pick a Page.' });
  const row = (await db.pool.query('SELECT connected_by FROM page_links WHERE page_id=$1', [id])).rows[0];
  if (!row) return res.status(404).json({ error: 'That Page is not connected.' });
  if (row.connected_by !== req.user.fb_id && !(await canSeeAdmin(req.user.fb_id))) return res.status(403).json({ error: 'Only the person who connected it or an admin can remove it.' });
  await pageOrders.disconnect(id); res.json({ ok: true });
}));
api.put('/orders/own', ownerOnly, wrap(async (req, res) => res.json(await pageOrders.setMode(!!(req.body || {}).on, req.user.name))));
api.post('/orders/test', adminOnly, wrap(async (req, res) => res.json(await orders.testApi())));
api.post('/orders/pull', wrap(async (req, res) => {
  if ((await pageOrders.mode()).on) { await pageOrders.flush(); return res.json({ ok: true, own: true }); } // counted live by Boost Desk; nothing to fetch
  const b = req.body || {}, today = sync.todayIn();
  let n;
  if (isDay(b.from) && isDay(b.to) && b.from <= b.to && b.from >= sync.addDays(today, -800)) n = await orders.pullRange(b.from, b.to > today ? today : b.to, { force: !!b.force });
  else n = await orders.pullApi(Math.min(62, Number(b.days) || 7)); if (n === null) return res.status(400).json({ error: 'Connect the adsbox.biz API first (Orders page → API settings).' }); res.json({ ok: true, rows: n }); }));
api.get('/orders/report', wrap(async (req, res) => {
  const { from, to } = req.query;
  if (!isDay(from) || !isDay(to) || from > to) return res.status(400).json({ error: 'Pick a valid period.' });
  res.json(await orders.report(req.user.fb_id, from, to, String(req.query.src || 'all')));
}));

// Set a campaign to Live or Post by hand (kind: 'live' | 'post' | null to go back to automatic), then recount.
api.put('/kind-override', wrap(async (req, res) => {
  const id = String((req.body || {}).campaignId || ''), kind = (req.body || {}).kind;
  if (!/^\d{3,30}$/.test(id)) return res.status(400).json({ error: 'Pick a campaign.' });
  const ov = (await db.getUserSetting(req.user.fb_id, 'kindOverride', {})) || {};
  if (kind === 'live' || kind === 'post') ov[id] = kind; else delete ov[id];
  await db.setUserSetting(req.user.fb_id, 'kindOverride', ov);
  // Recount now; if a sync is running, wait for it (the choice is already saved and every sync uses it).
  for (let i = 0; i < 40; i++) {
    if (await sync.exclusive(req.user.fb_id, () => sync.rematch(req.user))) return res.json({ ok: true });
    await new Promise((r) => setTimeout(r, 1500));
  }
  res.json({ ok: true, later: true });
}));
// The bigger live/post window (a day or less = live): recount saved days once.
app.use('/api', api);

// A page nobody has: a small branded 404 with a way back (API paths keep their JSON 404).
app.use((req, res, next) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not found.' });
  res.status(404).type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Page not found · Ads Box</title><link rel="icon" href="/favicon.ico"><style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:Inter,system-ui,sans-serif;background:#f6f7f9;color:#0f172a}main{text-align:center;padding:32px;max-width:420px}h1{font-size:22px;margin:0 0 8px}p{color:#64748b;margin:0 0 20px;line-height:1.5}a{display:inline-block;background:#2563eb;color:#fff;text-decoration:none;font-weight:600;padding:10px 18px;border-radius:10px}</style></head><body><main><h1>This page doesn't exist</h1><p>The link may be old or mistyped. Go back to Boost Desk and pick a page from the menu.</p><a href="/">Open Boost Desk</a></main></body></html>`);
});
// Errors → JSON with a clear message.
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (!err.status || err.status >= 500) console.error('[' + req.method + ' ' + req.path.slice(0, 40) + ']', err.message || err); else console.log('[' + req.path + ']', err.message);
  if (err instanceof meta.MetaError) {
    return res.status(err.needsLogin ? 401 : 502).json({
      error: err.needsLogin ? 'Your Facebook login has expired. Log in again.' : err.rateLimited ? 'Meta is limiting requests right now. Wait a few minutes and try again.' : 'Meta: ' + err.message,
      needsLogin: err.needsLogin,
    });
  }
  res.status(err.status || 500).json({ error: err.message || 'Something went wrong.' });
});

db.init().then(() => pageOrders.init()).then(() => { profit.init().catch((e) => console.log('[profit] init skipped:', e.message)); }).then(() => {
  require('./src/security').rekey().then((r) => { if (r.oldKey) console.log('[security] re-encrypted with the new key:', r.logins, 'logins,', r.keys, 'API keys', r.failed ? `(${r.failed} could not be read)` : ''); }).catch((e) => console.log('[security] rekey failed:', e.message));
  db.getSetting('invoiceQr', '').then((q) => invoice.setQr(q)).catch(() => {});
  // FULL_ADMIN_EMAILS (Railway variable, comma-separated Gmail addresses): on start, each one is put on the Admin website
  // list as a full admin (same rights as the owner). It only adds or upgrades — removing someone is done in Admin → Settings.
  (async () => {
    const want = String(process.env.FULL_ADMIN_EMAILS || '').split(',').map(normEmail).filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)); if (!want.length) return;
    const site = await siteCfg(); let n = 0;
    for (const email of want) { const cur = site.people.find((x) => x.email === email);
      if (!cur) { site.people.push({ email, name: '', linkTo: '', full: true, addedAt: new Date().toISOString(), addedBy: 'FULL_ADMIN_EMAILS' }); n++; }
      else if (!cur.full || cur.linkTo) { cur.full = true; cur.linkTo = ''; n++; } }
    if (n) { await db.setSetting('adminSite', site); console.log('[admin] full admin by Gmail set for', n, 'address(es)'); }
  })().catch((e) => console.log('[admin] FULL_ADMIN_EMAILS skipped:', e.message));
  // One time (18 Nov 2026): a workspace whose username was made for a named PM takes that PM's name; the Facebook
  // account's name is kept beside it and shown under Team Facebook accounts.
  (async () => {
    const flag = 'migr:pmNames:2026-11-18'; if (await db.getSetting(flag, null)) return; let n = 0;
    for (const l of await LOGINS().list()) {
      if (l.role !== 'pm' || !l.fbId || !String(l.name || '').trim()) continue;
      const u = await db.getUser(l.fbId); if (!u || u.name === l.name.trim() || (await db.getUserSetting(u.fb_id, 'fbName', ''))) continue;
      await db.setUserSetting(u.fb_id, 'fbName', u.name); await db.pool.query('UPDATE users SET name=$2 WHERE fb_id=$1', [u.fb_id, l.name.trim()]); n++;
    }
    await db.setSetting(flag, { at: new Date().toISOString(), renamed: n }); if (n) console.log('[accounts] workspace named after its PM for', n, 'account(s)');
  })().catch((e) => console.log('[accounts] PM names skipped:', e.message));
  // One time (17 Nov 2026): the company moved — every account's saved invoice address becomes the new one.
  (async () => {
    const flag = 'migr:invoiceAddress:2026-11-17'; if (await db.getSetting(flag, null)) return;
    const rows = (await db.pool.query(`SELECT key, value FROM settings WHERE key LIKE '%:invoiceProfile'`)).rows; let n = 0;
    for (const r of rows) { const v = r.value || {}; if (v.address1 === invoice.DEFAULT_PROFILE.address1 && v.address2 === invoice.DEFAULT_PROFILE.address2) continue; await db.setSetting(r.key, { ...v, address1: invoice.DEFAULT_PROFILE.address1, address2: invoice.DEFAULT_PROFILE.address2 }); n++; }
    await db.setSetting(flag, { at: new Date().toISOString(), updated: n }); console.log('[invoice] address updated for', n, 'account(s)');
  })().catch((e) => console.log('[invoice] address update skipped:', e.message));
  const server = app.listen(cfg.port, () => console.log(`Boost Desk running on ${cfg.baseUrl} (port ${cfg.port})`));
  // A restart (every deploy) lets the requests in flight finish first, then closes the database, at most 10 seconds.
  let closing = false;
  const stop = (sig) => { if (closing) return; closing = true; console.log(`[stop] ${sig}: finishing open requests`); const t = setTimeout(() => process.exit(0), 10000); if (t.unref) t.unref(); server.close(() => db.pool.end().catch(() => {}).finally(() => process.exit(0))); };
  process.on('SIGTERM', () => stop('SIGTERM')); process.on('SIGINT', () => stop('SIGINT'));
  jobs.start({ handoff: HANDOFF_DEPS });
  // One-off repair (19 Nov 2026): a merge left ad accounts the merged account was syncing unticked in the target, so its
  // sync read nothing. For every workspace merged into since 19 Nov: tick the unticked accounts that have synced rows in
  // the last 30 days, then pull this month again from Meta. Runs once (setting mergeRepair1).
  setTimeout(async () => {
    try {
      if (await db.getSetting('mergeRepair1', null)) return;
      const targets = [...new Set(((await db.getSetting('mergeLog', [])) || []).filter((m) => String(m.at) >= '2026-11-19' && m.into && m.into.id).map((m) => String(m.into.id)))];
      const today = sync.todayIn(), done = [];
      for (const owner of targets) {
        const u = await db.getUser(owner); if (!u) continue;
        const total = (await db.pool.query('SELECT count(*)::int n, count(*) FILTER (WHERE enabled)::int e FROM ad_accounts WHERE owner=$1', [owner])).rows[0];
        const used = (await db.pool.query(`SELECT DISTINCT regexp_replace(x->>'accountId', '^act_', '') id FROM raw_rows r, jsonb_array_elements(r.rows) x WHERE r.owner=$1 AND r.day >= $2::date AND x->>'accountId' IS NOT NULL`, [owner, sync.addDays(today, -30)])).rows.map((r) => r.id);
        const fixed = (await db.pool.query(`UPDATE ad_accounts SET enabled=true WHERE owner=$1 AND NOT enabled AND regexp_replace(id, '^act_', '') = ANY($2) RETURNING name`, [owner, used])).rows;
        console.log(`[merge repair] ${u.name}: ${total.n} ad accounts, ${total.e} ticked before; ${used.length} with synced rows in 30 days; ticked now: ${fixed.length}${fixed.length ? ' — ' + fixed.map((r) => r.name).join(', ') : ''}`);
        done.push({ owner, name: u.name, before: total, used: used.length, fixed: fixed.length });
        if (fixed.length) sync.exclusive(owner, () => sync.syncRange(today.slice(0, 8) + '01', today, { ...u, name: 'Auto sync' })).then((r) => console.log(`[merge repair] ${u.name}: month sync ${r ? `done, ${r.campaigns} campaigns, ${r.errors.length} account errors` : 'skipped (another sync is running — the next automatic sync picks it up)'}`)).catch((e) => console.error('[merge repair] month sync failed:', e.message));
      }
      await db.setSetting('mergeRepair1', { at: new Date().toISOString(), done });
    } catch (e) { console.error('[merge repair]', e.message); }
  }, 20e3).unref();
  // One-off (owner's request, 19 Nov 2026): in the workspaces merged into today, merge the FIRST pair of clients with the
  // same name and log this month's spend before and after, so the result can be checked before the rest is done.
  setTimeout(async () => {
    try {
      if (await db.getSetting('dupMerge1', null)) return;
      const targets = [...new Set(((await db.getSetting('mergeLog', [])) || []).filter((m) => String(m.at) >= '2026-11-19' && m.into && m.into.id).map((m) => String(m.into.id)))];
      const today = sync.todayIn(), from = today.slice(0, 8) + '01', out = [];
      for (const owner of targets) {
        const u = await db.getUser(owner); if (!u) continue;
        const list = (await db.listClients(owner)).filter((c) => !c.archived), groups = {};
        for (const c of list) (groups[String(c.name || '').trim().toLowerCase()] = groups[String(c.name || '').trim().toLowerCase()] || []).push(c);
        const dups = Object.values(groups).filter((g) => g.length > 1);
        console.log(`[dup merge] ${u.name}: ${list.length} clients, ${dups.length} names used more than once — ${dups.map((g) => `${g[0].name} ×${g.length}`).join(', ')}`);
        if (!dups.length) continue;
        const spendOf = async () => Object.fromEntries(((await sync.dashboard(owner, from, today)).clients || []).map((x) => [x.id, x.spend || 0]));
        const before = await spendOf(), g = dups[0].slice().sort((a, b) => (before[b.id] || 0) - (before[a.id] || 0) || a.id - b.id), A = g[0], B = g[1];
        const sumBefore = Math.round(((before[A.id] || 0) + (before[B.id] || 0)) * 100) / 100;
        await mergeClients(u, A.id, B.id);
        const after = await spendOf();
        console.log(`[dup merge] ${u.name}: "${B.name}" #${B.id} ($${(before[B.id] || 0).toFixed(2)}) into #${A.id} ($${(before[A.id] || 0).toFixed(2)}) — this month before $${sumBefore.toFixed(2)}, after $${(after[A.id] || 0).toFixed(2)}${Math.abs((after[A.id] || 0) - sumBefore) < 0.01 ? ' ✓ same' : ' ✗ DIFFERENT'}`);
        out.push({ owner, kept: A.id, removed: B.id, name: A.name, before: sumBefore, after: after[A.id] || 0 });
      }
      await db.setSetting('dupMerge1', { at: new Date().toISOString(), out });
    } catch (e) { console.error('[dup merge]', e.message); }
  }, 45e3).unref();
  // One-off (owner's request, 19 Nov 2026): the same for every workspace — after a backup to the owner's Telegram.
  setTimeout(async () => {
    try {
      if (await db.getSetting('dupMergeAll', null)) return;
      await db.setSetting('dupMergeAll', { at: new Date().toISOString(), running: true }); // claim first: never twice
      const todo = []; for (const u of await db.allUsers()) { const n = sameName(await db.listClients(u.fb_id)).length; if (n) todo.push(u); }
      if (!todo.length) { console.log('[dedupe] no workspace has two clients with the same name'); await db.setSetting('dupMergeAll', { at: new Date().toISOString(), out: [] }); return; }
      const bk = process.env.DEDUPE_TEST === 'local-no-backup' ? { sent: true } : await require('./src/backup').run(telegram).catch((e) => ({ sent: false, error: e.message }));
      console.log(`[dedupe] backup before merging duplicates: ${bk.sent ? 'sent to the owner on Telegram' : 'NOT sent (' + (bk.error || 'unknown') + ')'}`);
      if (!bk.sent) { await db.setSetting('dupMergeAll', { at: new Date().toISOString(), stopped: 'no backup' }); return; } // nothing is merged without a backup
      const out = []; for (const u of todo) { try { out.push({ name: u.name, ...(await dedupeClients(u)) }); } catch (e) { console.error('[dedupe]', u.name, e.message); out.push({ name: u.name, error: e.message }); } }
      await db.setSetting('dupMergeAll', { at: new Date().toISOString(), out });
    } catch (e) { console.error('[dedupe]', e.message); }
  }, 60e3).unref();
  // One-off (20 Nov 2026): the first auto Boost plan lines took the campaign's start on Meta, which counted older posts against them.
  setTimeout(async () => { try { if (await db.getSetting('autoPlanFix1', null)) return; await db.setSetting('autoPlanFix1', { at: new Date().toISOString(), running: true }); const n = await require('./src/autoplan').fixPastStarts(); await db.setSetting('autoPlanFix1', { at: new Date().toISOString(), lines: n }); console.log(`[autoplan] one-off: ${n} lines now start today`); } catch (e) { console.error('[autoplan] one-off', e.message); } }, 20e3).unref();
  setTimeout(() => require('./src/announce').run().catch((e) => console.error('[announce]', e.message)), 30e3).unref(); // one-off announcement of 19 Nov 2026
  setTimeout(() => require('./src/announce').runConnect().catch((e) => console.error('[announce]', e.message)), 45e3).unref(); // one-off of 20 Nov 2026 13:42: PMs connect client Pages (daytime only)
  setInterval(() => require('./src/announce').runGuide().catch((e) => console.error('[announce]', e.message)), 5 * 60e3).unref(); // one-off guide of 20 Nov 2026: goes out once, from 08:10
  // One time: recount saved days with the newer live/post rule (and keep campaign IDs for "Move to Post/Live").
  (async () => {
    for (const u of await db.allUsers()) {
      if (await db.getUserSetting(u.fb_id, 'kindsV5', false)) continue;
      try { if (!(await sync.exclusive(u.fb_id, () => sync.rematch(u)))) continue; await db.setUserSetting(u.fb_id, 'kindsV5', true); console.log('[startup] recounted live/post for', u.name); }
      catch (e) { console.error('[startup] recount failed for', u.name, e.message); }
    }
  })();
}).catch((e) => { console.error('Database setup failed:', e.message); process.exit(1); });
