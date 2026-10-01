// Minimal client for Meta's Graph / Marketing API.
const crypto = require('crypto');
const cfg = require('./config');

const GRAPH = `https://graph.facebook.com/${cfg.graphVersion}`;

class MetaError extends Error {
  constructor(message, { code, needsLogin, rateLimited, status } = {}) {
    super(message);
    this.code = code; this.needsLogin = !!needsLogin; this.rateLimited = !!rateLimited; this.status = status;
  }
}

const proof = (token) => crypto.createHmac('sha256', cfg.fbAppSecret).update(token).digest('hex');

async function get(pathOrUrl, params = {}, token) {
  const url = new URL(pathOrUrl.startsWith('http') ? pathOrUrl : GRAPH + pathOrUrl);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  if (token && !url.searchParams.has('access_token')) {
    url.searchParams.set('access_token', token);
    url.searchParams.set('appsecret_proof', proof(token));
  }
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    const e = body.error || {};
    const code = e.code;
    throw new MetaError(e.error_user_msg || e.message || `Meta API error (HTTP ${res.status})`, {
      code, status: res.status,
      needsLogin: code === 190 || code === 102 || e.type === 'OAuthException' && res.status === 401,
      rateLimited: [4, 17, 32, 613, 80000, 80003, 80004].includes(code),
    });
  }
  return body;
}

// Follow paging.next until done (with a safety cap).
async function getAll(path, params, token, cap = 50) {
  const out = [];
  let body = await get(path, params, token);
  for (let i = 0; ; i++) {
    out.push(...(body.data || []));
    const next = body.paging && body.paging.next;
    if (!next || i >= cap) break;
    const u = new URL(next); u.searchParams.delete('access_token'); u.searchParams.delete('appsecret_proof');
    body = await get(u.toString(), {}, token); // re-attach token + proof on every page
  }
  return out;
}

// ---- OAuth ----
function loginUrl(state) {
  // Same shape as the link Facebook accepted in testing: client_id, redirect_uri, response_type, scope, state.
  // (config_id is not used — Facebook rejected every link that carried it for this app.)
  const q = [
    ['client_id', cfg.fbAppId],
    ['redirect_uri', `${cfg.baseUrl}/auth/facebook/callback`],
    ['response_type', 'code'],
    ['scope', 'ads_read,business_management'],
    ['state', state],
  ].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&').replace('ads_read%2Cbusiness_management', 'ads_read,business_management');
  return `https://www.facebook.com/${cfg.graphVersion}/dialog/oauth?${q}`;
}

async function exchangeCode(code) {
  const short = await get('/oauth/access_token', {
    client_id: cfg.fbAppId, client_secret: cfg.fbAppSecret,
    redirect_uri: `${cfg.baseUrl}/auth/facebook/callback`, code,
  });
  // Swap for a long-lived token (~60 days).
  const long = await get('/oauth/access_token', {
    grant_type: 'fb_exchange_token', client_id: cfg.fbAppId, client_secret: cfg.fbAppSecret,
    fb_exchange_token: short.access_token,
  });
  const expires = long.expires_in ? new Date(Date.now() + long.expires_in * 1000) : null;
  return { token: long.access_token || short.access_token, expires };
}

const me = (token) => get('/me', { fields: 'id,name' }, token);

// ---- Ad accounts ----
const STATUS = {
  1: 'Active', 2: 'Disabled', 3: 'Unsettled', 7: 'Pending risk review', 8: 'Pending settlement',
  9: 'In grace period', 100: 'Pending closure', 101: 'Closed', 201: 'Active', 202: 'Closed',
};
const DISABLE_REASON = {
  0: '', 1: 'Ads integrity policy', 2: 'Ads IP review', 3: 'Risk payment', 4: 'Gray account shut down',
  5: 'Ads AFC review', 6: 'Business integrity RAR', 7: 'Permanent close', 8: 'Unused reseller account',
  9: 'Unused account', 10: 'Umbrella ad account', 11: 'Business manager integrity policy',
  12: 'Misrepresented ad account', 13: 'AOAB deshare legal entity', 14: 'CTX thread review',
  15: 'Compromised ad account',
};

