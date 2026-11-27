// 📱 The manager's phone page (/admin/m): one self-contained HTML page (styles and script inline), mobile first.
// Three tabs: ថ្ងៃនេះ (today at a glance) · ក្រុម (team follow-up) · Ads & AI (ads health, Ad Doctor, competitors).
// Data comes from the admin APIs the Main Dashboard already uses; see src/routes/manager-mobile.js.
function html() {
  return `<!doctype html><html lang="km"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex">
<meta name="theme-color" content="#14122A"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><meta name="apple-mobile-web-app-title" content="Ads Box">
<link rel="manifest" href="/admin/m/manifest.webmanifest"><link rel="icon" href="/assets/logo.svg"><link rel="apple-touch-icon" href="/assets/logo.svg">
<title>Ads Box · Manager</title>
<style>
:root{--ink:#14122A;--mut:#6b6880;--line:#e8e6f0;--bg:#f6f5fa;--card:#fff;--acc:#4f46e5;--bad:#dc2626;--warn:#d97706;--ok:#0f8a4b;--chip:#f0eff6}
@media (prefers-color-scheme:dark){:root{--ink:#eeedf5;--mut:#a3a0b8;--line:#2c2a3d;--bg:#0f0e17;--card:#1a1826;--chip:#252336}}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,-apple-system,"Segoe UI","Noto Sans Khmer","Khmer OS",sans-serif}
header{position:sticky;top:0;z-index:5;background:var(--ink);color:#fff;padding:calc(env(safe-area-inset-top) + 10px) 16px 10px;display:flex;align-items:center;gap:10px}
header b{font-size:17px}header small{opacity:.7;display:block;font-size:12px}header .sp{flex:1}
header button{background:rgba(255,255,255,.12);color:#fff;border:0;border-radius:10px;padding:8px 12px;font:inherit}
main{padding:12px 12px calc(84px + env(safe-area-inset-bottom))}
nav{position:fixed;left:0;right:0;bottom:0;z-index:5;background:var(--card);border-top:1px solid var(--line);display:flex;padding-bottom:env(safe-area-inset-bottom)}
nav button{flex:1;border:0;background:none;color:var(--mut);padding:10px 4px 12px;font:inherit;font-size:12px;display:flex;flex-direction:column;align-items:center;gap:2px}
nav button span{font-size:20px}nav button[aria-current=true]{color:var(--acc);font-weight:600}
nav .badge{background:var(--bad);color:#fff;border-radius:99px;font-size:10px;padding:0 5px;margin-left:2px}
.tiles{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px}
.t{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:10px 12px}
.t span{display:block;color:var(--mut);font-size:12px}.t b{font-size:21px;font-variant-numeric:tabular-nums}.t small{display:block;color:var(--mut);font-size:12px}
.t.bad b{color:var(--bad)}.t.ok b{color:var(--ok)}
h2{font-size:14px;margin:16px 4px 8px;color:var(--mut);font-weight:600;text-transform:none}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px;margin-bottom:8px}
.row{display:flex;align-items:center;gap:8px}.row .grow{flex:1;min-width:0}.mut{color:var(--mut);font-size:13px}.num{font-variant-numeric:tabular-nums;white-space:nowrap}
.name{font-weight:600;overflow-wrap:anywhere}
.chip{display:inline-block;border-radius:99px;padding:1px 8px;font-size:12px;background:var(--chip);color:var(--ink);margin:2px 4px 0 0}
.chip.bad{background:#fde8e8;color:#991b1b}.chip.warn{background:#fdf1dc;color:#92400e}.chip.ok{background:#e3f5ea;color:#14532d}
@media (prefers-color-scheme:dark){.chip.bad{background:#3b1717;color:#fca5a5}.chip.warn{background:#3a2a10;color:#fcd34d}.chip.ok{background:#13301f;color:#86efac}}
.lvl{width:10px;height:10px;border-radius:50%;flex:none}.lvl.bad{background:var(--bad)}.lvl.warn{background:var(--warn)}.lvl.ok{background:var(--ok)}
.bar{height:6px;border-radius:3px;background:var(--chip);overflow:hidden;margin-top:6px}.bar i{display:block;height:100%;background:var(--acc)}
.btn{border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:10px;padding:8px 12px;font:inherit;font-size:13px}
.btn.pri{background:var(--acc);border-color:var(--acc);color:#fff}.btn[disabled]{opacity:.5}
.acts{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.empty{color:var(--mut);text-align:center;padding:24px 8px}
.seg{display:flex;gap:6px;overflow-x:auto;margin:0 0 10px;padding-bottom:2px}.seg button{flex:none;border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:99px;padding:6px 12px;font:inherit;font-size:13px}.seg button[aria-pressed=true]{background:var(--ink);color:var(--bg);border-color:var(--ink)}
.sheet{position:fixed;inset:0;z-index:20;background:rgba(0,0,0,.45);display:none;align-items:flex-end}
.sheet.on{display:flex}.sheet>div{background:var(--bg);width:100%;max-height:92vh;overflow:auto;border-radius:18px 18px 0 0;padding:14px 12px calc(20px + env(safe-area-inset-bottom))}
.sheet .sh{display:flex;align-items:center;gap:8px;margin-bottom:8px}.sheet .sh b{flex:1;font-size:16px}
.ad{display:grid;grid-template-columns:56px 1fr;gap:10px}.ad img,.ad .ph{width:56px;height:56px;border-radius:10px;object-fit:cover;background:var(--chip)}
.ai{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px;margin-top:8px}.ai h4{margin:12px 0 4px;font-size:15px}.ai h4:first-child{margin-top:0}.ai ul,.ai ol{margin:4px 0;padding-left:20px}
.load{color:var(--mut);padding:16px;text-align:center}
.toast{position:fixed;left:12px;right:12px;bottom:calc(84px + env(safe-area-inset-bottom));z-index:30;background:var(--ink);color:var(--bg);border-radius:12px;padding:10px 14px;display:none}
details summary{cursor:pointer;color:var(--acc);font-size:13px;margin-top:6px}
</style></head><body>
<header><div><b>Ads Box · Manager</b><small id="upd">…</small></div><span class="sp"></span><button id="refresh" aria-label="Refresh">↻</button></header>
<main id="main"><div class="load">Loading…</div></main>
<nav><button data-tab="today" aria-current="true"><span>📊</span>ថ្ងៃនេះ</button><button data-tab="teams"><span>👥</span>ក្រុម<i id="tb" class="badge" hidden></i></button><button data-tab="ads"><span>🩺</span>Ads & AI</button><button data-tab="full"><span>🖥</span>Full site</button></nav>
<div class="sheet" id="sheet"><div id="sheetIn"></div></div><div class="toast" id="toast"></div>
<script>
(() => {
  const $ = (s) => document.querySelector(s), esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const money = (n) => '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const ago = (iso) => { const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return !iso || isNaN(m) ? '' : m < 1 ? 'ឥឡូវ' : m < 60 ? m + ' នាទីមុន' : m < 1440 ? Math.round(m / 60) + ' ម៉ោងមុន' : Math.round(m / 1440) + ' ថ្ងៃមុន'; };
  const md = (t) => { const out = []; let l = null; const il = (x) => esc(x).replace(/\\*\\*(.+?)\\*\\*/g, '<b>$1</b>'); const cl = () => { if (l) { out.push('</' + l + '>'); l = null; } };
    for (const raw of String(t || '').split('\\n')) { const s = raw.trim(); let m; if (!s) { cl(); continue; }
      if ((m = s.match(/^#{1,4}\\s+(.*)$/))) { cl(); out.push('<h4>' + il(m[1]) + '</h4>'); }
      else if ((m = s.match(/^[-*•]\\s+(.*)$/))) { if (l !== 'ul') { cl(); out.push('<ul>'); l = 'ul'; } out.push('<li>' + il(m[1]) + '</li>'); }
      else if ((m = s.match(/^\\d+[.)]\\s+(.*)$/))) { if (l !== 'ol') { cl(); out.push('<ol>'); l = 'ol'; } out.push('<li>' + il(m[1]) + '</li>'); }
      else { cl(); out.push('<p>' + il(s) + '</p>'); } } cl(); return out.join(''); };
  const toast = (t) => { const e = $('#toast'); e.textContent = t; e.style.display = 'block'; clearTimeout(toast.t); toast.t = setTimeout(() => { e.style.display = 'none'; }, 3200); };
  async function api(path, opts = {}) {
    const r = await fetch('/api' + path, { method: opts.method || 'GET', headers: opts.body ? { 'content-type': 'application/json' } : {}, body: opts.body ? JSON.stringify(opts.body) : undefined, credentials: 'same-origin' });
    if (r.status === 401) { location.href = '/admin/login'; throw new Error('Please log in again.'); }
    const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || 'Error ' + r.status); return j;
  }
  let tab = (location.hash || '#today').slice(1), D = null, team = 'all', loading = false;
  const soft = async (p) => { try { return await api(p); } catch (e) { return { _err: e.message }; } };
  async function load() {
    if (loading) return; loading = true; $('#refresh').disabled = true; $('#upd').textContent = 'កំពុងផ្ទុក…';
    const [ct, rep, lv, hl, ex] = await Promise.all([soft('/admin/clients-today'), soft('/admin/reports'), soft('/admin/lives'), soft('/admin/health'), soft('/admin/m/extra')]);
    D = { ct, rep, lv, hl, ex, at: new Date() }; loading = false; $('#refresh').disabled = false;
    $('#upd').textContent = 'ធ្វើបច្ចុប្បន្នភាព ' + D.at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    render();
  }
  // all clients of all teams, with their PM / team
  const allClients = () => ((D.ct && D.ct.teams) || []).flatMap((t) => t.clients.map((c) => ({ ...c, owner: t.id, account: t.account, team: t.team })));
  function render() {
    document.querySelectorAll('nav button').forEach((b) => b.setAttribute('aria-current', String(b.dataset.tab === tab)));
    if (!D) return;
    const m = $('#main');
    m.innerHTML = tab === 'teams' ? teams() : tab === 'ads' ? ads() : today();
    const unsent = ((D.rep.totals || {}).unsent) || 0, tb = $('#tb'); tb.hidden = !unsent; tb.textContent = unsent;
    wire();
  }
  // ---- ថ្ងៃនេះ ----
  function today() {
    if (D.ct._err) return '<div class="empty">' + esc(D.ct._err) + '</div>';
    const cs = allClients(), act = cs.filter((c) => c.active), bad = act.filter((c) => c.level === 'bad'), nobody = bad.filter((c) => !c.onIt);
    const rt = D.rep.totals || {}, lives = (D.lv.rows || []), now = lives.filter((l) => l.state === 'on');
    const spend = cs.reduce((t, c) => t + (c.spend || 0), 0), checked = act.filter((c) => c.checked).length;
    let h = '<div class="tiles">'
      + '<div class="t"><span>ចំណាយថ្ងៃនេះ</span><b>' + money(spend) + '</b><small>' + act.length + ' client កំពុង boost</small></div>'
      + '<div class="t"><span>Orders</span><b>' + (rt.orders || 0).toLocaleString('en-US') + '</b><small>' + (rt.cpo != null ? money(rt.cpo) + ' / order' : '–') + '</small></div>'
      + '<div class="t ' + (nobody.length ? 'bad' : 'ok') + '"><span>Urgent</span><b>' + bad.length + '</b><small>' + (nobody.length ? nobody.length + ' គ្មានអ្នកមើល' : 'មានអ្នកមើលទាំងអស់') + '</small></div>'
      + '<div class="t"><span>Live ឥឡូវ</span><b>' + now.length + '</b><small>' + lives.length + ' live ថ្ងៃនេះ</small></div>'
      + '<div class="t ' + (rt.unsent ? 'bad' : 'ok') + '"><span>របាយការណ៍ផ្ញើ</span><b>' + (rt.sent || 0) + ' / ' + ((rt.sent || 0) + (rt.unsent || 0) + (rt.nogroup || 0)) + '</b><small>' + (rt.nogroup ? rt.nogroup + ' គ្មាន Telegram group' : '&nbsp;') + '</small></div>'
      + '<div class="t"><span>បានពិនិត្យ</span><b>' + checked + ' / ' + act.length + '</b><small>client ថ្ងៃនេះ</small></div></div>';
    h += '<h2>🚨 Urgent ឥឡូវ</h2>' + (bad.length ? bad.map(cl).join('') : '<div class="card mut">គ្មាន client Urgent ទេ ✅</div>');
    const warn = act.filter((c) => c.level === 'warn' && !c.seen);
    if (warn.length) h += '<h2>👀 ត្រូវមើល (' + warn.length + ')</h2>' + warn.slice(0, 8).map(cl).join('') + (warn.length > 8 ? '<div class="mut" style="padding:0 4px">+' + (warn.length - 8) + ' ទៀត</div>' : '');
    h += '<h2>🔴 Live ឥឡូវ</h2>' + (now.length ? now.map((l) => '<div class="card"><div class="row"><div class="grow"><div class="name">' + esc(l.client) + '</div><div class="mut">' + esc(l.team) + ' · ' + esc(l.time) + ' · ' + l.comments + ' comments</div></div><div class="num"><b>' + money(l.spend) + '</b><div class="mut">' + (l.perComment ? money(l.perComment) + '/cmt' : '') + '</div></div></div></div>').join('') : '<div class="card mut">គ្មាន Live កំពុងដំណើរការ</div>');
    return h;
  }
  function cl(c) {
    const rs = (c.reasons || []).slice(0, 3).map((r) => '<span class="chip ' + (r.level === 'bad' ? 'bad' : 'warn') + '">' + esc(r.text) + '</span>').join('');
    return '<div class="card" data-doc="' + esc(c.owner) + '|' + c.id + '|' + esc(c.name) + '"><div class="row"><span class="lvl ' + c.level + '"></span><div class="grow"><div class="name">' + esc(c.name) + '</div><div class="mut">' + esc(c.team) + (c.onIt ? ' · 👤 ' + esc(c.onIt.by) : c.level === 'bad' ? ' · <b style="color:var(--bad)">គ្មានអ្នកមើល</b>' : '') + '</div></div><div class="num">' + money(c.spend) + '</div></div>' + (rs ? '<div>' + rs + '</div>' : '') + '<div class="mut" style="margin-top:4px">ចុចដើម្បីពិនិត្យ Ads 🩺</div></div>';
  }
  // ---- ក្រុម ----
  function teams() {
    const reps = (D.rep.teams || []), pms = Object.fromEntries(((D.ex.pms) || []).map((p) => [p.id, p])), ct = Object.fromEntries(((D.ct.teams) || []).map((t) => [t.id, t]));
    if (!reps.length) return '<div class="empty">' + esc(D.rep._err || 'មិនទាន់មានទិន្នន័យ') + '</div>';
    return '<div class="mut" style="padding:0 4px 8px">ក្រុមដែលនៅសល់ការងារច្រើន នៅខាងលើ។ ចុចប៊ូតុង ដើម្បីផ្ញើសាររំលឹកទៅ Telegram របស់ PM។</div>' + reps.map((t) => {
      const tt = t.totals || {}, cs = ((ct[t.owner] || {}).clients || []).filter((c) => c.active), bad = cs.filter((c) => c.level === 'bad'), nob = bad.filter((c) => !c.onIt).length;
      const chk = cs.filter((c) => c.checked).length, all = (tt.sent || 0) + (tt.unsent || 0) + (tt.nogroup || 0), p = pms[t.owner] || {}, tg = !!p.telegram;
      const btn = (kind, label, n) => '<button class="btn" data-nudge="' + kind + '|' + esc(t.owner) + '|' + (n || 0) + '|' + esc(t.name) + '"' + (tg ? '' : ' disabled') + '>' + label + '</button>';
      return '<div class="card"><div class="row"><div class="grow"><div class="name">' + esc(t.name) + '</div><div class="mut">' + esc(t.team || '') + (t.buyers && t.buyers.length ? ' · MB ' + esc(t.buyers.join(', ')) : '') + '</div></div><div class="num"><b>' + money(tt.spend) + '</b><div class="mut">' + (tt.orders || 0) + ' orders</div></div></div>'
        + '<div class="bar"><i style="width:' + (all ? Math.round((tt.sent || 0) / all * 100) : 0) + '%"></i></div>'
        + '<div><span class="chip ' + (tt.unsent ? 'warn' : 'ok') + '">📨 ' + (tt.sent || 0) + '/' + all + ' របាយការណ៍</span>'
        + '<span class="chip ' + (nob ? 'bad' : 'ok') + '">🚨 ' + bad.length + ' urgent' + (nob ? ' · ' + nob + ' គ្មានអ្នកមើល' : '') + '</span>'
        + '<span class="chip">✔ ' + chk + '/' + cs.length + ' ពិនិត្យ</span>'
        + '<span class="chip ' + (t.auto && t.auto.on ? 'ok' : 'warn') + '">⏰ Auto ' + (t.auto && t.auto.on ? t.auto.time : 'off') + '</span>'
        + '<span class="chip ' + (tg ? 'ok' : 'bad') + '">✈ ' + (tg ? 'Telegram' : 'មិនភ្ជាប់ Telegram') + '</span></div>'
        + '<div class="acts">' + (tt.unsent ? btn('reports', '📣 រំលឹករបាយការណ៍', tt.unsent) : '') + (nob ? btn('urgent', '🚨 រំលឹក Urgent', nob) : '') + (!(t.auto && t.auto.on) ? btn('autoreport', '⏰ សុំបើក Auto report') : '') + (!tg ? '<span class="mut">PM ត្រូវភ្ជាប់ Telegram ជាមុនសិន</span>' : '') + '</div></div>';
    }).join('');
  }
  // ---- Ads & AI ----
  let compOpen = null;
  function ads() {
    const cs = allClients().filter((c) => c.active), adProb = cs.filter((c) => (c.reasons || []).some((r) => /^(cpr-up|high|plan|quiet|missing)$/.test(r.kind)) || (c.cpr && c.level !== 'ok'));
    const hi = ((D.hl.items) || []).filter((i) => i.level === 'bad' || i.level === 'warn'), setup = ((D.hl.items) || []).filter((i) => i.area === 'Setup');
    const teamsL = [...new Set(cs.map((c) => c.team))].sort();
    const list = (team === 'all' ? cs : cs.filter((c) => c.team === team)).sort((a, b) => b.spend - a.spend);
    let h = '<h2>🩺 Ad Doctor — ជ្រើស client ដើម្បីមើល ad ខ្សោយ និងរបៀបកែ</h2>';
    if (adProb.length) h += '<div class="mut" style="padding:0 4px 6px">⚠ ' + adProb.length + ' client មានសញ្ញា ads មិនល្អ (cost per result ឡើង, លើស plan…)</div>' + adProb.slice(0, 6).map(cl).join('');
    h += '<div class="seg"><button data-team="all" aria-pressed="' + (team === 'all') + '">ទាំងអស់</button>' + teamsL.map((t) => '<button data-team="' + esc(t) + '" aria-pressed="' + (team === t) + '">' + esc(t) + '</button>').join('') + '</div>';
    h += list.slice(0, 40).map((c) => '<div class="card" data-doc="' + esc(c.owner) + '|' + c.id + '|' + esc(c.name) + '"><div class="row"><span class="lvl ' + c.level + '"></span><div class="grow"><div class="name">' + esc(c.name) + '</div><div class="mut">' + esc(c.team) + (c.cpr ? ' · ' + money(c.cpr.cost) + '/' + esc(c.cpr.type) : '') + '</div></div><div class="num">' + money(c.spend) + ' ›</div></div></div>').join('') || '<div class="card mut">គ្មាន client កំពុង boost</div>';
    const comp = (D.ex.competitors || []);
    h += '<h2>🥊 ការវិភាគគូប្រកួត</h2>' + (comp.length ? comp.map((x, i) => '<div class="card"><div class="row"><div class="grow"><div class="name">' + esc(x.client) + '</div><div class="mut">' + esc(x.pm) + ' · ' + x.competitors + ' គូប្រកួត · ' + esc(ago(x.at)) + (x.by ? ' · ' + esc(x.by) : '') + '</div></div><button class="btn" data-comp="' + i + '">' + (compOpen === i ? 'បិទ' : 'អាន') + '</button></div>' + (compOpen === i ? '<div class="ai">' + md(x.text) + '</div>' : '') + '</div>').join('') : '<div class="card mut">មិនទាន់មាន — PM បន្ថែមគូប្រកួតក្នុងទំព័រ client › AI › 🥊 គូប្រកួត។</div>');
    h += '<h2>⚙ Health</h2>' + (hi.length ? hi.map((i) => '<div class="card"><div class="row"><span class="lvl ' + (i.level === 'bad' ? 'bad' : 'warn') + '"></span><div class="grow"><div class="name">' + esc(i.title) + '</div><div class="mut">' + esc(i.detail || '') + '</div></div></div></div>').join('') : '<div class="card mut">គ្មានបញ្ហាប្រព័ន្ធ ✅</div>')
      + (setup.length ? '<details class="card"><summary>Client រៀបចំមិនទាន់រួច (' + setup.length + ' PM)</summary>' + setup.map((i) => '<div style="margin-top:8px"><b>' + esc(i.title) + '</b><div class="mut">' + esc(i.detail) + '</div></div>').join('') + '</details>' : '');
    return h;
  }
  // ---- Ad Doctor sheet ----
  const sh = $('#sheet'), shIn = $('#sheetIn'); let doc = null;
  const closeSheet = () => { sh.classList.remove('on'); doc = null; };
  sh.addEventListener('click', (e) => { if (e.target === sh || e.target.closest('[data-close]')) closeSheet(); });
  async function openDoc(owner, id, name, fresh) {
    doc = { owner, id, name, days: (doc && doc.id === id && doc.days) || 7 }; sh.classList.add('on'); paintDoc('<div class="load">កំពុងអានលេខពី Meta…</div>');
    try { doc.d = await api('/admin/m/ad-doctor/' + encodeURIComponent(owner) + '/' + id + '?days=' + doc.days + (fresh ? '&fresh=1' : '')); paintDoc(); } catch (e) { paintDoc('<div class="card">' + esc(e.message) + '</div>'); }
  }
  function paintDoc(body) {
    const d = doc && doc.d;
    let h = '<div class="sh"><b>🩺 ' + esc(doc.name) + '</b><button class="btn" data-close>✕</button></div><div class="seg">' + [7, 14].map((n) => '<button data-days="' + n + '" aria-pressed="' + (doc.days === n) + '">' + n + ' ថ្ងៃ</button>').join('') + '</div>';
    if (body) { shIn.innerHTML = h + body; return wireDoc(); }
    const weak = d.ads.filter((a) => a.level !== 'ok'), t = d.totals;
    h += '<div class="mut" style="padding:0 4px 8px">' + t.ads + ' ads · <b style="color:' + (weak.length ? 'var(--bad)' : 'var(--ok)') + '">' + weak.length + ' មានបញ្ហា</b>' + (weak.length ? ' · ' + money(t.weakSpend) + ' / ' + money(t.spend) : '') + '</div>';
    h += (weak.length ? weak.slice(0, 10) : d.ads.slice(0, 5)).map((a) => '<div class="card ad">' + (a.thumb ? '<img src="' + esc(a.thumb) + '" alt="" loading="lazy" referrerpolicy="no-referrer">' : '<span class="ph"></span>') + '<div><div class="name">' + esc(a.name) + (d.best.includes(a.adId) ? ' <span class="chip ok">⭐</span>' : '') + '</div><div class="mut">' + money(a.spend) + ' · ' + (a.results ? a.results + ' ' + esc(a.resultType) + ' · ' + money(a.cpr) : '0 លទ្ធផល') + ' · CTR ' + a.ctr.toFixed(2) + '% · Freq ' + a.frequency.toFixed(1) + '</div>'
      + (a.flags || []).map((f) => '<div style="margin-top:6px"><span class="chip ' + (f.level === 'bad' ? 'bad' : 'warn') + '">' + esc(f.title) + '</span> <span class="mut">' + esc(f.detail) + '</span><div style="font-size:14px">' + esc(f.fix) + '</div></div>').join('') + '</div></div>').join('');
    if (weak.length) h += '<div class="acts"><button class="btn pri" data-docai' + (doc.ai && doc.ai.loading ? ' disabled' : '') + '>✨ AI ណែនាំរបៀបកែ</button></div>' + (doc.ai ? (doc.ai.loading ? '<div class="load">AI កំពុងមើល ads…</div>' : doc.ai.err ? '<div class="card">' + esc(doc.ai.err) + '</div>' : '<div class="ai">' + md(doc.ai.text) + '</div>') : '');
    shIn.innerHTML = h; wireDoc();
  }
  function wireDoc() {
    shIn.querySelectorAll('[data-days]').forEach((b) => b.onclick = () => { doc.days = Number(b.dataset.days); doc.ai = null; openDoc(doc.owner, doc.id, doc.name); });
    shIn.querySelectorAll('[data-docai]').forEach((b) => b.onclick = async () => { doc.ai = { loading: true }; paintDoc();
      try { const r = await api('/admin/m/ad-doctor/' + encodeURIComponent(doc.owner) + '/' + doc.id + '/ai', { method: 'POST', body: { days: doc.days, lang: 'km' } }); doc.ai = { text: r.text }; } catch (e) { doc.ai = { err: e.message }; } if (doc) paintDoc(); });
  }
  function wire() {
    document.querySelectorAll('[data-doc]').forEach((el) => el.onclick = () => { const [o, id, ...n] = el.dataset.doc.split('|'); openDoc(o, Number(id), n.join('|')); });
    document.querySelectorAll('[data-team]').forEach((b) => b.onclick = () => { team = b.dataset.team; render(); });
    document.querySelectorAll('[data-comp]').forEach((b) => b.onclick = () => { const i = Number(b.dataset.comp); compOpen = compOpen === i ? null : i; render(); });
    document.querySelectorAll('[data-nudge]').forEach((b) => b.onclick = async () => {
      const [kind, owner, n, ...name] = b.dataset.nudge.split('|');
      if (!confirm('ផ្ញើសាររំលឹកទៅ Telegram របស់ ' + name.join('|') + '?')) return;
      b.disabled = true; try { const r = await api('/admin/m/nudge', { method: 'POST', body: { kind, owner, count: Number(n) } }); toast('✅ បានផ្ញើទៅ ' + r.to); } catch (e) { toast(e.message); b.disabled = false; }
    });
  }
  document.querySelectorAll('nav button').forEach((b) => b.onclick = () => { if (b.dataset.tab === 'full') { location.href = '/admin'; return; } tab = b.dataset.tab; history.replaceState(null, '', '#' + tab); render(); window.scrollTo(0, 0); });
  $('#refresh').onclick = load;
  document.addEventListener('visibilitychange', () => { if (!document.hidden && D && Date.now() - D.at > 60000) load(); });
  setInterval(() => { if (!document.hidden) load(); }, 120000);
  load();
})();
</script></body></html>`;
}
module.exports = { html };
