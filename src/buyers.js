// Media buyers: people who run the ads. They don't need a Boost Desk login — each one opens the bot from an
// invite link once, and from then on tasks a PM gives them arrive in their Telegram with a "Done" button.
const crypto = require('crypto');
const db = require('./db');
const sync = require('./sync');
const telegram = require('./telegram');

const cfg = require('./config');
const KEY = 'mediaBuyers';
// A signed link that opens the media buyer's own dashboard (valid 60 days; the bot sends a fresh one any time).
const sign = (id, exp) => crypto.createHmac('sha256', cfg.sessionSecret).update(`mb.${id}.${exp}`).digest('hex').slice(0, 32);
const dashLink = (b, cid) => { const exp = Date.now() + 60 * 864e5; return `${cfg.baseUrl}/mediabuyer/login?b=${b.id}&e=${exp}&s=${sign(b.id, exp)}${cid ? '&c=' + encodeURIComponent(cid) : ''}`; };
function checkLink(id, exp, sig) {
  if (!/^[a-f0-9]{8}$/.test(String(id)) || !(Number(exp) > Date.now()) || !/^[a-f0-9]{32}$/.test(String(sig))) return false;
  const good = sign(id, Number(exp)); return crypto.timingSafeEqual(Buffer.from(String(sig)), Buffer.from(good));
}
const list = async () => (await db.getSetting(KEY, [])) || [];
const save = (all) => db.setSetting(KEY, all);
const code = () => Array.from({ length: 8 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[crypto.randomInt(32)]).join('');
const pub = (b, bot) => ({ id: b.id, name: b.name, alias: b.alias || '', linked: !!b.chat, tgName: b.tgName || '', photo: !!b.photo, link: bot ? `https://t.me/${bot}?start=mb_${b.code}` : '', addedBy: b.addedBy || '', addedById: b.addedById || '' });

async function all() { const bot = await telegram.username(); return (await list()).map((b) => pub(b, bot)); }
async function add(name, by, byId) {
  const n = String(name || '').trim().slice(0, 60); if (!n) throw new Error('Type the media buyer\'s name.');
  const cur = await list(); if (cur.length >= 50) throw new Error('Too many media buyers.');
  const b = { id: crypto.randomBytes(4).toString('hex'), name: n, code: code(), chat: '', tgName: '', addedBy: by || '', addedById: byId || '', at: new Date().toISOString() };
  await save([...cur, b]); return pub(b, await telegram.username());
}
async function remove(id) { await save((await list()).filter((b) => b.id !== String(id))); }
async function get(id) { return (await list()).find((b) => b.id === String(id)) || null; }

// Tell a media buyer about a new task. Returns the Telegram message id (or throws if they can't be reached).
async function notify(buyer, { client, text, from, repeat, cid, tid }) {
  if (!buyer || !buyer.chat) throw new Error(`${buyer ? buyer.name : 'The media buyer'} hasn't connected Telegram yet.`);
  const msg = `📋 New task${from ? ' from ' + from : ''}\n👤 ${client}\n\n${text}${repeat ? '\n\n🔁 Every day' : ''}`;
  return telegram.sendButtons(msg, buyer.chat, [[{ text: '📋 My tasks', url: dashLink(buyer, cid) }]]);
}

// Called with each batch of Telegram updates: invite links opened, and "Done" buttons tapped.
async function onTelegram(fresh, AI) {
  if ((fresh.starts || []).length) {
    const cur = await list(); let changed = false;
    for (const s of fresh.starts) {
      const b = cur.find((x) => x.code === s.code); if (!b) continue;
      if (b.chat !== s.id) { b.chat = s.id; changed = true; }
      if (await syncProfile(b, s.name)) changed = true;
      telegram.sendButtons(`✅ Hi ${b.name}! Boost Desk tasks from your PM will come here. Tap 📋 My tasks under a task to open your tasks page and tick them off there — send /dashboard any time to get the link again.`, s.id, [[{ text: '📋 My tasks', url: dashLink(b) + '#dashboard' }]]).catch(() => telegram.send(`✅ Hi ${b.name}! Boost Desk tasks from your PM will come here.`, s.id).catch(() => {}));
    }
    if (changed) await save(cur);
  }
  for (const c of fresh.cmds || []) {
    const b = (await list()).find((x) => x.chat === c.id); if (!b) continue;
    telegram.sendButtons(`📋 ${b.name}, here are your tasks for today.`, c.id, [[{ text: '📋 My tasks', url: dashLink(b) + '#dashboard' }]]).catch(() => {});
  }
  for (const t of fresh.taps || []) {
    const m = String(t.data).match(/^td:(\d+):([a-f0-9]{6,20})$/); if (!m) { telegram.answerTap(t.qid); continue; }
    try {
      const cid = m[1], tid = m[2];
      const owner = ((await db.pool.query('SELECT owner FROM clients WHERE id=$1', [cid])).rows[0] || {}).owner;
      if (!owner) { telegram.answerTap(t.qid, 'This client was removed.'); continue; }
      const w = await AI().workbook(owner, cid), task = (w.tasks || []).find((x) => x.id === tid);
      const buyer = task && task.to ? await get(task.to.id) : null;
      if (!task || !buyer || buyer.chat !== t.chat) { telegram.answerTap(t.qid, 'This task is no longer yours.'); continue; }
      if (!task.done) {
        const day = sync.todayIn(), at = new Date().toISOString();
        task.done = true; task.doneAt = at; task.doneBy = buyer.name;
        const lid = 't:' + task.id + ':' + day; w.log = (w.log || []).filter((x) => x.id !== lid);
        w.log.push({ id: lid, day, at, by: buyer.name, text: task.text, kind: task.repeat ? 'repeat' : 'me' });
        await AI().saveWorkbook(owner, cid, w);
      }
      telegram.answerTap(t.qid, '✅ Marked done');
      const hhmm = new Date().toLocaleTimeString('en-GB', { timeZone: require('./config').tz, hour: '2-digit', minute: '2-digit' });
      telegram.editText(t.chat, t.msgId, `${t.text}\n\n✅ Done ${hhmm}`);
    } catch (e) { telegram.answerTap(t.qid, 'Could not save — try again.'); }
  }
}

// Every morning: send each media buyer their every-day tasks again, each with a fresh Done button.
// Keep the media buyer's name and picture the same as on Telegram. The name the PM typed stays as an alias.
async function syncProfile(b, tgName) {
  let changed = false;
  if (tgName && b.tgName !== tgName) { b.tgName = tgName; changed = true; }
  if (b.tgName && b.name !== b.tgName) { if (!b.alias && b.name !== b.tgName) b.alias = b.name; b.name = b.tgName; changed = true; }
  const photo = await telegram.profilePhoto(b.chat);
  if (photo && photo !== b.photo) { b.photo = photo; b.photoAt = new Date().toISOString(); changed = true; }
  return changed;
}
async function photoOf(id) { const b = await get(id); return b && b.photo ? b.photo : ''; }
async function morning(log = () => {}) {
  if (!telegram.hasBot()) return 0;
  const buyers = await list(); if (!buyers.some((b) => b.chat)) return 0;
  // once a day: refresh pictures from Telegram
  try { let ch = false; for (const b of buyers) if (b.chat && await syncProfile(b, '')) ch = true; if (ch) await save(buyers); } catch (e) { log('media buyer profiles:', e.message); }
  const rows = (await db.pool.query(`SELECT key, value FROM settings WHERE key ~ '^[^:]+:cwb:[0-9]+$'`)).rows;
  const names = Object.fromEntries((await db.pool.query('SELECT id, name, archived FROM clients')).rows.filter((c) => !c.archived).map((c) => [String(c.id), c.name]));
  let n = 0;
  for (const r of rows) {
    const cid = r.key.split(':')[2]; if (!names[cid]) continue;
    for (const t of (r.value || {}).tasks || []) {
      if (!t.repeat || !t.to) continue;
      const b = buyers.find((x) => x.id === t.to.id); if (!b || !b.chat) continue;
      try { await notify(b, { client: names[cid], text: t.text, from: t.by, repeat: true, cid, tid: t.id }); n++; } catch (e) { log('media buyer task failed:', e.message); }
    }
  }
  return n;
}

module.exports = { dashLink, checkLink, photoOf, syncProfile, save, list, all, add, remove, get, notify, onTelegram, morning };
