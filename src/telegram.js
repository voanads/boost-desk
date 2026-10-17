// Sends messages to Telegram groups through a bot.
const cfg = require('./config');

const API = 'https://api.telegram.org';
const configured = () => !!(cfg.telegramToken && cfg.telegramChatId);
const hasBot = () => !!cfg.telegramToken;
// A destination is a group id ("-100123") or a topic in a group with topics ("-100123:45").
function dest(id) {
  const [chat, thread] = String(id).split(':');
  return thread ? { chat_id: chat, message_thread_id: Number(thread) } : { chat_id: chat };
}
function addDest(form, id) { const d = dest(id); form.append('chat_id', d.chat_id); if (d.message_thread_id) form.append('message_thread_id', String(d.message_thread_id)); }

// chatId defaults to the team group. Pass a client's group to send it there instead.
async function send(text, chatId = cfg.telegramChatId) {
  if (!cfg.telegramToken) throw new Error('Telegram is not set up. Add TELEGRAM_BOT_TOKEN in Railway.');
  if (!chatId) throw new Error('No Telegram group chosen. Set TELEGRAM_CHAT_ID for the team, or pick a group for this client.');
  const chunks = [];
  for (let i = 0; i < text.length; i += 3900) chunks.push(text.slice(i, i + 3900)); // Telegram limit is 4096
  let lastId = null;
  for (const chunk of chunks) {
    const res = await fetch(`${API}/bot${cfg.telegramToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...dest(chatId), text: chunk, disable_web_page_preview: true }),
    });
    const body = await res.json().catch(() => ({}));
    if (!body.ok) throw new Error('Telegram: ' + (body.description || `HTTP ${res.status}`));
    lastId = body.result && body.result.message_id;
  }
  return lastId;
}
// Remove a message (works for the bot's own messages; others' only when the bot is a group admin).
async function remove(chatId, messageId) {
  if (!cfg.telegramToken || !messageId) return false;
  try {
    const r = await (await fetch(`${API}/bot${cfg.telegramToken}/deleteMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: String(chatId).split(':')[0], message_id: messageId }) })).json();
    return !!r.ok;
  } catch (_) { return false; }
}

// A picture with the report as its caption. Telegram captions are limited to 1024 characters,
// so a longer report goes as a separate message right after the picture.
async function sendPhoto(png, caption, chatId = cfg.telegramChatId) {
  if (!cfg.telegramToken) throw new Error('Telegram is not set up. Add TELEGRAM_BOT_TOKEN in Railway.');
  if (!chatId) throw new Error('No Telegram group chosen.');
  const fits = caption && caption.length <= 1024;
  const form = new FormData();
  addDest(form, chatId);
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
  addDest(form, chatId);
  if (caption) form.append('caption', caption.slice(0, 1024));
  form.append('document', new Blob([buf], { type }), filename);
  const res = await fetch(`${API}/bot${cfg.telegramToken}/sendDocument`, { method: 'POST', body: form });
  const body = await res.json().catch(() => ({}));
  if (!body.ok) throw new Error('Telegram: ' + (body.description || `HTTP ${res.status}`));
}

// Groups the bot has seen recently (add the bot to the group and send one message there).
// Telegram only keeps the last 24 hours of updates, so the server also saves what it finds.
// Reads new updates from `offset` on (up to 1000, in pages of 100). Telegram holds at most 100 unread
// updates per call, so without moving the offset a busy group would hide every newer /link.
async function listChats(offset = 0) {
  if (!cfg.telegramToken) throw new Error('Telegram is not set up. Add TELEGRAM_BOT_TOKEN in Railway.');
  const result = []; let next = offset;
  for (let page = 0; page < 10; page++) {
    const res = await fetch(`${API}/bot${cfg.telegramToken}/getUpdates?limit=100&offset=${next}&allowed_updates=${encodeURIComponent('["message","my_chat_member","channel_post"]')}`);
    const body = await res.json().catch(() => ({}));
    if (!body.ok) throw new Error('Telegram: ' + (body.description || `HTTP ${res.status}`));
    const list = body.result || []; result.push(...list);
    if (list.length) next = list[list.length - 1].update_id + 1;
    if (list.length < 100) break;
  }
  const found = new Map(), links = [], topicNames = {}, moved = [];
  for (const u of result) {
    const m = u.message || u.my_chat_member || u.channel_post || {}, chat = m.chat;
    if (!chat || chat.type === 'private') continue;
    // A group upgraded to a supergroup gets a new id; reports must follow it.
    if (u.message && u.message.migrate_to_chat_id) { moved.push({ from: String(chat.id), to: String(u.message.migrate_to_chat_id) }); continue; }
    found.set(String(chat.id), { id: String(chat.id), title: chat.title || String(chat.id), type: chat.type });
    // Groups with topics: a message inside a topic carries its thread id; the topic's name comes from
    // the "topic created" message it belongs to.
    const msg = u.message || {};
    let where = String(chat.id);
    if (msg.forum_topic_created && msg.message_thread_id) topicNames[`${chat.id}:${msg.message_thread_id}`] = msg.forum_topic_created.name;
    if (msg.is_topic_message && msg.message_thread_id) {
      where = `${chat.id}:${msg.message_thread_id}`;
      const name = msg.reply_to_message?.forum_topic_created?.name || msg.forum_topic_created?.name || topicNames[where];
      if (name) topicNames[where] = name;
      found.set(where, { id: where, chat: String(chat.id), title: `${chat.title || chat.id} › ${name || 'Topic ' + msg.message_thread_id}`, topic: name || '', type: 'topic' });
    }
    // "/link CODE" typed in a group (or in one topic of it) links it to one Boost Desk account.
    const t = (u.message || u.channel_post || {}).text || '';
    const mm = t.trim().match(/^\/(link|unlink)(?:@\w+)?\s+([A-Za-z0-9]{6})\b/i);
    if (mm) links.push({ id: where, code: mm[2].toUpperCase(), at: m.date || 0, unlink: mm[1].toLowerCase() === 'unlink', msgId: msg.message_id || (u.channel_post || {}).message_id });
  }
  links.sort((a, b) => a.at - b.at); // the latest /link wins
  return { chats: [...found.values()], links, moved, next };
}

let botName = null;
async function username() {
  if (botName || !cfg.telegramToken) return botName;
  try { const r = await (await fetch(`${API}/bot${cfg.telegramToken}/getMe`)).json(); if (r.ok) botName = r.result.username; } catch (_) {}
  return botName;
}

module.exports = { configured, hasBot, send, remove, sendPhoto, sendDocument, listChats, username };
