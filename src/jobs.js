// Scheduled jobs, all running quietly in the background (nothing shows in the app):
//   • every 5 min  — spots new ad accounts (loads their last 30 days) and newly created campaigns
//   • every hour   — refreshes today + yesterday
//   • 05:30 daily  — refreshes the last 30 days (Meta keeps finalising late spend)
//   • REPORT_TIME  — nightly Telegram team report
// Background syncs only run for admins who have tapped "Sync from Meta" at least once,
// never overlap with a manual sync, and skip admins whose Facebook login has expired.
const cron = require('node-cron');
const cfg = require('./config');
const db = require('./db');
const meta = require('./meta');
const sync = require('./sync');
const telegram = require('./telegram');

const log = (...a) => console.log(new Date().toISOString(), '[jobs]', ...a);
const AUTO_NAME = 'Auto sync';

// Has this admin tapped Sync from Meta at least once? (A brand-new admin stays empty until they do.)
async function hasSynced(owner) {
  return !!(await db.getUserSetting(owner, 'lastSyncCheck', null)) || (await db.listRaw(owner)).length > 0;
}
// The owner can switch auto sync off per account; default is on.
const autoSyncOn = async (owner) => (await db.getUserSetting(owner, 'autoSync', true)) !== false;

async function syncedAdmins() {
  const out = [];
  for (const user of await db.activeUsers()) {
    if ((await autoSyncOn(user.fb_id)) && (await hasSynced(user.fb_id))) out.push(user);
  }
  return out;
}

const noteRun = (owner, info) => db.setUserSetting(owner, 'autoSyncLast', { at: new Date().toISOString(), ...info });

const asAuto = (user) => ({ ...user, name: AUTO_NAME });

async function rangeFor(user, days, why) {
  const today = sync.todayIn();
  const since = sync.addDays(today, -(days - 1));
  const r = await sync.exclusive(user.fb_id, () => sync.syncRange(since, today, asAuto(user)));
  if (r) await noteRun(user.fb_id, { why, from: since, to: today, campaigns: r.campaigns, errors: r.errors.length });
  if (r) log(`${why}: ${user.name} ${since}→${today}, ${r.campaigns} campaigns${r.errors.length ? `, ${r.errors.length} account errors` : ''}`);
  return r;
}

// Compare each enabled ad account's active campaign IDs with the last check.
// Any ID not seen before = a new campaign → pull today + yesterday.
async function checkNewCampaigns(user) {
  if (sync.isBusy(user.fb_id)) return false;
  const token = await sync.tokenFor(user);
  // New ad accounts on this Facebook login: reload the account list, and load 30 days for a new one.
  const before = new Set((await db.listAccounts(user.fb_id)).map((a) => a.id));
  try { await sync.refreshAccounts(user); } catch (e) { if (e.needsLogin) throw e; log(`account list for ${user.name} failed:`, e.message); }
  const added = (await db.listAccounts(user.fb_id)).filter((a) => !before.has(a.id) && a.enabled), addedIds = new Set(added.map((a) => a.id));
  if (before.size && added.length) {
    log(`new ad account for ${user.name}: ${added.map((a) => a.name || a.id).join(', ')}`);
    await rangeFor(user, 30, 'new ad account');
  }
  const accounts = await db.enabledAccountIds(user.fb_id), pick = await sync.tokenPicker(user);
  const known = await db.getUserSetting(user.fb_id, 'activeCampaigns', null);
  const now = {};
  const fresh = [];
  for (const act of accounts) {
    try {
      now[act] = await meta.activeCampaignIds(pick(act), act);
    } catch (e) {
      now[act] = known?.[act] || [];
      continue;
    }
    if (!known || addedIds.has(act)) continue; // first run / a just-added account (already loaded above): just record a baseline
    const seen = new Set(known[act] || []);
    for (const id of now[act]) if (!seen.has(id)) fresh.push(id);
  }
  // Keep IDs from before so a paused-then-resumed campaign isn't treated as new.
  const merged = {};
  for (const act of new Set([...Object.keys(known || {}), ...Object.keys(now)])) {
    merged[act] = [...new Set([...(known?.[act] || []), ...(now[act] || [])])].slice(-2000);
  }
  await db.setUserSetting(user.fb_id, 'activeCampaigns', merged);
  await db.setUserSetting(user.fb_id, 'autoSyncChecked', new Date().toISOString());
  if (!fresh.length) return false;
  log(`new campaigns for ${user.name}: ${fresh.length}`);
  await rangeFor(user, 2, 'new campaign');
  return true;
}

