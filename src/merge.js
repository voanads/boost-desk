// Merge one workspace into another (Admin → Users → Merge): for a team that ended up with two Boost Desk
// accounts. The TARGET keeps its name, role, team and username. Everything of the SOURCE moves in:
//   clients (with their saved days, plans, tasks), ad accounts, synced rows, invoices, media buyers, usernames,
//   and the source's Facebook login becomes one more Facebook account of the target (so its ad accounts keep syncing).
// Afterwards a Facebook login with the source account opens the target workspace (setting `fbAlias`).
// plan() only counts; run() does it in one transaction. Nothing here deletes a client or a saved day.
const db = require('./db');
const sync = require('./sync');

const err = (msg, status = 400) => Object.assign(new Error(msg), { status });
const MAX_FB = 6; // one main + five extra Facebook accounts, as in Settings

async function check(from, into) {
  if (!from || !into || from === into) throw err('Choose two different accounts.');
  if (/^g:/.test(from) || /^g:/.test(into)) throw err('A Gmail sign-in has no workspace to merge.');
  const [src, dst] = [await db.getUser(from), await db.getUser(into)];
  if (!src || !dst) throw err('Account not found.', 404);
  if ((await db.ownerId()) === from) throw err(`${src.name} is the app owner's account, so it can only be the one that stays. Merge the other account into it instead.`);
  return { src, dst };
}
const fbName = async (u) => (await db.getUserSetting(u.fb_id, 'fbName', '')) || u.name;
// settings keys that carry this account as one ":"-separated part (111:cwb:5, kpi:111:2026-11, menuList:111:pm …)
const keysOf = async (c, id) => (await c.query(`SELECT key FROM settings WHERE key LIKE $1 OR key LIKE $2`, [id + ':%', '%:' + id + ':%'])).rows.map((r) => r.key).filter((k) => k.split(':').includes(id));
const swap = (key, from, into) => key.split(':').map((p) => (p === from ? into : p)).join(':');
// kept from the target when both have one (personal or per-workspace switches); the source's copy is dropped
const MERGED = new Set(['pageOwners', 'fbExtras', 'handoff']);
const SKIP = new Set(['tgCode', 'tgChat', 'kindsV5', 'lastSeen', 'fbName', 'tgAlertsSent']); // the source person's own links: never moved

async function plan(from, into, c = db.pool) {
  const { src, dst } = await check(from, into);
  const n = async (sql, p) => Number((await c.query(sql, p)).rows[0].n);
  const sClients = (await c.query('SELECT id, name, archived FROM clients WHERE owner=$1', [from])).rows, dNames = new Set((await c.query('SELECT lower(name) n FROM clients WHERE owner=$1', [into])).rows.map((r) => r.n));
  const shared = (await c.query('SELECT s.id, s.name FROM ad_accounts s JOIN ad_accounts d ON d.id=s.id AND d.owner=$2 WHERE s.owner=$1', [from, into])).rows;
  const keys = await keysOf(c, from), have = new Set(await keysOf(c, into));
  const moving = [], kept = [];
  for (const k of keys) { const base = k.split(':').filter((p) => p !== from).join(':').replace(/:.*/, ''), nk = swap(k, from, into); if (SKIP.has(base)) continue; if (!have.has(nk) || MERGED.has(base)) moving.push(k); else kept.push(base); }
  const buyers = ((await db.getSetting('mediaBuyers', [])) || []).filter((b) => b.addedById === from);
  const logins = (await require('./logins').list()).filter((l) => l.fbId === from);
  const extras = [...(await sync.extraLogins(into)), ...(await sync.extraLogins(from))];
  const fbAfter = 2 + new Set(extras.map((e) => e.id).filter((id) => id !== from && id !== into)).size;
  return {
    from: { id: from, name: src.name, facebook: await fbName(src) }, into: { id: into, name: dst.name, facebook: await fbName(dst) },
    clients: sClients.length, clientsActive: sClients.filter((x) => !x.archived).length, sameName: sClients.filter((x) => dNames.has(String(x.name).toLowerCase())).map((x) => x.name),
    days: await n('SELECT count(*) n FROM day_entries e JOIN clients c ON c.id=e.client_id WHERE c.owner=$1', [from]),
    adAccounts: await n('SELECT count(*) n FROM ad_accounts WHERE owner=$1', [from]), sharedAccounts: shared.map((a) => a.name || a.id),
    invoices: await n('SELECT count(*) n FROM invoices WHERE owner=$1', [from]),
    buyers: buyers.map((b) => b.name), usernames: logins.map((l) => l.username),
    settingsMoved: moving.length, settingsKept: [...new Set(kept)],
    facebookAfter: fbAfter, tooManyFacebook: fbAfter > MAX_FB,
    busy: sync.isBusy(from) || sync.isBusy(into),
  };
}