async function adAccounts(token) {
  const rows = await getAll('/me/adaccounts', {
    fields: 'id,name,account_status,disable_reason,balance,amount_spent,spend_cap,currency,timezone_name,business{name}',
    limit: 100,
  }, token);
  // balance, amount_spent and spend_cap come in minor units (cents) as strings.
  return rows.map((a) => ({
    id: a.id,
    name: a.name,
    status: STATUS[a.account_status] || `Status ${a.account_status}`,
    statusCode: a.account_status,
    disableReason: DISABLE_REASON[a.disable_reason] ?? '',
    balance: Number(a.balance || 0) / 100,
    amountSpent: Number(a.amount_spent || 0) / 100,
    spendCap: Number(a.spend_cap || 0) / 100,
    currency: a.currency,
    timezone: a.timezone_name,
    business: a.business?.name || '',
  }));
}

async function accountSpend(token, actId, day) {
  const d = await get(`/${actId}/insights`, { fields: 'spend', time_range: { since: day, until: day } }, token);
  return Number(d.data?.[0]?.spend || 0);
}

// Campaign-level spend for one day, with each campaign's start time.
async function campaignSpend(token, actId, day, accountName = '') {
  return campaignSpendRange(token, actId, day, day, accountName);
}

// Every status, so finished / archived / deleted boosts are included (Meta skips them by default).
const CAMPAIGN_STATUSES = ['ACTIVE', 'PAUSED', 'DELETED', 'ARCHIVED', 'IN_PROCESS', 'WITH_ISSUES'];
const AD_STATUSES = ['ACTIVE', 'PAUSED', 'DELETED', 'ARCHIVED', 'PENDING_REVIEW', 'DISAPPROVED', 'PREAPPROVED',
  'PENDING_BILLING_INFO', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED', 'IN_PROCESS', 'WITH_ISSUES'];

// Try with the "all statuses" filter; if Meta rejects that filter, run the plain query instead.
async function allStatuses(path, params, filter, token) {
  try { return await getAll(path, { ...params, filtering: [...(params.filtering || []), filter] }, token); }
  catch (e) {
    if (e.needsLogin || e.rateLimited || e.code !== 100) throw e;
    return getAll(path, params, token);
  }
}

// Total spend of the whole ad account for a period — used to check nothing was missed.
async function accountSpendRange(token, actId, since, until) {
  const d = await get(`/${actId}/insights`, { fields: 'spend', time_range: { since, until } }, token);
  return Number(d.data?.[0]?.spend || 0);
}

// Campaign spend per day over a date range (one API call per account, daily breakdown).
async function campaignSpendRange(token, actId, since, until, accountName = '') {
  const rows = await allStatuses(`/${actId}/insights`, {
    level: 'campaign', fields: 'campaign_id,campaign_name,spend,reach,impressions,actions,video_thruplay_watched_actions',
    time_range: { since, until }, time_increment: 1, limit: 500,
  }, { field: 'campaign.effective_status', operator: 'IN', value: CAMPAIGN_STATUSES }, token);
  const withSpend = rows.filter((r) => Number(r.spend) > 0);
  const ids = [...new Set(withSpend.map((r) => r.campaign_id))];
  const starts = {}, goals = {};
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    // Campaign start times via the account's campaign list (the multi-ID "?ids=" lookup is retired).
    const camps = await allStatuses(`/${actId}/campaigns`, {
      fields: 'id,start_time,created_time,adsets.limit(5){optimization_goal}',
      filtering: [{ field: 'id', operator: 'IN', value: chunk }], limit: 100,
    }, { field: 'effective_status', operator: 'IN', value: CAMPAIGN_STATUSES }, token);
    for (const c of camps) { starts[c.id] = c.start_time || c.created_time || null; goals[c.id] = (c.adsets?.data || []).map((a) => a.optimization_goal).find(Boolean) || ''; }
  }
  const pages = await campaignPages(token, actId, ids);
  return withSpend.map((r) => ({
    day: r.date_start,
    account: accountName || actId, accountId: actId,
    name: r.campaign_name, campaignId: r.campaign_id, spend: Number(r.spend),
    start: parseTime(starts[r.campaign_id]),
    page: pages[r.campaign_id]?.name || '',
    pageId: pages[r.campaign_id]?.id || '',
    creative: pages[r.campaign_id]?.type || '', // PHOTO / VIDEO / SHARE …
    boost: pages[r.campaign_id]?.boost || '', // 'live' when the boosted video was a Facebook live, 'post' otherwise
    ...campaignResult(r, goals[r.campaign_id]),
    ...engagement(r),
  }));
}

