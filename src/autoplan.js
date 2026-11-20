// Auto Boost plan (owner, 20 Nov 2026): a post campaign that is spending today, belongs to a client and is in no plan yet
// is added to that client's Boost plan by itself, so the team does not type it. The budget and the days come from the
// campaign on Meta (lifetime budget, or daily budget with an end date); if Meta does not give them, from the numbers in the
// campaign name ("50$ 5 Day"). A campaign with neither stays in "Found on Meta" for a person to add.
// A line added here carries `auto`; removing it from a plan puts its campaign in plan.noAuto so it is not added again.
const db = require('./db');
const sync = require('./sync');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const log = (...a) => console.log(new Date().toISOString(), '[autoplan]', ...a);

// "Phos Love 15$ 5 Day 5" → { total: 15, days: 5 } · "3 Day 15$" → { total: 15, days: 3 }
function fromName(name) {
  const s = String(name || '');
  const d = s.match(/(\d{1,3})\s*days?(?![a-z])/i), m = s.match(/(\d+(?:\.\d+)?)\s*\$/) || s.match(/\$\s*(\d+(?:\.\d+)?)/);
  const days = d ? Number(d[1]) : null, total = m ? Number(m[1]) : null;
  return { days: days >= 1 && days <= 365 ? days : null, total: total > 0 && total <= 1e5 ? total : null };
}

// The plan line for one campaign, or null when the budget or the number of days is not known.
// The line starts TODAY (the day it is added) and runs to the campaign's end on Meta: a plan's spend is counted for the whole
// client since the plan's first day, so a start in the past would count other, older posts against this budget.
function lineFor(cand, setup, usd, today) {
  const n = fromName(cand.name), s = usd && setup ? setup : {};
  const total = s.start && s.end ? Math.max(1, Math.ceil((Date.parse(s.end) - Date.parse(s.start)) / 864e5 - 0.02)) : null; // the campaign's whole run
  const left = s.end ? Math.max(1, Math.round((Date.parse(sync.todayIn(undefined, new Date(s.end))) - Date.parse(today)) / 864e5) + 1) : null; // days from today to its end
  let daily = null, days = null, how = '';
  if (s.dailyBudget > 0 && left) { daily = s.dailyBudget; days = left; how = 'meta'; }
  else if (s.lifetimeBudget > 0 && total) { daily = s.lifetimeBudget / total; days = left; how = 'meta'; }
  else if (n.total && n.days) { daily = n.total / n.days; days = left || n.days; how = 'name'; }
  if (!(daily > 0) || !days || days > 365) return null;
  return { post: String(cand.name || 'Post').slice(0, 160), link: '', img: '', extra: [], daily: round2(daily), days, start: today,
    account: cand.account || '', accountName: String(cand.accountName || '').slice(0, 120), sent: '', camp: cand.camp, auto: how };
}

// One-off for the lines added on 20 Nov before the rule above: a start in the past becomes today, the end date stays.
async function fixPastStarts() {
  const today = sync.todayIn(); let n = 0;
  for (const u of await db.allUsers()) for (const c of await db.listClients(u.fb_id)) {
    const lines = (c.plan && c.plan.lines) || []; if (!lines.some((l) => l.auto && l.start && l.start < today)) continue;
    const next = lines.map((l) => { if (!l.auto || !l.start || l.start >= today) return l; const end = sync.addDays(l.start, Math.max(1, Number(l.days) || 1) - 1); n++; return { ...l, start: today, days: Math.max(1, Math.round((Date.parse(end) - Date.parse(today)) / 864e5) + 1) }; });
    await db.updateClient(u.fb_id, c.id, { plan: { ...c.plan, lines: next } });
  }
  return n;
}

// Today's post campaigns with spend that belong to a client and are in no current plan.
async function candidates(owner, today) {
  const raw = {}; for (const r of (await db.getRaw(owner, today)) || []) if (r.campaignId) raw[String(r.campaignId)] = r;
  const all = (await db.listClients(owner)).filter((x) => !x.archived);
  const linked = new Set(all.flatMap((c) => ((c.plan && c.plan.lines) || []).map((l) => l.camp).filter(Boolean)));
  const out = [];
  for (const c of all) {
    const skip = new Set(((c.plan && c.plan.noAuto) || []).map(String));
    const e = await db.getEntry(today, c.id);
    for (const id of ((e && e.post && e.post.ids) || []).map(String)) {
      const r = raw[id]; if (!r || linked.has(id) || skip.has(id) || !(Number(r.spend) > 0)) continue;
      linked.add(id); out.push({ client: c, camp: id, name: r.name || '', account: r.accountId || '', accountName: r.account || '' });
    }
  }
  return out;
}

async function run(user) {
  const owner = user.fb_id, today = sync.todayIn();
  const cands = await candidates(owner, today); if (!cands.length) return 0;
  let setups = {};
  try { setups = await require('./lives').setupsFor(user, cands.map((c) => ({ id: c.camp, accountId: c.account }))); } catch (e) { log(`${user.name}: Meta setup lookup failed (${e.message}) — using campaign names only`); }
  const usd = new Map((await db.listAccounts(owner)).map((a) => [a.id, ((a.info || {}).currency || a.currency || '') === 'USD']));
  const byClient = new Map(); let added = 0, left = 0;
  for (const c of cands) {
    const l = lineFor(c, setups[c.camp], usd.get(c.account) === true, today);
    if (!l) { left++; continue; }
    if (!byClient.has(c.client.id)) byClient.set(c.client.id, []);
    byClient.get(c.client.id).push(l);
  }
  for (const [id, lines] of byClient) {
    // read the plan again right before writing, so a plan a person saved a moment ago is not overwritten
    const c = (await db.listClients(owner)).find((x) => x.id === id); if (!c) continue;
    const plan = c.plan || {}, cur = plan.lines || [], have = new Set(cur.map((l) => l.camp).filter(Boolean));
    const add = lines.filter((l) => !have.has(l.camp)).slice(0, Math.max(0, 30 - cur.length)); if (!add.length) continue;
    await db.updateClient(owner, id, { plan: { ...plan, lines: [...cur, ...add], sentAt: plan.sentAt || null } });
    added += add.length; log(`${user.name}: ${c.name} +${add.length} (${add.map((l) => `${l.post} $${l.daily}×${l.days} [${l.auto}]`).join('; ')})`);
  }
  if (added) log(`${user.name}: added ${added}, left for a person ${left}`);
  return added;
}

module.exports = { run, fromName, lineFor, fixPastStarts };
