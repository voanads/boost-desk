// Scheduled jobs: hourly auto-sync and the nightly Telegram report.
const cron = require('node-cron');
const cfg = require('./config');
const db = require('./db');
const sync = require('./sync');
const telegram = require('./telegram');

const log = (...a) => console.log(new Date().toISOString(), '[jobs]', ...a);

async function autoSync() {
  const user = await db.latestUser();
  if (!user) return log('auto-sync skipped: nobody logged in yet');
  const today = sync.todayIn();
  // Before noon, also re-sync yesterday: Meta keeps finalizing late-night spend for a few hours.
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: cfg.tz, hour: '2-digit', hour12: false }).format(new Date()));
  const days = hour < 12 ? [sync.addDays(today, -1), today] : [today];
  for (const day of days) {
    try {
      const r = await sync.syncDay(day, user);
      log(`auto-sync ${day}: ${r.campaigns} campaigns, ${r.matched} clients, ${r.unmatched.length} unmatched, ${r.errors.length} errors`);
    } catch (e) { log(`auto-sync ${day} failed:`, e.message); }
  }
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
  if (cron.validate(cfg.autoSyncCron)) {
    cron.schedule(cfg.autoSyncCron, autoSync, { timezone: cfg.tz });
    log(`auto-sync scheduled: "${cfg.autoSyncCron}" (${cfg.tz})`);
  } else log(`AUTO_SYNC_CRON "${cfg.autoSyncCron}" is not valid; auto-sync off`);

  const m = cfg.reportTime.match(/^(\d{1,2}):(\d{2})$/);
  if (telegram.configured() && m) {
    cron.schedule(`${Number(m[2])} ${Number(m[1])} * * *`, () => sendDailyReport().then(() => log('daily report sent')).catch((e) => log('daily report failed:', e.message)), { timezone: cfg.tz });
    log(`Telegram report scheduled at ${cfg.reportTime} (${cfg.tz})`);
  } else log('Telegram report off (set TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID and REPORT_TIME=HH:MM)');
}

module.exports = { start, autoSync, sendDailyReport };
