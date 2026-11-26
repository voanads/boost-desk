// Every ad account of every person (Admin → Ad accounts)
// Moved out of server.js unchanged; server.js mounts it at the same place, so route order is kept.
const db = require('../db');
const meta = require('../meta');
const sync = require('../sync');

module.exports = function mountAdminAdAccounts(app, api, deps) {
  const { adminOnly, getTeams, ownerOnly, wrap } = deps;
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
      for (const x of await sync.extraLogins(owner)) { try { acc = { ...(await meta.adAccount(require('../crypto').decrypt(x.token_enc), act)), via: x.id, viaName: x.name }; break; } catch (e2) { e = e0; } }
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
};
