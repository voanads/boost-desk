// Turns Meta campaign rows into per-client daily entries, and builds the text report.
const cfg = require('./config');
const db = require('./db');
const meta = require('./meta');
const { decrypt } = require('./crypto');

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const hasLive = (c) => c.type === 'live' || c.type === 'both';
const hasPost = (c) => c.type === 'post' || c.type === 'both';
const money = (n) => '$' + (Number(n) || 0).toFixed(2);
const round2 = (n) => Math.round(n * 100) / 100;

function todayIn(tz = cfg.tz, date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
function hhmm(ms, tz = cfg.tz) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));
}
// "DC Shop | 29" → "DC Shop"
const campaignPrefix = (name) => { const m = String(name).match(/^(.*?)\s*\|/); return (m ? m[1] : String(name)).trim(); };

const isAutoPost = (name) => /^post:/i.test(String(name || '')) || !name;

// Match order: campaign name ("DC Shop | 29") → the Facebook Page the ad promotes → linked ad account.
function matchClient(item, clients) {
  const active = clients.filter((c) => !c.archived);
  // A client can own several Pages: its name, its alternate name and every Page listed on it all count.
  const names = (c) => [c.name, c.match, ...(c.pages || [])].filter(Boolean).map(norm);
  if (!isAutoPost(item.name)) {
    const prefix = norm(campaignPrefix(item.name));
    const byName = active.find((c) => names(c).includes(prefix));
    if (byName) return byName;
  }
  if (item.page) {
    const byPage = active.find((c) => names(c).includes(norm(item.page)));
    if (byPage) return byPage;
  }
  return active.find((c) => c.account && (norm(c.account) === norm(item.account) || c.account === item.accountId)) || null;
}

/**
 * Group campaign rows by client. For live clients, campaigns that start within
 * `gapMs` of the first campaign in a group count as one live.
 * items: [{name, account, accountId, spend, start(ms|null)}]
 */
function buildPlan(items, clients, gapMs = cfg.liveGapMinutes * 60000) {
  const groups = new Map();
  const unmatched = new Map();
  for (const it of items) {
    if (!(it.spend > 0)) continue;
    const c = matchClient(it, clients);
    if (!c) {
      const auto = isAutoPost(it.name);
      const label = auto
        ? (it.page ? `Post boosts for Page "${it.page}"` : 'Post boosts (Page unknown)') + (it.account ? ' · ' + it.account : '')
        : campaignPrefix(it.name) + (it.account ? ' · ' + it.account : '');
      const u = unmatched.get(label) || { label, page: auto ? it.page || '' : it.page || campaignPrefix(it.name), kind: auto ? 'post' : 'live', spend: 0, count: 0 };
      u.spend = round2(u.spend + it.spend); u.count++;
      unmatched.set(label, u);
      continue;
    }
    if (!groups.has(c.id)) groups.set(c.id, { client: c, items: [] });
    groups.get(c.id).items.push(it);
  }
  const targets = [];
  for (const { client, items: g } of groups.values()) {
    // Post clients: everything is post spend. Live clients: everything is lives.
    // Post + live clients: auto-named "Post: …" boosts are posts, named campaigns are lives.
    const toPost = (it) => client.type === 'post' || (client.type === 'both' && isAutoPost(it.name));
    const postItems = g.filter(toPost), liveItems = g.filter((it) => !toPost(it));
    const slots = [];
    liveItems.sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity));
    for (const it of liveItems) {
      const last = slots[slots.length - 1];
      if (last && it.start != null && last.start != null && it.start - last.start <= gapMs) {
        last.spend = round2(last.spend + it.spend); last.count++;
      } else slots.push({ start: it.start, spend: round2(it.spend), count: 1 });
    }
    const post = postItems.length ? { spend: round2(postItems.reduce((s, x) => s + x.spend, 0)), count: postItems.length } : null;
    targets.push({ clientId: client.id, slots, post });
  }
  return { targets, unmatched: [...unmatched.values()].sort((a, b) => b.spend - a.spend) };
}

// Spend + progress for one client's entry.
function entryStats(c, e = {}) {
  let spend = 0, total = 0, done = 0;
  const lives = [];
  if (hasPost(c)) { const p = e.post || {}; spend += Number(p.spend) || 0; total++; if (p.on) done++; }
  if (hasLive(c)) {
    const n = e.liveCount ?? c.lives ?? 2;
    for (let i = 1; i <= n; i++) {
      const l = (e.lives || {})['l' + i] || {};
      spend += Number(l.spend) || 0; total++; if (l.on) done++;
      lives.push(l);
    }
  }
  return { spend: round2(spend), total, done, lives };
}

async function tokenFor(user) {
  if (!user) throw new meta.MetaError('Nobody is logged in with Facebook yet. Log in once so the app can read Ads Manager.', { needsLogin: true });
  return decrypt(user.token_enc);
}

async function refreshAccounts(user) {
  const token = await tokenFor(user);
  const list = await meta.adAccounts(token);
  await db.saveAccounts(list);
  return list;
}

