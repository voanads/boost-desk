// 🩺 Ad Doctor: for one client, which ads are weak over the last days, why (from Meta's own numbers), and how to fix them.
//   1. gather(): every ad behind the client's campaigns, straight from Meta (src/meta.js adDiagnostics) — read-only.
//   2. diagnose(): pure rules, no AI — each weak ad gets the reasons and a first fix, compared with the client's OWN ads
//      of the same result type (messages are compared with messages, ThruPlays with ThruPlays).
//   3. advice(): the AI (src/ai.js adDoctorAI) reads the weak ads next to the client's best ones, pictures included, and
//      writes what to change. Counts as one AI request.
// Nothing about the client's customers is read or sent. Nothing in Ads Manager is changed.
const db = require('./db');
const sync = require('./sync');
const meta = require('./meta');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const median = (xs) => { const a = xs.filter((x) => Number.isFinite(x)).sort((x, y) => x - y); if (!a.length) return null; const m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const MIN_SPEND = 1, NO_RESULT_SPEND = 5, MIN_IMPR = 1000, FREQ_HIGH = 3.5;

// What to tell the PM for each reason (Khmer, short, something to do now).
const FIX = {
  noresult: 'ចំណាយហើយ តែគ្មានលទ្ធផល — ផ្អាក ad នេះ ហើយដាក់លុយទៅ ad ដែលដើរល្អ ឬប្ដូររូប + caption ថ្មី។',
  cpr: 'ថ្លៃក្នុងមួយលទ្ធផល ខ្ពស់ជាង ad ផ្សេងរបស់ភ្ញៀវ — ប្រៀបធៀបរូប/caption ជាមួយ ad ល្អបំផុត ហើយសាក audience ផ្សេង។',
  freq: 'មនុស្សដដែលឃើញ ad ច្រើនដងពេក (audience ហត់) — ប្ដូររូប/វីដេអូថ្មី ឬពង្រីក audience (ទីតាំង អាយុ)។',
  ctr: 'មនុស្សឃើញ តែមិនសូវចុច/ចាប់អារម្មណ៍ — រូបដំបូង ឬ ៣ វិនាទីដំបូងមិនទាក់ទាញ; ដាក់តម្លៃ/promotion ឲ្យច្បាស់លើរូប។',
  cpm: 'ថ្លៃបង្ហាញ (CPM) ខ្ពស់ — audience តូចពេក ឬប្រកួតច្រើន; ពង្រីក audience ឬប្ដូរម៉ោង/ថ្ងៃ Boost។',
};
const TITLE = { noresult: 'គ្មានលទ្ធផល', cpr: 'ថ្លៃក្នុងមួយលទ្ធផលខ្ពស់', freq: 'Frequency ខ្ពស់', ctr: 'CTR ទាប', cpm: 'CPM ខ្ពស់' };

function diagnose(ads) {
  const list = (ads || []).filter((a) => a.spend >= MIN_SPEND).map((a) => ({ ...a, cpr: a.results > 0 ? r2(a.spend / a.results) : null }));
  // the client's own yardstick, per result type
  const byType = {};
  for (const a of list) { if (!a.results) continue; const t = byType[a.resultType] || (byType[a.resultType] = { spend: 0, results: 0 }); t.spend += a.spend; t.results += a.results; }
  const avgCpr = Object.fromEntries(Object.entries(byType).map(([k, t]) => [k, t.results ? t.spend / t.results : null]));
  const big = list.filter((a) => a.impressions >= MIN_IMPR), medCtr = median(big.map((a) => a.ctr)), medCpm = median(big.map((a) => a.cpm));
  for (const a of list) {
    const f = [], avg = avgCpr[a.resultType];
    if (!a.results && a.spend >= NO_RESULT_SPEND) f.push({ kind: 'noresult', level: 'bad', detail: `$${r2(a.spend)} · 0 លទ្ធផល` });
    if (a.cpr != null && avg && a.cpr >= avg * 1.5 && list.filter((x) => x.resultType === a.resultType && x.results).length > 1) f.push({ kind: 'cpr', level: a.cpr >= avg * 2 ? 'bad' : 'warn', detail: `$${a.cpr} ធៀបនឹងមធ្យម $${r2(avg)} (${a.resultType})` });
    if (a.frequency >= FREQ_HIGH) f.push({ kind: 'freq', level: 'warn', detail: `${a.frequency.toFixed(1)} ដង/នាក់` });
    if (a.impressions >= MIN_IMPR && medCtr && a.ctr < medCtr * 0.6 && big.length > 1) f.push({ kind: 'ctr', level: 'warn', detail: `${a.ctr.toFixed(2)}% ធៀបនឹង ${medCtr.toFixed(2)}%` });
    if (a.impressions >= MIN_IMPR && medCpm && a.cpm >= medCpm * 1.6 && big.length > 1) f.push({ kind: 'cpm', level: 'warn', detail: `$${a.cpm.toFixed(2)} ធៀបនឹង $${medCpm.toFixed(2)}` });
    a.flags = f.map((x) => ({ ...x, title: TITLE[x.kind], fix: FIX[x.kind] }));
    a.level = f.some((x) => x.level === 'bad') ? 'bad' : f.length ? 'warn' : 'ok';
  }
  const rank = { bad: 0, warn: 1, ok: 2 };
  list.sort((a, b) => rank[a.level] - rank[b.level] || b.spend - a.spend);
  // the client's best ads: enough results, cheapest per result within their type
  const best = list.filter((a) => a.level === 'ok' && a.results >= 3 && a.cpr != null && avgCpr[a.resultType] && a.cpr <= avgCpr[a.resultType]).sort((a, b) => a.cpr / avgCpr[a.resultType] - b.cpr / avgCpr[b.resultType]).slice(0, 3).map((a) => a.adId);
  const spend = r2(list.reduce((t, a) => t + a.spend, 0)), weak = list.filter((a) => a.level !== 'ok');
  return { ads: list, best, totals: { ads: list.length, spend, weak: weak.length, weakSpend: r2(weak.reduce((t, a) => t + a.spend, 0)), avgCpr: Object.fromEntries(Object.entries(avgCpr).map(([k, v]) => [k, r2(v)])), medCtr: medCtr != null ? r2(medCtr) : null, medCpm: medCpm != null ? r2(medCpm) : null } };
}

// ---- read from Meta (cached 20 minutes per client and period) ----
const cache = new Map();
async function gather(user, clientId, days = 7, fresh = false) {
  const today = sync.todayIn(), from = sync.addDays(today, -(Math.min(Math.max(Number(days) || 7, 1), 30) - 1));
  const k = `${user.fb_id}|${clientId}|${from}|${today}`, hit = cache.get(k);
  if (!fresh && hit && Date.now() - hit.at < 20 * 60e3) return hit.v;
  const { client, byAccount } = await require('./reportImage').clientCampaigns(user.fb_id, clientId, from, today);
  if (!client) { const e = new Error('Client not found.'); e.status = 404; throw e; }
  const pick = await sync.tokenPicker(user), ads = [], skipped = [];
  for (const [act, ids] of Object.entries(byAccount)) {
    try { ads.push(...await meta.adDiagnostics(pick(act), act, [...ids], from, today)); }
    catch (e) { if (e.needsLogin || e.rateLimited) throw e; skipped.push(String(act).replace(/^act_/, '')); }
  }
  const v = { client: { id: client.id, name: client.name, type: client.type }, from, to: today, skipped, ...diagnose(ads) };
  cache.set(k, { at: Date.now(), v }); if (cache.size > 200) cache.delete(cache.keys().next().value);
  return v;
}

// ---- AI advice on top ----
async function fetchImage(url) {
  if (!url) return null;
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 5000);
    const res = await fetch(url, { signal: ctl.signal }); clearTimeout(t);
    const type = (res.headers.get('content-type') || '').split(';')[0];
    if (!res.ok || !/^image\/(jpeg|png|webp|gif)$/.test(type)) return null;
    const buf = Buffer.from(await res.arrayBuffer()); if (buf.length > 4.5e6) return null;
    return { media_type: type, data: buf.toString('base64') };
  } catch (_) { return null; }
}
const slim = (a) => ({ ad: a.name, campaign: a.campaign, format: a.format, spend: a.spend, results: a.results, resultType: a.resultType, costPerResult: a.cpr, ctr: r2(a.ctr), cpm: r2(a.cpm), frequency: r2(a.frequency), reach: a.reach, comments: a.comments, messages: a.messages, text: a.text, audience: a.targeting, problems: (a.flags || []).map((f) => `${f.title}: ${f.detail}`) });
async function advice(user, clientId, { days = 7, lang = 'km', fresh = false } = {}) {
  const d = await gather(user, clientId, days);
  const weak = d.ads.filter((a) => a.level !== 'ok').slice(0, 5), best = d.ads.filter((a) => d.best.includes(a.adId));
  if (!weak.length) return { text: lang === 'km' ? `✅ Ads របស់ ${d.client.name} ក្នុង ${days} ថ្ងៃចុងក្រោយ មិនមានបញ្ហាធំទេ — គ្មាន ad ណាដែលថ្លៃ ឬគ្មានលទ្ធផលខុសធម្មតា។` : `✅ No weak ad for ${d.client.name} in the last ${days} days.`, noAi: true };
  // pictures: the weak ads first, then the best ones to compare with (at most 6)
  const pics = [];
  for (const a of [...weak.slice(0, 4), ...best.slice(0, 2)]) { const img = await fetchImage(a.image || a.thumb); if (img) pics.push({ label: `${weak.includes(a) ? 'WEAK' : 'BEST'} ad "${a.name}"`, ...img }); }
  const payload = { client: { name: d.client.name, pageProfile: await require('./pageProfile').forClient(user.fb_id, clientId) }, clientType: d.client.type, period: `${d.from} to ${d.to}`, totals: d.totals, weakAds: weak.map(slim), bestAds: best.map(slim) };
  return require('./ai').adDoctorAI(user.fb_id, payload, pics, { lang, fresh });
}

module.exports = { diagnose, gather, advice, FIX, TITLE };
