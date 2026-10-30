// Personal Telegram alerts (Settings → "Alerts to my Telegram"): each person picks what reaches their own chat.
//   user setting tgAlerts = { on, payment, overplan, liveNoBoost }   (defaults: on, payment + overplan)
//   user setting tgAlertsSent = { '<key>': '<day>' }               what was already sent, so each thing is said once a day
const db = require('./db');
const sync = require('./sync');
const telegram = require('./telegram');

const DEFAULT = { on: true, payment: true, overplan: true, liveNoBoost: false };
const prefs = async (owner) => ({ ...DEFAULT, ...((await db.getUserSetting(owner, 'tgAlerts', null)) || {}) });
const savePrefs = async (owner, b) => { const cur = await prefs(owner); for (const k of Object.keys(DEFAULT)) if (b[k] != null) cur[k] = !!b[k]; await db.setUserSetting(owner, 'tgAlerts', cur); return cur; };

// Run every hour: for every person with a connected Telegram and alerts on.
async function run(pm) {
  const today = sync.todayIn(), out = [];
  for (const u of await db.allUsers()) {
    const chat = await db.getUserSetting(u.fb_id, 'tgChat', null); if (!chat || !chat.id) continue;
    const p = await prefs(u.fb_id); if (!p.on) continue;
    const sent = (await db.getUserSetting(u.fb_id, 'tgAlertsSent', null)) || {}, lines = [];
    const once = (key) => { if (sent[key] === today) return false; sent[key] = today; return true; };
    if (p.payment) {
      for (const a of await db.listAccounts(u.fb_id)) {
        if (!a.enabled) continue;
        const st = String((a.info || {}).status || a.status || '').toLowerCase(), reason = String((a.info || {}).disableReason || (a.info || {}).reason || '');
        if (/disabled|unsettled|closed/.test(st) && once('acct:' + a.id)) lines.push(`💳 Ad account ${a.name}: ${st}${reason ? ' · ' + reason : ''}`);
      }
    }
    if (p.overplan || p.liveNoBoost) {
      let t = { items: [], tips: [] }; try { t = await pm.todo({ fb_id: u.fb_id, name: u.name }); } catch (_) {}
      for (const x of [...(t.items || []), ...(t.tips || [])]) {
        if (p.overplan && x.kind === 'plan' && once('plan:' + x.clientId)) lines.push(`📣 ${x.title}\n   ${x.detail || ''}`); // spends over the Boost Post plan
        if (p.liveNoBoost && x.kind === 'missing' && once('live:' + x.clientId)) lines.push(`🔴 ${x.title}\n   ${x.detail || ''}`); // usually boosts every day, nothing yet today
      }
    }
    for (const k of Object.keys(sent)) if (sent[k] < today) delete sent[k];
    await db.setUserSetting(u.fb_id, 'tgAlertsSent', sent);
    if (!lines.length) continue;
    try { await telegram.send(`🔔 Boost Desk · ${u.name}\n\n${lines.join('\n')}`, chat.id); out.push(u.name); } catch (e) { console.error('[alerts]', u.name, e.message); }
  }
  return out.length;
}

module.exports = { prefs, savePrefs, run, DEFAULT };