function addDays(day, n) {
  const d = new Date(day + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Pull campaign spend for every enabled ad account over [since, until].
async function fetchRange(since, until, user) {
  const token = await tokenFor(user);
  let ids = await db.enabledAccountIds();
  if (!ids.length) { await refreshAccounts(user); ids = await db.enabledAccountIds(); }
  const names = Object.fromEntries((await db.listAccounts()).map((a) => [a.id, a.name]));
  const items = [];
  const errors = [];
  for (const id of ids) {
    try { items.push(...(await meta.campaignSpendRange(token, id, since, until, names[id]))); }
    catch (e) {
      if (e.needsLogin) throw e;
      console.error(`[sync] ${names[id] || id} failed:`, e.code, e.message);
      errors.push({ account: names[id] || id, message: (e.code ? `(#${e.code}) ` : '') + e.message });
      if (e.rateLimited) break;
    }
  }
  return { items, errors };
}

// Write one day's campaign rows into the client entries.
async function applyDay(day, items, errors, user, clients) {
  await db.notePages(items.map((it) => it.page), day);
  const plan = buildPlan(items, clients);
  const syncedAt = new Date().toISOString();
  const touched = new Set();
  for (const t of plan.targets) {
    touched.add(t.clientId);
    const c = clients.find((x) => x.id === t.clientId);
    const e = await db.getEntry(day, t.clientId);
    if (t.slots.length) {
      const lives = {};
      t.slots.forEach((sl, i) => {
        const prev = (e.lives || {})['l' + (i + 1)] || {};
        lives['l' + (i + 1)] = { ...prev, spend: sl.spend, on: true, campaigns: sl.count, time: sl.start != null ? hhmm(sl.start) : prev.time || '' };
      });
      // Clear spend on slots Meta no longer reports.
      for (const k of Object.keys(e.lives || {})) if (!lives[k]) lives[k] = { ...e.lives[k], spend: 0, campaigns: 0 };
      e.lives = lives;
      e.liveCount = Math.max(e.liveCount ?? c.lives ?? 2, t.slots.length);
    }
    if (t.post) e.post = { ...(e.post || {}), spend: t.post.spend, on: true, campaigns: t.post.count };
    e.syncedAt = syncedAt;
    await db.putEntry(day, t.clientId, e);
  }
  await db.putDayMeta(day, user.name || user.fb_id, { unmatched: plan.unmatched, errors });
  return { day, matched: plan.targets.length, unmatched: plan.unmatched, errors, campaigns: items.length };
}

async function syncDay(day, user) {
  const { items, errors } = await fetchRange(day, day, user);
  return applyDay(day, items, errors, user, await db.listClients());
}

// Backfill several days with one API call per account (Meta allows up to ~37 months back).
async function syncRange(since, until, user) {
  const { items, errors } = await fetchRange(since, until, user);
  const clients = await db.listClients();
  const byDay = {};
  for (const it of items) (byDay[it.day] = byDay[it.day] || []).push(it);
  const results = [];
  for (let d = since; d <= until; d = addDays(d, 1)) results.push(await applyDay(d, byDay[d] || [], errors, user, clients));
  return {
    days: results.length,
    campaigns: items.length,
    matched: results.reduce((s, r) => s + r.matched, 0),
    daysWithSpend: results.filter((r) => r.campaigns).length,
    errors,
  };
}

async function buildReport(day) {
  const clients = (await db.listClients()).filter((c) => !c.archived);
  const { entries, meta: m } = await db.getDay(day);
  const nice = new Date(day + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const lines = [`📊 Boost report — ${nice}`, ''];
  let T = 0, B = 0;
  for (const c of clients) {
    const e = entries[c.id] || {};
    const s = entryStats(c, e);
    if (!s.spend && !s.done) continue;
    T += s.spend; B += c.budget;
    const over = c.budget && s.spend > c.budget + 0.009 ? `  ⚠️ over ${money(s.spend - c.budget)}` : '';
    lines.push(`• ${c.name}: ${money(s.spend)} / ${money(c.budget)}${over}`);
    const parts = [];
    if (hasPost(c)) parts.push(`Post ${money((e.post || {}).spend)}`);
    s.lives.forEach((l, i) => { if (l.spend || l.on) parts.push(`L${i + 1}${l.time ? ' (' + l.time + ')' : ''} ${money(l.spend)}`); });
    if (parts.length) lines.push('   ' + parts.join(' · '));
    if (e.note) lines.push('   📝 ' + e.note);
  }
  if (lines.length === 2) lines.push('No boost spend recorded.');
  lines.push('', `Total: ${money(T)} / ${money(B)}`);
  const un = m?.unmatched?.unmatched || [];
  if (un.length) lines.push(`Not matched to a client: ${money(un.reduce((s, u) => s + u.spend, 0))}`);
  return lines.join('\n');
}

module.exports = { buildPlan, entryStats, syncDay, syncRange, addDays, refreshAccounts, buildReport, todayIn, hhmm, tokenFor, campaignPrefix };
