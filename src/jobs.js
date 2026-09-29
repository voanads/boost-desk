// Scheduled jobs: the nightly Telegram team report (auto sync is off — admins tap Sync from Meta).
const cron = require('node-cron');
const cfg = require('./config');
const db = require('./db');
const sync = require('./sync');
const telegram = require('./telegram');

const log = (...a) => console.log(new Date().toISOString(), '[jobs]', ...a);

// Each admin's own report: refresh that admin's day, then send their summary.
// Admins without any clients are skipped.
async function sendDailyReport(day = sync.todayIn()) {
  const admins = await db.activeUsers();
  const sent = [];
  for (const user of admins) {
    if (!(await db.listClients(user.fb_id)).length) continue;
    let warn = '';
    try { await sync.syncDay(day, user); } catch (e) { warn = `\n\n⚠️ Could not refresh from Meta: ${e.message}`; }
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
  const m = cfg.reportTime.match(/^(\d{1,2}):(\d{2})$/);
  if (telegram.configured() && m) {
    cron.schedule(`${Number(m[2])} ${Number(m[1])} * * *`, () => sendDailyReport()
      .then((who) => log('daily report sent for', who.join(', ') || 'nobody'))
      .catch((e) => log('daily report failed:', e.message)), { timezone: cfg.tz });
    log(`Telegram report scheduled at ${cfg.reportTime} (${cfg.tz})`);
  } else log('Telegram report off (set TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID and REPORT_TIME=HH:MM)');
}

module.exports = { start, sendDailyReport };