// "Result" the way Ads Manager counts it: the action that matches the ad set's optimisation goal.
const RESULT_BY_GOAL = {
  CONVERSATIONS: ['onsite_conversion.messaging_conversation_started_7d', 'message'],
  REPLIES: ['onsite_conversion.messaging_conversation_started_7d', 'message'],
  POST_ENGAGEMENT: ['post_engagement', 'engagement'],
  THRUPLAY: ['@thruplay', 'ThruPlay'],
  VIDEO_VIEWS: ['video_view', 'video view'],
  LINK_CLICKS: ['link_click', 'link click'],
  LANDING_PAGE_VIEWS: ['landing_page_view', 'landing page view'],
  PAGE_LIKES: ['like', 'Page like'],
  LEAD_GENERATION: ['lead', 'lead'],
  QUALITY_LEAD: ['lead', 'lead'],
  OFFSITE_CONVERSIONS: ['offsite_conversion.fb_pixel_purchase', 'purchase'],
  REACH: ['@reach', 'person reached'],
  IMPRESSIONS: ['@impressions', 'impression'],
};
function campaignResult(r, goal) {
  const act = (type) => { const a = (r.actions || []).find((x) => x.action_type === type); return a ? Number(a.value) || 0 : 0; };
  let [type, label] = RESULT_BY_GOAL[goal] || [];
  if (!type) { // unknown goal: fall back to messages, then engagement
    if (act('onsite_conversion.messaging_conversation_started_7d')) [type, label] = RESULT_BY_GOAL.CONVERSATIONS;
    else if (act('post_engagement')) [type, label] = RESULT_BY_GOAL.POST_ENGAGEMENT;
    else return { results: 0, resultType: '' };
  }
  let n = 0;
  if (type === '@thruplay') n = Number((r.video_thruplay_watched_actions || [])[0]?.value || 0);
  else if (type === '@reach') n = Number(r.reach || 0);
  else if (type === '@impressions') n = Number(r.impressions || 0);
  else n = act(type);
  return { results: n, resultType: label };
}

// Comments and message conversations a campaign brought in (Live videos tab).
function engagement(r) {
  const act = (type) => { const a = (r.actions || []).find((x) => x.action_type === type); return a ? Number(a.value) || 0 : 0; };
  return { comments: act('comment'), messages: act('onsite_conversion.messaging_conversation_started_7d') };
}

