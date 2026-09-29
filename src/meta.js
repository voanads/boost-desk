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

// Campaign spend per day over a date range (one API call per account, daily breakdown).
async function campaignSpendRange(token, actId, since, until, accountName = '') {
  const rows = await getAll(`/${actId}/insights`, {
    level: 'campaign', fields: 'campaign_id,campaign_name,spend',
    time_range: { since, until }, time_increment: 1, limit: 500,
  }, token);
  const withSpend = rows.filter((r) => Number(r.spend) > 0);
  const ids = [...new Set(withSpend.map((r) => r.campaign_id))];
  const starts = {};
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    // Campaign start times via the account's campaign list (the multi-ID "?ids=" lookup is retired).
    const camps = await getAll(`/${actId}/campaigns`, {
      fields: 'id,start_time,created_time',
      filtering: [{ field: 'id', operator: 'IN', value: chunk }], limit: 100,
    }, token);
    for (const c of camps) starts[c.id] = c.start_time || c.created_time || null;
  }
  const pages = await campaignPages(token, actId, ids);
  return withSpend.map((r) => ({
    day: r.date_start,
    account: accountName || actId, accountId: actId,
    name: r.campaign_name, spend: Number(r.spend),
    start: parseTime(starts[r.campaign_id]),
    page: pages[r.campaign_id] || '',
  }));
}

// Which Facebook Page each campaign promotes (so auto-named "Post: …" boosts can be matched
// to a client by Page). Uses the ad creative's actor / post ID; page names are cached.
const pageNameCache = new Map();
async function campaignPages(token, actId, campaignIds) {
  const pageOf = {};
  try {
    for (let i = 0; i < campaignIds.length; i += 50) {
      const chunk = campaignIds.slice(i, i + 50);
      const ads = await getAll(`/${actId}/ads`, {
        fields: 'campaign_id,creative{actor_id,effective_object_story_id}',
        filtering: [{ field: 'campaign.id', operator: 'IN', value: chunk }], limit: 500,
      }, token);
      for (const ad of ads) {
        const c = ad.creative || {};
        const pid = c.actor_id || String(c.effective_object_story_id || '').split('_')[0];
        if (pid && !pageOf[ad.campaign_id]) pageOf[ad.campaign_id] = pid;
      }
    }
    const missing = [...new Set(Object.values(pageOf))].filter((p) => !pageNameCache.has(p));
    // Page names one by one (cached for the life of the server).
    for (const p of missing) {
      try { pageNameCache.set(p, (await get(`/${p}`, { fields: 'name' }, token)).name || ''); }
      catch (e) { if (e.needsLogin || e.rateLimited) throw e; pageNameCache.set(p, ''); }
    }
  } catch (e) {
    if (e.needsLogin || e.rateLimited) throw e;
    return {}; // Page lookup is a bonus; spend still syncs without it.
  }
  return Object.fromEntries(Object.entries(pageOf).map(([cid, pid]) => [cid, pageNameCache.get(pid) || '']));
}

// Graph returns "2026-09-29T13:28:04+0700"; add the colon so Date.parse is reliable.
function parseTime(s) {
  if (!s) return null;
  const t = Date.parse(String(s).replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isNaN(t) ? null : t;
}

module.exports = { MetaError, loginUrl, exchangeCode, me, adAccounts, accountSpend, campaignSpend, campaignSpendRange };
