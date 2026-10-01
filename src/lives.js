// Live videos tab: every boosted live, with the comments and messages its boost brought in,
// and how it was boosted (budget, run time, audience, placements) so good setups can be reused.
const cfg = require('./config');
const db = require('./db');
const meta = require('./meta');
const sync = require('./sync');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Group each client's live campaigns into lives (campaigns that start within the live gap), per day.
async function listLives(owner, from, to, gapMs = cfg.liveGapMinutes * 60000) {
  const all = (await db.listRaw(owner, from, to)).flatMap((d) => (d.rows || []).map((r) => ({ ...r, day: r.day || d.day })));
  if (!all.length) return [];
  const clients = await sync.clientsWithLearnedPages(owner, all, { save: false });
  const by = new Map();
  for (const r of all) {
    if (!(Number(r.spend) > 0)) continue;
    const c = sync.matchClient(r, clients);
    if (!c || sync.isPostFor(c, r)) continue;
    const k = c.id + '|' + r.day;
    if (!by.has(k)) by.set(k, { client: c, day: r.day, rows: [] });
    by.get(k).rows.push(r);
  }
  const lives = [];
  for (const { client, day, rows } of by.values()) {
    rows.sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity));
    let cur = null;
    const flush = () => { if (cur) lives.push(finish(client, day, cur)); };
    for (const r of rows) {
      if (cur && r.start != null && cur[0].start != null && r.start - cur[0].start <= gapMs) cur.push(r);
      else { flush(); cur = [r]; }
    }
    flush();
  }
  return lives.sort((a, b) => (b.comments ?? -1) - (a.comments ?? -1) || b.spend - a.spend);
}

function finish(client, day, rows) {
  const has = rows.some((r) => r.comments !== undefined); // rows from before this feature have no comment counts
  const pages = {};
  for (const r of rows) if (r.page) pages[r.page] = (pages[r.page] || 0) + 1;
  const page = Object.entries(pages).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  const spend = round2(rows.reduce((s, r) => s + Number(r.spend), 0));
  const comments = has ? rows.reduce((s, r) => s + (Number(r.comments) || 0), 0) : null;
  const messages = has ? rows.reduce((s, r) => s + (Number(r.messages) || 0), 0) : null;
  return {
    key: `${client.id}|${day}|${rows[0].campaignId || rows[0].name}`,
    clientId: client.id, client: client.name, page, day,
    start: rows[0].start ?? null, time: rows[0].start != null ? sync.hhmm(rows[0].start) : '',
    spend, comments, messages,
    perComment: comments ? round2(spend / comments * 1000) / 1000 : null,
    campaigns: rows.map((r) => ({
      id: r.campaignId || '', accountId: r.accountId || '', name: r.name, start: r.start ?? null,
      time: r.start != null ? sync.hhmm(r.start) : '', spend: round2(r.spend),
      comments: r.comments ?? null, messages: r.messages ?? null,
    })),
  };
}

// Setups for these campaign IDs: from the saved copy, or fetched from Meta (grouped by ad account).
async function setupsFor(user, campaigns, { fetch = true } = {}) {
  const ids = [...new Set(campaigns.map((c) => c.id).filter(Boolean))];
  const out = {};
  for (const r of await db.getSetups(user.fb_id, ids)) out[r.campaign_id] = r.data;
  if (!fetch) return out;
  const missing = {};
  for (const c of campaigns) if (c.id && !out[c.id] && c.accountId) (missing[c.accountId] = missing[c.accountId] || new Set()).add(c.id);
  if (!Object.keys(missing).length) return out;
  const token = await sync.tokenFor(user);
  const errors = [];
  for (const [act, set] of Object.entries(missing)) {
    try {
      const got = await meta.campaignSetups(token, act, [...set]);
      for (const [id, data] of Object.entries(got)) { out[id] = data; await db.putSetup(user.fb_id, id, data); }
    } catch (e) {
      if (e.needsLogin) throw e;
      errors.push(`${act}: ${e.message}`);
    }
  }
  if (errors.length) console.error('[lives] setup lookup:', errors.join('; '));
  return out;
}

// A setup's "shape" without the budget, so lives boosted the same way can be compared.
function signature(s) {
  if (!s) return '';
  const t = s.targeting || {};
  return JSON.stringify([s.goal, t.gender, t.ageMin, t.ageMax, [...(t.places || [])].sort(), [...(t.interests || [])].sort(), [...(t.placements || [])].sort(), t.advantage]);
}

module.exports = { listLives, setupsFor, signature };