// How a boost was set up: objective, goal, budget, run time, audience, placements, plus the post it promoted.
// Budgets come in cents. One call per ad account for up to 50 campaigns.
const GENDER = { 1: 'Men', 2: 'Women' };
const cents = (v) => (v == null || v === '' ? null : Number(v) / 100);
function describeTargeting(t = {}) {
  const g = t.geo_locations || {};
  const km = (x) => (x.radius ? ` +${x.radius} ${x.distance_unit === 'mile' ? 'mi' : 'km'}` : '');
  const places = [
    ...(g.cities || []).map((c) => c.name + km(c)),
    ...(g.regions || []).map((r) => r.name),
    ...(g.custom_locations || []).map((c) => (c.name || c.address_string || 'Pin') + km(c)),
    ...(g.zips || []).map((z) => z.name || z.key),
    ...(g.countries || []).map((c) => (c === 'KH' ? 'Cambodia' : c)),
  ];
  const interests = [];
  for (const f of t.flexible_spec || []) for (const k of ['interests', 'behaviors', 'life_events', 'work_positions', 'education_statuses']) for (const x of f[k] || []) interests.push(x.name);
  for (const x of t.interests || []) interests.push(x.name);
  const genders = (t.genders || []).map((x) => GENDER[x]).filter(Boolean);
  const plat = [];
  const fb = { feed: 'Facebook Feed', video_feeds: 'Video feeds', facebook_reels: 'Facebook Reels', story: 'Stories', marketplace: 'Marketplace', search: 'Search', instream_video: 'In-stream videos', right_hand_column: 'Right column' };
  for (const p of t.facebook_positions || []) plat.push(fb[p] || p);
  for (const p of t.instagram_positions || []) plat.push('Instagram ' + p.replace(/_/g, ' '));
  if (!plat.length) for (const p of t.publisher_platforms || []) plat.push(p === 'facebook' ? 'Facebook' : p === 'instagram' ? 'Instagram' : p === 'messenger' ? 'Messenger' : p === 'audience_network' ? 'Audience Network' : p);
  return {
    places: [...new Set(places)], ageMin: t.age_min || null, ageMax: t.age_max || null,
    gender: genders.length === 1 ? genders[0] : 'All', interests: [...new Set(interests)].slice(0, 20),
    placements: plat.length ? [...new Set(plat)] : ['Advantage+ placements'],
    advantage: !!(t.targeting_automation && t.targeting_automation.advantage_audience),
    customAudiences: (t.custom_audiences || []).map((a) => a.name).filter(Boolean),
  };
}
async function campaignSetups(token, actId, campaignIds) {
  const out = {};
  for (let i = 0; i < campaignIds.length; i += 50) {
    const chunk = campaignIds.slice(i, i + 50);
    const camps = await allStatuses(`/${actId}/campaigns`, {
      fields: 'id,name,objective,start_time,stop_time,daily_budget,lifetime_budget,'
        + 'adsets.limit(3){optimization_goal,daily_budget,lifetime_budget,start_time,end_time,targeting},'
        + 'ads.limit(1){creative{thumbnail_url,image_url,title,body,effective_object_story_id}}',
      filtering: [{ field: 'id', operator: 'IN', value: chunk }], limit: 50,
    }, { field: 'effective_status', operator: 'IN', value: CAMPAIGN_STATUSES }, token);
    for (const c of camps) {
      const as = (c.adsets?.data || [])[0] || {};
      const cr = (c.ads?.data || [])[0]?.creative || {};
      const start = as.start_time || c.start_time || null, end = as.end_time || c.stop_time || null;
      out[c.id] = {
        id: c.id, name: c.name, objective: c.objective || '', goal: as.optimization_goal || '',
        lifetimeBudget: cents(as.lifetime_budget ?? c.lifetime_budget), dailyBudget: cents(as.daily_budget ?? c.daily_budget),
        start, end, minutes: start && end ? Math.round((Date.parse(end) - Date.parse(start)) / 60000) : null,
        targeting: describeTargeting(as.targeting),
        thumb: cr.thumbnail_url || cr.image_url || '', text: (cr.body || cr.title || '').slice(0, 200), post: cr.effective_object_story_id || '',
      };
    }
  }
  return out;
}

// Ad-level numbers for a report picture: one row per ad, like the Ads tab in Ads Manager.
async function adInsights(token, actId, campaignIds, since, until) {
  const out = [];
  let reach = 0;
  for (let i = 0; i < campaignIds.length; i += 50) {
    const chunk = campaignIds.slice(i, i + 50);
    const filt = [{ field: 'campaign.id', operator: 'IN', value: chunk }];
    const rows = await allStatuses(`/${actId}/insights`, {
      level: 'ad', fields: 'ad_id,ad_name,campaign_id,spend,impressions,reach,actions,video_thruplay_watched_actions',
      time_range: { since, until }, filtering: filt, limit: 500,
    }, { field: 'ad.effective_status', operator: 'IN', value: AD_STATUSES }, token);
    const goals = {};
    const camps = await allStatuses(`/${actId}/campaigns`, { fields: 'id,adsets.limit(5){optimization_goal}', filtering: [{ field: 'id', operator: 'IN', value: chunk }], limit: 100 },
      { field: 'effective_status', operator: 'IN', value: CAMPAIGN_STATUSES }, token);
    for (const c of camps) goals[c.id] = (c.adsets?.data || []).map((a) => a.optimization_goal).find(Boolean) || '';
    const thumbs = {};
    const adIds = rows.map((r) => r.ad_id).filter(Boolean);
    for (let j = 0; j < adIds.length; j += 50) {
      try {
        const ads = await allStatuses(`/${actId}/ads`, { fields: 'id,creative{thumbnail_url,image_url}', filtering: [{ field: 'id', operator: 'IN', value: adIds.slice(j, j + 50) }], limit: 100 },
          { field: 'effective_status', operator: 'IN', value: AD_STATUSES }, token);
        for (const a of ads) thumbs[a.id] = a.creative?.thumbnail_url || a.creative?.image_url || '';
      } catch (e) { if (e.needsLogin) throw e; }
    }
    for (const r of rows) {
      out.push({
        adId: r.ad_id, name: r.ad_name, campaignId: r.campaign_id, spend: Number(r.spend || 0),
        impressions: Number(r.impressions || 0), reach: Number(r.reach || 0), thumb: thumbs[r.ad_id] || '',
        ...campaignResult(r, goals[r.campaign_id]), ...engagement(r),
      });
    }
    // Reach across these ads without double counting people (like Ads Manager's total row).
    try {
      const t = await get(`/${actId}/insights`, { fields: 'reach', time_range: { since, until }, filtering: filt }, token);
      if (reach !== null) reach += Number(t.data?.[0]?.reach || 0);
    } catch (e) { if (e.needsLogin) throw e; reach = null; }
  }
  return { ads: out, reach };
}

