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
// track (optional array): each sent message is added as { chat, id }, so it can be deleted later.
async function send(text, chatId = cfg.telegramChatId, track = null) {
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
    try { require('./health').noteService('Telegram', !!body.ok || res.status < 500, 0, body.ok ? '' : body.description); } catch (_) {}
    if (!body.ok) throw new Error('Telegram: ' + (body.description || `HTTP ${res.status}`));
    lastId = body.result && body.result.message_id;
    if (track && lastId) track.push({ chat: String(chatId), id: lastId });
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
async function sendPhoto(png, caption, chatId = cfg.telegramChatId, track = null) {
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
  if (track && body.result && body.result.message_id) track.push({ chat: String(chatId), id: body.result.message_id });
  if (caption && !fits) await send(caption, chatId, track);
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
    const res = await fetch(`${API}/bot${cfg.telegramToken}/getUpdates?limit=100&offset=${next}&allowed_updates=${encodeURIComponent('["message","my_chat_member","channel_post","callback_query"]')}`);
    const body = await res.json().catch(() => ({}));
    if (!body.ok) throw new Error('Telegram: ' + (body.description || `HTTP ${res.status}`));
    const list = body.result || []; result.push(...list);
    if (list.length) next = list[list.length - 1].update_id + 1;
    if (list.length < 100) break;
  }
  const found = new Map(), links = [], topicNames = {}, moved = [], alerts = [], starts = [], taps = [], cmds = [];
  for (const u of result) {
    // A button under a bot message was tapped (e.g. a media buyer's "Done").
    if (u.callback_query) { const q = u.callback_query; taps.push({ qid: q.id, data: q.data || '', chat: String((q.message && q.message.chat && q.message.chat.id) || (q.from && q.from.id) || ''), msgId: q.message && q.message.message_id, text: (q.message && q.message.text) || '', name: [q.from && q.from.first_name, q.from && q.from.last_name].filter(Boolean).join(' ') }); continue; }
    const m = u.message || u.my_chat_member || u.channel_post || {}, chat = m.chat;
    if (chat && chat.type === 'private') {
      const pt = ((u.message || {}).text || '').trim().match(/^\/alerts(?:@\w+)?\s+([A-Za-z0-9]{6})\b/i);
      if (pt) alerts.push({ id: String(chat.id), code: pt[1].toUpperCase(), name: [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || '' });
      // A media buyer opened the bot from their invite link (t.me/<bot>?start=mb_CODE).
      const st = ((u.message || {}).text || '').trim().match(/^\/start\s+mb_([A-Za-z0-9]{8})\b/);
      if (st) starts.push({ id: String(chat.id), code: st[1].toUpperCase(), name: [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || '' });
      // A media buyer asking for their dashboard link (/dashboard, or /start without a code).
      const cm = ((u.message || {}).text || '').trim().match(/^\/(dashboard|start|mytasks)(?:@\w+)?\s*$/i);
      if (cm) cmds.push({ id: String(chat.id), cmd: cm[1].toLowerCase() });
      continue;
    }
    if (!chat) continue;
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
  return { chats: [...found.values()], links, moved, alerts, starts, taps, cmds, next };
}

// A user's Telegram profile photo (smallest size), as a data URL — or '' when they have none / it's hidden.
async function profilePhoto(userId) {
  if (!cfg.telegramToken || !userId) return '';
  try {
    const r = await (await fetch(`${API}/bot${cfg.telegramToken}/getUserProfilePhotos?user_id=${encodeURIComponent(userId)}&limit=1`)).json();
    const sizes = r.ok && r.result && r.result.photos && r.result.photos[0]; if (!sizes || !sizes.length) return '';
    const small = sizes.find((p) => p.width >= 150) || sizes[sizes.length - 1];
    const f = await (await fetch(`${API}/bot${cfg.telegramToken}/getFile?file_id=${encodeURIComponent(small.file_id)}`)).json();
    if (!f.ok || !f.result || !f.result.file_path) return '';
    const bin = await (await fetch(`${API}/file/bot${cfg.telegramToken}/${f.result.file_path}`)).arrayBuffer();
    if (bin.byteLength > 200000) return '';
    return 'data:image/jpeg;base64,' + Buffer.from(bin).toString('base64');
  } catch (_) { return ''; }
}
let botName = null;
async function username() {
  if (botName || !cfg.telegramToken) return botName;
  try { const r = await (await fetch(`${API}/bot${cfg.telegramToken}/getMe`)).json(); if (r.ok) botName = r.result.username; } catch (_) {}
  return botName;
}

// Up to 10 pictures as one album; the text goes as the album's caption when it fits, else as a message after it.
async function sendAlbum(images, text, chatId) {
  if (!cfg.telegramToken) throw new Error('Telegram is not set up. Add TELEGRAM_BOT_TOKEN in Railway.');
  if (!chatId) throw new Error('No Telegram group chosen.');
  const list = images.slice(0, 10), fits = text && text.length <= 1024;
  if (list.length === 1) {
    const form = new FormData(); addDest(form, chatId); if (fits) form.append('caption', text);
    form.append('photo', new Blob([list[0].data], { type: list[0].mime }), 'post.jpg');
    const body = await (await fetch(`${API}/bot${cfg.telegramToken}/sendPhoto`, { method: 'POST', body: form })).json().catch(() => ({}));
    if (!body.ok) throw new Error('Telegram: ' + (body.description || 'photo failed'));
  } else {
    const form = new FormData(); addDest(form, chatId);
    form.append('media', JSON.stringify(list.map((im, i) => ({ type: 'photo', media: `attach://p${i}`, ...(i === 0 && fits ? { caption: text } : {}) }))));
    list.forEach((im, i) => form.append(`p${i}`, new Blob([im.data], { type: im.mime }), `p${i}.jpg`));
    const body = await (await fetch(`${API}/bot${cfg.telegramToken}/sendMediaGroup`, { method: 'POST', body: form })).json().catch(() => ({}));
    if (!body.ok) throw new Error('Telegram: ' + (body.description || 'album failed'));
  }
  if (text && !fits) await send(text, chatId);
}

// A message with buttons under it: buttons = [[{ text, data }]].
async function sendButtons(text, chatId, buttons) {
  if (!cfg.telegramToken) throw new Error('Telegram is not set up. Add TELEGRAM_BOT_TOKEN in Railway.');
  const body = await (await fetch(`${API}/bot${cfg.telegramToken}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...dest(chatId), text, disable_web_page_preview: true, reply_markup: { inline_keyboard: buttons.map((row) => row.map((b) => (b.url ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.data }))) } }) })).json().catch(() => ({}));
  if (!body.ok) throw new Error('Telegram: ' + (body.description || 'send failed'));
  return body.result && body.result.message_id;
}
async function answerTap(qid, text) {
  if (!cfg.telegramToken || !qid) return;
  await fetch(`${API}/bot${cfg.telegramToken}/answerCallbackQuery`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ callback_query_id: qid, text: text || '' }) }).catch(() => {});
}
// Replace a bot message's text and drop its buttons.
async function editText(chatId, msgId, text) {
  if (!cfg.telegramToken || !msgId) return;
  await fetch(`${API}/bot${cfg.telegramToken}/editMessageText`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: String(chatId).split(':')[0], message_id: msgId, text, disable_web_page_preview: true }) }).catch(() => {});
}

module.exports = { profilePhoto, sendButtons, answerTap, editText, sendAlbum, configured, hasBot, send, remove, sendPhoto, sendDocument, listChats, username };
