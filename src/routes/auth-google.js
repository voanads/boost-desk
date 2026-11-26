// Admin website (/admin): Google sign-in for people the owner allows
// Moved out of server.js unchanged; server.js mounts it at the same place, so route order is kept.
const cfg = require('../config');
const db = require('../db');
const express = require('express');
const health = require('../health');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');

module.exports = function mountAuthGoogle(app, api, deps) {
  const { loggedIn, newState, stateOk, wrap } = deps;
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
  require('../legal')(app); // public /privacy and /data-deletion (Meta app publishing)
  app.get('/admin/login', (req, res) => res.sendFile(path.join(ROOT, 'public', 'admin-login.html')));
  app.get('/admin/login/info', wrap(async (req, res) => res.json({ google: !!(cfg.googleClientId && cfg.googleClientSecret) })));

  app.get('/login', wrap(async (req, res) => {
    if (await loggedIn(req)) return res.redirect('/'); // already logged in: go straight to the app
    res.sendFile(path.join(ROOT, 'public', 'login.html'));
  }));
  // Public standalone AdsCheck Pro page (no Boost Desk login required):
  app.get(['/adscheck', '/adscheck/', '/adscheck.html', '/check', '/smit'], (req, res) => {
    res.set('Cache-Control', 'no-cache').sendFile(path.join(ROOT, 'extension', 'adscheck.html')); // the same page ships inside the extension
  });
  app.get(['/adscheck.js', '/adscheck/adscheck.js'], (req, res) => {
    res.set('Cache-Control', 'no-cache').sendFile(path.join(ROOT, 'extension', 'adscheck.js'));
  });
  // Always revalidate so a new deploy shows up on the next refresh.
  // Khmer mode: the same address serves the Khmer build of app.js (src/km.js). The page is reloaded on a language switch and
  // assets are always revalidated (no-cache), so the right one arrives; the ETag differs between the two.
  app.get('/assets/app.js', (req, res, next) => {
    res.setHeader('Vary', 'Cookie');
    if (!/(?:^|;\s*)bd_lang=km(?:;|$)/.test(req.headers.cookie || '')) return next();
    const b = require('../km').build(); if (!b) return next();
    res.setHeader('Cache-Control', require('../assets').cacheHeader(req, 'app.js')); res.setHeader('ETag', b.etag);
    if (req.headers['if-none-match'] === b.etag) return res.status(304).end();
    res.type('application/javascript').send(b.text);
  });
  // index.html asks for /assets/x?v=<content hash> (src/assets.js): that exact version is kept by the browser for a year;
  // anything else (old hash, no hash, logo, pictures) is always revalidated.
  app.use('/assets', (req, res, next) => { res.locals.assetCache = require('../assets').cacheHeader(req, path.basename(req.path)); next(); },
    express.static(path.join(ROOT, 'public', 'assets'), { maxAge: 0, etag: true, setHeaders: (res) => res.setHeader('Cache-Control', res.locals.assetCache || 'no-cache') }));
  // The extension download is zipped from extension/ once per start, so it always matches the code in git.
  let extZip = null;
  app.get(['/adscheck-connect-extension.zip', '/assets/adscheck-connect-extension.zip', '/AdsCheck-Pro-NoLogin-Extension.zip'], (req, res) => {
    extZip = extZip || require('../zip').zipDir(path.join(ROOT, 'extension'));
    res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="AdsCheck-Pro-NoLogin-Extension.zip"', 'Cache-Control': 'no-cache' }).send(extZip);
  });

  app.use(health.middleware);
  return { googleRedirect, normEmail, siteCfg, sitePerson };
};
