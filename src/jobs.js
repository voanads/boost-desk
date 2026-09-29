// Scheduled jobs: auto-sync (interval set in the app) and the nightly Telegram report.
const cron = require('node-cron');
const cfg = require('./config');
const db = require('./db');
const sync = require('./sync');
const telegram = require('./telegram');

const log = (...a) => console.log(new Date().toISOString(), '[jobs]', ...a);

const AUTO_DEFAULT = { enabled: true, everyMinutes: 60, from: 8, to: 23 }; // hours in local time
const getAuto = async () => ({ ...AUTO_DEFAULT, ...(await db.getSetting('autoSync', {})) });

let running = false;
async function autoSync() {
  if (running) return log('auto-sync skipped: previous run still going');
  running = true;
  try { await autoSyncInner(); } finally { running = false; }
}
async function autoSyncInner() {
  const user = await db.latestUser();
  if (!user) return log('auto-sync skipped: nobody logged in yet');
  // Same as the Sync button: the last 30 days in one pass (Meta keeps adjusting recent days).
  const today = sync.todayIn(), from = sync.addDays(today, -29);
  try {
    const r = await sync.syncRange(from, today, user);
    log(`auto-sync ${from}..${today}: ${r.campaigns} campaign-days, ${r.daysWithSpend} days with spend, ${r.errors.length} errors`);
  } catch (e) { log('auto-sync failed:', e.message); }
  const a = await getAuto();
  await db.setSetting('autoSync', { ...a, lastRun: new Date().toISOString() });
}

// Every 5 minutes: run a sync when auto-sync is on, we're inside its hours, and the interval has passed.
async function autoSyncTick() {
  const a = await getAuto();
  if (!a.enabled) return;
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: cfg.tz, hour: '2-digit', hour12: false }).format(new Date())) % 24;
  if (hour < a.from || hour > a.to) return;
  const last = a.lastRun ? Date.parse(a.lastRun) : 0;
  if (Date.now() - last < a.everyMinutes * 60000 - 60000) return; // 1-minute slack
  await autoSync();
}

async function sendDailyReport(day = sync.todayIn()) {
  const user = await db.latestUser();
  let warn = '';
  if (user) {
    try { await sync.syncDay(day, user); } catch (e) { warn = `\n\n⚠️ Could not refresh from Meta: ${e.message}`; }
    if (user.token_expires && new Date(user.token_expires) - Date.now() < 7 * 864e5) {
      warn += `\n\n🔑 Facebook login for ${user.name} expires ${new Date(user.token_expires).toLocaleDateString('en-GB')}. Log in again to keep syncing.`;
    }
  } else warn = '\n\n⚠️ Nobody is logged in with Facebook, so spend was not refreshed.';
  const text = (await sync.buildReport(day)) + warn;
  await telegram.send(text);
  return text;
}

function start() {
  // Auto sync is off: data updates when someone taps "Sync from Meta".

  const m = cfg.reportTime.match(/^(\d{1,2}):(\d{2})$/);
  if (telegram.configured() && m) {
    cron.schedule(`${Number(m[2])} ${Number(m[1])} * * *`, () => sendDailyReport().then(() => log('daily report sent')).catch((e) => log('daily report failed:', e.message)), { timezone: cfg.tz });
    log(`Telegram report scheduled at ${cfg.reportTime} (${cfg.tz})`);
  } else log('Telegram report off (set TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID and REPORT_TIME=HH:MM)');
}

module.exports = { start, autoSync, sendDailyReport, getAuto, AUTO_DEFAULT };
