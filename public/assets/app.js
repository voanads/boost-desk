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
    ['checklist', 'dashboard', 'clients', 'accounts', 'team'].forEach((t) => $('tab-' + t).hidden = t !== name);
    if (name === 'team') renderTeam();
    if (name === 'dashboard') loadDash();
    try { history.replaceState(null, '', '#' + name); } catch (_) {}
  }

  // ---------- checklist helpers ----------
  const active = () => clients.filter((c) => !c.archived);
  const entry = (cid) => day.entries[cid] || {};
  const liveCount = (c) => { const e = entry(c.id); return e.liveCount ?? 1; };
  function stats(c, e = entry(c.id)) {
    let spend = 0, total = 0, done = 0;
    if (hasPost(c)) { const p = e.post || {}; spend += Number(p.spend) || 0; total++; if (p.on) done++; }
    if (hasLive(c)) { const n = e.liveCount ?? 1; for (let i = 1; i <= n; i++) { const l = (e.lives || {})['l' + i] || {}; spend += Number(l.spend) || 0; total++; if (l.on) done++; } }
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
      $('newName').value = u.pageId && u.page === u.pageId ? '' : u.page; newPages = [u.page]; drawNewPages();
      $('newType').value = u.kind === 'post' ? 'post' : 'live';
      showTab('clients'); $('newType').focus();
      toast('Check the boost type, then tap Add client');
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
    const sig = date + '|' + list.map((c) => [c.id, c.type, c.name, hasLive(c) ? liveCount(c) : 0].join(':')).join(',');
    if (sig !== structSig) { structSig = sig; buildCards(list); }
    refreshValues();
  }

  function buildCards(list) {
    const box = $('list'); box.innerHTML = '';
    if (!list.length) { box.innerHTML = '<div class="empty">No clients yet. Add your first client in the <a href="#clients" id="toClients">Clients</a> tab, with their Facebook Page names.</div>'; const tc = $('toClients'); if (tc) tc.onclick = (e) => { e.preventDefault(); showTab('clients'); }; return; }
    for (const c of list) {
      const card = document.createElement('div'); card.className = 'card'; card.dataset.cid = c.id;
      card.innerHTML = `<div class="chead"><span class="name">${esc(c.name)}</span>${hasPost(c) ? '<span class="chip post">Post</span>' : ''}${hasLive(c) ? '<span class="chip live">Live</span>' : ''}<span class="chip meta" data-f="synced" hidden>From Meta</span><span class="ctot"><span class="hint">Spent</span> <b class="num" data-f="spent"></b></span></div><div class="rows"></div><div class="cfoot"></div>`;
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
        foot.append(minus, plus);
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
    let spend = 0, total = 0, done = 0, lives = 0, withSpend = 0;
    for (const c of active()) {
      const e = entry(c.id), s = stats(c, e);
      spend += s.spend; total += s.total; done += s.done; if (s.spend > 0) withSpend++;
      if (hasLive(c)) lives += Object.values(e.lives || {}).filter((l) => l && Number(l.spend) > 0).length;
      const card = document.querySelector(`.card[data-cid="${c.id}"]`); if (!card) continue;
      card.classList.toggle('is-done', s.total > 0 && s.done === s.total);
      card.querySelector('[data-f=spent]').textContent = money(s.spend);
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
    $('sSpend').textContent = money(spend); $('sLives').textContent = lives;
    $('sDone').textContent = done + ' / ' + total; $('sActive').textContent = withSpend + ' / ' + active().length;
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
    let T = 0, L = 0, D = 0;
    $('monthBody').innerHTML = list.length ? list.map((p) => { T += p.spend; L += hasLive(p.c) ? p.lives : 0; return `<tr><td>${esc(p.c.name)}</td><td class="r num">${p.days}</td><td class="r num">${hasLive(p.c) ? p.lives : '–'}</td><td class="r num">${money(p.spend)}</td><td class="r num">${money(p.spend / p.days)}</td></tr>`; }).join('') : '<tr><td colspan="5" class="muted">Nothing logged this month yet.</td></tr>';
    $('monthFoot').innerHTML = list.length ? `<tr><td>Total</td><td></td><td class="r num">${L}</td><td class="r num">${money(T)}</td><td></td></tr>` : '';
  }

  async function loadCheck() {
    let c = null; try { c = await api('/sync-check'); } catch (_) {}
    const el = $('syncCheck');
    if (!c || !c.checks) { el.textContent = ''; return; }
    const gaps = c.checks.filter((x) => x.missing > 0.5);
    const t = new Date(c.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    if (!gaps.length) { status(el, `✓ Checked at ${t}: all spend from ${c.checks.length} ad account${c.checks.length === 1 ? '' : 's'} was found (${nice(c.from).replace(/^\w+, /, '')} – ${nice(c.to).replace(/^\w+, /, '')}).`); return; }
    status(el, `⚠ Checked at ${t}: some spend was not found — ` + gaps.map((g) => `${g.account}: Meta ${money(g.meta)}, found ${money(g.found)} (missing ${money(g.missing)})`).join(' · ') + '. Tell your developer which accounts.', true);
  }

  // ---------- checklist actions ----------
  // Live progress: accounts are ~85% of the work, saving the days the rest.
  let progTimer = null;
  function showProgress(p) {
    const box = $('syncProg'); box.hidden = false;
    let pct = 0, text = 'Starting…';
    if (p.phase === 'accounts' && p.total) { pct = (p.done / p.total) * 85; text = `Reading ad account ${p.done + 1} of ${p.total}: ${p.account}`; }
    else if (p.phase === 'saving' && p.total) { pct = 85 + (p.done / p.total) * 15; text = `Saving day ${p.done + 1} of ${p.total}…`; }
    $('syncProgBar').style.width = Math.max(3, pct) + '%';
    $('syncProgText').textContent = text;
    $('syncProgTime').textContent = (p.elapsed || 0) + 's';
  }
  function watchProgress() {
    clearInterval(progTimer);
    progTimer = setInterval(async () => {
      try { const p = await api('/sync-progress'); if (p.running) showProgress(p); } catch (_) {}
    }, 1000);
  }
  function stopProgress() { clearInterval(progTimer); progTimer = null; $('syncProg').hidden = true; }

  $('syncBtn').onclick = async () => {
    const b = $('syncBtn'); b.disabled = true; b.textContent = 'Syncing 30 days…';
    status($('syncStatus'), '');
    showProgress({ phase: 'starting', elapsed: 0 }); watchProgress();
    const t0 = Date.now();
    try {
      const r = await api('/sync-recent', { method: 'POST', body: { around: date } });
      await loadDay(); loadPages(); loadCheck();
      toast(`Synced ${nice(r.from).replace(/^\w+, /, '')} – ${nice(r.to).replace(/^\w+, /, '')} in ${Math.round((Date.now() - t0) / 1000)}s · ${r.daysWithSpend} days with spend`);
    } catch (e) { status($('syncStatus'), e.message, true); }
    finally { stopProgress(); b.disabled = false; b.textContent = 'Sync from Meta'; }
  };
  // If a sync is already running (started by someone else or another tab), show it.
  (async () => { try { const p = await api('/sync-progress'); if (p.running) { showProgress(p); watchProgress(); const w = setInterval(async () => { const q = await api('/sync-progress').catch(() => ({})); if (!q.running) { clearInterval(w); stopProgress(); loadDay(); loadCheck(); } }, 1500); } } catch (_) {} })();
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

  function tgSelect(c) {
    if (!me || !me.telegram || !me.telegram.bot) return '<span class="hint">Add TELEGRAM_BOT_TOKEN to use groups</span>';
    const opts = [...tgChats];
    if (c.telegram && !opts.some((o) => o.id === c.telegram)) opts.push({ id: c.telegram, title: c.telegram_title || c.telegram });
    return `<select data-tg aria-label="Telegram group for ${esc(c.name)}"><option value="">No group</option>${opts.map((o) => `<option value="${esc(o.id)}" ${o.id === c.telegram ? 'selected' : ''}>${esc(o.title)}</option>`).join('')}</select>
      <button class="ghost rbtn" data-tgrefresh type="button">Refresh groups</button>`;
  }
  function renderClients() {
    const typeSel = (c) => `<select data-k="type">${[['live', 'Live'], ['post', 'Post'], ['both', 'Post + live']].map(([v, l]) => `<option value="${v}" ${c.type === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
    $('clientBody').innerHTML = clients.map((c) => `<tr data-cid="${c.id}">
      <td><input type="text" data-k="name" value="${esc(c.name)}" style="width:150px">${c.archived ? '<div class="hint">Paused</div>' : ''}</td>
      <td><span class="pages" data-pages></span></td>
      <td>${typeSel(c)}</td>
      <td><div class="tgcell">${tgSelect(c)}</div></td>
      <td><button class="ghost" data-act="pause">${c.archived ? 'Resume' : 'Pause'}</button><button class="ghost" data-act="del">Delete</button></td></tr>`).join('')
      || '<tr><td colspan="5" class="muted">No clients yet.</td></tr>';
    document.querySelectorAll('#clientBody tr[data-cid]').forEach((tr) => {
      const id = Number(tr.dataset.cid);
      const c0 = clients.find((c) => c.id === id);
      pageEditor(tr.querySelector('[data-pages]'), [...new Set([...(c0.pages || []), c0.match].filter(Boolean))], 'pg-' + id,
        (pages) => saveClient(id, { pages, match: '' }));
      tr.querySelectorAll('[data-k]').forEach((el) => el.onchange = () => saveClient(id, { [el.dataset.k]: el.type === 'number' ? Number(el.value) : el.value }));
      const tg = tr.querySelector('[data-tg]');
      if (tg) tg.onchange = () => { const o = tgChats.find((x) => x.id === tg.value); saveClient(id, { telegram: tg.value, telegram_title: o ? o.title : '' }); };
      const tr2 = tr.querySelector('[data-tgrefresh]');
      if (tr2) tr2.onclick = async () => { await loadChats(); toast(tgChats.length ? `${tgChats.length} group${tgChats.length > 1 ? 's' : ''} found` : 'No groups yet. Add the bot to a group and send a message there, then refresh.'); };
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
    const body = { name: $('newName').value, pages: newPages, type: $('newType').value };
    try {
      const c = await api('/clients', { method: 'POST', body });
      clients.push(c); clients.sort((a, b) => a.name.localeCompare(b.name));
      $('newName').value = ''; newPages = []; drawNewPages();
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

  // While the checklist is open on today, pull fresh numbers every 2 minutes (picks up auto-sync results).
  setInterval(async () => {
    if (document.hidden || $('tab-checklist').hidden || date !== (me && me.today)) return;
    if (document.activeElement && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
    try {
      const d = await api('/day/' + date);
      if (JSON.stringify(d.entries) !== JSON.stringify(day.entries) || JSON.stringify(d.meta) !== JSON.stringify(day.meta)) { day = d; renderChecklist(); renderSyncInfo(); loadMonth(); }
    } catch (_) {}
  }, 120000);

  // ---------- dashboard ----------
  let dMode = 'month', dDate = null, dFrom = null, dTo = null, dData = null, dSort = { key: 'spend', asc: false };
  const addD = (d, n) => { const x = parse(d); x.setDate(x.getDate() + n); return iso(x); };
  const monthLabel = (ym) => parse(ym + '-01').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const lastDay = (ym) => new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0).getDate();
  const typeLabel = { live: 'Live', post: 'Post', both: 'Post + live' };
  function dRange() {
    if (dMode === 'day') return [dDate, dDate];
    if (dMode === 'range') return [dFrom, dTo];
    const ym = dDate.slice(0, 7); return [ym + '-01', ym + '-' + pad(lastDay(ym))];
  }
  function setMode(m) {
    dMode = m;
    $('dMode-day').setAttribute('aria-pressed', String(m === 'day'));
    $('dMode-month').setAttribute('aria-pressed', String(m === 'month'));
    $('dMode-range').setAttribute('aria-pressed', String(m === 'range'));
    $('dDay').hidden = m !== 'day'; $('dMonth').hidden = m !== 'month'; $('dRangeBox').hidden = m !== 'range';
    if (m === 'range' && !dFrom) { dTo = dDate || me.today; dFrom = addD(dTo, -6); }
    loadDash();
  }
  // Quick periods
  function applyPreset(v) {
    const t = me.today;
    if (v === 'today') { dDate = t; setMode('day'); }
    else if (v === 'yesterday') { dDate = addD(t, -1); setMode('day'); }
    else if (v === '7' || v === '30') { dTo = t; dFrom = addD(t, -(Number(v) - 1)); setMode('range'); }
    else if (v === 'thisMonth') { dDate = t; setMode('month'); }
    else if (v === 'lastMonth') { const d = parse(t.slice(0, 8) + '01'); d.setMonth(d.getMonth() - 1); dDate = iso(d); setMode('month'); }
    else if (v === 'custom') { if (!dFrom) { dTo = t; dFrom = addD(t, -13); } setMode('range'); $('dFrom').focus(); }
  }
  $('dPreset').onchange = () => applyPreset($('dPreset').value);
  $('dMode-range').onclick = () => { $('dPreset').value = 'custom'; setMode('range'); };
  $('dFrom').onchange = () => { if ($('dFrom').value) { dFrom = $('dFrom').value; if (dTo < dFrom) dTo = dFrom; $('dPreset').value = 'custom'; loadDash(); } };
  $('dTo').onchange = () => { if ($('dTo').value) { dTo = $('dTo').value; if (dFrom > dTo) dFrom = dTo; $('dPreset').value = 'custom'; loadDash(); } };
  $('dMode-day').onclick = () => setMode('day');
  $('dMode-month').onclick = () => setMode('month');
  const dShift = (n) => {
    const d = parse(dDate);
    if (dMode === 'range') { // move the whole range by its own length
      const len = Math.round((parse(dTo) - parse(dFrom)) / 864e5) + 1;
      dFrom = addD(dFrom, n * len); dTo = addD(dTo, n * len); $('dPreset').value = 'custom'; loadDash(); return;
    }
    if (dMode === 'day') d.setDate(d.getDate() + n); else { d.setDate(1); d.setMonth(d.getMonth() + n); }
    dDate = iso(d); $('dPreset').value = dMode === 'day' ? (dDate === me.today ? 'today' : dDate === addD(me.today, -1) ? 'yesterday' : 'custom') : (dDate.slice(0, 7) === me.today.slice(0, 7) ? 'thisMonth' : 'custom');
    loadDash();
  };
  $('dPrev').onclick = () => dShift(-1); $('dNext').onclick = () => dShift(1);
  $('dDay').onchange = () => { if ($('dDay').value) { dDate = $('dDay').value; loadDash(); } };
  $('dMonth').onchange = () => { if ($('dMonth').value) { dDate = $('dMonth').value + '-01'; loadDash(); } };
  $('dSearch').oninput = () => renderDash(); $('dType').onchange = () => renderDash(); $('dShowIdle').onchange = () => renderDash();
  document.querySelectorAll('.dtable th[data-sort]').forEach((th) => th.onclick = () => {
    const k = th.dataset.sort; dSort = { key: k, asc: dSort.key === k ? !dSort.asc : k === 'name' }; renderDash();
  });

  async function loadDash() {
    if (!$('rPanel').hidden && rTarget) openReport(rTarget.kind === 'client' ? rTarget.id : null);
    if (!dDate) dDate = me.today;
    $('dDay').value = dDate; $('dMonth').value = dDate.slice(0, 7);
    if (dFrom) { $('dFrom').value = dFrom; $('dTo').value = dTo; }
    const [from, to] = dRange();
    $('dTableTitle').textContent = 'Clients · ' + periodLabel();
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

    const t = list.reduce((a, c) => ({ spend: a.spend + c.spend, live: a.live + c.liveSpend, post: a.post + c.postSpend, lives: a.lives + c.lives, active: a.active + (c.spend > 0 ? 1 : 0) }), { spend: 0, live: 0, post: 0, lives: 0, active: 0 });
    $('dSpend').textContent = money(t.spend); $('dLives').textContent = t.lives;
    $('dSplit').textContent = `$${Math.round(t.live).toLocaleString('en-US')} / $${Math.round(t.post).toLocaleString('en-US')}`;
    $('dActive').textContent = t.active;

    const top = Math.max(0.01, ...list.map((c) => c.spend));
    $('dBody').innerHTML = list.map((c) => {
      const share = t.spend ? c.spend / t.spend * 100 : 0;
      const extra = c.pages.filter((p) => p !== c.name);
      return `<tr class="clickable" data-cid="${c.id}"><td>${esc(c.name)}${extra.length ? `<div class="pg">${esc(extra.join(' · '))}</div>` : ''}</td>
        <td><span class="chip ${c.type === 'post' ? 'post' : 'live'}">${typeLabel[c.type] || c.type}</span></td>
        <td class="r num">${c.days}</td><td class="r num">${c.type === 'post' ? '–' : c.lives}</td>
        <td class="r num">${c.type === 'post' ? '–' : money(c.liveSpend)}</td><td class="r num">${c.type === 'live' ? '–' : money(c.postSpend)}</td>
        <td class="r num"><b>${money(c.spend)}</b></td><td class="r num">${c.days ? money(c.spend / c.days) : '–'}</td>
        <td><div class="sharecell"><div class="meter" title="${share.toFixed(1)}% of total spend"><i style="width:${c.spend / top * 100}%"></i></div><span class="hint num">${share.toFixed(0)}%</span></div></td>
        <td><button class="rbtn" data-report="${c.id}">Report${c.telegram ? ' ✈' : ''}</button></td></tr>`;
    }).join('') || `<tr><td colspan="10" class="muted">${dData.clients.length ? 'No client spend for this period.' : 'No clients yet. Add them in the Clients tab.'}</td></tr>`;
    $('dFoot').innerHTML = list.length ? `<tr><td>Total (${list.length})</td><td></td><td></td><td class="r num">${t.lives}</td><td class="r num">${money(t.live)}</td><td class="r num">${money(t.post)}</td><td class="r num">${money(t.spend)}</td><td></td><td></td><td></td></tr>` : '';
    document.querySelectorAll('#dBody [data-report]').forEach((b) => b.onclick = (ev) => { ev.stopPropagation(); openReport(Number(b.dataset.report)); });
    document.querySelectorAll('#dBody tr[data-cid]').forEach((tr) => tr.onclick = () => {
      if (dMode === 'day') { date = dDate; showTab('checklist'); loadDay(); }
      else { const n = dData.clients.find((c) => c.id === Number(tr.dataset.cid)).name; $('dSearch').value = $('dSearch').value === n ? '' : n; renderDash(); }
    });

    // Daily chart (month mode only), filtered to the visible clients.
    $('dChartPanel').hidden = dMode === 'day';
    if (dMode !== 'day') {
      const ids = new Set(list.map((c) => c.id));
      const days = dData.days.map((d) => ({ day: d.day, spend: dData.clients.filter((c) => ids.has(c.id)).reduce((s, c) => s + (c.daily[d.day] || 0), 0) }));
      const max = Math.max(1, ...days.map((d) => d.spend));
      $('dChartTitle').textContent = 'Spend per day · ' + money(days.reduce((s, d) => s + d.spend, 0));
      $('dChart').innerHTML = days.map((d) => `<button class="col${d.day === me.today ? ' today' : ''}" data-day="${d.day}" title="${nice(d.day)}: ${money(d.spend)}" aria-label="${nice(d.day)}: ${money(d.spend)}"><span class="b" style="height:${Math.max(1, d.spend / max * 100)}%"></span><span class="d">${Number(d.day.slice(8))}</span></button>`).join('');
      document.querySelectorAll('#dChart .col').forEach((b) => b.onclick = () => { dDate = b.dataset.day; $('dPreset').value = dDate === me.today ? 'today' : 'custom'; setMode('day'); });
    }
  }

  // ---------- reports (per client + team summary) ----------
  let rTarget = null; // { kind: 'client', id } or { kind: 'team' }
  const shortD = (d) => parse(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const periodLabel = () => dMode === 'day' ? nice(dDate) : dMode === 'month' ? monthLabel(dDate.slice(0, 7)) : `${shortD(dFrom)} – ${shortD(dTo)} ${dTo.slice(0, 4)}`;
  async function openReport(clientId) {
    const [from, to] = dRange();
    rTarget = clientId ? { kind: 'client', id: clientId } : { kind: 'team' };
    $('rPanel').hidden = false; $('rText').value = 'Loading…'; $('rSend').disabled = true;
    $('rPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    try {
      if (clientId) {
        const r = await api(`/client-report/${clientId}?from=${from}&to=${to}`);
        $('rTitle').textContent = `${r.client.name} · ${periodLabel()}`;
        $('rText').value = r.text;
        rTarget.hasGroup = !!r.client.telegram;
        $('rTo').textContent = r.client.telegram ? `Sends to Telegram group: ${r.client.telegramTitle || r.client.telegram}` : 'No Telegram group for this client yet. Copy the text, or pick a group in the Clients tab.';
        $('rSend').textContent = 'Send to client group';
        $('rSend').disabled = !r.client.telegram || !(me.telegram && me.telegram.bot);
      } else {
        const r = await api(`/summary?from=${from}&to=${to}`);
        $('rTitle').textContent = `Team summary · ${periodLabel()}`;
        $('rText').value = r.text;
        $('rTo').textContent = me.telegram.configured ? 'Sends to your team Telegram group.' : 'Team Telegram group not set (TELEGRAM_CHAT_ID). You can still copy the text.';
        $('rSend').textContent = 'Send to team group';
        $('rSend').disabled = !me.telegram.configured;
      }
    } catch (e) { $('rText').value = e.message; }
  }
  $('dTeamReport').onclick = () => openReport(null);
  $('rClose').onclick = () => { $('rPanel').hidden = true; rTarget = null; };
  $('rCopy').onclick = async () => {
    const t = $('rText').value;
    try { await navigator.clipboard.writeText(t); toast('Report copied'); }
    catch (_) { $('rText').select(); try { document.execCommand('copy'); toast('Report copied'); } catch (__) { toast('Select the text and copy it'); } }
  };
  $('rSend').onclick = async () => {
    if (!rTarget) return;
    const [from, to] = dRange(), b = $('rSend'); b.disabled = true;
    try {
      if (rTarget.kind === 'client') { const r = await api(`/client-report/${rTarget.id}/send`, { method: 'POST', body: { from, to, text: $('rText').value } }); toast('Sent to ' + r.sentTo); }
      else { await api('/summary/send', { method: 'POST', body: { from, to, text: $('rText').value } }); toast('Sent to the team group'); }
    } catch (e) { toast(e.message); } finally { b.disabled = false; }
  };

  // ---------- Telegram groups for clients ----------
  let tgChats = [];
  async function loadChats() {
    if (!me || !me.telegram || !me.telegram.bot) return;
    try { tgChats = await api('/telegram/chats'); } catch (_) { tgChats = []; }
    renderClients();
  }

  // ---------- boot ----------
  (async () => {
    try {
      me = await api('/me');
      loadChats(); loadCheck();
      date = me.today || date;
      $('whoName').textContent = me.name;
      [clients, accounts] = await Promise.all([api('/clients'), api('/accounts')]);
      renderClients(); renderAccounts(); drawNewPages(); loadPages();
      await loadDay();
      const h = location.hash.slice(1);
      if (['dashboard', 'clients', 'accounts', 'team'].includes(h)) showTab(h);
      else window.scrollTo(0, 0);
    } catch (e) { $('list').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  })();
})();
