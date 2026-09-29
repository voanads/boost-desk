// Scheduled jobs, all running quietly in the background (nothing shows in the app):
//   • every 5 min  — spots newly created campaigns and pulls their spend
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
  const accounts = await db.enabledAccountIds(user.fb_id);
  const known = await db.getUserSetting(user.fb_id, 'activeCampaigns', null);
  const now = {};
  const fresh = [];
  for (const act of accounts) {
    try {
      now[act] = await meta.activeCampaignIds(token, act);
    } catch (e) {
      now[act] = known?.[act] || [];
      continue;
    }
    if (!known) continue; // first run: just record a baseline
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
    await telegram.send(head + (await sync.buildReport(user.fb_id, day)) + warn);
    sent.push(user.name);
  }
  return sent;
}

function start() {
  const opts = { timezone: cfg.tz };
  if (process.env.AUTO_SYNC !== 'off') {
    let running = false;
    const guard = (fn) => async () => { if (running) return; running = true; try { await fn(); } finally { running = false; } };
    cron.schedule('*/5 * * * *', guard(() => forEachAdmin(checkNewCampaigns, 'new-campaign check')), opts);
    cron.schedule('7 * * * *', guard(() => forEachAdmin((u) => rangeFor(u, 2, 'hourly'), 'hourly sync')), opts);
    cron.schedule('30 5 * * *', guard(() => forEachAdmin((u) => rangeFor(u, 30, 'daily 30-day'), '30-day sync')), opts);
    log('Background auto sync on (new campaigns every 5 min, hourly refresh, 30-day refresh at 05:30)');
  }
  const m = cfg.reportTime.match(/^(\d{1,2}):(\d{2})$/);
  if (telegram.configured() && m) {
    cron.schedule(`${Number(m[2])} ${Number(m[1])} * * *`, () => sendDailyReport()
      .then((who) => log('daily report sent for', who.join(', ') || 'nobody'))
      .catch((e) => log('daily report failed:', e.message)), opts);
    log(`Telegram report scheduled at ${cfg.reportTime} (${cfg.tz})`);
  } else log('Telegram report off (set TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID and REPORT_TIME=HH:MM)');
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
