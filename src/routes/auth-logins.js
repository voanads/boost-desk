// Username + password sign-in (src/logins.js)
// Moved out of server.js unchanged; server.js mounts it at the same place, so route order is kept.
const db = require('../db');

module.exports = function mountAuthLogins(app, api, deps) {
  const { wrap } = deps;
  // ---------- Username + password (src/logins.js) ----------
  // The login opens the same session a Facebook login (PM) or a Telegram link (media buyer) would, so everything after it is unchanged.
  const LOGINS = () => require('../logins');
  app.post('/auth/login', wrap(async (req, res) => {
    const b = req.body || {};
    let rec; try { rec = await LOGINS().verify(b.username, b.password); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
    req.session = { loginId: rec.username };
    if (rec.role === 'mb') {
      if (!(await deps.MB().get(rec.mbId))) { req.session = null; return res.status(403).json({ error: 'This media buyer was removed from the team. Ask your PM.' }); }
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

  return { LOGINS };
};