// Run a job for every synced admin, one at a time; errors are logged, never thrown.
async function forEachAdmin(job, label) {
  for (const user of await syncedAdmins()) {
    try { await job(user); } catch (e) {
      log(`${label} failed for ${user.name}:`, e.message);
      await noteRun(user.fb_id, { why: label, error: e.message }).catch(() => {});
    }
  }
}

// Each admin's own report: refresh that admin's day, then send their summary.
// Admins without any clients are skipped.
async function sendDailyReport(day = sync.todayIn()) {
  const admins = await db.activeUsers();
  const sent = [];
  for (const user of admins) {
    if (!(await db.listClients(user.fb_id)).length) continue;
    let warn = '';
    try { await sync.exclusive(user.fb_id, () => sync.syncDay(day, asAuto(user))); } catch (e) { warn = `\n\n⚠️ Could not refresh from Meta: ${e.message}`; }
    if (user.token_expires && new Date(user.token_expires) - Date.now() < 7 * 864e5) {
      warn += `\n\n🔑 ${user.name}'s Facebook login expires ${new Date(user.token_expires).toLocaleDateString('en-GB')}. Log in again to keep syncing.`;
    }
    const head = admins.length > 1 ? `👤 ${user.name}\n` : '';
    try { await telegram.send(head + (await sync.buildReport(user.fb_id, day)) + warn); sent.push(user.name); }
    catch (e) { log(`daily report for ${user.name} failed:`, e.message); } // one failure must not stop the other reports
  }
  return sent;
}