async function run(from, into, by = '') {
  const p = await plan(from, into);
  if (p.tooManyFacebook) throw err(`Together they would have ${p.facebookAfter} Facebook accounts — the limit is ${MAX_FB}. Remove one in Settings first.`);
  const done = await sync.exclusive(from, () => sync.exclusive(into, () => move(from, into, p, by)));
  if (!done) throw err('One of the two accounts is syncing right now. Try again in a minute.', 409);
  return done;
}

async function move(from, into, p, by) {
  const { src } = await check(from, into), srcFb = await fbName(src);
  const c = await db.pool.connect();
  try {
    await c.query('BEGIN');
    // 1 · clients (their saved days, plans and pictures follow by client id)
    await c.query('UPDATE clients SET owner=$2 WHERE owner=$1', [from, into]);
    await c.query('UPDATE invoices SET owner=$2 WHERE owner=$1', [from, into]);
    await c.query('UPDATE post_images SET owner=$2 WHERE owner=$1', [from, into]);
    // 2 · ad accounts: one the target already has stays the target's; the rest move and remember which Facebook login reaches them
    const shared = (await c.query('SELECT s.id FROM ad_accounts s JOIN ad_accounts d ON d.id=s.id AND d.owner=$2 WHERE s.owner=$1', [from, into])).rows.map((r) => r.id);
    // an account the source was syncing stays ticked: otherwise the merged clients' spend silently stops (Nang Sokhy, 19 Nov 2026)
    await c.query('UPDATE ad_accounts d SET enabled = true FROM ad_accounts s WHERE d.owner=$2 AND s.owner=$1 AND s.id=d.id AND s.enabled AND NOT d.enabled', [from, into]);
    await c.query('DELETE FROM ad_accounts WHERE owner=$1 AND id = ANY($2)', [from, shared]);
    await c.query(`UPDATE ad_accounts SET owner=$2, info = info || CASE WHEN info ? 'via' THEN '{}'::jsonb ELSE jsonb_build_object('via', $1::text, 'viaName', $3::text) END WHERE owner=$1`, [from, into, srcFb]);
    // 3 · synced rows: a day both have gets the source's rows added, minus accounts the target already counted
    const both = (await c.query('SELECT s.day, s.rows FROM raw_rows s JOIN raw_rows d ON d.day=s.day AND d.owner=$2 WHERE s.owner=$1', [from, into])).rows;
    for (const r of both) {
      const add = (r.rows || []).filter((x) => !shared.includes(x.accountId));
      if (add.length) await c.query('UPDATE raw_rows SET rows = rows || $3::jsonb WHERE owner=$1 AND day=$2', [into, r.day, JSON.stringify(add)]);
    }
    await c.query('DELETE FROM raw_rows s USING raw_rows d WHERE s.owner=$1 AND d.owner=$2 AND d.day=s.day', [from, into]);
    await c.query('UPDATE raw_rows SET owner=$2 WHERE owner=$1', [from, into]);
    for (const [t, col] of [['day_meta', 'day'], ['pages_seen', 'name'], ['campaign_setups', 'campaign_id']]) {
      await c.query(`DELETE FROM ${t} s USING ${t} d WHERE s.owner=$1 AND d.owner=$2 AND d.${col}=s.${col}`, [from, into]);
      await c.query(`UPDATE ${t} SET owner=$2 WHERE owner=$1`, [from, into]);
    }
    // 4 · settings: tasks, KPIs, menus … move when the target has none; three lists are joined; the rest of the source's go
    const get = async (k) => ((await c.query('SELECT value FROM settings WHERE key=$1', [k])).rows[0] || {}).value;
    const put = (k, v) => c.query('INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2', [k, JSON.stringify(v)]);
    const srcExtras = (await get(`${from}:fbExtras`)) || [], dstExtras = (await get(`${into}:fbExtras`)) || [];
    for (const k of await keysOf(c, from)) {
      const base = k.split(':').filter((x) => x !== from).join(':').replace(/:.*/, ''), nk = swap(k, from, into), mine = await get(k), theirs = await get(nk);
      if (!SKIP.has(base)) {
        if (theirs === undefined && base !== 'fbExtras') await put(nk, mine);
        else if (base === 'pageOwners') await put(nk, { ...(mine || {}), ...(theirs || {}) });
        else if (base === 'handoff') await put(nk, { notes: [...((mine || {}).notes || []), ...((theirs || {}).notes || [])].sort((a, b) => String(a.at).localeCompare(String(b.at))).slice(-60) });
      }
      await c.query('DELETE FROM settings WHERE key=$1', [k]);
    }
    // 5 · the source's Facebook login (and its own extra ones) become Facebook accounts of the target
    const extras = [...dstExtras.filter((e) => e.id !== from)];
    extras.push({ id: from, name: srcFb, token_enc: src.token_enc, expires: src.token_expires, addedAt: new Date().toISOString(), merged: true });
    for (const e of srcExtras) if (e.id !== into && !extras.some((x) => x.id === e.id)) extras.push(e);
    await put(`${into}:fbExtras`, extras);
    // 6 · people: media buyers, usernames, roles, teams, admin lists, Telegram groups
    const dstName = (await c.query('SELECT name FROM users WHERE fb_id=$1', [into])).rows[0].name;
    const buyers = (await get('mediaBuyers')) || []; let ch = false;
    for (const b of buyers) if (b.addedById === from) { b.addedById = into; b.addedBy = dstName; ch = true; }
    if (ch) await put('mediaBuyers', buyers);
    for (const row of (await c.query(`SELECT key, value FROM settings WHERE key LIKE 'login:%'`)).rows) if (row.value && row.value.fbId === from) await put(row.key, { ...row.value, fbId: into });
    const roles = (await get('roles')) || {}; if (roles[from] !== undefined) { delete roles[from]; await put('roles', roles); }
    const teams = (await get('teams')) || []; let tch = false;
    for (const t of teams) if ((t.members || []).includes(from)) { t.members = t.members.filter((m) => m !== from); if (!teams.some((x) => (x.members || []).includes(into))) t.members.push(into); tch = true; }
    if (tch) await put('teams', teams);
    for (const k of ['fullAdmins', 'adminViewers']) { const l = await get(k); if (Array.isArray(l) && l.includes(from)) await put(k, l.filter((x) => x !== from)); }
    const site = await get('adminSite'); if (site && Array.isArray(site.people) && site.people.some((x) => x.linkTo === from)) { for (const x of site.people) if (x.linkTo === from) x.linkTo = into; await put('adminSite', site); }
    const chats = await get('telegramChats');
    if (Array.isArray(chats)) { let cch = false; for (const ch2 of chats) { const o = ch2.owners || (ch2.owner ? [ch2.owner] : []); if (o.includes(from)) { ch2.owners = [...new Set(o.map((x) => (x === from ? into : x)))]; ch2.owner = ch2.owners[0]; cch = true; } } if (cch) await put('telegramChats', chats); }
    // 7 · the source account itself goes; a Facebook login with it now opens the target workspace
    const alias = (await get('fbAlias')) || {}; for (const k of Object.keys(alias)) if (alias[k] === from) alias[k] = into; alias[from] = into; await put('fbAlias', alias);
    await c.query('DELETE FROM users WHERE fb_id=$1', [from]);
    const log = (await get('mergeLog')) || []; log.push({ at: new Date().toISOString(), by, from: p.from, into: p.into, clients: p.clients, adAccounts: p.adAccounts, days: p.days, sameName: p.sameName });
    await put('mergeLog', log.slice(-50));
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  return { ok: true, ...p };
}

const aliasOf = async (fbId) => ((await db.getSetting('fbAlias', {})) || {})[fbId] || '';
module.exports = { plan, run, aliasOf, MAX_FB };
