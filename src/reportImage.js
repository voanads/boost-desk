// Report picture: a table of the client's ads for the period (results, cost per result, spend,
// impressions, reach, messages), drawn as SVG and turned into a PNG to send with the Telegram report.
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');
const { svgText, fit } = require('./textpath');
const db = require('./db');
const meta = require('./meta');
const sync = require('./sync');

const FONTS = ['Inter_400Regular.ttf', 'Inter_600SemiBold.ttf', 'NotoSansKhmer_400Regular.ttf', 'NotoSansKhmer_600SemiBold.ttf']
  .map((f) => path.join(__dirname, '..', 'fonts', f));

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const money = (n) => '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const int = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');
const cut = (s, n) => { const a = [...String(s || '')]; return a.length > n ? a.slice(0, n - 1).join('') + '…' : a.join(''); };
const plural = (n, t) => (n === 1 ? t : t === 'person reached' ? 'people reached' : t + 's');

// The client's campaigns in the period (from saved sync rows), grouped by ad account.
async function clientCampaigns(owner, clientId, from, to, kind = '', only = null) {
  const c = (await db.listClients(owner)).find((x) => x.id === Number(clientId));
  if (!c) return { client: null, byAccount: {} };
  const all = (await db.listRaw(owner, from, to)).flatMap((d) => (d.rows || []).map((r) => ({ ...r, day: r.day || d.day })));
  const clients = await sync.clientsWithLearnedPages(owner, all, { save: false });
  const byAccount = {};
  for (const r of all) {
    if (!(Number(r.spend) > 0) || !r.campaignId || !r.accountId) continue;
    const m = sync.matchClient(r, clients);
    if (!m || m.id !== c.id) continue;
    if (kind && (sync.isPostFor(c, r) ? 'post' : 'live') !== kind) continue; // Live / Post filter
    if (only && !only.has(String(r.campaignId))) continue; // only the ticked lives / posts
    (byAccount[r.accountId] = byAccount[r.accountId] || new Set()).add(String(r.campaignId));
  }
  return { client: c, byAccount };
}

async function fetchThumb(url) {
  if (!url) return '';
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 4000);
    const res = await fetch(url, { signal: ctl.signal }); clearTimeout(t);
    if (!res.ok) return '';
    const type = res.headers.get('content-type') || 'image/jpeg';
    if (!/^image\/(jpeg|png|webp|gif)/.test(type)) return '';
    return `data:${type};base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}`;
  } catch (_) { return ''; }
}

// Ads for one client and period, straight from Meta.
async function clientAds(user, clientId, from, to, kind = '', parts = null) {
  // Ticked lines (one-day reports): keep only the campaigns behind those lives / the post.
  let only = null;
  if (parts && parts.length && from === to) {
    const e = await db.getEntry(from, Number(clientId));
    only = new Set();
    for (const k of parts) for (const id of (k === 'post' ? (e.post || {}).ids : ((e.lives || {})[k] || {}).ids) || []) only.add(String(id));
    if (!only.size) return { client: (await db.listClients(user.fb_id)).find((x) => x.id === Number(clientId)), ads: [], reach: 0 }; // campaign list not saved for this day: no picture rather than a wrong one
  }
  const { client, byAccount } = await clientCampaigns(user.fb_id, clientId, from, to, kind, only);
  if (!client) { const e = new Error('Client not found.'); e.status = 404; throw e; }
  const token = await sync.tokenFor(user);
  const ads = []; let reach = 0;
  for (const [act, ids] of Object.entries(byAccount)) {
    const r = await meta.adInsights(token, act, [...ids], from, to);
    ads.push(...r.ads.filter((a) => a.spend > 0 || a.impressions > 0));
    reach = reach === null || r.reach === null ? null : reach + r.reach;
  }
  ads.sort((a, b) => b.spend - a.spend);
  return { client, ads, reach };
}

