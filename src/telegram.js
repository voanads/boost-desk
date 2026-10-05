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

// A picture with the report as its caption. Telegram captions are limited to 1024 characters,
// so a longer report goes as a separate message right after the picture.
async function sendPhoto(png, caption, chatId = cfg.telegramChatId) {
  if (!cfg.telegramToken) throw new Error('Telegram is not set up. Add TELEGRAM_BOT_TOKEN in Railway.');
  if (!chatId) throw new Error('No Telegram group chosen.');
  const fits = caption && caption.length <= 1024;
  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (fits) form.append('caption', caption);
  form.append('photo', new Blob([png], { type: 'image/png' }), 'report.png');
  const res = await fetch(`${API}/bot${cfg.telegramToken}/sendPhoto`, { method: 'POST', body: form });
  const body = await res.json().catch(() => ({}));
  if (!body.ok) throw new Error('Telegram: ' + (body.description || `HTTP ${res.status}`));
  if (caption && !fits) await send(caption, chatId);
}

// A file (e.g. an invoice PDF) with a caption.
async function sendDocument(buf, filename, caption, chatId = cfg.telegramChatId, type = 'application/pdf') {
  if (!cfg.telegramToken) throw new Error('Telegram is not set up. Add TELEGRAM_BOT_TOKEN in Railway.');
  if (!chatId) throw new Error('No Telegram group chosen.');
  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (caption) form.append('caption', caption.slice(0, 1024));
  form.append('document', new Blob([buf], { type }), filename);
  const res = await fetch(`${API}/bot${cfg.telegramToken}/sendDocument`, { method: 'POST', body: form });
  const body = await res.json().catch(() => ({}));
  if (!body.ok) throw new Error('Telegram: ' + (body.description || `HTTP ${res.status}`));
}

// Groups the bot has seen recently (add the bot to the group and send one message there).
// Telegram only keeps the last 24 hours of updates, so the server also saves what it finds.
async function listChats() {
  if (!cfg.telegramToken) throw new Error('Telegram is not set up. Add TELEGRAM_BOT_TOKEN in Railway.');
  const res = await fetch(`${API}/bot${cfg.telegramToken}/getUpdates?allowed_updates=${encodeURIComponent('["message","my_chat_member","channel_post"]')}`);
  const body = await res.json().catch(() => ({}));
  if (!body.ok) throw new Error('Telegram: ' + (body.description || `HTTP ${res.status}`));
  const found = new Map(), links = [];
  for (const u of body.result || []) {
    const m = u.message || u.my_chat_member || u.channel_post || {}, chat = m.chat;
    if (!chat || chat.type === 'private') continue;
    found.set(String(chat.id), { id: String(chat.id), title: chat.title || String(chat.id), type: chat.type });
    // "/link CODE" typed in a group links that group to one Boost Desk account.
    const t = (u.message || u.channel_post || {}).text || '';
    const mm = t.match(/^\/(link|unlink)(?:@\w+)?\s+([A-Za-z0-9]{6})\b/);
    if (mm) links.push({ id: String(chat.id), code: mm[2].toUpperCase(), at: m.date || 0, unlink: mm[1] === 'unlink' });
  }
  links.sort((a, b) => a.at - b.at); // the latest /link wins
  return { chats: [...found.values()], links };
}

let botName = null;
async function username() {
  if (botName || !cfg.telegramToken) return botName;
  try { const r = await (await fetch(`${API}/bot${cfg.telegramToken}/getMe`)).json(); if (r.ok) botName = r.result.username; } catch (_) {}
  return botName;
}

module.exports = { configured, hasBot, send, sendPhoto, sendDocument, listChats, username };
