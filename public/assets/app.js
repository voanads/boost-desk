(() => {
  const $ = (id) => document.getElementById(id);
  const money = (n) => (Number(n) < 0 ? '-$' : '$') + Math.abs(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pad = (n) => String(n).padStart(2, '0');
  const iso = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const parse = (s) => { const [a, b, c] = s.split('-').map(Number); return new Date(a, b - 1, c); };
  const nice = (s) => parse(s).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hasLive = (c) => c.type === 'live' || c.type === 'both';
  const hasPost = (c) => c.type === 'post' || c.type === 'both';

  let me = null, clients = [], accounts = [], date = iso(new Date()), day = { entries: {}, meta: null }, structSig = '';

  function toast(t) { const el = document.createElement('div'); el.className = 'toast'; el.textContent = t; document.body.appendChild(el); setTimeout(() => el.remove(), 2200); }
  function status(el, text, isErr) { el.textContent = text; el.classList.toggle('err', !!isErr); }

  async function api(path, opts = {}) {
    const res = await fetch('/api' + path, { headers: { 'content-type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401 && body.needsLogin) { location.href = '/login?error=' + encodeURIComponent(body.error || 'Please log in again.'); throw new Error(body.error); }
    if (!res.ok) throw new Error(body.error || 'Request failed (' + res.status + ')');
    return body;
  }

  // ---------- tabs ----------
  document.querySelectorAll('nav.tabs button').forEach((b) => b.onclick = () => showTab(b.dataset.tab));
  function showTab(name) {
    document.querySelectorAll('nav.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
    ['checklist', 'dashboard', 'accounts', 'team'].forEach((t) => $('tab-' + t).hidden = t !== name);
    if (name === 'team') renderTeam();
    if (name === 'dashboard') loadDash();
    try { history.replaceState(null, '', '#' + name); } catch (_) {}
  }

  // ---------- checklist helpers ----------
  const active = () => clients.filter((c) => !c.archived);
  const entry = (cid) => day.entries[cid] || {};
  const liveCount = (c) => { const e = entry(c.id); return e.liveCount ?? c.lives ?? 2; };
  function stats(c, e = entry(c.id)) {
    let spend = 0, total = 0, done = 0;
    if (hasPost(c)) { const p = e.post || {}; spend += Number(p.spend) || 0; total++; if (p.on) done++; }
    if (hasLive(c)) { const n = e.liveCount ?? c.lives ?? 2; for (let i = 1; i <= n; i++) { const l = (e.lives || {})['l' + i] || {}; spend += Number(l.spend) || 0; total++; if (l.on) done++; } }
    return { spend, total, done };
  }
  function merge(t, s) { for (const k in s) { if (s[k] && typeof s[k] === 'object') { t[k] = t[k] || {}; merge(t[k], s[k]); } else t[k] = s[k]; } return t; }

  const queues = {};
  function patch(cid, p) {
    const d = date;
    day.entries[cid] = merge(day.entries[cid] || {}, p);
    refreshValues();
    queues[cid] = (queues[cid] || Promise.resolve()).then(() => api(`/day/${d}/${cid}`, { method: 'PATCH', body: p }))
      .catch((e) => status($('syncStatus'), 'Could not save: ' + e.message, true));
  }

  async function loadDay() {
    $('dateInput').value = date;
    try { day = await api('/day/' + date); } catch (e) { status($('syncStatus'), e.message, true); return; }
    structSig = '';
    renderChecklist();
    renderSyncInfo();
    loadMonth();
  }

  function renderSyncInfo() {
    const m = day.meta;
    if (m && m.synced_at) {
      const t = new Date(m.synced_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      const errs = (m.unmatched && m.unmatched.errors) || [];
      status($('syncStatus'), `Last synced from Meta ${t} by ${m.synced_by}.` + (errs.length ? ` ${errs.length} account(s) failed — ` + errs.map((e) => `${e.account}: ${e.message}`).join(' · ') : ''), errs.length > 0);
    } else status($('syncStatus'), 'Not synced from Meta yet for this day.');
    const un = (m && m.unmatched && m.unmatched.unmatched) || [];
    $('unmatchedPanel').hidden = !un.length;
    $('unmatchedBody').innerHTML = un.map((u, i) => `<tr><td>${esc(u.label)}</td><td class="r num">${u.count}</td><td class="r num">${money(u.spend)}</td><td>${u.page
      ? `<div class="linkrow"><button data-new="${i}">New client</button><select data-link="${i}" aria-label="Add this Page to a client"><option value="">Add to client…</option>${active().map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>`
      : '<span class="hint">Page unknown. Link the ad account to a client instead.</span>'}</td></tr>`).join('');
    document.querySelectorAll('[data-new]').forEach((b) => b.onclick = () => {
      const u = un[b.dataset.new];
      $('newName').value = u.page; newPages = [u.page]; drawNewPages();
      $('newType').value = u.kind === 'post' ? 'post' : 'live';
      showTab('checklist'); $('clientsSection').scrollIntoView({ behavior: 'smooth', block: 'start' }); $('newBudget').focus({ preventScroll: true });
      toast('Set the budget, then tap Add client');
    });
    document.querySelectorAll('[data-link]').forEach((sel) => sel.onchange = async () => {
      const u = un[sel.dataset.link], c = clients.find((x) => x.id === Number(sel.value));
      if (!c) return;
      await saveClient(c.id, { pages: [...new Set([...(c.pages || []), u.page])] });
      toast(`"${u.page}" added to ${c.name}. Tap Sync to update.`);
    });
  }

  function renderChecklist() {
    const list = active();
    const sig = date + '|' + list.map((c) => [c.id, c.type, c.name, c.budget, hasLive(c) ? liveCount(c) : 0].join(':')).join(',');
    if (sig !== structSig) { structSig = sig; buildCards(list); }
    refreshValues();
  }

  function buildCards(list) {
    const box = $('list'); box.innerHTML = '';
    if (!list.length) { box.innerHTML = '<div class="empty">No clients yet. Add your first client in <a href="#clients" id="toClients">Clients</a> below, with their Facebook Page names.</div>'; const tc = $('toClients'); if (tc) tc.onclick = (e) => { e.preventDefault(); $('clientsSection').scrollIntoView({ behavior: 'smooth' }); }; return; }
    for (const c of list) {
      const card = document.createElement('div'); card.className = 'card'; card.dataset.cid = c.id;
      card.innerHTML = `<div class="chead"><span class="name">${esc(c.name)}</span>${hasPost(c) ? '<span class="chip post">Post</span>' : ''}${hasLive(c) ? '<span class="chip live">Live</span>' : ''}<span class="chip warn" data-f="over" hidden></span><span class="chip meta" data-f="synced" hidden>From Meta</span><span class="ctot"><b class="num" data-f="spent"></b><span class="muted num">/ ${money(c.budget)}</span></span></div><div class="bar"><i data-f="bar"></i></div><div class="rows"></div><div class="cfoot"></div>`;
      const rows = card.querySelector('.rows');
      if (hasPost(c)) rows.appendChild(makeRow(c, 'post', 'Boost post', false));
      if (hasLive(c)) for (let i = 1; i <= liveCount(c); i++) rows.appendChild(makeRow(c, 'l' + i, 'Live ' + i, true));
      const foot = card.querySelector('.cfoot');
      if (hasLive(c)) {
        const n = liveCount(c);
        const minus = document.createElement('button'); minus.className = 'ghost'; minus.textContent = '− Live'; minus.disabled = n <= 1;
        minus.onclick = () => { patch(c.id, { liveCount: Math.max(1, n - 1) }); renderChecklist(); };
        const plus = document.createElement('button'); plus.className = 'ghost'; plus.textContent = '+ Live'; plus.disabled = n >= 8;
        plus.onclick = () => { patch(c.id, { liveCount: Math.min(8, n + 1) }); renderChecklist(); };
        const per = document.createElement('span'); per.className = 'hint num'; per.textContent = '≈ ' + money((c.budget || 0) / n) + ' per live';
        foot.append(minus, plus, per);
      }
      const note = document.createElement('input'); note.type = 'text'; note.className = 'note'; note.id = 'note-' + c.id; note.placeholder = 'Note (e.g. client asked +3 days)'; note.dataset.f = 'note';
      let t; note.oninput = () => { clearTimeout(t); t = setTimeout(() => patch(c.id, { note: note.value }), 700); };
      foot.appendChild(note);
      box.appendChild(card);
    }
  }

  function makeRow(c, key, label, isLive) {
    const row = document.createElement('div'); row.className = 'row'; row.dataset.key = key;
    row.innerHTML = `<label><input type="checkbox" id="cb-${c.id}-${key}"><span>${label}</span><span class="hint" data-f="camp"></span></label>` +
      (isLive ? `<input type="text" class="time num" id="tm-${c.id}-${key}" placeholder="time">` : '<span></span>') +
      `<span class="spend"><span class="muted">$</span><input type="number" min="0" step="0.01" inputmode="decimal" id="sp-${c.id}-${key}" placeholder="0.00"></span><span></span>`;
    const mk = (v) => key === 'post' ? { post: v } : { lives: { [key]: v } };
    const cb = row.querySelector('input[type=checkbox]'), sp = row.querySelector('input[type=number]'), tm = row.querySelector('input.time');
    cb.onchange = () => patch(c.id, mk({ on: cb.checked }));
    let t; sp.oninput = () => { clearTimeout(t); t = setTimeout(() => patch(c.id, mk({ spend: sp.value === '' ? 0 : Number(sp.value) })), 600); };
    if (tm) { let tt; tm.oninput = () => { clearTimeout(tt); tt = setTimeout(() => patch(c.id, mk({ time: tm.value })), 700); }; }
    return row;
  }

  function refreshValues() {
    let spend = 0, budget = 0, total = 0, done = 0, over = 0;
    for (const c of active()) {
      const e = entry(c.id), s = stats(c, e);
      spend += s.spend; budget += c.budget; total += s.total; done += s.done;
      const isOver = c.budget > 0 && s.spend > c.budget + 0.009; if (isOver) over++;
      const card = document.querySelector(`.card[data-cid="${c.id}"]`); if (!card) continue;
      card.classList.toggle('is-over', isOver); card.classList.toggle('is-done', !isOver && s.total > 0 && s.done === s.total);
      card.querySelector('[data-f=spent]').textContent = money(s.spend);
      const bar = card.querySelector('[data-f=bar]'); bar.style.width = (c.budget ? Math.min(100, s.spend / c.budget * 100) : 0) + '%'; bar.classList.toggle('over', isOver);
      const oc = card.querySelector('[data-f=over]'); oc.hidden = !isOver; if (isOver) oc.textContent = 'Over ' + money(s.spend - c.budget);
      card.querySelector('[data-f=synced]').hidden = !e.syncedAt;
      card.querySelectorAll('.row').forEach((row) => {
        const key = row.dataset.key; const v = key === 'post' ? (e.post || {}) : ((e.lives || {})[key] || {});
        const cb = row.querySelector('input[type=checkbox]'), sp = row.querySelector('input[type=number]'), tm = row.querySelector('input.time');
        cb.checked = !!v.on; row.classList.toggle('done', !!v.on);
        if (document.activeElement !== sp) sp.value = v.spend ? v.spend : '';
        if (tm && document.activeElement !== tm) tm.value = v.time || '';
        row.querySelector('[data-f=camp]').textContent = v.campaigns ? `· ${v.campaigns} campaign${v.campaigns > 1 ? 's' : ''}` : '';
      });
      const note = card.querySelector('[data-f=note]'); if (document.activeElement !== note) note.value = e.note || '';
    }
    $('sSpend').textContent = money(spend); $('sBudget').textContent = money(budget);
    $('sDone').textContent = done + ' / ' + total; $('sOver').textContent = over;
    $('sOver').classList.toggle('over', over > 0); $('sSpend').classList.toggle('over', budget > 0 && spend > budget + 0.009);
  }

  async function loadMonth() {
    const ym = date.slice(0, 7);
    $('monthTitle').textContent = parse(date).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    let rows = [];
    try { rows = await api('/month/' + ym); } catch (_) { return; }
    const per = {};
    for (const r of rows) {
      const c = clients.find((x) => x.id === r.client_id); if (!c) continue;
      const s = stats(c, r.data); if (!s.spend && !s.done) continue;
      const p = per[c.id] || (per[c.id] = { c, days: 0, spend: 0, lives: 0 });
      p.days++; p.spend += s.spend;
      if (hasLive(c)) p.lives += Object.values(r.data.lives || {}).filter((l) => l && (l.on || Number(l.spend) > 0)).length;
    }
    const list = Object.values(per).sort((a, b) => b.spend - a.spend);
    const diffCell = (d) => `<td class="r num" style="color:${d > 0.009 ? 'var(--live)' : 'var(--ok)'}">${d > 0 ? '+' : d < 0 ? '−' : ''}${money(Math.abs(d))}</td>`;
    let T = 0, P = 0;
    $('monthBody').innerHTML = list.length ? list.map((p) => { const plan = p.days * p.c.budget; T += p.spend; P += plan; return `<tr><td>${esc(p.c.name)}</td><td class="r num">${p.days}</td><td class="r num">${hasLive(p.c) ? p.lives : '–'}</td><td class="r num">${money(p.spend)}</td><td class="r num">${money(plan)}</td>${diffCell(p.spend - plan)}</tr>`; }).join('') : '<tr><td colspan="6" class="muted">Nothing logged this month yet.</td></tr>';
    $('monthFoot').innerHTML = list.length ? `<tr><td>Total</td><td></td><td></td><td class="r num">${money(T)}</td><td class="r num">${money(P)}</td>${diffCell(T - P)}</tr>` : '';
  }

  // ---------- checklist actions ----------
  $('syncBtn').onclick = async () => {
    const b = $('syncBtn'); b.disabled = true; b.textContent = 'Syncing…';
    status($('syncStatus'), 'Reading spend for ' + nice(date) + ' from Ads Manager…');
    try {
      const r = await api('/sync/' + date, { method: 'POST' });
      await loadDay();
      toast(`Synced ${r.campaigns} campaigns · ${r.matched} clients`); loadPages();
    } catch (e) { status($('syncStatus'), e.message, true); }
    finally { b.disabled = false; b.textContent = 'Sync from Meta'; }
  };
  $('syncMonthBtn').onclick = async () => {
    const b = $('syncMonthBtn'); b.disabled = true; b.textContent = 'Syncing month…';
    const ym = date.slice(0, 7), last = new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0).getDate();
    status($('syncStatus'), 'Reading every day of ' + parse(date).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }) + ' from Ads Manager… this can take a minute.');
    try {
      const r = await api('/sync-range', { method: 'POST', body: { from: ym + '-01', to: ym + '-' + pad(last) } });
      await loadDay();
      toast(`Synced ${r.daysWithSpend} days with spend · ${r.campaigns} campaign-days`);
    } catch (e) { status($('syncStatus'), e.message, true); }
    finally { b.disabled = false; b.textContent = 'Sync whole month'; }
  };
  $('copyReport').onclick = async () => {
    try {
      const { text } = await api('/report/' + date);
      await navigator.clipboard.writeText(text); toast('Report copied');
    } catch (e) { toast('Could not copy: ' + e.message); }
  };
  $('sendReport').onclick = async () => {
    if (!me.telegram.configured) { toast('Telegram is not set up yet. See Team & Telegram.'); return; }
    const b = $('sendReport'); b.disabled = true;
    try { await api(`/report/${date}/send`, { method: 'POST' }); toast('Sent to Telegram'); }
    catch (e) { toast(e.message); } finally { b.disabled = false; }
  };
  const shift = (n) => { const d = parse(date); d.setDate(d.getDate() + n); date = iso(d); loadDay(); };
  $('prevDay').onclick = () => shift(-1); $('nextDay').onclick = () => shift(1);
  $('todayBtn').onclick = () => { date = me?.today || iso(new Date()); loadDay(); };
  $('dateInput').onchange = () => { if ($('dateInput').value) { date = $('dateInput').value; loadDay(); } };

  // ---------- ad accounts ----------
  function renderAccounts() {
    $('acctList').innerHTML = accounts.map((a) => `<option value="${esc(a.name)}"></option>`).join('');
    let act = 0, bad = 0, today = 0;
    $('acctBody').innerHTML = accounts.map((a) => {
      const i = a.info || {};
      const ok = [1, 201].includes(i.statusCode), warn = [9, 3, 7, 8, 100].includes(i.statusCode);
      if (ok) act++; if (!ok) bad++; today += Number(i.todaySpend) || 0;
      const chip = `<span class="chip ${ok ? 'ok' : warn ? 'warn' : 'bad'}">${esc(i.status || '—')}</span>${i.disableReason ? `<div class="hint">${esc(i.disableReason)}</div>` : ''}`;
      const cap = i.spendCap ? money(Math.max(0, i.spendCap - i.amountSpent)) : '<span class="muted">No limit</span>';
      const cur = i.currency && i.currency !== 'USD' ? ` <span class="hint">${esc(i.currency)}</span>` : '';
      return `<tr><td><input type="checkbox" data-acct="${esc(a.id)}" ${a.enabled ? 'checked' : ''} aria-label="Include in sync"></td>
        <td>${esc(a.name)}<div class="hint num">${esc(a.id)}${i.business ? ' · ' + esc(i.business) : ''}</div></td>
        <td>${chip}</td>
        <td class="r num">${i.todayError ? '<span class="hint">error</span>' : i.todaySpend != null ? money(i.todaySpend) : '–'}</td>
        <td class="r num">${money(i.balance)}${cur}</td><td class="r num">${cap}</td><td class="r num">${money(i.amountSpent)}</td></tr>`;
    }).join('') || '<tr><td colspan="7" class="muted">No ad accounts loaded yet. Tap Refresh from Meta.</td></tr>';
    $('aCount').textContent = accounts.length; $('aActive').textContent = act; $('aBad').textContent = bad;
    $('aBad').classList.toggle('over', bad > 0); $('aToday').textContent = money(today);
    const seen = accounts.map((a) => a.seen_at).sort().pop();
    if (seen) $('acctUpdated').textContent = 'Updated ' + new Date(seen).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + '. Ticked accounts are included in Sync.';
    document.querySelectorAll('[data-acct]').forEach((cb) => cb.onchange = () => api('/accounts/' + encodeURIComponent(cb.dataset.acct), { method: 'PATCH', body: { enabled: cb.checked } }).then(() => toast(cb.checked ? 'Included in sync' : 'Left out of sync')).catch((e) => toast(e.message)));
  }
  $('refreshAccts').onclick = async () => {
    const b = $('refreshAccts'); b.disabled = true; b.textContent = 'Refreshing…';
    try { accounts = await api('/accounts/refresh', { method: 'POST' }); renderAccounts(); toast('Ad accounts updated'); }
    catch (e) { toast(e.message); } finally { b.disabled = false; b.textContent = 'Refresh from Meta'; }
  };

  // ---------- clients ----------
  // Chip list of Facebook Page names with an input to add more.
  function pageEditor(el, pages, idBase, onChange) {
    el.innerHTML = '';
    pages.forEach((p, i) => {
      const chip = document.createElement('span'); chip.className = 'pchip';
      const t = document.createElement('span'); t.textContent = p;
      const x = document.createElement('button'); x.type = 'button'; x.textContent = '×'; x.setAttribute('aria-label', 'Remove ' + p);
      x.onclick = () => onChange(pages.filter((_, j) => j !== i));
      chip.append(t, x); el.appendChild(chip);
    });
    const inp = document.createElement('input'); inp.type = 'text'; inp.id = idBase + '-add'; inp.setAttribute('list', 'pageList');
    inp.placeholder = pages.length ? '+ another Page' : '+ add Page';
    const add = () => { const v = inp.value.trim(); if (v && !pages.includes(v)) onChange([...pages, v]); inp.value = ''; };
    inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } };
    inp.onchange = add;
    el.appendChild(inp);
  }
  let newPages = [];
  function drawNewPages() { pageEditor($('newPages'), newPages, 'newpg', (p) => { newPages = p; drawNewPages(); }); }
  async function loadPages() {
    try {
      const pages = await api('/pages');
      $('pageList').innerHTML = pages.map((p) => `<option value="${esc(p.name)}"></option>`).join('');
    } catch (_) {}
  }

  function renderClients() {
    const typeSel = (c) => `<select data-k="type">${[['live', 'Live'], ['post', 'Post'], ['both', 'Post + live']].map(([v, l]) => `<option value="${v}" ${c.type === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
    $('clientBody').innerHTML = clients.map((c) => `<tr data-cid="${c.id}">
      <td><input type="text" data-k="name" value="${esc(c.name)}" style="width:150px">${c.archived ? '<div class="hint">Paused</div>' : ''}</td>
      <td><span class="pages" data-pages></span></td>
      <td>${typeSel(c)}</td>
      <td><input type="number" data-k="budget" value="${c.budget}" min="0" step="0.5" style="width:80px"></td>
      <td><input type="number" data-k="lives" value="${c.lives}" min="1" max="6" style="width:60px"></td>
      <td><input type="text" data-k="account" value="${esc(c.account)}" list="acctList" placeholder="optional" style="width:160px"></td>
      <td><button class="ghost" data-act="pause">${c.archived ? 'Resume' : 'Pause'}</button><button class="ghost" data-act="del">Delete</button></td></tr>`).join('')
      || '<tr><td colspan="7" class="muted">No clients yet.</td></tr>';
    document.querySelectorAll('#clientBody tr[data-cid]').forEach((tr) => {
      const id = Number(tr.dataset.cid);
      const c0 = clients.find((c) => c.id === id);
      pageEditor(tr.querySelector('[data-pages]'), [...new Set([...(c0.pages || []), c0.match].filter(Boolean))], 'pg-' + id,
        (pages) => saveClient(id, { pages, match: '' }));
      tr.querySelectorAll('[data-k]').forEach((el) => el.onchange = () => saveClient(id, { [el.dataset.k]: el.type === 'number' ? Number(el.value) : el.value }));
      tr.querySelector('[data-act=pause]').onclick = () => saveClient(id, { archived: !clients.find((c) => c.id === id).archived });
      const del = tr.querySelector('[data-act=del]');
      del.onclick = async () => {
        if (!del.dataset.arm) { del.dataset.arm = '1'; del.textContent = 'Tap again to delete'; setTimeout(() => { del.dataset.arm = ''; del.textContent = 'Delete'; }, 3000); return; }
        try { await api('/clients/' + id, { method: 'DELETE' }); clients = clients.filter((c) => c.id !== id); renderClients(); structSig = ''; renderChecklist(); toast('Client deleted'); } catch (e) { toast(e.message); }
      };
    });
  }
  async function saveClient(id, p) {
    try { const c = await api('/clients/' + id, { method: 'PATCH', body: p }); clients = clients.map((x) => x.id === id ? c : x); renderClients(); structSig = ''; renderChecklist(); toast('Saved'); }
    catch (e) { toast(e.message); }
  }
  $('addForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const body = { name: $('newName').value, pages: newPages, type: $('newType').value, budget: $('newBudget').value, lives: $('newLives').value, account: $('newAccount').value };
    try {
      const c = await api('/clients', { method: 'POST', body });
      clients.push(c); clients.sort((a, b) => a.name.localeCompare(b.name));
      $('newName').value = ''; $('newAccount').value = ''; newPages = []; drawNewPages();
      renderClients(); structSig = ''; renderChecklist(); toast('Added ' + c.name + '. Tap "Sync whole month" to fill past days.');
    } catch (e) { toast(e.message); }
  });

  // ---------- team ----------
  async function renderTeam() {
    const fmt = (d) => d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
    $('teamBody').innerHTML = (me.team || []).map((u) => {
      const soon = u.token_expires && new Date(u.token_expires) - Date.now() < 7 * 864e5;
      return `<tr><td>${esc(u.name)}</td><td class="num">${esc(u.fb_id)}</td><td>${fmt(u.updated_at)}</td><td class="${soon ? 'over' : ''}">${fmt(u.token_expires)}</td></tr>`;
    }).join('');
    $('tgInfo').textContent = me.telegram.configured
      ? `Sends automatically every day at ${me.telegram.time} (${me.tz}), after a fresh sync. Preview for ${nice(date)}:`
      : 'Not set up yet. Add TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID and REPORT_TIME to the server settings (see README). Preview:';
    try { $('reportPreview').textContent = (await api('/report/' + date)).text; } catch (e) { $('reportPreview').textContent = e.message; }
  }

  $('logoutBtn').onclick = async () => { await fetch('/auth/logout', { method: 'POST' }); location.href = '/login'; };

  // ---------- auto sync ----------
  let auto = null;
  function renderAuto() {
    if (!auto) return;
    $('autoSel').value = auto.enabled ? String(auto.everyMinutes) : '0';
    const last = auto.lastRun ? new Date(auto.lastRun).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : null;
    $('autoInfo').textContent = auto.enabled
      ? `Runs ${pad(auto.from)}:00–${pad(auto.to)}:59 · today and, before noon, yesterday${last ? ` · last run ${last}` : ''}`
      : 'Off. Tap Sync from Meta to update by hand.';
  }
  async function loadAuto() { try { auto = await api('/auto-sync'); renderAuto(); } catch (_) {} }
  $('autoSel').onchange = async () => {
    const v = Number($('autoSel').value);
    try {
      auto = await api('/auto-sync', { method: 'PUT', body: v ? { enabled: true, everyMinutes: v } : { enabled: false } });
      renderAuto(); toast(v ? `Auto sync on: every ${v >= 60 ? v / 60 + ' hour' + (v > 60 ? 's' : '') : v + ' min'}` : 'Auto sync off');
    } catch (e) { toast(e.message); }
  };
  // While the checklist is open on today, pull fresh numbers every 2 minutes (picks up auto-sync results).
  setInterval(async () => {
    if (document.hidden || $('tab-checklist').hidden || date !== (me && me.today)) return;
    if (document.activeElement && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
    try {
      const d = await api('/day/' + date);
      if (JSON.stringify(d.entries) !== JSON.stringify(day.entries) || JSON.stringify(d.meta) !== JSON.stringify(day.meta)) { day = d; renderChecklist(); renderSyncInfo(); loadMonth(); }
      loadAuto();
    } catch (_) {}
  }, 120000);

  // ---------- dashboard ----------
  let dMode = 'month', dDate = null, dData = null, dSort = { key: 'spend', asc: false };
  const monthLabel = (ym) => parse(ym + '-01').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const lastDay = (ym) => new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0).getDate();
  const typeLabel = { live: 'Live', post: 'Post', both: 'Post + live' };
  function dRange() {
    if (dMode === 'day') return [dDate, dDate];
    const ym = dDate.slice(0, 7); return [ym + '-01', ym + '-' + pad(lastDay(ym))];
  }
  function setMode(m) {
    dMode = m;
    $('dMode-day').setAttribute('aria-pressed', String(m === 'day'));
    $('dMode-month').setAttribute('aria-pressed', String(m === 'month'));
    $('dDay').hidden = m !== 'day'; $('dMonth').hidden = m !== 'month';
    loadDash();
  }
  $('dMode-day').onclick = () => setMode('day');
  $('dMode-month').onclick = () => setMode('month');
  const dShift = (n) => {
    const d = parse(dDate);
    if (dMode === 'day') d.setDate(d.getDate() + n); else { d.setDate(1); d.setMonth(d.getMonth() + n); }
    dDate = iso(d); loadDash();
  };
  $('dPrev').onclick = () => dShift(-1); $('dNext').onclick = () => dShift(1);
  $('dToday').onclick = () => { dDate = me.today; loadDash(); };
  $('dDay').onchange = () => { if ($('dDay').value) { dDate = $('dDay').value; loadDash(); } };
  $('dMonth').onchange = () => { if ($('dMonth').value) { dDate = $('dMonth').value + '-01'; loadDash(); } };
  $('dSearch').oninput = () => renderDash(); $('dType').onchange = () => renderDash(); $('dShowIdle').onchange = () => renderDash();
  document.querySelectorAll('.dtable th[data-sort]').forEach((th) => th.onclick = () => {
    const k = th.dataset.sort; dSort = { key: k, asc: dSort.key === k ? !dSort.asc : k === 'name' }; renderDash();
  });

  async function loadDash() {
    if (!dDate) dDate = me.today;
    $('dDay').value = dDate; $('dMonth').value = dDate.slice(0, 7);
    const [from, to] = dRange();
    $('dTableTitle').textContent = dMode === 'day' ? 'Clients · ' + nice(from) : 'Clients · ' + monthLabel(from.slice(0, 7));
    try { dData = await api(`/dashboard?from=${from}&to=${to}`); renderDash(); }
    catch (e) { $('dBody').innerHTML = `<tr><td colspan="10" class="muted">${esc(e.message)}</td></tr>`; }
  }

  function renderDash() {
    if (!dData) return;
    const q = $('dSearch').value.trim().toLowerCase(), type = $('dType').value, idle = $('dShowIdle').checked;
    let list = dData.clients.filter((c) => !c.archived || c.spend > 0)
      .filter((c) => idle || c.spend > 0)
      .filter((c) => !type || c.type === type)
      .filter((c) => !q || [c.name, ...c.pages].some((x) => x.toLowerCase().includes(q)));
    const k = dSort.key, dir = dSort.asc ? 1 : -1;
    list.sort((a, b) => (k === 'name' ? a.name.localeCompare(b.name) : (a[k] - b[k])) * dir || a.name.localeCompare(b.name));
    document.querySelectorAll('.dtable th[data-sort]').forEach((th) => { th.classList.toggle('sorted', th.dataset.sort === k); th.classList.toggle('asc', th.dataset.sort === k && dSort.asc); });

    const t = list.reduce((a, c) => ({ spend: a.spend + c.spend, planned: a.planned + c.planned, live: a.live + c.liveSpend, post: a.post + c.postSpend, lives: a.lives + c.lives, active: a.active + (c.spend > 0 ? 1 : 0) }), { spend: 0, planned: 0, live: 0, post: 0, lives: 0, active: 0 });
    $('dSpend').textContent = money(t.spend); $('dPlanned').textContent = money(t.planned);
    $('dSpend').classList.toggle('over', t.planned > 0 && t.spend > t.planned + 0.009);
    $('dSplit').textContent = `$${Math.round(t.live).toLocaleString('en-US')} / $${Math.round(t.post).toLocaleString('en-US')}`;
    $('dActive').textContent = t.active;

    const diffCell = (d) => `<td class="r num" style="color:${d > 0.009 ? 'var(--live)' : 'var(--ok)'}">${d > 0.009 ? '+' : d < -0.009 ? '−' : ''}${money(Math.abs(d))}</td>`;
    $('dBody').innerHTML = list.map((c) => {
      const pct = c.planned ? Math.min(100, c.spend / c.planned * 100) : 0, over = c.planned && c.spend > c.planned + 0.009;
      const extra = c.pages.filter((p) => p !== c.name);
      return `<tr class="clickable" data-cid="${c.id}"><td>${esc(c.name)}${extra.length ? `<div class="pg">${esc(extra.join(' · '))}</div>` : ''}${c.overDays && dMode === 'month' ? `<div class="pg" style="color:var(--live)">over budget ${c.overDays} day${c.overDays > 1 ? 's' : ''}</div>` : ''}</td>
        <td><span class="chip ${c.type === 'post' ? 'post' : 'live'}">${typeLabel[c.type] || c.type}</span></td>
        <td class="r num">${c.days}</td><td class="r num">${c.type === 'post' ? '–' : c.lives}</td>
        <td class="r num">${c.type === 'post' ? '–' : money(c.liveSpend)}</td><td class="r num">${c.type === 'live' ? '–' : money(c.postSpend)}</td>
        <td class="r num"><b>${money(c.spend)}</b></td><td class="r num">${money(c.planned)}</td>${diffCell(c.diff)}
        <td><div class="meter" title="${Math.round(c.planned ? c.spend / c.planned * 100 : 0)}% of budget"><i class="${over ? 'over' : ''}" style="width:${pct}%"></i></div></td></tr>`;
    }).join('') || `<tr><td colspan="10" class="muted">${dData.clients.length ? 'No client spend for this period.' : 'No clients yet. Add them on the Checklist page.'}</td></tr>`;
    $('dFoot').innerHTML = list.length ? `<tr><td>Total (${list.length})</td><td></td><td></td><td class="r num">${t.lives}</td><td class="r num">${money(t.live)}</td><td class="r num">${money(t.post)}</td><td class="r num">${money(t.spend)}</td><td class="r num">${money(t.planned)}</td>${diffCell(t.spend - t.planned)}<td></td></tr>` : '';
    document.querySelectorAll('#dBody tr[data-cid]').forEach((tr) => tr.onclick = () => {
      if (dMode === 'day') { date = dDate; showTab('checklist'); loadDay(); }
      else { $('dSearch').value = dData.clients.find((c) => c.id === Number(tr.dataset.cid)).name; setMode('day'); }
    });

    // Daily chart (month mode only), filtered to the visible clients.
    $('dChartPanel').hidden = dMode !== 'month';
    if (dMode === 'month') {
      const ids = new Set(list.map((c) => c.id));
      const days = dData.days.map((d) => ({ day: d.day, spend: dData.clients.filter((c) => ids.has(c.id)).reduce((s, c) => s + (c.daily[d.day] || 0), 0) }));
      const max = Math.max(1, ...days.map((d) => d.spend));
      $('dChartTitle').textContent = 'Spend per day · ' + money(days.reduce((s, d) => s + d.spend, 0));
      $('dChart').innerHTML = days.map((d) => `<button class="col${d.day === me.today ? ' today' : ''}" data-day="${d.day}" title="${nice(d.day)}: ${money(d.spend)}" aria-label="${nice(d.day)}: ${money(d.spend)}"><span class="b" style="height:${Math.max(1, d.spend / max * 100)}%"></span><span class="d">${Number(d.day.slice(8))}</span></button>`).join('');
      document.querySelectorAll('#dChart .col').forEach((b) => b.onclick = () => { dDate = b.dataset.day; setMode('day'); });
    }
  }

  // ---------- boot ----------
  (async () => {
    try {
      me = await api('/me');
      loadAuto();
      date = me.today || date;
      $('whoName').textContent = me.name;
      [clients, accounts] = await Promise.all([api('/clients'), api('/accounts')]);
      renderClients(); renderAccounts(); drawNewPages(); loadPages();
      await loadDay();
      const h = location.hash.slice(1);
      if (['dashboard', 'accounts', 'team'].includes(h)) showTab(h);
      else if (h === 'clients') $('clientsSection').scrollIntoView();
      else window.scrollTo(0, 0);
    } catch (e) { $('list').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  })();
})();
