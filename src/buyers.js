// Media buyers: people who run the ads. They don't need a Boost Desk login — each one opens the bot from an
// invite link once, and from then on tasks a PM gives them arrive in their Telegram with a "Done" button.
const crypto = require('crypto');
const db = require('./db');
const sync = require('./sync');
const telegram = require('./telegram');

const KEY = 'mediaBuyers';
const list = async () => (await db.getSetting(KEY, [])) || [];
const save = (all) => db.setSetting(KEY, all);
const code = () => Array.from({ length: 8 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[crypto.randomInt(32)]).join('');
const pub = (b, bot) => ({ id: b.id, name: b.name, linked: !!b.chat, tgName: b.tgName || '', link: bot ? `https://t.me/${bot}?start=mb_${b.code}` : '', addedBy: b.addedBy || '' });

async function all() { const bot = await telegram.username(); return (await list()).map((b) => pub(b, bot)); }
async function add(name, by) {
  const n = String(name || '').trim().slice(0, 60); if (!n) throw new Error('Type the media buyer\'s name.');
  const cur = await list(); if (cur.length >= 50) throw new Error('Too many media buyers.');
  const b = { id: crypto.randomBytes(4).toString('hex'), name: n, code: code(), chat: '', tgName: '', addedBy: by || '', at: new Date().toISOString() };
  await save([...cur, b]); return pub(b, await telegram.username());
}
async function remove(id) { await save((await list()).filter((b) => b.id !== String(id))); }
async function get(id) { return (await list()).find((b) => b.id === String(id)) || null; }

// Tell a media buyer about a new task. Returns the Telegram message id (or throws if they can't be reached).
async function notify(buyer, { client, text, from, repeat, cid, tid }) {
  if (!buyer || !buyer.chat) throw new Error(`${buyer ? buyer.name : 'The media buyer'} hasn't connected Telegram yet.`);
  const msg = `📋 New task${from ? ' from ' + from : ''}\n👤 ${client}\n\n${text}${repeat ? '\n\n🔁 Every day' : ''}`;
  return telegram.sendButtons(msg, buyer.chat, [[{ text: '✅ Done', data: `td:${cid}:${tid}` }]]);
}

// Called with each batch of Telegram updates: invite links opened, and "Done" buttons tapped.
async function onTelegram(fresh, AI) {
  if ((fresh.starts || []).length) {
    const cur = await list(); let changed = false;
    for (const s of fresh.starts) {
      const b = cur.find((x) => x.code === s.code); if (!b) continue;
      if (b.chat !== s.id) { b.chat = s.id; b.tgName = s.name; changed = true; }
      telegram.send(`✅ Hi ${b.name}! Boost Desk tasks from your PM will come here. Tap ✅ Done under a task when it's finished.`, s.id).catch(() => {});
    }
    if (changed) await save(cur);
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
async function morning(log = () => {}) {
  if (!telegram.hasBot()) return 0;
  const buyers = await list(); if (!buyers.some((b) => b.chat)) return 0;
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

module.exports = { all, add, remove, get, notify, onTelegram, morning };