function start(deps = {}) {
  const opts = { timezone: cfg.tz };
  const H = require('./health'), T = (name, fn) => () => H.track(name, fn).catch(() => {});
  // every copy of the app keeps its timers, but each run happens in one copy only (see runOnce.js)
  const every = (name, expr, fn, o) => cron.schedule(expr, require('./runOnce').once(name, fn), o);
  if (process.env.AUTO_SYNC !== 'off') {
    let running = false;
    const guard = (fn) => async () => { if (running) return; running = true; try { await fn(); } finally { running = false; } };
    H.register('New campaigns check', 5, 'every 5 minutes'); H.register('Hourly sync', 60, 'every hour at :07'); H.register('Today sync', 15, 'every 15 minutes at :22, :37, :52'); H.register('30-day refresh', 1440, 'daily at 05:30');
    every('New campaigns check', '*/5 * * * *', guard(T('New campaigns check', async () => { await forEachAdmin(checkNewCampaigns, 'new-campaign check'); for (const u of await syncedAdmins()) { try { await require('./autoplan').run(u); } catch (e) { log(`auto boost plan failed for ${u.name}:`, e.message); } } })), opts);
    every('Hourly sync', '7 * * * *', guard(T('Hourly sync', () => forEachAdmin((u) => rangeFor(u, 2, 'hourly'), 'hourly sync'))), opts);
    // Today alone every 15 minutes in between, so the Dashboard and reports are never more than a quarter hour behind Meta.
    every('Today sync', '22,37,52 * * * *', guard(T('Today sync', () => forEachAdmin((u) => rangeFor(u, 1, 'today'), 'today sync'))), opts);
    every('30-day refresh', '30 5 * * *', guard(T('30-day refresh', () => forEachAdmin((u) => rangeFor(u, 30, 'daily 30-day'), '30-day sync'))), opts);
    log('Background auto sync on (new campaigns every 5 min, hourly refresh, 30-day refresh at 05:30)');
  }
  // Each account's own "auto daily report" (time chosen in the app): checked every minute.
  H.register('Auto reports', 1, 'every minute');
  every('Auto reports', '* * * * *', () => H.track('Auto reports', () => require('./extras').tick()).catch((e) => log('auto report failed:', e.message)), opts);
  // adsbox.biz order counts, every 30 minutes once the API is connected on the Orders page.
  H.register('adsbox.biz orders', 30, 'every 30 minutes');
  H.register('Spend to adsbox.biz', 30, 'every 30 minutes, at :15 and :45');
  every('Spend to adsbox.biz', '15,45 * * * *', () => H.track('Spend to adsbox.biz', () => require('./orders').pushSpend(7)).then((r) => { if (r) log('spend sent to adsbox:', r.saved, 'of', r.received); }).catch((e) => log('spend to adsbox failed:', e.message)), opts);
  // Today's count every 5 minutes (one small call), the last 3 days every 30 minutes.
  H.register('adsbox.biz today', 5, 'every 5 minutes');
  every('adsbox.biz today', '2,7,12,17,22,27,32,37,42,47,52,57 * * * *', () => H.track('adsbox.biz today', () => require('./orders').pullApi(1)).catch((e) => log('adsbox today failed:', e.message)), opts);
  every('adsbox.biz orders', '*/30 * * * *', () => H.track('adsbox.biz orders', () => require('./orders').pullApi(3)).then((n) => { if (n !== null) log('adsbox orders:', n, 'rows'); }).catch((e) => log('adsbox orders failed:', e.message)), opts); // does nothing until the API is connected
  // Boost Desk's own order counting: comments of a running Live on each connected Page, every minute
  // (Messenger messages and other comments arrive by webhook straight away).
  // Connect the team's client Pages for order counting with every saved Facebook login (new clients' Pages too).
  H.register('Connect client Pages (orders)', 180, 'every 3 hours');
  every('Connect client Pages (orders)', '17 */3 * * *', () => H.track('Connect client Pages (orders)', () => require('./pageOrders').autoConnect()).then((r) => { if (r && r.connected.length) log('client Pages connected:', r.connected.length); }).catch((e) => log('Connect client Pages failed:', e.message)), opts);
  setTimeout(() => require('./pageOrders').autoConnect().catch((e) => log('Connect client Pages failed:', e.message)), 90e3);
  H.register('Live comments (orders)', 1, 'every minute');
  every('Live comments (orders)', '* * * * *', () => H.track('Live comments (orders)', () => require('./pageOrders').pollLives()).then((n) => { if (n) log('orders from Live comments:', n); }).catch((e) => log('Live comments failed:', e.message)), opts);
  // AI: a plan for today for each active client, every morning at 06:40 (only when an AI key is set).
  H.register('AI daily plans', 1440, 'daily at 06:40');
  every('AI daily plans', '40 6 * * *', () => H.track('AI daily plans', () => require('./ai').morningPlans(log)).then((n) => { if (n) log('AI daily plans:', n); }).catch((e) => log('AI daily plans failed:', e.message)), opts);
  // AI: a weekly strategy for the clients each PM picked, Mondays at 07:00 (drafts for the team; nothing is sent to a client).
  H.register('AI weekly strategies', 10080, 'Mondays at 07:00');
  every('AI weekly strategies', '0 7 * * 1', () => H.track('AI weekly strategies', () => require('./ai').weeklyPlans(log)).then((n) => { if (n) log('AI weekly strategies:', n); }).catch((e) => log('AI weekly strategies failed:', e.message)), opts);
  // System health: check every 5 minutes, alert the owner on Telegram.
  H.register('Database backup', 1440, 'daily at 03:20');
  // Media buyers get their every-day tasks again each morning at 08:00, with a fresh Done button.
  H.register('Media buyer tasks', 1440, 'daily at 08:00');
  every('Media buyer tasks', '0 8 * * *', () => H.track('Media buyer tasks', () => require('./buyers').morning(log)).then((n) => { if (n) log('media buyer tasks sent:', n); }).catch((e) => log('media buyer tasks failed:', e.message)), opts);
  every('Database backup', '20 3 * * *', () => H.track('Database backup', async () => { const r = await require('./backup').run(telegram); if (r.error) throw new Error(r.error); log('backup sent:', r.sizeMb, 'MB'); }).catch((e) => log('backup failed:', e.message)), opts);

  // Settings → "Alerts to my Telegram": each person's own picks, once a day per thing.
  H.register('Personal alerts', 60, 'every hour at :25');
  every('Personal alerts', '25 * * * *', () => H.track('Personal alerts', () => require('./myalerts').run(require('./pm'))).then((n) => { if (n) log('personal alerts sent:', n); }).catch((e) => log('personal alerts failed:', e.message)), opts);

  // Handoff between media buyers (morning) and PMs (evening): brief 08:00, "before you leave" 16:45, digest 20:45.
  if (deps.handoff) {
    const HO = require('./handoff'), at = (t) => { const [h, m] = t.split(':').map(Number); return `${m} ${h} * * *`; };
    H.register('Morning brief', 1440, 'daily at ' + HO.TIMES.brief); H.register('Leave reminder', 1440, 'daily at ' + HO.TIMES.remind); H.register('Evening digest', 1440, 'daily at ' + HO.TIMES.digest);
    every('Morning brief', at(HO.TIMES.brief), () => H.track('Morning brief', () => HO.morningBrief(deps.handoff, log)).then((n) => { if (n) log('morning briefs sent:', n); }).catch((e) => log('morning brief failed:', e.message)), opts);
    every('Leave reminder', at(HO.TIMES.remind), () => H.track('Leave reminder', () => HO.leaveReminder(deps.handoff, log)).then((n) => { if (n) log('leave reminders sent:', n); }).catch((e) => log('leave reminder failed:', e.message)), opts);
    every('Evening digest', at(HO.TIMES.digest), () => H.track('Evening digest', () => HO.eveningDigest(deps.handoff, log)).then((n) => { if (n) log('evening digests sent:', n); }).catch((e) => log('evening digest failed:', e.message)), opts);
  }
  H.register('Health check', 5, 'every 5 minutes');
  every('Health check', '*/5 * * * *', T('Health check', () => H.checkAndAlert(db, telegram)), opts);
  // The 21:00 "Boost report" to the team group was removed on 19 Nov 2026 (owner's decision). The evening digest to each
  // PM, the per-client auto reports and Teams today cover it. sendDailyReport() stays for a manual run only.
}