function periodTitle(from, to) {
  const d = (x, o) => new Date(x + 'T12:00:00Z').toLocaleDateString('en-GB', { timeZone: 'UTC', ...o });
  if (from === to) return d(from, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  return d(from, { day: 'numeric', month: 'short' }) + ' – ' + d(to, { day: 'numeric', month: 'short', year: 'numeric' });
}

// Draw the table. Up to 12 ads are listed; the total row always covers every ad.
async function render({ client, ads, reach }, from, to) {
  const shown = ads.slice(0, 12), more = ads.length - shown.length;
  const thumbs = await Promise.all(shown.map((a) => fetchThumb(a.thumb)));
  const W = 1200, pad = 28, headH = 96, colH = 46, rowH = 64, totH = 62, footH = more > 0 ? 34 : 14;
  const H = headH + colH + shown.length * rowH + totH + footH + pad;
  const cols = [
    { k: 'ad', label: 'Ad', x: pad + 16, w: 380, align: 'start' },
    { k: 'res', label: 'Results', x: 590, align: 'end' },
    { k: 'cpr', label: 'Cost per result', x: 720, align: 'end' },
    { k: 'spend', label: 'Amount spent', x: 850, align: 'end' },
    { k: 'imp', label: 'Impressions', x: 965, align: 'end' },
    { k: 'reach', label: 'Reach', x: 1060, align: 'end' },
    { k: 'msg', label: 'Messages', x: W - pad - 16, align: 'end' },
  ];
  const tot = ads.reduce((t, a) => ({ spend: t.spend + a.spend, imp: t.imp + a.impressions, msg: t.msg + (a.messages || 0), res: t.res + (a.results || 0), type: !a.results ? t.type : !t.type || t.type === a.resultType ? a.resultType : 'result' }), { spend: 0, imp: 0, msg: 0, res: 0, type: '' });
  const txt = (x, y, s, { size = 17, weight = 400, fill = '#1c1e21', anchor = 'start' } = {}) => svgText(s, x, y, { size, weight, fill, anchor });
  const names = await Promise.all(shown.map((a) => fit(a.name, 400, 16, 600)));
  const title = await fit(client.name, 620, 22, 600);
  let y = headH;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7C5CFF"/><stop offset="1" stop-color="#5B45F0"/></linearGradient>
  ${shown.map((_, i) => `<clipPath id="c${i}"><rect x="${pad + 16}" y="${headH + colH + i * rowH + 10}" width="44" height="44" rx="8"/></clipPath>`).join('')}</defs>
  <rect width="${W}" height="${H}" fill="#f0f2f5"/>
  <rect x="${pad / 2}" y="${pad / 2}" width="${W - pad}" height="${H - pad}" rx="18" fill="#ffffff"/>
  <rect x="${pad + 4}" y="${pad + 6}" width="44" height="44" rx="12" fill="url(#g)"/>
  ${await txt(pad + 26, pad + 36, 'A', { size: 22, weight: 600, fill: '#fff', anchor: 'middle' })}
  ${await txt(pad + 62, pad + 26, title, { size: 22, weight: 600 })}
  ${await txt(pad + 62, pad + 50, `Ads · ${periodTitle(from, to)}`, { size: 15, fill: '#65676b' })}
  ${await txt(W - pad - 16, pad + 26, 'Ads Box', { size: 16, weight: 600, fill: '#5B45F0', anchor: 'end' })}
  ${await txt(W - pad - 16, pad + 48, `${ads.length} ad${ads.length === 1 ? '' : 's'}`, { size: 14, fill: '#65676b', anchor: 'end' })}
  <rect x="${pad}" y="${y}" width="${W - 2 * pad}" height="${colH}" fill="#f5f6f7"/>
  <line x1="${pad}" y1="${y + colH}" x2="${W - pad}" y2="${y + colH}" stroke="#dadde1"/>
  ${(await Promise.all(cols.map((c) => txt(c.x, y + 29, c.label, { size: 14, weight: 600, fill: '#444950', anchor: c.align })))).join('')}`;
  y += colH;
  for (const [i, a] of shown.entries()) {
    const cpr = a.results > 0 ? a.spend / a.results : null;
    if (i % 2) svg += `<rect x="${pad}" y="${y}" width="${W - 2 * pad}" height="${rowH}" fill="#fafbfc"/>`;
    svg += thumbs[i]
      ? `<image x="${pad + 16}" y="${y + 10}" width="44" height="44" preserveAspectRatio="xMidYMid slice" clip-path="url(#c${i})" href="${thumbs[i]}" xlink:href="${thumbs[i]}"/>`
      : `<rect x="${pad + 16}" y="${y + 10}" width="44" height="44" rx="8" fill="#e4e6eb"/>`;
    svg += await txt(pad + 72, y + 30, names[i], { size: 16, weight: 600 });
    svg += await txt(pad + 72, y + 51, a.results > 0 ? plural(a.results, a.resultType) : (a.resultType || 'No results yet'), { size: 13, fill: '#65676b' });
    svg += await txt(cols[1].x, y + 38, a.results > 0 ? int(a.results) : '—', { weight: 600, fill: a.results > 0 ? '#1c1e21' : '#8a8d91', anchor: 'end' });
    svg += await txt(cols[2].x, y + 38, cpr != null ? money(cpr) : '—', { fill: cpr != null ? '#1c1e21' : '#8a8d91', anchor: 'end' });
    svg += await txt(cols[3].x, y + 38, money(a.spend), { weight: 600, anchor: 'end' });
    svg += await txt(cols[4].x, y + 38, int(a.impressions), { anchor: 'end' });
    svg += await txt(cols[5].x, y + 38, a.reach ? int(a.reach) : '—', { anchor: 'end' });
    svg += await txt(cols[6].x, y + 38, a.messages ? int(a.messages) : '—', { fill: a.messages ? '#1c1e21' : '#8a8d91', anchor: 'end' });
    svg += `<line x1="${pad}" y1="${y + rowH}" x2="${W - pad}" y2="${y + rowH}" stroke="#ebedf0"/>`;
    y += rowH;
  }
  svg += `<rect x="${pad}" y="${y}" width="${W - 2 * pad}" height="${totH}" fill="#f0edff"/>`;
  svg += await txt(pad + 16, y + 28, `Total · ${ads.length} ad${ads.length === 1 ? '' : 's'}`, { size: 16, weight: 600 });
  svg += await txt(pad + 16, y + 48, tot.res ? plural(tot.res, tot.type || 'result') : '', { size: 13, fill: '#65676b' });
  svg += await txt(cols[1].x, y + 38, tot.res ? int(tot.res) : '—', { weight: 600, anchor: 'end' });
  svg += await txt(cols[2].x, y + 38, tot.res ? money(tot.spend / tot.res) : '—', { weight: 600, anchor: 'end' });
  svg += await txt(cols[3].x, y + 38, money(tot.spend), { weight: 600, fill: '#5B45F0', anchor: 'end', size: 18 });
  svg += await txt(cols[4].x, y + 38, int(tot.imp), { weight: 600, anchor: 'end' });
  svg += await txt(cols[5].x, y + 38, reach ? int(reach) : '—', { weight: 600, anchor: 'end' });
  svg += await txt(cols[6].x, y + 38, tot.msg ? int(tot.msg) : '—', { weight: 600, anchor: 'end' });
  y += totH;
  if (more > 0) svg += await txt(pad + 16, y + 24, `+ ${more} more ad${more === 1 ? '' : 's'} included in the total`, { size: 13, fill: '#65676b' });
  svg += '</svg>';
  const png = new Resvg(svg, { font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: 'Inter' }, fitTo: { mode: 'width', value: 1800 } }).render().asPng();
  return png;
}

// PNG for a client's report, or null when there are no ads with spend.
async function clientReportImage(user, clientId, from, to, kind = '', parts = null) {
  const data = await clientAds(user, clientId, from, to, kind, parts);
  if (!data.ads.length) return null;
  return render(data, from, to);
}

module.exports = { clientReportImage, render, clientCampaigns };
