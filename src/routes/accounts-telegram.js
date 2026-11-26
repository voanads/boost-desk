// Ad accounts tab, Telegram link codes and the chat list
// Moved out of server.js unchanged; server.js mounts it at the same place, so route order is kept.
const cfg = require('../config');
const db = require('../db');
const health = require('../health');
const sync = require('../sync');
const telegram = require('../telegram');

module.exports = function mountAccountsTelegram(app, api, deps) {
  const { LOGINS, MB, accountsWithToday, isDay, wrap } = deps;
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
  if (telegram.hasBot()) { health.register('Telegram check', 1, 'every minute'); setInterval(require('../runOnce').once('Telegram check', () => health.track('Telegram check', () => refreshChats()).catch((e) => console.error('[telegram] refresh:', e.message)), 15000), 15000).unref(); } // every 15 s so "Done" taps show quickly
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
    try { await require('../status').onTelegram(fresh); } catch (e) { console.error('[telegram] client status:', e.message); }
    try { await require('../buyers').onTelegram(fresh, deps.AI); } catch (e) { console.error('[telegram] media buyers:', e.message); }
    try { await require('../handoff').onTelegram(fresh); } catch (e) { console.error('[telegram] handoff:', e.message); }
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
  return { chatsNow, linkCode, newCode, rangeOk };
};