// Owner's control panel: every account that has logged in, with its auto sync state.
async function statusAll() {
  const out = [];
  for (const u of await db.allUsers()) {
    out.push({
      id: u.fb_id, name: u.name, tokenExpires: u.token_expires,
      expired: !!(u.token_expires && new Date(u.token_expires) < new Date()),
      enabled: await autoSyncOn(u.fb_id),
      synced: await hasSynced(u.fb_id),
      busy: sync.isBusy(u.fb_id),
      accounts: (await db.enabledAccountIds(u.fb_id)).length,
      clients: (await db.listClients(u.fb_id)).filter((c) => !c.archived).length,
      lastRun: await db.getUserSetting(u.fb_id, 'autoSyncLast', null),
      lastCheck: await db.getUserSetting(u.fb_id, 'autoSyncChecked', null),
      adminView: (await db.getSetting('adminViewers', [])).includes(u.fb_id),
    });
  }
  return out;
}

const setEnabled = (owner, on) => db.setUserSetting(owner, 'autoSync', !!on);

// "Run now" from the owner panel: refresh today + yesterday for one account.
async function runNow(owner) {
  const user = await db.getUser(owner);
  if (!user) throw Object.assign(new Error('Account not found.'), { status: 404 });
  if (user.token_expires && new Date(user.token_expires) < new Date()) throw Object.assign(new Error(`${user.name}'s Facebook login has expired. They need to log in again.`), { status: 400 });
  if (!(await hasSynced(owner))) throw Object.assign(new Error(`${user.name} hasn't tapped Sync from Meta yet, so their workspace stays empty until they do.`), { status: 400 });
  if (sync.isBusy(owner)) throw Object.assign(new Error(`A sync is already running for ${user.name}.`), { status: 409 });
  rangeFor(user, 2, 'run now').catch(async (e) => { log('run now failed for', user.name, e.message); await noteRun(owner, { why: 'run now', error: e.message }).catch(() => {}); });
}

module.exports = { start, sendDailyReport, checkNewCampaigns, syncedAdmins, rangeFor, statusAll, setEnabled, runNow };