// Was this video a Facebook live? 'live' | 'post' | '' (Meta wouldn't say). Cached for the process.
const videoKindCache = new Map();
async function videoKind(id, token) {
  if (videoKindCache.has(id)) return videoKindCache.get(id);
  let k = '';
  try {
    const v = await get(`/${id}`, { fields: 'live_status' }, token);
    k = v.live_status ? 'live' : (v.id ? 'post' : '');
  } catch (e) {
    if (e.needsLogin || e.rateLimited) throw e;
    // A photo or text post id isn't a video: Meta answers "nonexisting field" for it — that's a post.
    if (/nonexisting field|live_status/i.test(e.message)) k = 'post';
  }
  videoKindCache.set(id, k);
  return k;
}

// Which Facebook Page each campaign promotes, so auto-named "Post: …" boosts can be matched
// to a client by Page. Page names come from the ad account's promoted-Pages list first (works
// even for client Pages you don't manage), then from the Page itself.
const pageNameCache = new Map(); // only successful lookups are cached
async function campaignPages(token, actId, campaignIds) {
  const pageOf = {}, typeOf = {}, videosOf = {};
  if (!campaignIds.length) return pageOf;
  try {
    for (let i = 0; i < campaignIds.length; i += 50) {
      const chunk = campaignIds.slice(i, i + 50);
      const ads = await allStatuses(`/${actId}/ads`, {
        fields: 'campaign_id,creative{actor_id,effective_object_story_id,object_type,video_id,object_story_spec{page_id,video_data{video_id}}},adset{promoted_object{page_id}}',
        filtering: [{ field: 'campaign.id', operator: 'IN', value: chunk }], limit: 500,
      }, { field: 'effective_status', operator: 'IN', value: AD_STATUSES }, token);
      for (const ad of ads) {
        const c = ad.creative || {};
        const pid = ad.adset?.promoted_object?.page_id || c.object_story_spec?.page_id || c.actor_id
          || String(c.effective_object_story_id || '').split('_')[0];
        if (pid && !pageOf[ad.campaign_id]) pageOf[ad.campaign_id] = String(pid);
        if (c.object_type) { const t = typeOf[ad.campaign_id]; typeOf[ad.campaign_id] = !t || t === c.object_type ? c.object_type : (c.object_type === 'VIDEO' || t === 'VIDEO' ? 'VIDEO' : t); }
        // The video behind the ad: its own id, or the second half of the boosted post id (video posts share it).
        const vid = c.video_id || c.object_story_spec?.video_data?.video_id;
        const story = String(c.effective_object_story_id || '').split('_')[1];
        if (vid || story) (videosOf[ad.campaign_id] = videosOf[ad.campaign_id] || new Set()).add(String(vid || story));
      }
    }
  } catch (e) {
    if (e.needsLogin || e.rateLimited) throw e;
    console.error(`[meta] ${actId}: could not read ads for Page lookup:`, e.message);
  }
  let needed = [...new Set(Object.values(pageOf))].filter((p) => !pageNameCache.has(p));
  if (needed.length) { await loadPageDirectory(token); needed = needed.filter((p) => !pageNameCache.has(p)); }
  if (needed.length) {
    try {
      const promoted = await getAll(`/${actId}/promote_pages`, { fields: 'id,name', limit: 200 }, token);
      for (const p of promoted) if (p.name) pageNameCache.set(String(p.id), p.name);
    } catch (e) {
      if (e.needsLogin || e.rateLimited) throw e;
      console.error(`[meta] ${actId}: promote_pages failed:`, e.message);
    }
    for (const p of needed.filter((x) => !pageNameCache.has(x))) {
      try { const n = (await get(`/${p}`, { fields: 'name' }, token)).name; if (n) pageNameCache.set(p, n); }
      catch (e) { if (e.needsLogin || e.rateLimited) throw e; }
    }
  }
  const out = Object.fromEntries(Object.entries(pageOf).map(([cid, pid]) => [cid, { id: pid, name: pageNameCache.get(pid) || '' }]));
  for (const [cid, t] of Object.entries(typeOf)) (out[cid] = out[cid] || { id: '', name: '' }).type = t;
  // Live or post? Ask Meta whether the boosted video was a Facebook live broadcast.
  for (const [cid, set] of Object.entries(videosOf)) {
    if (typeOf[cid] && typeOf[cid] !== 'VIDEO') { (out[cid] = out[cid] || { id: '', name: '' }).boost = 'post'; continue; }
    let kind = '';
    for (const v of set) { const k = await videoKind(v, token); if (k === 'live') { kind = 'live'; break; } if (k === 'post') kind = 'post'; }
    if (kind) (out[cid] = out[cid] || { id: '', name: '' }).boost = kind;
  }
  return out;
}

