// Config from environment variables. See .env.example.
const req = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing environment variable ${k}. See .env.example.`);
  return v;
};

module.exports = {
  port: Number(process.env.PORT || 3000),
  // Tolerate typos like "https:host", "host" or a trailing slash.
  baseUrl: (() => {
    let u = String(process.env.BASE_URL || 'http://localhost:3000').trim().replace(/\/+$/, '');
    u = u.replace(/^(https?):\/*/i, (m, p) => p.toLowerCase() + '://');
    if (!/^https?:\/\//.test(u)) u = 'https://' + u;
    return u;
  })(),
  databaseUrl: req('DATABASE_URL'),
  sessionSecret: req('SESSION_SECRET'),
  encryptionKey: req('ENCRYPTION_KEY'), // 64 hex chars (32 bytes)
  fbAppId: req('FB_APP_ID'),
  fbAppSecret: req('FB_APP_SECRET'),
  fbConfigId: process.env.FB_CONFIG_ID || '', // Facebook Login for Business configuration (optional)
  graphVersion: process.env.GRAPH_VERSION || 'v25.0',
  allowedFbIds: (process.env.ALLOWED_FB_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
  tz: process.env.TZ_NAME || 'Asia/Phnom_Penh',
  liveGapMinutes: Number(process.env.LIVE_GAP_MINUTES || 30),
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  reportTime: process.env.REPORT_TIME || '21:00', // HH:MM in tz
  autoSyncCron: process.env.AUTO_SYNC_CRON || '5 8-23 * * *', // minute 5 of every hour 08:00–23:00
  pgSsl: process.env.PGSSL === 'true',
};
