// Auto daily report: each client's report goes to their own Telegram group at a set time.
const cfg = require('./config');
const db = require('./db');
const sync = require('./sync');
const telegram = require('./telegram');
const reportImage = require('./reportImage');

const hasLive = (c) => c.type === 'live' || c.type === 'both';
const hasPost = (c) => c.type === 'post' || c.type === 'both';

// ---------- auto daily report ----------
const AR_DEFAULT = { on: false, time: '20:00', skip: [], withImage: true };
async function autoSettings(owner) {
  const s = { ...AR_DEFAULT, ...((await db.getUserSetting(owner, 'autoReport', null)) || {}) };
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s.time)) s.time = AR_DEFAULT.time;
  s.skip = (Array.isArray(s.skip) ? s.skip : []).map(Number).filter(Number.isFinite);
  return s;
}
const nowHHMM = () => new Intl.DateTimeFormat('en-GB', { timeZone: cfg.tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
async function saveAutoSettings(owner, b) {
  const cur = await autoSettings(owner);
  const next = {
    on: 'on' in b ? !!b.on : cur.on,
    time: /^([01]\d|2[0-3]):[0-5]\d$/.test(b.time) ? b.time : cur.time,
    skip: Array.isArray(b.skip) ? [...new Set(b.skip.map(Number).filter(Number.isFinite))] : cur.skip,
    withImage: 'withImage' in b ? !!b.withImage : cur.withImage,
  };
  await db.setUserSetting(owner, 'autoReport', next);
  // Switched on (or time moved) after today's time has already passed → start tomorrow, don't fire right away.
  if (next.on && (!cur.on || cur.time !== next.time) && nowHHMM() >= next.time) {
    const last = (await db.getUserSetting(owner, 'autoReportLast', null)) || {};
    if (last.day !== sync.todayIn()) await db.setUserSetting(owner, 'autoReportLast', { ...last, day: sync.todayIn(), skipped: true });
  }
  return next;
}

// Send every client's report for one day to their own group. Clients with no spend, no group,
// unticked in the settings, or already sent by hand that day are left out.
async function sendClientReports(user, day = sync.todayIn(), { refresh = true } = {}) {
  const set = await autoSettings(user.fb_id);
  const out = { day, at: new Date().toISOString(), sent: [], failed: [], already: [], noSpend: 0, warn: '' };
  if (refresh) { try { await sync.exclusive(user.fb_id, () => sync.syncDay(day, { ...user, name: 'Auto report' })); } catch (e) { out.warn = e.message; } }
  for (const c of await db.listClients(user.fb_id)) {
    if (c.archived || !c.telegram || set.skip.includes(c.id)) continue;
    const e = await db.getEntry(day, c.id);
    const spend = (hasLive(c) ? Object.values(e.lives || {}).reduce((s, l) => s + (Number(l && l.spend) || 0), 0) : 0) + (hasPost(c) ? Number((e.post || {}).spend) || 0 : 0);
    if (!(spend > 0)) { out.noSpend++; continue; }
    if (e.reportSent) { out.already.push(c.name); continue; }
    try {
      const r = await sync.clientReport(user.fb_id, c.id, day, day);
      let png = null;
      if (set.withImage) { try { png = await reportImage.clientReportImage(user, c.id, day, day); } catch (err) { console.error('[auto report] picture:', c.name, err.message); } }
      if (png) await telegram.sendPhoto(png, r.text, c.telegram); else await telegram.send(r.text, c.telegram);
      await db.putEntry(day, c.id, { ...(await db.getEntry(day, c.id)), reportSent: { at: new Date().toISOString(), by: 'Auto report' } });
      out.sent.push(c.name);
    } catch (err) { out.failed.push({ name: c.name, error: err.message }); }
  }
  return out;
}

// Called every minute: send for each account whose time has come and that hasn't sent today.
let ticking = false;
async function tick() {
  if (ticking || !telegram.hasBot()) return;
  ticking = true;
  try {
    const today = sync.todayIn(), now = nowHHMM();
    for (const user of await db.activeUsers()) {
      try {
        const set = await autoSettings(user.fb_id);
        if (!set.on || now < set.time) continue;
        const last = (await db.getUserSetting(user.fb_id, 'autoReportLast', null)) || {};
        if (last.day === today) continue;
        await db.setUserSetting(user.fb_id, 'autoReportLast', { day: today, running: true }); // claim the day first, so it can never send twice
        const r = await sendClientReports(user, today);
        await db.setUserSetting(user.fb_id, 'autoReportLast', r);
        console.log(new Date().toISOString(), `[auto report] ${user.name}: sent ${r.sent.length}, failed ${r.failed.length}`);
      } catch (e) { console.error('[auto report]', user.name, e.message); }
    }
  } finally { ticking = false; }
}

module.exports = { autoSettings, saveAutoSettings, sendClientReports, tick };