// IDs of the account's currently active campaigns — one cheap call, used to spot new campaigns.
async function activeCampaignIds(token, actId) {
  const rows = await getAll(`/${actId}/campaigns`, {
    fields: 'id', filtering: [{ field: 'effective_status', operator: 'IN', value: ['ACTIVE', 'IN_PROCESS'] }], limit: 500,
  }, token);
  return rows.map((r) => r.id);
}

// Names of every Page you can see through Business portfolios (owned + client Pages shared
// with the business) and Pages you manage directly. Doesn't need access to the Page itself.
let directoryLoadedAt = 0;
async function loadPageDirectory(token, force = false) {
  if (!force && Date.now() - directoryLoadedAt < 10 * 60 * 1000) return; // at most every 10 min
  directoryLoadedAt = Date.now();
  const add = (list) => { for (const p of list || []) if (p && p.id && p.name) pageNameCache.set(String(p.id), p.name); };
  const soft = async (fn) => { try { return await fn(); } catch (e) { if (e.needsLogin || e.rateLimited) throw e; console.error('[meta] page directory:', e.message); return []; } };
  add(await soft(() => getAll('/me/accounts', { fields: 'id,name', limit: 200 }, token)));
  const businesses = await soft(() => getAll('/me/businesses', { fields: 'id,name', limit: 100 }, token));
  for (const b of businesses) {
    add(await soft(() => getAll(`/${b.id}/owned_pages`, { fields: 'id,name', limit: 200 }, token)));
    add(await soft(() => getAll(`/${b.id}/client_pages`, { fields: 'id,name', limit: 200 }, token)));
  }
}
const knownPageNames = () => Object.fromEntries(pageNameCache);
const rememberPageNames = (map, force = false) => { for (const [id, n] of Object.entries(map || {})) if (n && (force || !pageNameCache.has(id))) pageNameCache.set(id, n); };

// Graph returns "2026-09-29T13:28:04+0700"; add the colon so Date.parse is reliable.
function parseTime(s) {
  if (!s) return null;
  const t = Date.parse(String(s).replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isNaN(t) ? null : t;
}

module.exports = { videoKind, adInsights, campaignSetups, describeTargeting, campaignResult, activeCampaignIds, loadPageDirectory, knownPageNames, rememberPageNames, MetaError, loginUrl, exchangeCode, me, adAccounts, accountSpend, accountSpendRange, campaignSpend, campaignSpendRange };
