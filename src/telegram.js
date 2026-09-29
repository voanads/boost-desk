// Sends messages to a Telegram group through a bot.
const cfg = require('./config');

const configured = () => !!(cfg.telegramToken && cfg.telegramChatId);

async function send(text) {
  if (!configured()) throw new Error('Telegram is not set up. Add TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.');
  const chunks = [];
  for (let i = 0; i < text.length; i += 3900) chunks.push(text.slice(i, i + 3900)); // Telegram limit is 4096
  for (const chunk of chunks) {
    const res = await fetch(`https://api.telegram.org/bot${cfg.telegramToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: cfg.telegramChatId, text: chunk, disable_web_page_preview: true }),
    });
    const body = await res.json().catch(() => ({}));
    if (!body.ok) throw new Error('Telegram: ' + (body.description || `HTTP ${res.status}`));
  }
}

module.exports = { configured, send };
