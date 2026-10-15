// Where a client's report goes. Normally one report to the client's Telegram group. A client whose Pages
// each have their own topic gets one report per Page, each in its topic; spend from any other Page goes
// to the client's main group.
const sync = require('./sync');
const telegram = require('./telegram');
const reportImage = require('./reportImage');

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

function routes(c) {
  const pages = (c.pages || []).map(norm);
  const topics = Object.entries(c.topics || {}).filter(([p, v]) => v && v.id && pages.includes(norm(p)));
  if (!topics.length) return [{ key: '', label: 'All Pages', scope: null, chat: c.telegram || '', title: c.telegram_title || '' }];
  return [
    ...topics.map(([page, v]) => ({ key: page, label: page, scope: { page }, chat: v.id, title: v.title || '' })),
    { key: '__rest', label: 'Other Pages', scope: { exclude: topics.map(([p]) => p) }, chat: c.telegram || '', title: c.telegram_title || '', rest: true },
  ];
}

// The report text for each route (rest / extra routes with no spend are left out).
async function preview(owner, c, from, to, { kind = '', parts = null } = {}) {
  const list = routes(c), out = [];
  for (const r of list) {
    const rep = await sync.clientReport(owner, c.id, from, to, kind, parts, r.scope);
    if (list.length > 1 && !(rep.spend > 0)) continue;
    out.push({ key: r.key, label: r.label, chat: r.chat, title: r.title, text: rep.text, spend: rep.spend });
  }
  return out;
}

// Send. `only` = one route key (from the report dialog, with text the user may have edited).
async function send(user, c, from, to, { kind = '', parts = null, withImage = true, only = null, text = '' } = {}) {
  const list = routes(c);
  const pick = only != null ? list.filter((r) => r.key === only) : list;
  if (!pick.length) throw Object.assign(new Error('That Page has no Telegram topic any more.'), { status: 400 });
  const sent = [];
  for (const r of pick) {
    const rep = await sync.clientReport(user.fb_id, c.id, from, to, kind, parts, r.scope);
    if (list.length > 1 && only == null && !(rep.spend > 0)) continue; // a Page with nothing to report
    if (!r.chat) {
      if (list.length === 1 || only != null) throw Object.assign(new Error(`${c.name} has no Telegram ${r.rest || list.length === 1 ? 'group' : 'topic'} for ${r.label} yet. Pick one in the Clients tab.`), { status: 400 });
      continue;
    }
    const body = only != null && typeof text === 'string' && text.trim() ? text.slice(0, 12000) : rep.text;
    let png = null;
    if (withImage) { try { png = await reportImage.clientReportImage(user, c.id, from, to, kind, parts, r.scope); } catch (e) { if (e.needsLogin) throw e; console.error('[report image]', e.message); } }
    if (png) await telegram.sendPhoto(png, body, r.chat); else await telegram.send(body, r.chat);
    sent.push({ label: r.label, to: r.title || r.chat, withImage: !!png });
  }
  return sent;
}

module.exports = { routes, preview, send };
