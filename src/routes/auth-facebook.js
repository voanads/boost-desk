// Facebook login: sign-in, connecting more Facebook accounts and Pages
// Moved out of server.js unchanged; server.js mounts it at the same place, so route order is kept.
const cfg = require('../config');
const crypto = require('crypto');
const db = require('../db');
const meta = require('../meta');
const pageOrders = require('../pageOrders');
const sync = require('../sync');

module.exports = function mountAuthFacebook(app, api, deps) {
  const { encrypt, wrap } = deps;
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
  // and saves the Pages instead of logging in. A media buyer (owner, 20 Nov 2026) can start it too: the Pages are saved
  // in their PM's workspace, and the media buyer's own Facebook login is used for nothing else.
  const mbPmId = async (mbId) => { const b = mbId && (await deps.MB().get(mbId)); return (b && (b.addedById || ((await db.allUsers()).find((u) => u.name === b.addedBy) || {}).fb_id)) || ''; };
  app.get('/auth/facebook/pages', wrap(async (req, res) => {
    // Facebook/username login, or an owner who signs in with Gmail on the admin site (e.g. Hor Vannak).
    const pm = req.session && req.session.mb ? await mbPmId(req.session.mb) : '';
    const who = req.session && req.session.mb ? (pm ? 'mb:' + pm : '') : req.session ? req.session.fbId || (req.session.gEmail ? 'g:' + req.session.gEmail : '') : '';
    if (!who) return res.redirect('/login');
    req.session.pagesFor = who; req.session.linkFor = null;
    res.redirect(pageOrders.connectUrl(newState()));
  }));
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
    const viaMb = !!(pagesFor && pagesFor.startsWith('mb:') && req.session.mb && (await mbPmId(req.session.mb)) === pagesFor.slice(3)); // a media buyer, for their PM's workspace
    const pagesUser = viaMb ? await db.getUser(pagesFor.slice(3)) : pagesFor && req.session.fbId === pagesFor ? await db.getUser(pagesFor) : null;
    if (pagesFor && (pagesUser || viaGmail)) {
      const back = (msg, ok) => res.redirect((viaMb ? '/mediabuyer' : '/') + '?pg=' + (ok ? 'ok' : 'err') + '&pgmsg=' + encodeURIComponent(msg) + '#orders');
      try {
        const who = pagesUser ? pagesUser.name : req.session.gName || req.session.gEmail;
        const r = await pageOrders.connectFromUserToken(token, { id: viaMb ? pagesFor.slice(3) : pagesFor, name: viaMb ? who + ' (' + profile.name + ')' : who + (profile.id !== pagesFor ? ' (' + profile.name + ')' : '') });
        if (r.missing.length && !r.connected.length) return back(`Facebook did not give Boost Desk the Page permissions (${r.missing.join(', ')}). Tap Connect Pages again and allow everything.`, false);
        if (!r.connected.length && !r.failed.length) return back(`${profile.name} does not manage any Facebook Page.`, false);
        return back(`${r.connected.length} Page${r.connected.length === 1 ? '' : 's'} connected — new orders are counted from now.${r.failed.length ? ` ${r.failed.length} could not be connected: ${r.failed[0].name} (${r.failed[0].error}).` : ''}`, r.connected.length > 0);
      } catch (e) { return back('Connecting Pages failed: ' + e.message, false); }
    }
    // Connecting an extra Facebook account to my workspace: keep me logged in as myself, save the other login beside mine.
    const linkFor = req.session.linkFor; req.session.linkFor = null;
    if (linkFor && req.session.fbId === linkFor && (await db.getUser(linkFor))) {
      const back = (msg, ok) => { console.log(`[fb link] ${ok ? 'connected' : 'not connected'}: ${msg}`); return res.redirect('/?fb=' + (ok ? 'ok' : 'err') + '&fbmsg=' + encodeURIComponent(msg) + '#settings'); };
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
    const mergedInto = await require('../merge').aliasOf(profile.id);
    if (mergedInto && (await db.getUser(mergedInto))) {
      const list = (await sync.extraLogins(mergedInto)).filter((x) => x.id !== profile.id);
      list.push({ id: profile.id, name: profile.name, token_enc: encrypt(token), expires, addedAt: new Date().toISOString(), merged: true });
      await db.setUserSetting(mergedInto, 'fbExtras', list);
      req.session.fbId = mergedInto; req.session.name = (await db.getUser(mergedInto)).name;
      const nx = req.session.next === '/admin' ? '/admin' : '/'; req.session.next = null; return res.redirect(nx);
    }
    // A username that has no workspace yet takes this Facebook account as its workspace (existing clients and settings stay as they are).
    if (req.session.loginId) {
      const rec = await deps.LOGINS().get(req.session.loginId);
      if (rec && rec.role === 'pm' && !rec.fbId) {
        const taken = await deps.LOGINS().forFb(profile.id);
        if (taken) return res.redirect('/welcome?error=' + encodeURIComponent(`${profile.name} is already connected to the username "${taken.username}". Switch facebook.com to your own account and try again.`));
        rec.fbId = profile.id; await deps.LOGINS().save(rec);
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

  return { fbNameOf, loggedIn, newState, stateOk };
};
