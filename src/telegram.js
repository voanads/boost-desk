// Sends messages to Telegram groups through a bot.
const cfg = require('./config');

const API = 'https://api.telegram.org';
const configured = () => !!(cfg.telegramToken && cfg.telegramChatId);
const hasBot = () => !!cfg.telegramToken;

// chatId defaults to the team group. Pass a client's group to send it there instead.
async function send(text, chatId = cfg.telegramChatId) {
  if (!cfg.telegramToken) throw new Error('Telegram is not set up. Add TELEGRAM_BOT_TOKEN in Railway.');
  if (!chatId) throw new Error('No Telegram group chosen. Set TELEGRAM_CHAT_ID for the team, or pick a group for this client.');
  const chunks = [];
  for (let i = 0; i < text.length; i += 3900) chunks.push(text.slice(i, i + 3900)); // Telegram limit is 4096
  for (const chunk of chunks) {
    const res = await fetch(`${API}/bot${cfg.telegramToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: chunk, disable_web_page_preview: true }),
    });
    const body = await res.json().catch(() => ({}));
    if (!body.ok) throw new Error('Telegram: ' + (body.description || `HTTP ${res.status}`));
  }
}

// Groups the bot has seen recently (add the bot to the group and send one message there).
// Telegram only keeps the last 24 hours of updates, so the server also saves what it finds.
async function listChats() {
  if (!cfg.telegramToken) throw new Error('Telegram is not set up. Add TELEGRAM_BOT_TOKEN in Railway.');
  const res = await fetch(`${API}/bot${cfg.telegramToken}/getUpdates?allowed_updates=${encodeURIComponent('["message","my_chat_member","channel_post"]')}`);
  const body = await res.json().catch(() => ({}));
  if (!body.ok) throw new Error('Telegram: ' + (body.description || `HTTP ${res.status}`));
  const found = new Map();
  for (const u of body.result || []) {
    const chat = (u.message || u.my_chat_member || u.channel_post || {}).chat;
    if (chat && chat.type !== 'private') found.set(String(chat.id), { id: String(chat.id), title: chat.title || String(chat.id), type: chat.type });
  }
  return [...found.values()];
}

module.exports = { configured, hasBot, send, listChats };
