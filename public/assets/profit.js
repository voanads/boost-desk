// Profit tab: monthly ad accounts, client balances and profit split (was the separate Ads & Profit Tracker).
// Renders into <section id="tab-profit">. app.js calls BDProfit.show(me) when the tab opens.
window.BDProfit = (() => {
  const ROLES = ['developer', 'doer', 'spender', 'supporter', 'company'];
  const PEOPLE_ROLES = ['developer', 'doer', 'spender', 'supporter'];
  const ROLE_LABEL = { developer: 'Developer', doer: 'Doer', spender: 'Spender', supporter: 'Supporter', company: 'Company' };
  const DEFAULT_SERVICES = [{ name: 'Buy TH', pct: [7, 8, 25, 10, 50] }, { name: 'Request Up', pct: [7, 8, 25, 10, 50] }, { name: 'Refund', pct: [10, 20, 15, 5, 50] }, { name: 'Reset', pct: [5, 10, 25, 10, 50] }, { name: 'Pay Debt', pct: [15, 5, 25, 5, 50] }, { name: 'VAT + TH', pct: [0, 0, 30, 10, 60] }, { name: 'Another', pct: [0, 0, 30, 10, 60] }, { name: 'TikTok Credit', pct: [7, 8, 25, 10, 50] }];
  const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const ACCESS_INFO = { admin: 'Own book, can look at everyone’s book, changes split rules, the people list and access', member: 'Own book only: enters and sees just their own months', none: 'Doesn’t see the Profit tab' };
  const ACCESS_LABEL = { admin: 'Admin', member: 'Own book', none: 'No access' };

  let root = null, app = null, statusEl = null, booted = false, pollT = null;
  let viewBook = '', myId = '', books = [], serviceUse = {}; // whose book is open (admins can open anyone's)
  let months = {}, current = null, draft = null, dirty = false, saveTimer = null, rulesTimer = null, confirmDel = false;
  let page = 'accounts', role = 'viewer', canEdit = false, isAdmin = false, me = null;
  let services = JSON.parse(JSON.stringify(DEFAULT_SERVICES)), accessPeople = [];
  // Names in the Developer / Doer / Spender / Supporter dropdowns (settings/main.team). Admins edit the list.
  const DEFAULT_TEAM = ['Dorn Sovandara', 'Hor Vannak', 'Phat Sopheak', 'Eng Khunngoun', 'Nang Sokhy', 'Nuon Ni', 'Van Chivarn', 'Eng Khunmeng', 'Run Vannak', 'Choeun Phanith', 'Van Socheat', 'Chamroun Chetara', 'Chea Lykheang', 'En Chomrey', 'Chhon Bunna', 'Another'];
  let team = DEFAULT_TEAM.slice();

  const $ = (s) => root.querySelector(s);
  const byId = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (v) => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
  const money = (n, dec = 2) => { n = num(n); n = Math.round(n * 10 ** dec) / 10 ** dec || 0; // no “−$0.00”
    const s = '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec }); return n < 0 ? '−' + s : s; };
  const pct = (n) => Math.max(0, Math.min(100, n));
  const monthLabel = (id) => { const [y, m] = id.split('-'); return MONTHS_EN[+m - 1] + ' ' + y; };
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const setText = (id, v) => { const e = byId(id); if (e) e.textContent = v; };
  const setStatus = (t) => { if (statusEl) statusEl.textContent = t; };
  const ruleFor = (name) => { const s = services.find((x) => x.name === name); return s ? s.pct : [0, 0, 0, 0, 100]; };
  const typing = () => app && app.contains(document.activeElement) && /INPUT|SELECT/.test(document.activeElement.tagName);

  async function api(path, method = 'GET', body) {
    const r = await fetch('/api/profit' + path, { method, credentials: 'same-origin', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 && j.needsLogin) { location.href = '/login'; throw new Error(j.error); }
    if (!r.ok) { const e = new Error(j.error || 'Server error ' + r.status); e.status = r.status; throw e; }
    return j;
  }

  function blankMonth() { return { updatedOn: '', admin: '', aba: 0, carry: 0, accounts: [], clients: [], transactions: [] }; }
  function normalize(d) {
    const b = Object.assign(blankMonth(), clone(d || {})); ['accounts', 'clients', 'transactions'].forEach((k) => { if (!Array.isArray(b[k])) b[k] = []; });
    // The old tracker's second client column (ជំពាក់) is the sheet's boost deposit (លុយភ្ញៀវតំកល់ប៊ូត).
    b.clients.forEach((c) => { if ((c.deposit === undefined || c.deposit === '') && c.owes !== undefined && c.owes !== '') c.deposit = c.owes; delete c.owes; });
    return b;
  }
  function servicesFrom(data) {
    if (data && Array.isArray(data.services)) return data.services.map((s) => ({ name: String(s.name || ''), pct: ROLES.map((_, i) => num((s.pct || [])[i])) }));
    if (data && data.rules && typeof data.rules === 'object') {
      const names = DEFAULT_SERVICES.map((s) => s.name).filter((n) => data.rules[n]).concat(Object.keys(data.rules).filter((n) => !DEFAULT_SERVICES.some((s) => s.name === n)));
      return names.map((n) => ({ name: n, pct: ROLES.map((_, i) => num(data.rules[n][i])) }));
    }
    return clone(DEFAULT_SERVICES);
  }
  function usage(name) { let n = 0; const all = Object.assign({}, months); if (current && draft) all[current] = draft; Object.values(all).forEach((m) => (m.transactions || []).forEach((t) => { if (t.service === name) n++; })); return Math.max(n, serviceUse[name] || 0); }

  function calc(d) {
    const fbActive = d.accounts.filter((a) => a.platform !== 'TikTok' && a.status === 'Active');
    const fbDebt = fbActive.reduce((s, a) => s + num(a.balance), 0);
    const fbThresh = fbActive.reduce((s, a) => s + num(a.threshold), 0);
    const dis = d.accounts.filter((a) => a.status === 'Disabled'), need = d.accounts.filter((a) => a.status === 'Need to pay');
    const disabled = dis.reduce((s, a) => s + num(a.balance), 0), disT = dis.reduce((s, a) => s + num(a.threshold), 0);
    const needPay = need.reduce((s, a) => s + num(a.balance), 0), needT = need.reduce((s, a) => s + num(a.threshold), 0);
    const toReceive = d.clients.reduce((s, c) => s + num(c.receive), 0);
    const deposit = d.clients.reduce((s, c) => s + num(c.deposit), 0), depCount = d.clients.filter((c) => num(c.deposit) > 0).length;
    const recvCount = d.clients.filter((c) => num(c.receive) > 0).length;
    const profit = d.transactions.reduce((s, t) => s + num(t.profit), 0);
    const ppl = {}, roles = { developer: 0, doer: 0, spender: 0, supporter: 0, company: 0 }, svc = {};
    d.transactions.forEach((t) => {
      const p = num(t.profit), r = ruleFor(t.service), key = t.service || '—';
      svc[key] = svc[key] || { total: 0, count: 0, roles: [0, 0, 0, 0, 0] }; svc[key].total += p; svc[key].count++;
      ROLES.forEach((rl, i) => {
        const amt = p * num(r[i]) / 100; roles[rl] += amt; svc[key].roles[i] += amt;
        const name = (t[rl] || '').trim();
        const who = rl === 'company' || name.toLowerCase() === 'another' ? 'Company' : (name || 'Unassigned'); // “Another” = the company
        ppl[who] = ppl[who] || { total: 0, parts: {} };
        ppl[who].total += amt; ppl[who].parts[rl] = (ppl[who].parts[rl] || 0) + amt;
      });
    });
    // Same formulas as the Google Sheet (Ad account tab):
    //   កើនឡើង (increase)              = ABA + to receive − boost deposits − FB debt
    //   ដកចែកគ្នា (profit to split)     = the profit (ជាក់ស្តែង) of every deal
    //   នៅសល់សម្រាប់ខែក្រោយ (carry over) = increase − profit to split
    // ដកចែកគ្នា can be typed in; left empty it is the deals' profit.
    const splitTyped = d.split !== undefined && d.split !== null && d.split !== '';
    const split = splitTyped ? num(d.split) : profit;
    const r2 = (x) => Math.round(x * 100) / 100 || 0; // cents, so $0.00 is never “below zero”
    const increase = r2(num(d.aba) + toReceive - deposit - fbDebt), carry = r2(increase - split);
    return { fbDebt, fbThresh, fbCount: fbActive.length, disabled, disT, needPay, needT, toReceive, deposit, depCount, recvCount, profit, split, splitTyped, increase, carry, net: profit, people: ppl, roles, rolesNet: roles, svc };
  }

  const fid = (path) => 'pf-' + path.replace(/\./g, '-');
  const inp = (path, val, type = 'text', extra = '') => `<input id="${fid(path)}" data-path="${path}" data-type="${type === 'number' ? 'num' : 'text'}" type="${type}" ${type === 'number' ? 'step="any" inputmode="decimal" class="n"' : ''} value="${esc(val ?? '')}" ${extra}>`;
  const sel = (path, val, opts, label, cls = '') => { const o = opts.includes(val) || !val ? opts : [val].concat(opts); return `<select id="${fid(path)}" data-path="${path}" data-type="text" aria-label="${label}" class="${cls}">${o.map((x) => `<option${x === val ? ' selected' : ''}>${esc(x)}</option>`).join('')}</select>`; };
  // A person dropdown: the team list, plus the saved name if it isn't on the list any more.
  const personSel = (path, val, label) => { const v = String(val || '').trim(), opts = v && !team.includes(v) ? [v, ...team] : team; return `<select id="${fid(path)}" data-path="${path}" data-type="text" aria-label="${label}"><option value=""${v ? '' : ' selected'}>—</option>${opts.map((x) => `<option value="${esc(x)}"${x === v ? ' selected' : ''}>${esc(x)}${x.toLowerCase() === 'another' ? ' (Company)' : ''}</option>`).join('')}</select>`; };
  const rm = (path, label, disabled, title) => `<td class="x"><button type="button" data-remove="${path}" aria-label="Remove ${esc(label)}"${disabled ? ` disabled title="${esc(title)}"` : ' title="Remove row"'}>✕</button></td>`;
  const avatar = (name) => { const s = String(name || '?').trim(); let h = 0; for (const ch of s) h = (h * 31 + ch.codePointAt(0)) % 360; const w = s.split(/\s+/).filter(Boolean); const ini = (w.length > 1 ? w[0][0] + w[1][0] : s.slice(0, 2)).toUpperCase(); return `<span class="av" style="--h:${h}" aria-hidden="true">${esc(ini)}</span>`; };
  const stCls = (s) => (s === 'Active' ? 'st-Active' : s === 'Disabled' ? 'st-Disabled' : 'st-Need');
  const when = (iso) => { try { const d = new Date(iso); return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } };

  function topRow() {
    return `<div class="pf-top"><div><span class="pf-eyebrow">${page === 'split' ? 'Profit split' : 'Ad accounts &amp; clients'}</span><h2>${esc(monthLabel(current))}</h2>${draft && draft._by ? `<span class="pf-lastedit">Last edited by <b>${esc(draft._by)}</b> · ${esc(when(draft._at))}</span>` : ''}</div>
    <div class="pf-confirm">${!canEdit ? `<span class="pf-roleb viewer">${esc(bookName())}’s book · view only</span>` : confirmDel ? `<span class="hint">Delete ${esc(monthLabel(current))} for good?</span><button class="sm danger" type="button" id="pfDelYes">Delete</button><button class="sm" type="button" id="pfDelNo">Keep</button>` : '<button class="ghost sm pf-danger" type="button" id="pfDelBtn">Delete month</button>'}</div></div>`;
  }
  const emptyHTML = () => `<div class="pf-empty"><h3>${canEdit ? 'No months yet' : esc(bookName()) + ' has no months yet'}</h3><p>Each month keeps its own ad accounts, client balances and transactions.${canEdit ? ' Start one with <b>+ New month</b>.' : ''}</p></div>`;

  function renderAccounts() {
    const d = draft;
    app.innerHTML = `
    ${topRow()}
    <section class="pf-strip" id="pfStripA" aria-label="Key numbers"></section>
    <div class="pf-grid2">
      <section class="pf-sheet pf-main">
        <div class="pf-title t-blue"><span>Ad accounts</span><span class="t2" id="pfAccTitle"></span></div>
        <div class="pf-scroll"><table style="min-width:600px"><thead><tr><th>No</th><th>Status</th><th>Account</th><th>Platform</th><th class="n">Balance</th><th class="n">Thresh</th><th style="width:130px">Used</th><th></th></tr></thead><tbody>
        ${d.accounts.map((a, i) => `<tr><td class="idx">${i + 1}</td><td style="width:120px">${sel(`accounts.${i}.status`, a.status || 'Active', ['Active', 'Disabled', 'Need to pay'], 'Status', stCls(a.status || 'Active'))}</td><td>${inp(`accounts.${i}.name`, a.name, 'text', 'aria-label="Account name" placeholder="Account name"')}</td><td style="width:105px">${sel(`accounts.${i}.platform`, a.platform || 'Facebook', ['Facebook', 'TikTok'], 'Platform')}</td><td style="width:100px">${inp(`accounts.${i}.balance`, a.balance, 'number', 'aria-label="Balance"')}</td><td style="width:90px">${inp(`accounts.${i}.threshold`, a.threshold, 'number', 'aria-label="Threshold"')}</td><td><div class="pf-barcell"><div class="mini"><i id="pf-uf-${i}"></i></div><span id="pf-up-${i}"></span></div></td>${rm(`accounts.${i}`, a.name || 'account')}</tr>`).join('')}
        <tr class="total"><td class="idx"></td><td colspan="3">Total active (Facebook)</td><td class="n" id="pfAccBal"></td><td class="n" id="pfAccThr"></td><td></td><td></td></tr>
        </tbody></table></div>
        <div class="pf-foot"><span class="pf-foot-l"><button class="ghost sm pf-link" type="button" data-add="accounts">+ Add account</button><button class="ghost sm pf-link" type="button" id="pfFillMeta" title="Balance, threshold and status from your own ad accounts (the ones on your Ad accounts tab)">↻ Fill from Meta</button></span><span>Orange = 85%+ of threshold, will bill soon</span></div>
      </section>

      <div class="pf-side">
        <section class="pf-sheet pf-sum">
          <div class="pf-title t-green"><span>Summary · <span lang="km">ចំណេញ</span></span><span class="t2" id="pfSumUpd"></span></div>
          <table><tbody>
            <tr><td class="k">Updated on</td><td style="width:170px">${inp('updatedOn', d.updatedOn, 'date', 'aria-label="Updated on"')}</td></tr>
            <tr><td class="k good">Active <small>balance / threshold</small></td><td class="v n" id="pfSActive"></td></tr>
            <tr><td class="k bad">Disabled</td><td class="v n" id="pfSDis"></td></tr>
            <tr><td class="k warnc">Need to pay</td><td class="v n" id="pfSNeed"></td></tr>
            <tr><td class="k">FB debt</td><td class="v n" id="pfSFb"></td></tr>
            <tr><td class="k">ABA <small>cash in bank</small></td><td>${inp('aba', d.aba, 'number', 'aria-label="ABA balance"')}</td></tr>
            <tr><td class="k"><span lang="km">លុយត្រូវទទួលបានថែម</span> <small>to receive</small></td><td class="v n good" id="pfSRecv"></td></tr>
            <tr><td class="k"><span lang="km">លុយភ្ញៀវតម្កល់ប៊ូស</span> <small>boost deposits</small></td><td class="v n blue" id="pfSDep"></td></tr>
            <tr class="pf-calc"><td class="k"><span lang="km">កើនឡើង</span> <small>increase = ABA + to receive − deposits − FB debt</small></td><td class="v n" id="pfSInc"></td></tr>
            <tr class="pf-calc"><td class="k"><span lang="km">ដកចែកគ្នា</span> <small id="pfSSplitHint">profit to split · empty = deals' profit</small></td><td>${inp('split', d.split, 'number', `aria-label="Profit to split" placeholder="${calc(d).profit.toFixed(2)}"`)}</td></tr>
            <tr class="pf-calc"><td class="k"><span lang="km">នៅសល់សម្រាប់ខែក្រោយ</span> <small>carry over = increase − profit to split</small></td><td class="v n" id="pfSCarry"></td></tr>
          </tbody></table>
        </section>

        <section class="pf-sheet">
          <div class="pf-title t-green"><span>Clients</span><span class="t2" id="pfCliTitle"></span></div>
          <div class="pf-scroll"><table style="min-width:360px"><thead><tr><th>No</th><th>Client</th><th class="n"><span lang="km">ទទួលបានថែម</span></th><th class="n"><span lang="km">តម្កល់ប៊ូស</span></th><th></th></tr></thead><tbody>
          ${d.clients.map((x, i) => `<tr><td class="idx">${i + 1}</td><td><div class="namecell">${avatar(x.name)}${inp(`clients.${i}.name`, x.name, 'text', 'aria-label="Client name" placeholder="Client name"')}</div></td><td style="width:92px">${inp(`clients.${i}.receive`, x.receive, 'number', 'aria-label="To receive"')}</td><td style="width:92px">${inp(`clients.${i}.deposit`, x.deposit, 'number', 'aria-label="Boost deposit"')}</td>${rm(`clients.${i}`, x.name || 'client')}</tr>`).join('')}
          <tr class="total"><td class="idx"></td><td>Total</td><td class="n good" id="pfCRecv"></td><td class="n blue" id="pfCDep"></td><td></td></tr>
          </tbody></table></div>
          <div class="pf-foot"><button class="ghost sm pf-link" type="button" data-add="clients">+ Add client</button></div>
        </section>
      </div>
    </div>`;
    updateAccounts();
  }
  function updateAccounts() {
    const d = draft, c = calc(d), k = byId('pfStripA'); if (!k) return;
    const usedPct = c.fbThresh ? c.fbDebt / c.fbThresh * 100 : 0;
    k.innerHTML = `
      <button type="button" class="hl" data-page="split"><span class="k"><span class="ic">÷</span>Profit to split · <span lang="km">ដកចែកគ្នា</span></span><span class="v">${money(c.split)}</span><span class="sub">${c.splitTyped ? `Typed · deals' profit ${money(c.profit)} · ` : ''}See profit split →</span></button>
      <div><span class="k"><span class="ic c-blue">B</span>ABA balance</span><span class="v">${money(d.aba)}</span><span class="sub">Cash in bank</span></div>
      <div><span class="k"><span class="ic c-gold">f</span>FB debt</span><span class="v">${money(c.fbDebt)}</span><div class="meter"><i style="width:${pct(usedPct)}%;background:var(--pf-gold)"></i></div><span class="sub">${Math.round(usedPct)}% of ${money(c.fbThresh, 0)} threshold</span></div>
      <div><span class="k"><span class="ic c-green">↓</span>To receive</span><span class="v good">${money(c.toReceive)}</span><span class="sub">From ${c.recvCount} clients</span></div>
      <div><span class="k"><span class="ic c-blue">$</span>Boost deposits</span><span class="v blue">${money(c.deposit)}</span><span class="sub"><span lang="km">លុយភ្ញៀវតម្កល់ប៊ូស</span> · ${c.depCount}</span></div>
      <div><span class="k"><span class="ic c-purple">↑</span>Increase</span><span class="v${c.increase < 0 ? ' bad' : ''}">${money(c.increase)}</span><span class="sub" lang="km">កើនឡើង</span></div>
      <div><span class="k"><span class="ic c-purple">→</span>Carry to next month</span><span class="v${c.carry < 0 ? ' bad' : ''}">${money(c.carry)}</span><span class="sub" lang="km">នៅសល់សម្រាប់ខែក្រោយ</span></div>`;
    setText('pfAccTitle', `${c.fbCount} active · ${money(c.fbDebt, 0)} of ${money(c.fbThresh, 0)}`);
    setText('pfAccBal', money(c.fbDebt)); setText('pfAccThr', money(c.fbThresh));
    d.accounts.forEach((a, i) => {
      const u = num(a.threshold) ? num(a.balance) / num(a.threshold) * 100 : 0, hot = u >= 85;
      const f = byId('pf-uf-' + i), p = byId('pf-up-' + i);
      if (f) { f.style.width = pct(u) + '%'; f.classList.toggle('hot', hot); } if (p) { p.textContent = num(a.threshold) ? Math.round(u) + '%' : '—'; p.classList.toggle('hot', hot); }
      const s = byId(fid(`accounts.${i}.status`)); if (s) s.className = stCls(a.status || 'Active');
    });
    setText('pfSumUpd', d.updatedOn ? 'Updated ' + d.updatedOn : '');
    setText('pfSActive', `${money(c.fbDebt)} / ${money(c.fbThresh, 0)}`); setText('pfSDis', `${money(c.disabled)} / ${money(c.disT, 0)}`); setText('pfSNeed', `${money(c.needPay)} / ${money(c.needT, 0)}`);
    setText('pfSFb', money(c.fbDebt)); setText('pfSRecv', money(c.toReceive)); setText('pfSDep', money(c.deposit)); setText('pfSInc', money(c.increase)); setText('pfSSplitHint', c.splitTyped ? `profit to split · typed (deals' profit ${money(c.profit)})` : 'profit to split · empty = deals\' profit'); { const e = byId('pf-split'); if (e) e.placeholder = c.profit.toFixed(2); } setText('pfSCarry', money(c.carry)); { const e = byId('pfSCarry'); if (e) e.classList.toggle('bad', c.carry < 0); }
    setText('pfCRecv', money(c.toReceive)); setText('pfCDep', money(c.deposit));
    setText('pfCliTitle', `${c.recvCount} to receive · ${c.depCount} deposit`);
  }

  function renderSplit() {
    const d = draft, names = services.map((s) => s.name);
    app.innerHTML = `
    ${topRow()}
    <section class="pf-strip" id="pfStripS" aria-label="Split by person"></section>
    <section class="pf-sheet">
      <div class="pf-title t-blue"><span>Transactions</span><span class="t2" id="pfTTitle"></span></div>
      <div class="pf-scroll"><table style="min-width:1440px"><thead><tr><th>No</th><th title="Service" lang="km">ប្រភេទសេវាកម្ម</th><th class="n" title="Full price" lang="km">តម្លៃពេញ</th><th class="n" title="Actual profit" lang="km">ជាក់ស្តែង</th><th title="Notes / ad account" lang="km">ចំណាំផ្សេងៗ</th>${PEOPLE_ROLES.map((r) => `<th>${ROLE_LABEL[r]}</th>`).join('')}${ROLES.map((r) => `<th class="n shade">${ROLE_LABEL[r]}</th>`).join('')}<th></th></tr></thead><tbody>
      ${d.transactions.map((t, i) => `<tr><td class="idx">${i + 1}</td><td style="width:130px">${sel(`transactions.${i}.service`, t.service || names[0] || '', names, 'Service')}</td><td style="width:95px">${inp(`transactions.${i}.amount`, t.amount, 'number', 'aria-label="Amount"')}</td><td style="width:95px">${inp(`transactions.${i}.profit`, t.profit, 'number', 'aria-label="Profit"')}</td><td style="width:150px">${inp(`transactions.${i}.account`, t.account, 'text', 'aria-label="Notes" placeholder="Notes"')}</td>${PEOPLE_ROLES.map((r) => `<td style="width:140px">${personSel(`transactions.${i}.${r}`, t[r], ROLE_LABEL[r])}</td>`).join('')}${ROLES.map((r, j) => `<td class="v n${r === 'company' ? '' : ' mut'}" id="pf-ts-${i}-${j}" style="width:90px"></td>`).join('')}${rm(`transactions.${i}`, 'transaction ' + (i + 1))}</tr>`).join('')}
      <tr class="total"><td class="idx"></td><td>Total</td><td class="n" id="pfTAmt"></td><td class="n" id="pfTPro"></td><td colspan="5"></td>${ROLES.map((r, j) => `<td class="n" id="pf-tt-${j}"></td>`).join('')}<td></td></tr>
      </tbody></table></div>
      <div class="pf-foot"><button class="ghost sm pf-link" type="button" data-add="transactions">+ Add transaction</button><span>Shares come from the split rules below</span></div>
    </section>
    <div class="pf-grid3">
      <section class="pf-sheet"><div class="pf-title t-gold"><span>By person</span><span class="t2" id="pfPTitle"></span></div><div class="pf-scroll" id="pfByPerson"></div></section>
      <section class="pf-sheet"><div class="pf-title t-red"><span>By service type</span></div><div class="pf-scroll" id="pfByService"></div></section>
    </div>
    <section class="pf-sheet">
      <div class="pf-title t-purple"><span>Split rules · % of profit per role</span><span class="t2" id="pfRuleMsg" aria-live="polite">${isAdmin ? 'Applies to every month' : 'Only admins can edit'}</span></div>
      <div class="pf-scroll"><table style="min-width:760px"><thead><tr><th>No</th><th>Service type</th><th class="n">Sum</th>${ROLES.map((r) => `<th class="n">${ROLE_LABEL[r]}</th>`).join('')}<th>Used in</th><th></th></tr></thead><tbody>
      ${services.map((s, i) => { const used = usage(s.name); return `<tr><td class="idx">${i + 1}</td><td><input id="pf-rn-${i}" type="text" data-rule-name="${i}" value="${esc(s.name)}" aria-label="Service type name" style="font-weight:600"></td><td class="v n pf-sum" id="pf-rt-${i}" style="width:80px"></td>${s.pct.map((x, j) => `<td style="width:100px"><span class="pf-pct"><input id="pf-rp-${i}-${j}" class="n" type="number" step="any" inputmode="decimal" data-rule-pct="${i}|${j}" value="${num(x)}" aria-label="${esc(s.name)} ${ROLE_LABEL[ROLES[j]]} percent"></span></td>`).join('')}<td class="v" style="width:90px"><span class="pf-badge${used ? ' on' : ''}">${used} ${used === 1 ? 'deal' : 'deals'}</span></td>${rm('services.' + i, s.name, used > 0, 'Used in ' + used + ' deals. Change those deals first.')}</tr>`; }).join('')}
      </tbody></table></div>
      <div class="pf-foot"><button class="ghost sm pf-link" type="button" id="pfAddService">+ Add service type</button><span>${isAdmin ? 'Click a name or % to edit · each row should total 100%' : 'Ask a Profit admin to change these'}</span></div>
    </section>
    <section class="pf-sheet">
      <div class="pf-title t-green"><span>People · dropdown names</span><span class="t2">${team.length} names · used for Developer, Doer, Spender and Supporter</span></div>
      <div class="pf-chips">${team.map((n, i) => `<span class="pf-chip">${avatar(n)}<span>${esc(n)}</span><button type="button" data-remove="team.${i}" aria-label="Remove ${esc(n)} from the list" title="Remove from the list (deals keep the name)">✕</button></span>`).join('')}</div>
      <div class="pf-foot" id="pfPeopleAdd"><span class="pf-addp"><input type="text" id="pfNewPerson" placeholder="Add a name" aria-label="New name for the dropdown" maxlength="60"><button class="sm" type="button" id="pfAddPerson">+ Add</button></span><span>“Another” counts as Company${isAdmin ? ' · names show in this order in the dropdowns' : ''}</span></div>
    </section>`;
    updateSplit();
  }
  function updateSplit() {
    const d = draft, c = calc(d), strip = byId('pfStripS'); if (!strip) return;
    const ppl = Object.entries(c.people).filter(([, v]) => Math.abs(v.total) > 0.004).sort((a, b) => b[1].total - a[1].total);
    strip.innerHTML = `<div class="hl"><span class="k"><span class="ic">÷</span>Profit to split · <span lang="km">ដកចែកគ្នា</span></span><span class="v">${money(c.profit)}</span><span class="sub">${d.transactions.length} transactions</span></div>` +
      ppl.map(([name, v]) => { const sh = c.net ? v.total / c.net * 100 : 0; return `<div><span class="k">${avatar(name)}${esc(name)}</span><span class="v${v.total < 0 ? ' bad' : ''}">${money(v.total)}</span><div class="meter"><i style="width:${pct(sh)}%;background:${name === 'Company' ? 'var(--pf-fg)' : 'var(--pf-brand)'}"></i></div><span class="sub">${sh.toFixed(1)}% of profit</span></div>`; }).join('');
    const cell = (x, b) => `<td class="v n${x < 0 ? ' bad' : ''}"${b ? ' style="font-weight:700"' : ''}>${Math.abs(x) < 0.004 ? '<span class="mut">$0</span>' : money(x)}</td>`;
    byId('pfByPerson').innerHTML = `<table style="min-width:560px"><thead><tr><th>Person</th><th class="n">Sum</th>${ROLES.map((r) => `<th class="n">${ROLE_LABEL[r]}</th>`).join('')}</tr></thead><tbody>
      ${ppl.map(([name, v]) => `<tr><td class="v"><span class="who">${avatar(name)}${esc(name)}</span></td>${cell(v.total, 1)}${ROLES.map((r) => cell(v.parts[r] || 0)).join('')}</tr>`).join('') || '<tr><td class="v mut" colspan="7">No transactions yet</td></tr>'}
      <tr class="total"><td>Sum</td><td class="n">${money(c.net)}</td>${ROLES.map((r) => `<td class="n">${money(c.rolesNet[r])}</td>`).join('')}</tr></tbody></table>`;
    const svc = Object.entries(c.svc);
    const order = services.map((s) => s.name).filter((n) => c.svc[n]).concat(svc.map(([n]) => n).filter((n) => !services.some((s) => s.name === n)));
    byId('pfByService').innerHTML = `<table style="min-width:560px"><thead><tr><th>Service</th><th class="n">Deals</th><th class="n">Sum</th>${ROLES.map((r) => `<th class="n">${ROLE_LABEL[r]}</th>`).join('')}</tr></thead><tbody>
      ${order.map((n) => { const v = c.svc[n]; return `<tr><td class="v">${esc(n)}</td><td class="v n mut">${v.count}</td>${cell(v.total, 1)}${v.roles.map((x) => cell(x)).join('')}</tr>`; }).join('') || '<tr><td class="v mut" colspan="8">No transactions yet</td></tr>'}
      <tr class="total"><td>Sum</td><td class="n">${d.transactions.length}</td><td class="n">${money(c.profit)}</td>${ROLES.map((r) => `<td class="n">${money(c.roles[r])}</td>`).join('')}</tr></tbody></table>`;
    setText('pfTTitle', `${d.transactions.length} deals · profit ${money(c.profit)}`);
    setText('pfPTitle', `${ppl.length} people`);
    d.transactions.forEach((t, i) => { const p = num(t.profit), r = ruleFor(t.service); ROLES.forEach((_, j) => { const e = byId(`pf-ts-${i}-${j}`); if (e) { const x = p * num(r[j]) / 100; e.textContent = Math.abs(x) < 0.004 ? '$0' : money(x); e.classList.toggle('bad', x < 0); } }); });
    setText('pfTAmt', money(d.transactions.reduce((s, t) => s + num(t.amount), 0))); setText('pfTPro', money(c.profit));
    ROLES.forEach((r, j) => setText('pf-tt-' + j, money(c.roles[r])));
    services.forEach((s, i) => { const tot = s.pct.reduce((a, b) => a + num(b), 0), e = byId('pf-rt-' + i); if (e) { e.textContent = (Math.round(tot * 100) / 100) + '%'; e.classList.toggle('warn', Math.abs(tot - 100) > 0.01); } });
  }

  // ---- Access (Profit admins) ----
  async function renderAccess() {
    app.innerHTML = `<div class="pf-top"><div><span class="pf-eyebrow">Profit</span><h2>Who can use Profit</h2><span class="pf-lastedit">Everyone has their own Profit book. Admins can also open anyone’s book.</span></div></div>
      <div class="pf-grid2"><section class="pf-sheet pf-main"><div class="pf-title t-blue"><span>People</span><span class="t2" id="pfAccCount"></span></div><div class="pf-scroll" id="pfAccessTable"><p class="hint" style="padding:0 16px 16px">Loading…</p></div></section>
      <div class="pf-side"><section class="pf-sheet"><div class="pf-title t-purple"><span>What each choice means</span></div><div class="pf-roles">${['admin', 'member', 'none'].map((r) => `<div><span class="pf-roleb ${r === 'member' ? 'editor' : r}">${ACCESS_LABEL[r]}</span><span>${ACCESS_INFO[r]}</span></div>`).join('')}</div></section></div></div>`;
    try { accessPeople = (await api('/access')).people || []; drawAccess(); }
    catch (e) { const t = byId('pfAccessTable'); if (t) t.innerHTML = `<p class="bad" style="padding:0 16px 16px">${esc(e.message)}</p>`; }
  }
  function drawAccess() {
    const t = byId('pfAccessTable'); if (!t) return;
    setText('pfAccCount', `${accessPeople.filter((p) => p.access === 'admin').length} admins · ${accessPeople.filter((p) => p.access === 'member').length} with own book`);
    t.innerHTML = `<table style="min-width:480px"><thead><tr><th>Name</th><th>Login</th><th class="n">Months</th><th style="width:170px">Profit access</th></tr></thead><tbody>
      ${accessPeople.map((p) => `<tr><td class="v"><span class="who">${avatar(p.name)}${esc(p.name)}</span></td><td class="v mut">${esc(p.kind)}${p.email ? ' · ' + esc(p.email) : ''}</td><td class="v n">${p.months || '—'}</td>
        <td>${p.owner ? '<span class="pf-roleb admin" style="margin-left:8px">admin · app owner</span>' : `<select data-access="${esc(p.id)}" aria-label="Profit access for ${esc(p.name)}">${['member', 'admin', 'none'].map((v) => `<option value="${v}"${p.access === v ? ' selected' : ''}>${ACCESS_LABEL[v]}</option>`).join('')}</select>`}</td></tr>`).join('')}
    </tbody></table>`;
  }

  function render() {
    if (!app) return;
    root.querySelectorAll('[data-pfpage]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.pfpage === page)));
    $('#pfMonthBar').hidden = page === 'access';
    if (page === 'access') { renderAccess(); return; }
    if (!current) { app.innerHTML = emptyHTML(); return; }
    page === 'split' ? renderSplit() : renderAccounts();
    if (!canEdit) { app.querySelectorAll('[data-path]').forEach((e) => { e.disabled = true; }); app.querySelectorAll("[data-add],[data-remove^='accounts.'],[data-remove^='clients.'],[data-remove^='transactions.'],#pfFillMeta").forEach((e) => { e.hidden = true; }); }
    if (!isAdmin && page === 'split') { app.querySelectorAll('[data-rule-name],[data-rule-pct]').forEach((e) => { e.disabled = true; }); app.querySelectorAll("#pfAddService,[data-remove^='services.'],[data-remove^='team.'],#pfPeopleAdd").forEach((e) => { e.hidden = true; }); }
  }
  const update = () => (page === 'split' ? updateSplit() : page === 'accounts' ? updateAccounts() : null);
  function goPage(p) { page = p; confirmDel = false; render(); }
  const bookName = () => { const b = books.find((x) => x.id === viewBook); return b ? b.name : 'Someone'; };
  function renderBookSel() {
    const w = $('#pfBookWrap'); w.hidden = !isAdmin || !books.length; if (w.hidden) return;
    const others = books.filter((b) => b.id !== myId);
    $('#pfBookSel').innerHTML = `<option value="${esc(myId)}"${viewBook === myId ? ' selected' : ''}>My book</option>` + others.map((b) => `<option value="${esc(b.id)}"${b.id === viewBook ? ' selected' : ''}>${esc(b.name)}${b.months ? '' : ' (empty)'}</option>`).join('');
  }
  function renderMonthSel() {
    const ids = Object.keys(months).sort().reverse();
    if (current && !ids.includes(current)) ids.unshift(current);
    const s = $('#pfMonthSel');
    s.innerHTML = ids.length ? ids.map((id) => `<option value="${id}"${id === current ? ' selected' : ''}>${monthLabel(id)}</option>`).join('') : '<option value="">No months</option>';
    s.disabled = !ids.length;
  }

  function scheduleSave() { if (!canEdit) return; dirty = true; setStatus('Saving…'); clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 800); }
  async function saveNow() {
    clearTimeout(saveTimer);
    if (!current) return;
    const id = current, body = clone(draft);
    try { const r = await api('/months/' + id, 'PUT', body); body._by = r._by; body._at = r._at; months[id] = body; if (current === id && draft) { draft._by = r._by; draft._at = r._at; } dirty = false; setStatus('Saved'); }
    catch (e) { setStatus("Couldn't save: " + e.message); if (!e.status || e.status >= 500) setTimeout(saveNow, 2000); }
  }
  function scheduleRules() {
    if (!isAdmin) return;
    setStatus('Saving…'); clearTimeout(rulesTimer);
    rulesTimer = setTimeout(async () => { try { await api('/settings/main', 'PUT', { services: clone(services), team: team.slice() }); setStatus('Saved'); } catch (e) { setStatus("Couldn't save rules: " + e.message); } }, 700);
  }
  async function renameService(i, input) {
    const oldName = services[i].name, nn = input.value.trim(), msg = byId('pfRuleMsg');
    if (nn === oldName) { input.value = oldName; return; }
    if (!nn) { input.value = oldName; if (msg) msg.textContent = 'A service type needs a name'; return; }
    if (services.some((s, j) => j !== i && s.name.toLowerCase() === nn.toLowerCase())) { input.value = oldName; if (msg) msg.textContent = '“' + nn + '” already exists'; return; }
    if (dirty) await saveNow();
    services[i].name = nn; if (msg) msg.textContent = 'Applies to every month';
    try { await api('/rename-service', 'POST', { from: oldName, to: nn }); } catch (e) { setStatus("Couldn't rename in every book: " + e.message); }
    if (serviceUse[oldName]) { serviceUse[nn] = serviceUse[oldName]; delete serviceUse[oldName]; }
    Object.values(months).forEach((m) => (m.transactions || []).forEach((t) => { if (t.service === oldName) t.service = nn; }));
    if (draft) draft.transactions.forEach((t) => { if (t.service === oldName) t.service = nn; });
    scheduleRules(); renderSplit();
  }


  // Ad accounts from Boost Desk's Meta sync → this month's list (balance, threshold, status).
  const META_STATUS = (code) => (code === 1 ? 'Active' : [3, 8, 9].includes(Number(code)) ? 'Need to pay' : code == null ? null : 'Disabled');
  async function fillFromMeta(btn) {
    btn.disabled = true; setStatus('Reading ad accounts…');
    try {
      const list = (await api('/meta-accounts')).accounts || [];
      if (!list.length) { setStatus('Your Facebook login has no ad accounts yet. Open Ad accounts and tap Refresh from Meta first.'); btn.disabled = false; return; }
      const key = (s) => String(s || '').trim().toLowerCase();
      let upd = 0, add = 0;
      for (const m of list) {
        let row = draft.accounts.find((a) => a.metaId === m.id) || draft.accounts.find((a) => !a.metaId && key(a.name) === key(m.name));
        if (!row) { if (!m.synced || META_STATUS(m.statusCode) !== 'Active') continue; row = { name: m.name, platform: 'Facebook', status: 'Active', balance: '', threshold: '' }; draft.accounts.push(row); add++; } else upd++;
        row.metaId = m.id; row.balance = Math.round(num(m.balance) * 100) / 100;
        if (m.threshold != null) row.threshold = Math.round(num(m.threshold) * 100) / 100;
        const st = META_STATUS(m.statusCode); if (st) row.status = st;
      }
      dirty = true; render(); await saveNow();
      setStatus(`Updated ${upd} and added ${add} accounts from Meta`);
    } catch (e) { setStatus("Couldn't read Meta accounts: " + e.message); btn.disabled = false; }
  }

  function setPath(obj, path, val) { const k = path.split('.'); let o = obj; for (let i = 0; i < k.length - 1; i++) o = o[k[i]]; o[k[k.length - 1]] = val; }

  function wire() {
    app.addEventListener('input', (e) => {
      const t = e.target;
      if (t.dataset.path) { setPath(draft, t.dataset.path, t.dataset.type === 'bool' ? t.checked : t.dataset.type === 'num' ? (t.value === '' ? '' : num(t.value)) : t.value); update(); scheduleSave(); return; }
      if (t.dataset.rulePct) { const [i, j] = t.dataset.rulePct.split('|').map(Number); services[i].pct[j] = num(t.value); updateSplit(); scheduleRules(); }
    });
    app.addEventListener('change', async (e) => {
      const t = e.target;
      if (t.tagName === 'SELECT' && t.dataset.path) { setPath(draft, t.dataset.path, t.value); update(); scheduleSave(); return; }
      if (t.dataset.ruleName !== undefined) { renameService(+t.dataset.ruleName, t); return; }
      if (t.dataset.access !== undefined) {
        try { await api('/access/' + encodeURIComponent(t.dataset.access), 'PUT', { access: t.value }); const p = accessPeople.find((x) => x.id === t.dataset.access); if (p) p.access = t.value; setStatus('Access saved'); drawAccess(); refresh(false); }
        catch (err) { setStatus(err.message); }
      }
    });
    app.addEventListener('keydown', (e) => {
      const t = e.target; if (e.key !== 'Enter' || t.tagName !== 'INPUT') return;
      if (t.dataset.ruleName !== undefined) { t.blur(); return; }
      if (t.id === 'pfNewPerson') { e.preventDefault(); addPerson(); return; }
      const td = t.closest('td'), tr = td && td.closest('tr'); if (!tr) return;
      const col = [...tr.children].indexOf(td); const next = tr.nextElementSibling && tr.nextElementSibling.children[col];
      const f = next && next.querySelector('input,select'); if (f) { e.preventDefault(); f.focus(); if (f.select) f.select(); }
    });
    app.addEventListener('focusin', (e) => { if (e.target.tagName === 'INPUT' && e.target.type !== 'date' && e.target.select) setTimeout(() => { try { e.target.select(); } catch (_) {} }, 0); });
    root.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b || b.disabled || !root.contains(b)) return;
      if (b.dataset.pfpage) { goPage(b.dataset.pfpage); return; }
      if (b.dataset.page) { goPage(b.dataset.page); window.scrollTo(0, 0); return; }
      if (b.id === 'pfFillMeta') { fillFromMeta(b); return; }
      if (b.dataset.add) {
        const k = b.dataset.add;
        const row = k === 'accounts' ? { name: '', platform: 'Facebook', status: 'Active', balance: '', threshold: '' } : k === 'clients' ? { name: '', receive: '', deposit: '' } : { service: (services[0] || {}).name || '', account: '', amount: '', profit: '', developer: '', doer: '', spender: '', supporter: '' };
        draft[k].push(row); scheduleSave(); render();
        const f = byId(fid(`${k}.${draft[k].length - 1}.${k === 'transactions' ? 'amount' : 'name'}`)); if (f) f.focus(); return;
      }
      if (b.dataset.remove) {
        const [k, i] = b.dataset.remove.split('.');
        if (k === 'services') { services.splice(+i, 1); scheduleRules(); renderSplit(); return; }
        if (k === 'team') { team.splice(+i, 1); scheduleRules(); renderSplit(); return; }
        draft[k].splice(+i, 1); scheduleSave(); render(); return;
      }
      if (b.id === 'pfAddPerson') { addPerson(); return; }
      if (b.id === 'pfAddService') {
        let n = 1, name = 'New service'; while (services.some((s) => s.name === name)) { n++; name = 'New service ' + n; }
        services.push({ name, pct: [0, 0, 0, 0, 100] }); scheduleRules(); renderSplit(); const f = byId('pf-rn-' + (services.length - 1)); if (f) { f.focus(); f.select(); } return;
      }
      if (b.id === 'pfDelBtn') { confirmDel = true; render(); return; }
      if (b.id === 'pfDelNo') { confirmDel = false; render(); return; }
      if (b.id === 'pfDelYes') { deleteMonth(); return; }
      if (b.id === 'pfNewBtn') { openNew(); return; }
      if (b.id === 'pfCreate') { createMonth(); return; }
      if (b.id === 'pfCancelNew') { render(); }
    });
    $('#pfBookSel').addEventListener('change', async (e) => { if (dirty) await saveNow(); viewBook = e.target.value; current = null; draft = null; confirmDel = false; if (page === 'access') page = 'accounts'; setStatus(''); refresh(true); });
    $('#pfMonthSel').addEventListener('change', async (e) => { if (dirty) await saveNow(); current = e.target.value; draft = normalize(months[current]); confirmDel = false; render(); });
  }
  function addPerson() {
    const f = byId('pfNewPerson'); if (!f || !isAdmin) return;
    const n = f.value.trim().replace(/\s+/g, ' ');
    if (!n) { f.focus(); return; }
    if (team.some((x) => x.toLowerCase() === n.toLowerCase())) { setStatus(`“${n}” is already on the list`); f.select(); return; }
    const k = team.indexOf('Another'); if (k >= 0) team.splice(k, 0, n); else team.push(n); // “Another” stays last
    scheduleRules(); renderSplit(); const g = byId('pfNewPerson'); if (g) g.focus();
  }
  function openNew() {
    if (page === 'access') goPage('accounts');
    const last = Object.keys(months).sort().pop(); let y, m;
    if (last) { [y, m] = last.split('-').map(Number); m++; if (m > 12) { m = 1; y++; } } else { const n = new Date(); y = n.getFullYear(); m = n.getMonth() + 1; }
    const val = `${y}-${String(m).padStart(2, '0')}`;
    const old = byId('pfNewCard'); if (old) old.remove();
    app.insertAdjacentHTML('afterbegin', `<section class="pf-newcard" id="pfNewCard"><b>Start a new month</b><label for="pfNewMonth" class="hint">Month</label><input type="month" id="pfNewMonth" value="${val}"><button class="sm primary" type="button" id="pfCreate">Create</button><button class="sm" type="button" id="pfCancelNew">Cancel</button><p>Account and client names carry over from your latest month with to-receive cleared. Boost deposits carry over. Transactions start empty.</p><p class="bad" id="pfNewMsg"></p></section>`);
    byId('pfNewMonth').focus();
  }
  async function createMonth() {
    const v = byId('pfNewMonth').value, msg = byId('pfNewMsg');
    if (!/^\d{4}-\d{2}$/.test(v)) { msg.textContent = 'Pick a month first.'; return; }
    if (months[v]) { msg.textContent = monthLabel(v) + ' already exists. Pick it from the Month menu.'; return; }
    if (dirty) await saveNow();
    const prevId = Object.keys(months).sort().filter((id) => id < v).pop() || Object.keys(months).sort().pop();
    const prev = prevId ? normalize(months[prevId]) : blankMonth();
    const nd = blankMonth(); nd.admin = prev.admin || '';
    nd.accounts = prev.accounts.map((a) => ({ name: a.name, platform: a.platform || 'Facebook', status: a.status || 'Active', balance: a.balance, threshold: a.threshold, ...(a.metaId ? { metaId: a.metaId } : {}) }));
    nd.clients = prev.clients.map((x) => ({ name: x.name, receive: '', deposit: x.deposit ?? '' }));
    current = v; draft = nd; months[v] = clone(nd); page = 'accounts'; renderMonthSel(); render(); await saveNow();
  }
  async function deleteMonth() {
    const id = current; confirmDel = false;
    try {
      await api('/months/' + id, 'DELETE'); delete months[id];
      const ids = Object.keys(months).sort(); current = ids.pop() || null; draft = current ? normalize(months[current]) : null; dirty = false;
      setStatus('Deleted'); renderMonthSel(); render();
    } catch (e) { setStatus("Couldn't delete: " + e.message); }
  }

  async function refresh(first) {
    let s;
    try { s = await api('/state' + (viewBook && viewBook !== myId ? '?book=' + encodeURIComponent(viewBook) : '')); } catch (e) { if (first) app.innerHTML = `<div class="pf-empty"><h3>Can't open Profit</h3><p>${esc(e.message)}</p></div>`; return; }
    role = s.role || 'member'; isAdmin = role === 'admin'; serviceUse = s.serviceUse || {}; canEdit = !!s.mine; myId = s.me || myId; viewBook = s.book || myId; books = s.books || [];
    $('#pfNewBtn').hidden = !canEdit; $('#pfAccessTab').hidden = !isAdmin; renderBookSel();
    const nextServices = s.settings && s.settings.main ? servicesFrom(s.settings.main) : services;
    const main = (s.settings && s.settings.main) || {};
    const nextTeam = Array.isArray(main.team) ? main.team.map((x) => String(x || '').trim()).filter(Boolean) : DEFAULT_TEAM.slice();
    const servicesChanged = JSON.stringify(nextServices) !== JSON.stringify(services) || JSON.stringify(nextTeam) !== JSON.stringify(team); services = nextServices; team = nextTeam;
    months = s.months || {};
    if (first || !current || (!months[current] && !dirty)) { const ids = Object.keys(months).sort(); current = ids.pop() || null; draft = current ? normalize(months[current]) : null; renderMonthSel(); render(); return; }
    let changed = servicesChanged;
    if (!dirty && months[current]) { const fresh = normalize(months[current]); if (JSON.stringify(fresh) !== JSON.stringify(draft)) { draft = fresh; changed = true; } }
    renderMonthSel();
    if (changed && page !== 'access' && !typing()) render();
  }

  function show(meInfo) {
    me = meInfo || me;
    root = byId('tab-profit'); if (!root) return;
    if (!booted) {
      booted = true;
      root.innerHTML = `<div class="pf">
        <div class="bhead"><div><h2>Profit</h2><div class="hint">Your monthly ad accounts, client balances and profit split.</div></div>
          <div class="bh-r" id="pfMonthBar"><span id="pfBookWrap" hidden><label for="pfBookSel" class="hint">Book</label><select id="pfBookSel" aria-label="Whose Profit book"></select></span><label for="pfMonthSel" class="hint">Month</label><select id="pfMonthSel" aria-label="Month"></select><button class="sm" id="pfNewBtn" type="button" hidden>+ New month</button><span class="pf-status" id="pfStatus" aria-live="polite"></span></div></div>
        <div class="seg pf-seg" role="group" aria-label="Profit pages"><button type="button" data-pfpage="accounts" aria-pressed="true">Ad accounts &amp; clients</button><button type="button" data-pfpage="split" aria-pressed="false">Profit split · <span lang="km">ចំណេញ</span></button><button type="button" data-pfpage="access" aria-pressed="false" id="pfAccessTab" hidden>Access</button></div>
        <div id="pfApp"><div class="pf-empty"><h3>Loading…</h3></div></div></div>`;
      app = byId('pfApp'); statusEl = byId('pfStatus');
      wire();
      refresh(true);
      pollT = setInterval(() => { if (document.visibilityState === 'visible' && !root.hidden && !dirty) refresh(false); }, 20000);
    } else if (!dirty) refresh(false);
  }
  return { show };
})();
