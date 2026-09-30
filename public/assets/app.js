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

  function toast(t) { const el = document.createElement('div'); el.className = 'toast'; el.textContent = t; document.body.appendChild(el); setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, 2400); }
  // Count numbers up/down smoothly when they change.
  const calm = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  function countTo(el, to, fmt) {
    const from = el._v ?? 0; el._v = to; cancelAnimationFrame(el._raf);
    if (calm || from === to) { el.textContent = fmt(to); return; }
    const t0 = performance.now(), dur = 650;
    const step = (t) => { const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3); el.textContent = fmt(from + (to - from) * e); if (k < 1) el._raf = requestAnimationFrame(step); };
    el._raf = requestAnimationFrame(step);
  }
  const intF = (v) => String(Math.round(v));

  // ---------- motion kit ----------
  // 1) Ticker: digits roll into place like an airport board.
  function rollTo(el, text) {
    if (!el) return;
    el.setAttribute('aria-label', text);
    if (calm) { el.textContent = text; el._roll = text; return; }
    const shape = (t) => [...t].map((c) => (/\d/.test(c) ? 'd' : c)).join('');
    if (!el._roll || shape(el._roll) !== shape(text)) {
      el.innerHTML = [...text].map((c) => /\d/.test(c)
        ? '<span class="rd"><span class="rs">' + '0123456789'.split('').map((d) => `<span>${d}</span>`).join('') + '</span></span>'
        : `<span class="rc">${esc(c)}</span>`).join('');
      void el.offsetWidth;
    }
    const digits = [...text].filter((c) => /\d/.test(c));
    el.querySelectorAll('.rs').forEach((st, i) => { st.style.transitionDelay = (i * 45) + 'ms'; st.style.transform = `translateY(${-Number(digits[i]) * 1.15}em)`; });
    el._roll = text;
  }
  // Float a little label up from an element (e.g. "+$12.40").
  function floatUp(anchorEl, text, cls = '') {
    if (calm || !anchorEl) return;
    const r = anchorEl.getBoundingClientRect(), f = document.createElement('div');
    f.className = 'floatup ' + cls; f.textContent = text; document.body.appendChild(f);
    f.style.left = r.left + scrollX + r.width / 2 + 'px'; f.style.top = r.top + scrollY + 'px';
    f.animate([{ opacity: 0, transform: 'translate(-50%, 6px) scale(.8)' }, { opacity: 1, transform: 'translate(-50%, -14px) scale(1.05)', offset: .25 }, { opacity: 0, transform: 'translate(-50%, -46px) scale(1)' }], { duration: 1600, easing: 'cubic-bezier(.2,.7,.2,1)' }).onfinish = () => f.remove();
  }
  // Confetti burst from an element.
  function confetti(anchorEl, n = 26) {
    if (calm || !anchorEl || !document.body.animate) return;
    const r = anchorEl.getBoundingClientRect(), cx = r.left + scrollX + r.width / 2, cy = r.top + scrollY + r.height / 2;
    const colors = ['#8B5CF6', '#5B45F0', '#34D399', '#F5B041', '#FF6B6E', '#60A5FA'];
    for (let i = 0; i < n; i++) {
      const c = document.createElement('i'); c.className = 'confetto'; c.style.background = colors[i % colors.length];
      c.style.left = cx + 'px'; c.style.top = cy + 'px'; document.body.appendChild(c);
      const a = Math.random() * Math.PI * 2, v = 60 + Math.random() * 90, dx = Math.cos(a) * v, dy = Math.sin(a) * v - 40, rot = (Math.random() - .5) * 720;
      c.animate([{ transform: 'translate(-50%,-50%) rotate(0) scale(1)', opacity: 1 }, { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) rotate(${rot / 2}deg)`, opacity: 1, offset: .5 }, { transform: `translate(calc(-50% + ${dx * 1.2}px), calc(-50% + ${dy + 90}px)) rotate(${rot}deg) scale(.6)`, opacity: 0 }],
        { duration: 1100 + Math.random() * 500, easing: 'cubic-bezier(.2,.6,.4,1)' }).onfinish = () => c.remove();
    }
  }
  // Green success badge that slides in from the right.
  function successBadge(text) {
    const b = document.createElement('div'); b.className = 'okbadge'; b.innerHTML = `<span class="ok-ic">✓</span>${esc(text)}`; document.body.appendChild(b);
    const kf = calm ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: 'translateX(120%)' }, { opacity: 1, transform: 'translateX(-8px)', offset: .7 }, { opacity: 1, transform: 'none' }];
    b.animate(kf, { duration: 450, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'both' });
    setTimeout(() => b.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: calm ? 'none' : 'translateX(40px)' }], { duration: 350, fill: 'both' }).onfinish = () => b.remove(), 2800);
  }
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
  const ink = document.createElement('span'); ink.className = 'tab-ink'; document.querySelector('nav.tabs').appendChild(ink);
  function moveInk() {
    const b = document.querySelector('nav.tabs button[aria-selected=true]'); if (!b) return;
    ink.style.left = b.offsetLeft + 'px'; ink.style.width = b.offsetWidth + 'px'; ink.style.top = b.offsetTop + 'px'; ink.style.height = b.offsetHeight + 'px';
    ink.classList.add('on');
  }
  addEventListener('resize', () => { ink.style.transition = 'none'; moveInk(); requestAnimationFrame(() => { ink.style.transition = ''; }); });
  function showTab(name) {
    if (name === 'checklist') name = 'dashboard'; // Home was merged into the Dashboard
    document.querySelectorAll('nav.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
    if (name === 'admin' && !(me && me.canAdmin)) name = 'dashboard';
    ['dashboard', 'clients', 'accounts', 'admin', 'team'].forEach((t) => $('tab-' + t).hidden = t !== name);
    moveInk();
    if (name === 'team') renderTeam();
    if (name === 'dashboard') loadDash();
    if (name === 'clients') loadClientMonth();
    if (name === 'admin') loadAdmin();
    if (name === 'accounts') api('/accounts').then((a) => { accounts = a; renderAccounts(); }).catch(() => {});
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
      showTab('clients');
      openClientDlg(null, { name: u.pageId && u.page === u.pageId ? '' : u.page, pages: [u.page], type: u.kind === 'post' ? 'post' : 'live' });
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
    if (!list.length) { box.innerHTML = '<div class="empty"><b>Your workspace is empty.</b><br>1. Tap <b>Sync from Meta</b> to load your ad accounts and the last 30 days of spend.<br>2. Then add your clients in the <a href="#clients" id="toClients">Clients</a> tab (or tap <b>New client</b> on each Page listed under “Spend not matched”).</div>'; const tc = $('toClients'); if (tc) tc.onclick = (e) => { e.preventDefault(); showTab('clients'); }; return; }
    for (const [i, c] of list.entries()) {
      const card = document.createElement('div'); card.className = 'card'; card.dataset.cid = c.id; card.style.setProperty('--i', Math.min(i, 12));
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
      const rep = document.createElement('button'); rep.className = 'repbtn'; rep.dataset.f = 'rep';
      rep.innerHTML = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M21.5 3.5 2.5 11l7 2.5 2.5 7 9.5-17Z"/><path d="m9.5 13.5 5-5"/></svg><span>Send report</span>';
      rep.onclick = () => openDayReport(c.id);
      foot.appendChild(rep);
      box.appendChild(card);
    }
  }

  function makeRow(c, key, label, isLive) {
    const row = document.createElement('div'); row.className = 'row'; row.dataset.key = key;
    row.innerHTML = `<div class="rlabel"><span>${label}</span><span class="hint" data-f="camp"></span></div>` +
      (isLive ? `<input type="text" class="time num" id="tm-${c.id}-${key}" placeholder="time">` : '<span></span>') +
      `<span class="spend"><span class="muted">$</span><input type="number" min="0" step="0.01" inputmode="decimal" id="sp-${c.id}-${key}" placeholder="0.00"></span><span></span>`;
    const mk = (v) => key === 'post' ? { post: v } : { lives: { [key]: v } };
    const sp = row.querySelector('input[type=number]'), tm = row.querySelector('input.time');
    let t; sp.oninput = () => { clearTimeout(t); t = setTimeout(() => patch(c.id, mk({ spend: sp.value === '' ? 0 : Number(sp.value) })), 600); };
    if (tm) { let tt; tm.oninput = () => { clearTimeout(tt); tt = setTimeout(() => patch(c.id, mk({ time: tm.value })), 700); }; }
    return row;
  }

  function refreshValues() {
    let spend = 0, total = 0, done = 0, lives = 0, withSpend = 0, posts = 0;
    for (const c of active()) {
      const e = entry(c.id), s = stats(c, e);
      spend += s.spend; total += s.total; done += s.done; if (s.spend > 0) withSpend++;
      if (hasLive(c)) lives += Object.values(e.lives || {}).filter((l) => l && Number(l.spend) > 0).length;
      if (hasPost(c) && Number((e.post || {}).spend) > 0) posts++;
      const card = document.querySelector(`.card[data-cid="${c.id}"]`); if (!card) continue;
      card.classList.toggle('is-done', s.spend > 0);
      card.querySelector('[data-f=spent]').textContent = money(s.spend);
      card.querySelector('[data-f=synced]').hidden = !e.syncedAt;
      card.querySelectorAll('.row').forEach((row) => {
        const key = row.dataset.key; const v = key === 'post' ? (e.post || {}) : ((e.lives || {})[key] || {});
        const sp = row.querySelector('input[type=number]'), tm = row.querySelector('input.time');
        row.classList.toggle('done', Number(v.spend) > 0);
        if (document.activeElement !== sp) sp.value = v.spend ? v.spend : '';
        if (tm && document.activeElement !== tm) tm.value = v.time || '';
        row.querySelector('[data-f=camp]').textContent = v.campaigns ? `· ${v.campaigns} campaign${v.campaigns > 1 ? 's' : ''}` : '';
      });
      const note = card.querySelector('[data-f=note]'); if (document.activeElement !== note) note.value = e.note || '';
      const rep = card.querySelector('[data-f=rep]');
      if (rep) {
        const sent = e.reportSent && e.reportSent.at;
        rep.classList.toggle('sent', !!sent);
        rep.querySelector('span').textContent = sent ? '✓ Sent ' + new Date(sent).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : 'Send report';
        rep.title = sent ? `Report sent by ${e.reportSent.by || 'you'} — tap to send again` : 'Preview and send this day\'s report to the client\'s Telegram group';
      }
    }
    countTo($('sSpend'), spend, money); countTo($('sLives'), lives, intF);
    countTo($('sDone'), posts, intF); countTo($('sActive'), withSpend, (v) => Math.round(v) + ' / ' + active().length);
    $('listTitle').textContent = nice(date).replace(/ \d{4}$/, '');
    $('listHint').textContent = withSpend ? `${lives} live${lives === 1 ? '' : 's'} · ${posts} boost post${posts === 1 ? '' : 's'} · ${money(spend)}` : 'No boost spend yet';
  }

  async function loadMonth() {
    const ym = date.slice(0, 7);
    $('monthTitle').textContent = parse(date).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    let rows = [];
    try { rows = await api('/month/' + ym); } catch (_) { return; }
    const per = {};
    for (const r of rows) {
      const c = clients.find((x) => x.id === r.client_id); if (!c) continue;
      const s = stats(c, r.data); if (!(s.spend > 0)) continue;
      const p = per[c.id] || (per[c.id] = { c, days: 0, spend: 0, lives: 0 });
      p.days++; p.spend += s.spend;
      if (hasLive(c)) p.lives += Object.values(r.data.lives || {}).filter((l) => l && Number(l.spend) > 0).length;
    }
    const list = Object.values(per).sort((a, b) => b.spend - a.spend);
    let T = 0, L = 0, D = 0;
    $('monthBody').innerHTML = list.length ? list.map((p) => { T += p.spend; L += hasLive(p.c) ? p.lives : 0; return `<tr><td>${esc(p.c.name)}</td><td class="r num">${p.days}</td><td class="r num">${hasLive(p.c) ? p.lives : '–'}</td><td class="r num">${money(p.spend)}</td><td class="r num">${money(p.spend / p.days)}</td></tr>`; }).join('') : '<tr><td colspan="5" class="muted">Nothing logged this month yet.</td></tr>';
    $('monthFoot').innerHTML = list.length ? `<tr><td>Total</td><td></td><td class="r num">${L}</td><td class="r num">${money(T)}</td><td></td></tr>` : '';
  }

  async function loadCheck() {
    let c = null; try { c = await api('/sync-check'); } catch (_) {}
    const el = $('syncCheck');
    if (!c || !c.checks || !c.from || !c.to) { el.textContent = ''; return; }
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
    if (p.phase === 'accounts' && !p.total) { pct = 2; text = 'Loading your ad accounts…'; }
    else if (p.phase === 'accounts' && p.total) { pct = (p.done / p.total) * 85; text = `Reading ad account ${p.done + 1} of ${p.total}: ${p.account}`; }
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
    const b = $('syncBtn'); b.disabled = true; b.classList.add('syncing'); b.innerHTML = '<svg class="inf" viewBox="0 0 48 24" aria-hidden="true"><path d="M12 4a8 8 0 1 0 0 16c6 0 18-16 24-16a8 8 0 1 1 0 16C30 20 18 4 12 4Z"/></svg>Syncing 30 days…';
    let ok = false;
    status($('syncStatus'), '');
    showProgress({ phase: 'starting', elapsed: 0 }); watchProgress();
    const t0 = Date.now();
    try {
      const [vf, vt] = dDate ? dRange() : [date, date];
      const r = await api('/sync-recent', { method: 'POST', body: { around: date, from: vf, to: vt } });
      await loadDay(); loadPages(); loadCheck(); loadDash();
      try { accounts = await api('/accounts'); renderAccounts(); } catch (_) {}
      toast(`Synced ${nice(r.from).replace(/^\w+, /, '')} – ${nice(r.to).replace(/^\w+, /, '')} in ${Math.round((Date.now() - t0) / 1000)}s · ${r.daysWithSpend} days with spend`);
      ok = true;
    } catch (e) { status($('syncStatus'), e.message, true); }
    finally {
      stopProgress(); b.classList.remove('syncing');
      if (ok) {
        b.classList.add('synced'); b.innerHTML = '<svg class="chk" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>Synced';
        confetti(b);
        setTimeout(() => { b.classList.remove('synced'); b.textContent = 'Sync from Meta'; b.disabled = false; }, 1800);
      } else { b.disabled = false; b.textContent = 'Sync from Meta'; }
    }
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
        <td class="r num">${i.todayError ? '<span class="hint" title="' + esc(i.todayError) + '">error</span>' : i.todaySpend != null ? (Number(i.todaySpend) > 0 ? '<b>' + money(i.todaySpend) + '</b>' : '<span class="muted">$0.00</span>') : '<span class="muted">–</span>'}</td>
        <td class="r num">${money(i.balance)}${cur}</td><td class="r num">${cap}</td><td class="r num">${money(i.amountSpent)}</td></tr>`;
    }).join('') || '<tr><td colspan="8" class="muted">No ad accounts loaded yet. Tap Refresh from Meta.</td></tr>';
    $('aCount').textContent = accounts.length; $('aActive').textContent = act; $('aBad').textContent = bad;
    $('aBad').classList.toggle('over', bad > 0); $('aToday').textContent = money(today);
    const seen = accounts.map((a) => a.seen_at).sort().pop();
    const tAt = accounts.map((a) => a.info && a.info.todayAt).filter(Boolean).sort().pop();
    if (seen) $('acctUpdated').textContent = (tAt ? "Today's spend as of " + new Date(tAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) + ' (updates with every sync). ' : '') + 'Ticked accounts are included in Sync.';
    document.querySelectorAll('[data-acct]').forEach((cb) => cb.onchange = () => api('/accounts/' + encodeURIComponent(cb.dataset.acct), { method: 'PATCH', body: { enabled: cb.checked } }).then(() => toast(cb.checked ? 'Included in sync' : 'Left out of sync')).catch((e) => toast(e.message)));
  }
  $('refreshAccts').onclick = async () => {
    const b = $('refreshAccts'); b.disabled = true; b.textContent = 'Refreshing…';
    try { accounts = await api('/accounts/refresh', { method: 'POST' }); renderAccounts(); toast("Ad accounts and today's spend updated"); if (date === me.today) loadDay(); }
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
  async function loadPages() {
    try {
      const pages = await api('/pages');
      $('pageList').innerHTML = pages.map((p) => `<option value="${esc(p.name)}"></option>`).join('');
    } catch (_) {}
  }
  const isId = (p) => /^\d{6,}$/.test(p);
  const typeTags = (t) => (t === 'live' || t === 'both' ? '<span class="chip live">Live</span>' : '') + (t === 'post' || t === 'both' ? '<span class="chip post">Post</span>' : '');

  // This month's spend per client, shown on the cards.
  let cMonth = {};
  async function loadClientMonth() {
    const t = (me && me.today) || iso(new Date()), ym = t.slice(0, 7);
    try {
      const d = await api(`/dashboard?from=${ym}-01&to=${t}`);
      cMonth = Object.fromEntries(d.clients.map((c) => [c.id, c]));
      renderClients();
    } catch (_) {}
  }

  function renderClients() {
    const q = ($('cSearch').value || '').trim().toLowerCase();
    const list = clients.filter((c) => !q || [c.name, ...(c.pages || [])].some((x) => String(x).toLowerCase().includes(q)))
      .sort((a, b) => (a.archived - b.archived) || ((cMonth[b.id]?.spend || 0) - (cMonth[a.id]?.spend || 0)) || a.name.localeCompare(b.name));
    $('cCount').textContent = clients.filter((c) => !c.archived).length;
    $('cGrid').innerHTML = list.map((c, i) => {
      const pages = [...new Set([...(c.pages || []), c.match].filter(Boolean))];
      const m = cMonth[c.id];
      const tg = c.telegram ? `<span class="tgok">✈ ${esc(c.telegram_title || 'Telegram group')}</span>` : '<span class="muted">No Telegram group</span>';
      return `<button class="ccard${c.archived ? ' paused' : ''}" data-edit="${c.id}" style="--i:${Math.min(i, 12)}">
        <div class="cc-top"><span class="cc-title"><b class="cc-name">${esc(c.name)}</b>${typeTags(c.type)}${c.archived ? '<span class="chip meta">Paused</span>' : ''}</span><span class="cc-edit">Edit</span></div>
        <div class="cc-pages">${pages.length ? pages.map((p) => `<span class="pchip ro${isId(p) ? ' id' : ''}">${isId(p) ? 'Page ID …' + esc(p.slice(-5)) : esc(p)}</span>`).join('') : '<span class="warnline">⚠ No Facebook Page yet — tap to add one</span>'}</div>
        <div class="cc-foot"><span class="cc-month">${m && m.spend ? `This month <b class="num">${money(m.spend)}</b>${m.lives ? ` · ${m.lives} live${m.lives === 1 ? '' : 's'}` : ''}` : '<span class="muted">No spend this month</span>'}</span>${tg}</div>
      </button>`;
    }).join('') || `<div class="empty">${clients.length ? 'No client matches your search.' : '<b>No clients yet.</b><br>Tap <b>+ Add client</b>, or tap <b>Sync from Meta</b> on Home and add the Pages it finds.'}</div>`;
    document.querySelectorAll('#cGrid [data-edit]').forEach((b) => b.onclick = () => openClientDlg(clients.find((c) => c.id === Number(b.dataset.edit))));
  }
  $('cSearch').oninput = () => renderClients();

  // Add / edit dialog
  let cEdit = null, cDraft = null;
  function drawDlgPages() { pageEditor($('cPages'), cDraft.pages, 'cpg', (p) => { cDraft.pages = p; drawDlgPages(); }); }
  function drawDlgType() { document.querySelectorAll('#cType button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === cDraft.type))); }
  document.querySelectorAll('#cType button').forEach((b) => b.onclick = () => { cDraft.type = b.dataset.v; drawDlgType(); });
  function drawDlgTg() {
    const box = $('cTgBox');
    if (!me || !me.telegram || !me.telegram.bot) { box.innerHTML = '<div class="note">The Telegram bot is not set up on the server yet (TELEGRAM_BOT_TOKEN in Railway), so groups can’t be picked. Reports can still be copied.</div>'; return; }
    const opts = [...tgChats];
    if (cDraft.telegram && !opts.some((o) => o.id === cDraft.telegram)) opts.push({ id: cDraft.telegram, title: cDraft.telegram_title || cDraft.telegram });
    box.innerHTML = `<div class="tgrow"><select id="cTg"><option value="">No group</option>${opts.map((o) => `<option value="${esc(o.id)}" ${o.id === cDraft.telegram ? 'selected' : ''}>${esc(o.title)}</option>`).join('')}</select><button type="button" id="cTgRefresh">Refresh list</button></div>
      <div class="linkhelp"><b>Connect a group:</b> add ${tgBot ? '<b>@' + esc(tgBot) + '</b>' : 'the bot'} to the client's Telegram group, send <code class="lcode" title="Tap to copy">/link ${esc(tgCode)}</code> in the group, then tap <b>Refresh list</b>. Only you see groups linked with your code.</div>`;
    const lc = box.querySelector('.lcode'); if (lc) lc.onclick = async () => { try { await navigator.clipboard.writeText(lc.textContent); toast('Copied — paste it in the Telegram group'); } catch (_) {} };
    $('cTg').onchange = () => { const o = opts.find((x) => x.id === $('cTg').value); cDraft.telegram = $('cTg').value; cDraft.telegram_title = o ? o.title : ''; };
    $('cTgRefresh').onclick = async () => { await loadChats(); drawDlgTg(); toast(tgChats.length ? `${tgChats.length} group${tgChats.length > 1 ? 's' : ''} found` : 'No groups yet — add the bot to a group and send a message there.'); };
  }
  function openClientDlg(c, preset) {
    cEdit = c || null;
    cDraft = c ? { name: c.name, type: c.type, pages: [...new Set([...(c.pages || []), c.match].filter(Boolean))], telegram: c.telegram || '', telegram_title: c.telegram_title || '' }
      : { name: '', type: 'live', pages: [], telegram: '', telegram_title: '', ...(preset || {}) };
    $('cDlgTitle').textContent = c ? 'Edit ' + c.name : 'Add client';
    $('cName').value = cDraft.name; $('cSave').textContent = c ? 'Save changes' : 'Add client';
    $('cDel').hidden = !c; $('cPause').hidden = !c; if (c) $('cPause').textContent = c.archived ? 'Resume' : 'Pause';
    $('cDel').textContent = 'Delete'; $('cDel').dataset.arm = '';
    drawDlgType(); drawDlgPages(); drawDlgTg();
    const d = $('cDlg'); if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '');
    setTimeout(() => (c ? $('cpg-add') : $('cName')).focus(), 60);
  }
  const closeClientDlg = () => $('cDlg').close();
  $('cAddBtn').onclick = () => openClientDlg(null);
  $('cClose').onclick = closeClientDlg; $('cCancel').onclick = closeClientDlg;
  $('cDlg').addEventListener('click', (ev) => { if (ev.target === $('cDlg')) closeClientDlg(); });
  $('cForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const pending = $('cpg-add') && $('cpg-add').value.trim(); if (pending && !cDraft.pages.includes(pending)) cDraft.pages.push(pending);
    const body = { name: $('cName').value.trim(), type: cDraft.type, pages: cDraft.pages, telegram: cDraft.telegram, telegram_title: cDraft.telegram_title };
    if (!body.name) { $('cName').focus(); return; }
    const b = $('cSave'); b.disabled = true;
    try {
      if (cEdit) {
        const c = await api('/clients/' + cEdit.id, { method: 'PATCH', body: { ...body, match: '' } });
        clients = clients.map((x) => x.id === c.id ? c : x); toast('Saved ' + c.name);
      } else {
        const c = await api('/clients', { method: 'POST', body });
        clients.push(c); toast('Added ' + c.name + ' — matched to your synced days');
      }
      closeClientDlg(); renderClients(); structSig = ''; renderChecklist(); afterClientChange(); loadClientMonth();
    } catch (e) { toast(e.message); } finally { b.disabled = false; }
  });
  $('cPause').onclick = async () => {
    if (!cEdit) return;
    try { const c = await api('/clients/' + cEdit.id, { method: 'PATCH', body: { archived: !cEdit.archived } }); clients = clients.map((x) => x.id === c.id ? c : x); toast(c.archived ? c.name + ' paused' : c.name + ' resumed'); closeClientDlg(); renderClients(); structSig = ''; renderChecklist(); afterClientChange(); }
    catch (e) { toast(e.message); }
  };
  $('cDel').onclick = async () => {
    const del = $('cDel'); if (!cEdit) return;
    if (!del.dataset.arm) { del.dataset.arm = '1'; del.textContent = 'Tap again to delete'; setTimeout(() => { del.dataset.arm = ''; del.textContent = 'Delete'; }, 3000); return; }
    try { await api('/clients/' + cEdit.id, { method: 'DELETE' }); const n = cEdit.name; clients = clients.filter((c) => c.id !== cEdit.id); closeClientDlg(); renderClients(); structSig = ''; renderChecklist(); afterClientChange(); toast(n + ' deleted'); }
    catch (e) { toast(e.message); }
  };
  // After a client change the server re-matches all saved days, so reload what's on screen.
  function afterClientChange() { loadDay(); if (!$('tab-dashboard').hidden || dData) loadDash(); }
  async function saveClient(id, p) {
    try { const c = await api('/clients/' + id, { method: 'PATCH', body: p }); clients = clients.map((x) => x.id === id ? c : x); renderClients(); structSig = ''; renderChecklist(); afterClientChange(); toast('Saved'); }
    catch (e) { toast(e.message); }
  }

  // ---------- team ----------
  async function renderTeam() {
    const fmt = (d) => d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
    const soon = me.tokenExpires && new Date(me.tokenExpires) - Date.now() < 7 * 864e5;
    $('teamBody').innerHTML = `<tr><td>${esc(me.name)}</td><td class="num">${esc(me.id)}</td><td class="${soon ? 'over' : ''}">${fmt(me.tokenExpires)}</td></tr>`;
    $('tgInfo').textContent = me.telegram.configured
      ? `Sends automatically every day at ${me.telegram.time} (${me.tz}), after a fresh sync. Preview for ${nice(date)}:`
      : 'Not set up yet. Add TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID and REPORT_TIME to the server settings (see README). Preview:';
    try { $('reportPreview').textContent = (await api('/report/' + date)).text; } catch (e) { $('reportPreview').textContent = e.message; }
    if (me.isOwner) loadAuto();
  }

  // ---------- auto sync (owner only) ----------
  const ago = (t) => {
    if (!t) return '—';
    const m = Math.round((Date.now() - new Date(t)) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    if (m < 1440) return Math.round(m / 60) + ' h ago';
    return new Date(t).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  };
  const whyLabel = { 'new campaign': 'new campaign found', hourly: 'hourly refresh', 'daily 30-day': '30-day refresh', 'run now': 'run now' };
  async function loadAuto() {
    $('autoPanel').hidden = false;
    let d;
    try { d = await api('/auto-sync'); } catch (e) { $('autoMsg').textContent = e.message; return; }
    $('autoMsg').textContent = d.on ? '' : 'Auto sync is switched off on the server (AUTO_SYNC=off in Railway), so nothing runs until you remove it.';
    $('autoMsg').classList.toggle('err', !d.on);
    $('autoBody').innerHTML = d.users.map((u) => {
      let st;
      if (u.expired) st = '<span class="over">Login expired</span>';
      else if (!u.enabled) st = '<span class="muted">Off</span>';
      else if (!u.synced) st = '<span class="muted">Waiting for first Sync from Meta</span>';
      else if (u.busy) st = 'Syncing…';
      else st = '<span class="ok">Running</span>';
      const lr = u.lastRun;
      const last = !lr ? '—' : lr.error
        ? `<span class="over">${esc(ago(lr.at))} · failed: ${esc(lr.error)}</span>`
        : `${esc(ago(lr.at))} · ${esc(whyLabel[lr.why] || lr.why)} · ${lr.campaigns} campaigns${lr.errors ? ` · ${lr.errors} account errors` : ''}`;
      const exp = u.tokenExpires ? new Date(u.tokenExpires).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
      return `<tr>
        <td>${esc(u.name)}${u.id === me.id ? ' <span class="muted">(you)</span>' : ''}<div class="hint">${u.accounts} ad accounts · ${u.clients} clients</div></td>
        <td><label class="chk"><input type="checkbox" data-auto="${esc(u.id)}" ${u.enabled ? 'checked' : ''}> ${u.enabled ? 'On' : 'Off'}</label></td>
        <td>${st}</td>
        <td>${last}${u.lastCheck ? `<div class="hint">checked for new campaigns ${esc(ago(u.lastCheck))}</div>` : ''}</td>
        <td>${esc(exp)}</td>
        <td>${u.id === me.id ? '<span class="chip meta">Owner</span>' : `<label class="chk"><input type="checkbox" data-adminview="${esc(u.id)}" ${u.adminView ? 'checked' : ''}> ${u.adminView ? 'Yes' : 'No'}</label>`}</td>
        <td class="acts"><button data-run="${esc(u.id)}" ${u.expired || u.busy || !u.synced ? 'disabled' : ''}>Run now</button>${u.id === me.id ? '' : ` <button class="danger" data-remove="${esc(u.id)}" data-name="${esc(u.name)}">Remove</button>`}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="7" class="muted">Nobody has logged in yet.</td></tr>';
    try {
      const b = Object.entries(await api('/blocked'));
      $('blockedBox').hidden = !b.length;
      $('blockedBody').innerHTML = b.map(([id, x]) => `<tr><td>${esc(x.name || id)}<div class="hint">Facebook ID ${esc(id)} · removed ${esc(ago(x.at))}</div></td><td class="acts"><button data-restore="${esc(id)}">Restore access</button></td></tr>`).join('');
    } catch (_) {}
  }
  $('blockedBody').addEventListener('click', async (ev) => {
    const id = ev.target.dataset.restore; if (!id) return;
    try { await api('/blocked/' + encodeURIComponent(id), { method: 'DELETE' }); toast('Access restored — they can log in again'); } catch (e) { toast(e.message); }
    loadAuto();
  });
  $('autoBody').addEventListener('change', async (ev) => {
    const av = ev.target.dataset.adminview;
    if (av) {
      try { await api('/admin/viewers/' + encodeURIComponent(av), { method: 'PUT', body: { enabled: ev.target.checked } }); toast(ev.target.checked ? 'They can now see the Admin dashboard' : 'Admin dashboard access removed'); }
      catch (e) { toast(e.message); }
      return loadAuto();
    }
    const id = ev.target.dataset.auto; if (!id) return;
    try { await api('/auto-sync/' + encodeURIComponent(id), { method: 'PUT', body: { enabled: ev.target.checked } }); toast('Auto sync ' + (ev.target.checked ? 'on' : 'off')); }
    catch (e) { toast(e.message); }
    loadAuto();
  });
  $('autoBody').addEventListener('click', async (ev) => {
    const rm = ev.target.dataset.remove;
    if (rm) {
      const name = ev.target.dataset.name;
      if (!confirm(`Remove ${name}?\n\nThis deletes ${name}'s clients, synced days and settings from Boost Desk, logs them out, and blocks them from logging in again. It does not touch anything in Facebook or Ads Manager.\n\nThis can't be undone (you can restore their login later, but their data will be gone).`)) return;
      try { await api('/users/' + encodeURIComponent(rm), { method: 'DELETE' }); toast(name + ' removed'); } catch (e) { toast(e.message); }
      return loadAuto();
    }
    const id = ev.target.dataset.run; if (!id) return;
    ev.target.disabled = true;
    try { await api('/auto-sync/' + encodeURIComponent(id) + '/run', { method: 'POST' }); toast('Sync started — refreshing today and yesterday'); }
    catch (e) { toast(e.message); }
    loadAuto();
    setTimeout(() => { if (!$('tab-team').hidden) loadAuto(); }, 15000);
  });
  for (const [btn, on] of [['autoAllOn', true], ['autoAllOff', false]]) {
    $(btn).onclick = async () => {
      try { await api('/auto-sync', { method: 'PUT', body: { enabled: on } }); toast('Auto sync ' + (on ? 'on' : 'off') + ' for everyone'); }
      catch (e) { toast(e.message); }
      loadAuto();
    };
  }

  $('logoutBtn').onclick = async () => { await fetch('/auth/logout', { method: 'POST' }); location.href = '/login'; };

  // While the Dashboard shows a period that includes today, pull fresh numbers every 2 minutes (picks up auto sync).
  setInterval(() => {
    if (document.hidden || $('tab-dashboard').hidden || !me || !dDate) return;
    if (document.activeElement && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
    if ($('ckDlg').open || $('cDlg').open) return;
    const [, to] = dRange(); if (to < me.today) return;
    loadDay(); loadDash(true);
  }, 120000);

  // ---------- dashboard ----------
  // One control for the period: quick chips + ‹ label › to step. Mode follows the chip.
  let dMode = 'day', dDate = null, dFrom = null, dTo = null, dData = null, dSort = { key: 'spend', asc: false }, dTypeF = '';
  const addD = (d, n) => { const x = parse(d); x.setDate(x.getDate() + n); return iso(x); };
  const monthLabel = (ym) => parse(ym + '-01').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const lastDay = (ym) => new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0).getDate();
  const shortD = (d) => parse(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const taxRate = () => (me && Number.isFinite(me.taxRate) ? me.taxRate : 10);
  const withTax = (v) => Math.round(Math.round(v * 100) * (100 + taxRate()) / 100) / 100;
  function dRange() {
    if (dMode === 'day') return [dDate, dDate];
    if (dMode === 'range') return [dFrom, dTo];
    if (dMode === 'year') { const y = dDate.slice(0, 4); return [y + '-01-01', y + '-12-31']; }
    const ym = dDate.slice(0, 7); return [ym + '-01', ym + '-' + pad(lastDay(ym))];
  }
  const periodLabel = () => dMode === 'day' ? nice(dDate) : dMode === 'month' ? monthLabel(dDate.slice(0, 7)) : dMode === 'year' ? 'Year ' + dDate.slice(0, 4) : `${shortD(dFrom)} – ${shortD(dTo)} ${dTo.slice(0, 4)}`;
  let forceCustom = false;
  function currentPreset() {
    const t = me.today;
    if (dMode === 'range' && forceCustom) return 'custom';
    if (dMode === 'year') return dDate.slice(0, 4) === t.slice(0, 4) ? 'thisYear' : String(Number(t.slice(0, 4)) - 1) === dDate.slice(0, 4) ? 'lastYear' : '';
    if (dMode === 'day') return dDate === t ? 'today' : dDate === addD(t, -1) ? 'yesterday' : '';
    if (dMode === 'month') { const lm = parse(t.slice(0, 8) + '01'); lm.setMonth(lm.getMonth() - 1); return dDate.slice(0, 7) === t.slice(0, 7) ? 'thisMonth' : dDate.slice(0, 7) === iso(lm).slice(0, 7) ? 'lastMonth' : ''; }
    if (dTo === t && dFrom === addD(t, -6)) return '7';
    if (dTo === t && dFrom === addD(t, -29)) return '30';
    return 'custom';
  }
  function applyPreset(v) {
    const t = me.today; forceCustom = false;
    if (v === 'today') { dMode = 'day'; dDate = t; }
    else if (v === 'yesterday') { dMode = 'day'; dDate = addD(t, -1); }
    else if (v === '7' || v === '30') { dMode = 'range'; dTo = t; dFrom = addD(t, -(Number(v) - 1)); }
    else if (v === 'thisMonth') { dMode = 'month'; dDate = t; }
    else if (v === 'thisYear') { dMode = 'year'; dDate = t; }
    else if (v === 'lastYear') { dMode = 'year'; dDate = (Number(t.slice(0, 4)) - 1) + '-06-15'; }
    else if (v === 'lastMonth') { const d = parse(t.slice(0, 8) + '01'); d.setMonth(d.getMonth() - 1); dMode = 'month'; dDate = iso(d); }
    else if (v === 'custom') { if (dMode !== 'range') { dTo = dMode === 'day' ? dDate : t; dFrom = addD(dTo, -13); } dMode = 'range'; forceCustom = true; setTimeout(() => $('dFrom').focus(), 50); }
    loadDash();
  }
  document.querySelectorAll('#dChips button').forEach((b) => b.onclick = () => applyPreset(b.dataset.preset));
  const dShift = (n) => {
    if (dMode === 'range') { const len = Math.round((parse(dTo) - parse(dFrom)) / 864e5) + 1; dFrom = addD(dFrom, n * len); dTo = addD(dTo, n * len); }
    else if (dMode === 'day') dDate = addD(dDate, n);
    else if (dMode === 'year') dDate = (Number(dDate.slice(0, 4)) + n) + dDate.slice(4);
    else { const d = parse(dDate); d.setDate(1); d.setMonth(d.getMonth() + n); dDate = iso(d); }
    loadDash();
  };
  $('dPrev').onclick = () => dShift(-1); $('dNext').onclick = () => dShift(1);
  $('dPick').onclick = () => {
    if (dMode === 'range') { applyPreset('custom'); return; }
    if (dMode === 'year') return;
    const el = dMode === 'month' ? $('dMonth') : $('dDay');
    try { el.showPicker(); } catch (_) { el.focus(); el.click(); }
  };
  $('dDay').onchange = () => { if ($('dDay').value) { dDate = $('dDay').value; loadDash(); } };
  $('dMonth').onchange = () => { if ($('dMonth').value) { dDate = $('dMonth').value + '-01'; loadDash(); } };
  $('dFrom').onchange = () => { if ($('dFrom').value) { dFrom = $('dFrom').value; if (dTo < dFrom) dTo = dFrom; loadDash(); } };
  $('dTo').onchange = () => { if ($('dTo').value) { dTo = $('dTo').value; if (dFrom > dTo) dFrom = dTo; loadDash(); } };
  $('dSearch').oninput = () => renderDash(); $('dShowIdle').onchange = () => renderDash();
  document.querySelectorAll('#dTypeSeg button').forEach((b) => b.onclick = () => {
    dTypeF = b.dataset.type; document.querySelectorAll('#dTypeSeg button').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); renderDash();
  });
  document.querySelectorAll('.dtable th[data-sort]').forEach((th) => th.onclick = () => {
    const k = th.dataset.sort; dSort = { key: k, asc: dSort.key === k ? !dSort.asc : k === 'name' }; renderDash();
  });

  let dEntries = {}, dKey = ''; const dOpen = new Set();
  const skelRows = (n) => Array.from({ length: n }, (_, i) => `<tr class="skel"><td colspan="8"><div class="sk" style="--w:${60 + ((i * 37) % 35)}%"></div></td></tr>`).join('');
  async function loadDash(quiet) {
    if (!dDate) dDate = me.today;
    // Sync status and "Spend not matched" follow the day you're looking at (today for longer periods).
    const infoDay = dMode === 'day' ? dDate : me.today;
    if (date !== infoDay) { date = infoDay; loadDay(); }
    const pre = currentPreset();
    document.querySelectorAll('#dChips button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.preset === pre)));
    $('dLabel').textContent = periodLabel();
    $('dDay').value = dDate; $('dMonth').value = dDate.slice(0, 7);
    const custom = dMode === 'range' && pre === 'custom';
    $('dRangeBox').hidden = !custom; $('dPick').hidden = custom;
    if (dMode === 'range') { $('dFrom').value = dFrom; $('dTo').value = dTo; }
    $('dNext').disabled = (dMode === 'day' && dDate >= me.today) || (dMode === 'month' && dDate.slice(0, 7) >= me.today.slice(0, 7)) || (dMode === 'year' && dDate.slice(0, 4) >= me.today.slice(0, 4)) || (dMode === 'range' && dTo >= me.today);
    $('dTable').classList.toggle('oneday', dMode === 'day');
    const [from, to] = dRange();
    $('dTableTitle').textContent = 'Clients · ' + periodLabel();
    const key = from + '|' + to, samePeriod = key === dKey;
    const dir = !dKey ? 0 : samePeriod ? 0 : (from > dKey.split('|')[0] ? 1 : -1);
    const prevSpend = samePeriod && dData ? Object.fromEntries(dData.clients.map((c) => [c.id, c.spend])) : null;
    // 9) skeleton while a new period loads
    const skel = !samePeriod ? setTimeout(() => { $('dBody').innerHTML = skelRows(5); $('dFoot').innerHTML = ''; document.querySelectorAll('#tab-dashboard .summary .val').forEach((v) => v.classList.add('skel-v')); }, 120) : null;
    try {
      const [d, rows] = await Promise.all([api(`/dashboard?from=${from}&to=${to}`), api(`/entries?from=${from}&to=${to}`).catch(() => [])]);
      clearTimeout(skel); document.querySelectorAll('.skel-v').forEach((v) => v.classList.remove('skel-v'));
      dData = d; dEntries = {}; dKey = key;
      for (const r of rows) (dEntries[r.client_id] = dEntries[r.client_id] || {})[r.day] = r.data || {};
      renderDash();
      // 5) the new period slides in from the direction you moved
      if (dir && !calm) ['#tab-dashboard .summary', '#dChartPanel', '#dTable tbody'].forEach((sel, i) => { const el = document.querySelector(sel); if (el && !el.hidden) el.animate([{ opacity: 0, transform: `translateX(${dir * 46}px)` }, { opacity: 1, transform: 'none' }], { duration: 420, delay: i * 50, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'backwards' }); });
      // 2) rows whose spend went up since the last refresh flash green with a "+$" label
      if (prevSpend) dData.clients.forEach((c) => {
        const inc = c.spend - (prevSpend[c.id] || 0);
        if (inc > 0.009) { const tr = document.querySelector(`#dBody tr.drow[data-cid="${c.id}"]`); if (tr) { tr.classList.remove('flash'); void tr.offsetWidth; tr.classList.add('flash'); floatUp(tr.querySelector('td.tot b') || tr, '+' + money(inc), 'up'); } }
      });
    }
    catch (e) { $('dBody').innerHTML = `<tr><td colspan="8" class="muted">${esc(e.message)}</td></tr>`; }
  }

  // Page names under the client (hide raw Page ID numbers and the client's own name).
  const pageNames = (c) => { const n = c.pages.filter((p) => p !== c.name && !/^\d{6,}$/.test(p)); return n.length > 2 ? n.slice(0, 2).join(' · ') + ` +${n.length - 2}` : n.join(' · '); };
  const hasL = (c) => c.type === 'live' || c.type === 'both', hasP = (c) => c.type === 'post' || c.type === 'both';

  // The breakdown under a client: lives (start time, campaigns, spend) and boost posts — one day, or day by day.
  function dayParts(c, e) {
    const out = [];
    if (hasL(c)) Object.entries(e.lives || {}).sort(([a], [b]) => Number(a.slice(1)) - Number(b.slice(1)))
      .forEach(([k, l]) => { if (l && Number(l.spend) > 0) out.push({ kind: 'live', label: 'Live ' + k.slice(1), time: l.time || '', n: l.campaigns || 0, spend: Number(l.spend) }); });
    if (hasP(c) && Number((e.post || {}).spend) > 0) out.push({ kind: 'post', label: 'Boost post', time: '', n: e.post.campaigns || 0, spend: Number(e.post.spend) });
    return out;
  }
  const partLine = (p) => `<div class="dl ${p.kind}"><span class="dl-n"><b>${esc(p.label)}</b><span class="hint">${p.n ? ' · ' + p.n + ' campaign' + (p.n > 1 ? 's' : '') : ''}</span></span>${p.time ? `<span class="dl-t num">${esc(p.time)}</span>` : '<span></span>'}<span class="dl-v"><span class="muted">$</span><span class="box num">${Number(p.spend).toFixed(2)}</span></span></div>`;
  function detailRow(c) {
    const days = dEntries[c.id] || {};
    let body = '';
    if (dMode === 'day') {
      const e = days[dDate] || {}, parts = dayParts(c, e);
      body = (parts.length ? parts.map(partLine).join('') : '<div class="muted">No boost spend on this day.</div>')
        + (e.note ? `<div class="dnote">📝 ${esc(e.note)}</div>` : '')
        + (e.reportSent && e.reportSent.at ? `<div class="dsent">✓ Report sent ${new Date(e.reportSent.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}${e.reportSent.by ? ' by ' + esc(e.reportSent.by) : ''}</div>` : '');
    } else if (dMode === 'year') {
      const months = {};
      for (const d of Object.keys(days)) {
        const parts = dayParts(c, days[d]); if (!parts.length) continue;
        const m = months[d.slice(0, 7)] || (months[d.slice(0, 7)] = { live: 0, post: 0, lives: 0, days: 0 });
        m.days++; for (const p of parts) { if (p.kind === 'live') { m.live += p.spend; m.lives++; } else m.post += p.spend; }
      }
      const keys = Object.keys(months).sort().reverse();
      body = keys.length ? keys.map((ym) => { const m = months[ym];
        return `<div class="dl mrow"><span class="dl-n"><b>${esc(monthLabel(ym))}</b><span class="hint"> · ${m.days} day${m.days === 1 ? '' : 's'}${m.lives ? ` · ${m.lives} live${m.lives === 1 ? '' : 's'}` : ''}${m.post ? ` · posts ${money(m.post)}` : ''}</span></span><span></span><span class="dl-v"><span class="muted">$</span><span class="box num">${(m.live + m.post).toFixed(2)}</span></span></div>`;
      }).join('') : '<div class="muted">No boost spend this year.</div>';
    } else {
      const list = Object.keys(days).sort().reverse().map((d) => ({ d, parts: dayParts(c, days[d]) })).filter((x) => x.parts.length);
      body = list.length ? list.map((x) => {
        const tot = x.parts.reduce((s2, p) => s2 + p.spend, 0);
        return `<div class="dday"><div class="dday-h"><b>${esc(nice(x.d).replace(/ \d{4}$/, ''))}</b><span class="num">${money(tot)}</span></div>${x.parts.map(partLine).join('')}</div>`;
      }).join('') : '<div class="muted">No boost spend in this period.</div>';
    }
    return `<tr class="dexp"><td colspan="8"><div class="dexp-in">${body}<div class="dexp-foot"><button class="primary${sentFlash && sentFlash.cid === c.id && Date.now() < sentFlash.until ? ' sent-ok' : ''}" data-dreport="${c.id}"><span class="plane"><svg class="pl" viewBox="0 0 24 24" aria-hidden="true"><path d="M21.5 11.2 3.4 3.1a.9.9 0 0 0-1.2 1.1L4.6 11 2.2 17.8a.9.9 0 0 0 1.2 1.1l18.1-8.1a.9.9 0 0 0 0-1.6Z" fill="currentColor"/><path d="M4.6 11h7" stroke="rgba(0,0,0,.25)" stroke-width="1.4" stroke-linecap="round"/></svg></span> Send report · ${esc(periodLabel())}</button></div></div></td></tr>`;
  }

  // ---------- open / close motion ----------
  const ease = 'cubic-bezier(.22,.8,.2,1)';
  const PLANE_SVG = `<svg class="pl" viewBox="0 0 24 24" aria-hidden="true"><path d="M21.5 11.2 3.4 3.1a.9.9 0 0 0-1.2 1.1L4.6 11 2.2 17.8a.9.9 0 0 0 1.2 1.1l18.1-8.1a.9.9 0 0 0 0-1.6Z" fill="currentColor"/><path d="M4.6 11h7" stroke="rgba(0,0,0,.25)" stroke-width="1.4" stroke-linecap="round"/></svg>`;
  // The breakdown unfolds, and each live / post line slides in one after another.
  function unfoldClient(id) {
    const tr = document.querySelector(`#dBody tr.drow[data-cid="${id}"]`), box = tr && tr.nextElementSibling && tr.nextElementSibling.querySelector('.dexp-in');
    if (!box || calm || !box.animate) return;
    const h = box.offsetHeight;
    box.animate([{ height: '0px', opacity: 0 }, { height: h + 'px', opacity: 1 }], { duration: 380, easing: ease });
    box.querySelectorAll('.dl, .dday-h, .dnote, .dsent').forEach((el, i) => el.animate(
      [{ opacity: 0, transform: 'translateX(-18px)' }, { opacity: 1, transform: 'none' }],
      { duration: 360, delay: 60 + i * 55, easing: ease, fill: 'backwards' }));
  }
  // A paper plane swings out past the right edge, loops back in and lands with a little spin, leaving a dotted trail.
  function flyPlane(from, to, { duration = 1150 } = {}) {
    return new Promise((resolve) => {
      if (calm || !document.body.animate) return resolve();
      const sx = scrollX, sy = scrollY;
      const x0 = from.left + from.width / 2 + sx, y0 = from.top + from.height / 2 + sy;
      const x1 = to.left + to.width / 2 + sx, y1 = to.top + to.height / 2 + sy;
      const R = Math.min(Math.max(x0, x1) + 330, sx + innerWidth + 30);                 // out to the right
      const down = y1 > y0;
      const c1 = { x: R, y: y0 + (down ? -70 : 50) }, c2 = { x: R + 10, y: y1 + (down ? 60 : -70) };
      const pt = (t) => { const u = 1 - t; return { x: u * u * u * x0 + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * x1, y: u * u * u * y0 + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * y1 }; };
      const tan = (t) => { const u = 1 - t; return Math.atan2(3 * u * u * (c1.y - y0) + 6 * u * t * (c2.y - c1.y) + 3 * t * t * (y1 - c2.y), 3 * u * u * (c1.x - x0) + 6 * u * t * (c2.x - c1.x) + 3 * t * t * (x1 - c2.x)) * 180 / Math.PI; };
      const size0 = Math.max(12, from.height), size1 = Math.max(12, to.height);
      const p = document.createElement('div'); p.className = 'flyplane'; p.innerHTML = PLANE_SVG; document.body.appendChild(p);
      const N = 24, frames = []; let prev = null, turn = 0;
      for (let i = 0; i <= N; i++) {
        const t = i / N, q = pt(t);
        let a = tan(Math.min(Math.max(t, .02), .9));
        if (prev != null) { while (a - prev > 180) a -= 360; while (a - prev < -180) a += 360; }  // keep rotation continuous
        prev = a; if (t > .9) a = prev + (Math.round(prev / 360 + .5) * 360 - prev) * ((t - .9) / .1);  // spin upright to land
        turn = a;
        const sc = (size0 + (size1 - size0) * t) / 20 * (1 + Math.sin(t * Math.PI) * .7);
        frames.push({ transform: `translate(${q.x - 10}px, ${q.y - 10}px) rotate(${a}deg) scale(${sc})`, offset: t });
      }
      const anim = p.animate(frames, { duration, easing: 'cubic-bezier(.4,.05,.25,1)' });
      for (let i = 1; i < 16; i++) {
        const t = i / 16, q = pt(t), d = document.createElement('i'); d.className = 'trail'; document.body.appendChild(d);
        d.style.left = q.x + 'px'; d.style.top = q.y + 'px';
        d.animate([{ opacity: 0, transform: 'scale(.4)' }, { opacity: .9, transform: 'scale(1)', offset: .2 }, { opacity: 0, transform: 'scale(.3)' }],
          { duration: 750, delay: duration * t * .8, easing: 'ease-out', fill: 'both' }).onfinish = () => d.remove();
      }
      const done = () => { p.remove(); resolve(); };
      anim.onfinish = done; anim.oncancel = done;
    });
  }
  const pop = (el) => { if (el && !calm && el.animate) el.animate([{ transform: 'scale(.4) rotate(-20deg)', opacity: 0 }, { transform: 'scale(1.35) rotate(6deg)', opacity: 1, offset: .55 }, { transform: 'none' }], { duration: 420, easing: ease }); };

  // Open: the plane leaves the Report button and lands in Send report, which then shines.
  function planeToSend(id, from) {
    const btn = document.querySelector(`#dBody [data-dreport="${id}"]`); if (!btn) return;
    const slot = btn.querySelector('.plane');
    const land = () => {
      slot.style.visibility = ''; pop(slot);
      btn.classList.remove('glow', 'shine'); void btn.offsetWidth; btn.classList.add('glow', 'shine');
      const r = btn.getBoundingClientRect();
      if (r.bottom > innerHeight - 70 || r.top < 70) btn.scrollIntoView({ behavior: calm ? 'auto' : 'smooth', block: 'center' });
    };
    if (calm || !from) return land();
    slot.style.visibility = 'hidden';
    setTimeout(() => flyPlane(from, slot.getBoundingClientRect()).then(land), 160); // let the breakdown unfold first
  }
  // Close: the plane takes off from Send report, the breakdown folds up, and it lands back in Report.
  function collapseClient(id, tr) {
    const box = tr.nextElementSibling && tr.nextElementSibling.querySelector('.dexp-in');
    const slot = box && box.querySelector('[data-dreport] .plane'), from = slot && slot.getBoundingClientRect();
    if (slot) slot.style.visibility = 'hidden';
    const reopen = () => {
      dOpen.delete(id); renderDash();
      const rb = document.querySelector(`#dBody [data-report="${id}"]`), rp = rb && rb.querySelector('.plane');
      if (!rp || calm || !from) return;
      rp.style.visibility = 'hidden';
      flyPlane(from, rp.getBoundingClientRect(), { duration: 1050 }).then(() => { rp.style.visibility = ''; pop(rp); rb.animate && rb.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.08)' }, { transform: 'none' }], { duration: 320, easing: ease }); });
    };
    if (!box || calm || !box.animate) return reopen();
    box.style.overflow = 'hidden';
    const a = box.animate([{ height: box.offsetHeight + 'px', opacity: 1 }, { height: '0px', opacity: 0 }], { duration: 260, easing: 'cubic-bezier(.4,0,.6,1)' });
    a.onfinish = reopen; a.oncancel = reopen;
  }

  // 3) "Live now": today, a live started less than 2 hours ago.
  function liveNow(c) {
    if (dMode !== 'day' || dDate !== me.today) return false;
    const e = (dEntries[c.id] || {})[dDate] || {}, now = new Date(), mins = now.getHours() * 60 + now.getMinutes();
    return Object.values(e.lives || {}).some((l) => { if (!l || !(Number(l.spend) > 0) || !/^\d{1,2}:\d{2}$/.test(l.time || '')) return false; const [h, m] = l.time.split(':').map(Number), d = mins - (h * 60 + m); return d >= 0 && d <= 120; });
  }

  function renderDash() {
    if (!dData) return;
    const q = $('dSearch').value.trim().toLowerCase(), idle = !$('dShowIdle').checked; // all clients by default
    let list = dData.clients.map((c) => ({ ...c, perDay: c.days ? c.spend / c.days : 0 }))
      .filter((c) => !c.archived || c.spend > 0)
      .filter((c) => idle || c.spend > 0)
      .filter((c) => !dTypeF || (dTypeF === 'live' ? hasL(c) : hasP(c)))
      .filter((c) => !q || [c.name, ...c.pages].some((x) => x.toLowerCase().includes(q)));
    const k = dSort.key, dir = dSort.asc ? 1 : -1;
    list.sort((a, b) => ((b.spend > 0) - (a.spend > 0)) || (k === 'name' ? a.name.localeCompare(b.name) : (a[k] - b[k])) * dir || a.name.localeCompare(b.name));
    document.querySelectorAll('.dtable th[data-sort]').forEach((th) => { th.classList.toggle('sorted', th.dataset.sort === k); th.classList.toggle('asc', th.dataset.sort === k && dSort.asc); });

    const t = list.reduce((a, c) => ({ spend: a.spend + c.spend, live: a.live + c.liveSpend, post: a.post + c.postSpend, lives: a.lives + c.lives, active: a.active + (c.spend > 0 ? 1 : 0), posters: a.posters + (c.postSpend > 0 ? 1 : 0) }), { spend: 0, live: 0, post: 0, lives: 0, active: 0, posters: 0 });
    rollTo($('dSpend'), money(t.spend));
    $('dTax').textContent = t.spend && taxRate() ? `With tax ${taxRate()}%: ${money(withTax(t.spend))}` : '';
    rollTo($('dLive'), money(t.live)); $('dLives').textContent = `${t.lives} live${t.lives === 1 ? '' : 's'}`;
    rollTo($('dPost'), money(t.post)); $('dPosts').textContent = `${t.posters} client${t.posters === 1 ? '' : 's'} boosted posts`;
    rollTo($('dActive'), String(t.active)); $('dActiveSub').textContent = `of ${dData.clients.filter((c) => !c.archived).length} clients`;

    const top = Math.max(0.01, ...list.map((c) => c.spend));
    const dash = '<span class="muted">–</span>';
    $('dBody').innerHTML = list.map((c) => {
      const share = t.spend ? c.spend / t.spend * 100 : 0, pg = pageNames(c);
      const tags = (hasL(c) ? (liveNow(c) ? '<span class="chip livenow" title="A live started in the last 2 hours">Live now</span>' : '<span class="chip live">Live</span>') : '') + (hasP(c) ? '<span class="chip post">Post</span>' : '');
      const open = dOpen.has(c.id);
      return `<tr data-cid="${c.id}" class="drow${open ? ' open' : ''}${c.spend > 0 ? '' : ' nospend'}" tabindex="0" aria-expanded="${open}">
        <td class="cname"><div class="nm"><span class="chev" aria-hidden="true">›</span><b>${esc(c.name)}</b>${tags}</div>${pg ? `<div class="pg">${esc(pg)}</div>` : ''}</td>
        <td class="r num" data-l="Lives">${hasL(c) && c.lives ? c.lives : dash}</td>
        <td class="r num" data-l="Live">${c.liveSpend > 0 ? money(c.liveSpend) : dash}</td>
        <td class="r num" data-l="Post">${c.postSpend > 0 ? money(c.postSpend) : dash}</td>
        <td class="r num multi" data-l="Days">${c.days || dash}</td>
        <td class="r num multi" data-l="Per day">${c.days ? money(c.perDay) : dash}</td>
        <td class="r num tot" data-l="Total"><b>${money(c.spend)}</b>${c.spend && taxRate() ? `<div class="hint">+tax ${money(withTax(c.spend))}</div>` : ''}</td>
        <td class="actc">${open ? '' : `<button class="rbtn${c.telegram ? ' tg' : ''}" data-report="${c.id}" title="${c.telegram ? 'Preview and send to the client\u2019s Telegram group' : 'No Telegram group yet \u2014 you can copy the report'}"><span class="plane"><svg class="pl" viewBox="0 0 24 24" aria-hidden="true"><path d="M21.5 11.2 3.4 3.1a.9.9 0 0 0-1.2 1.1L4.6 11 2.2 17.8a.9.9 0 0 0 1.2 1.1l18.1-8.1a.9.9 0 0 0 0-1.6Z" fill="currentColor"/><path d="M4.6 11h7" stroke="rgba(0,0,0,.25)" stroke-width="1.4" stroke-linecap="round"/></svg></span> Report</button>`}</td></tr>${open ? detailRow(c) : ''}`;
    }).join('') || `<tr><td colspan="8" class="empty-row">${dData.clients.length ? 'No client spend for this period.' : 'No clients yet. Add them in the Clients tab.'}</td></tr>`;
    $('dFoot').innerHTML = list.length > 1 ? `<tr><td>Total · ${list.length} clients</td><td class="r num" data-l="Lives">${t.lives}</td><td class="r num" data-l="Live">${money(t.live)}</td><td class="r num" data-l="Post">${money(t.post)}</td><td class="multi"></td><td class="multi"></td><td class="r num tot" data-l="Total"><b>${money(t.spend)}</b>${taxRate() ? `<div class="hint">+tax ${money(withTax(t.spend))}</div>` : ''}</td><td></td></tr>` : '';
    document.querySelectorAll('#dBody tr.drow').forEach((tr) => {
      const toggle = () => {
        const id = Number(tr.dataset.cid), opening = !dOpen.has(id);
        if (!opening) return collapseClient(id, tr);
        const rp = tr.querySelector('[data-report] .plane'), from = rp && rp.getBoundingClientRect();
        dOpen.add(id); renderDash(); unfoldClient(id); planeToSend(id, from);
      };
      tr.onclick = (ev) => { if (!ev.target.closest('button')) toggle(); };
      tr.onkeydown = (ev) => { if ((ev.key === 'Enter' || ev.key === ' ') && ev.target === tr) { ev.preventDefault(); toggle(); } };
    });
    document.querySelectorAll('#dBody [data-dreport]').forEach((b) => b.onclick = () => {
      const [from, to] = dRange(); openReportDlg({ kind: 'client', cid: Number(b.dataset.dreport), from, to, label: periodLabel() });
    });
    document.querySelectorAll('#dBody [data-report]').forEach((b) => b.onclick = () => {
      const [from, to] = dRange(); openReportDlg({ kind: 'client', cid: Number(b.dataset.report), from, to, label: periodLabel() });
    });

    // Daily chart for months and ranges, filtered to the visible clients.
    $('dChartPanel').hidden = dMode === 'day';
    if (dMode !== 'day') {
      const ids = new Set(list.map((c) => c.id));
      let days = dData.days.map((d) => ({ day: d.day, spend: dData.clients.filter((c) => ids.has(c.id)).reduce((s, c) => s + (c.daily[d.day] || 0), 0) }));
      if (dMode === 'year') { // one bar per month
        const by = {}; for (const d of days) by[d.day.slice(0, 7)] = (by[d.day.slice(0, 7)] || 0) + d.spend;
        const y = dDate.slice(0, 4);
        days = Array.from({ length: 12 }, (_, i) => { const ym = y + '-' + pad(i + 1); return { day: ym + '-01', ym, spend: by[ym] || 0 }; });
      }
      const max = Math.max(1, ...days.map((d) => d.spend));
      $('dChartTitle').textContent = dMode === 'year' ? 'Spend per month' : 'Spend per day';
      $('dChartHint').textContent = dMode === 'year' ? 'Tap a bar to see that month' : 'Tap a bar to see that day';
      $('dChart').innerHTML = days.map((d, i) => `<button style="--i:${i}" class="col${(d.ym ? d.ym === me.today.slice(0, 7) : d.day === me.today) ? ' today' : ''}" data-day="${d.day}"  aria-label="${nice(d.day)}: ${money(d.spend)}"><span class="b" style="height:${Math.max(1, d.spend / max * 100)}%" data-tip="${esc(d.ym ? monthLabel(d.ym) : nice(d.day).replace(/ \d{4}$/, ''))} · ${money(d.spend)}"></span><span class="d">${d.ym ? parse(d.day).toLocaleDateString('en-GB', { month: 'short' }) : Number(d.day.slice(8))}</span></button>`).join('');
      document.querySelectorAll('#dChart .col').forEach((b) => b.onclick = () => { dMode = dMode === 'year' ? 'month' : 'day'; dDate = b.dataset.day; loadDash(); });
    }
  }

  // ---------- report dialog (Home + Dashboard + team summary) ----------
  let ckTarget = null;
  async function openReportDlg(o) {
    const dlg = $('ckDlg'); ckTarget = o;
    $('ckTitle').textContent = 'Report'; $('ckTo').textContent = ''; $('ckText').value = 'Loading…'; $('ckSend').disabled = true;
    if (typeof dlg.showModal === 'function') { if (!dlg.open) dlg.showModal(); } else dlg.setAttribute('open', '');
    const bot = me.telegram && me.telegram.bot;
    try {
      if (o.kind === 'client') {
        const r = await api(`/client-report/${o.cid}?from=${o.from}&to=${o.to}`);
        if (ckTarget !== o) return;
        $('ckTitle').textContent = `${r.client.name} · ${o.label}`;
        $('ckText').value = r.text;
        $('ckTo').textContent = !r.client.telegram ? 'No Telegram group for this client yet — copy the text, or pick a group in the Clients tab.'
          : !bot ? 'Telegram bot is not set up on the server, so you can only copy the text.'
          : `Sends to Telegram group: ${r.client.telegramTitle || r.client.telegram}`;
        $('ckSend').textContent = 'Send to Telegram';
        $('ckSend').disabled = !r.client.telegram || !bot;
      } else {
        const r = await api(`/summary?from=${o.from}&to=${o.to}`);
        if (ckTarget !== o) return;
        $('ckTitle').textContent = `Team summary · ${o.label}`;
        $('ckText').value = r.text;
        $('ckTo').textContent = me.telegram.configured ? 'Sends to your team Telegram group.' : 'Team Telegram group not set (TELEGRAM_CHAT_ID), so you can only copy the text.';
        $('ckSend').textContent = 'Send to team group';
        $('ckSend').disabled = !me.telegram.configured;
      }
      $('ckText').focus();
    } catch (e) { $('ckText').value = e.message; }
  }
  // 7) after sending, a plane zooms off the right side of the screen
  let sentFlash = null;
  function planeOff(fromEl) {
    if (calm || !fromEl || !document.body.animate) return;
    const r = fromEl.getBoundingClientRect(), p = document.createElement('div'); p.className = 'flyplane'; p.innerHTML = PLANE_SVG; document.body.appendChild(p);
    const x0 = r.right + scrollX - 40, y0 = r.top + scrollY + r.height / 2 - 10, x1 = scrollX + innerWidth + 80, y1 = y0 - 160;
    p.animate([{ transform: `translate(${x0}px, ${y0}px) rotate(0deg) scale(1)` }, { transform: `translate(${x0 + 60}px, ${y0 + 12}px) rotate(8deg) scale(1.3)`, offset: .2 }, { transform: `translate(${x1}px, ${y1}px) rotate(-25deg) scale(1.9)` }], { duration: 900, easing: 'cubic-bezier(.5,0,.8,.4)' }).onfinish = () => p.remove();
  }
  const openDayReport = (cid) => openReportDlg({ kind: 'client', cid, from: date, to: date, label: nice(date) });
  $('dTeamReport').onclick = () => { const [from, to] = dRange(); openReportDlg({ kind: 'team', from, to, label: periodLabel() }); };
  $('ckDlg').addEventListener('close', () => { ckTarget = null; });
  $('ckDlg').addEventListener('click', (ev) => { if (ev.target === $('ckDlg')) $('ckDlg').close(); });
  $('ckCopy').onclick = async () => {
    try { await navigator.clipboard.writeText($('ckText').value); toast('Report copied'); }
    catch (_) { $('ckText').select(); try { document.execCommand('copy'); toast('Report copied'); } catch (__) { toast('Select the text and copy it'); } }
  };
  $('ckSend').onclick = async () => {
    const o = ckTarget; if (!o) return;
    const b = $('ckSend'); b.disabled = true; b.classList.add('busy');
    try {
      if (o.kind === 'client') {
        const r = await api(`/client-report/${o.cid}/send`, { method: 'POST', body: { from: o.from, to: o.to, text: $('ckText').value } });
        if (o.from === o.to && o.from === date) { day.entries[o.cid] = merge(day.entries[o.cid] || {}, { reportSent: { at: r.sentAt, by: me.name } }); refreshValues(); }
        planeOff(b); $('ckDlg').close();
        successBadge('Sent to ' + r.sentTo);
        sentFlash = { cid: o.cid, until: Date.now() + 2600 };
        if (!$('tab-dashboard').hidden) { loadDash(); setTimeout(() => { if (dData) renderDash(); }, 2700); }
      } else { await api('/summary/send', { method: 'POST', body: { from: o.from, to: o.to, text: $('ckText').value } }); planeOff(b); $('ckDlg').close(); successBadge('Sent to the team group'); }
    } catch (e) { toast(e.message); } finally { b.disabled = false; b.classList.remove('busy'); }
  };

  // ---------- admin dashboard (owner only) ----------
  let aPreset = 'today', aData = null, aTeams = { teams: [], users: [], canEdit: false }; const aOpen = new Set();
  function aRange(v) {
    const t = me.today;
    if (v === 'today') return [t, t];
    if (v === 'yesterday') { const y = addD(t, -1); return [y, y]; }
    if (v === '7') return [addD(t, -6), t];
    if (v === 'thisMonth') return [t.slice(0, 8) + '01', t];
    if (v === 'lastMonth') { const d = parse(t.slice(0, 8) + '01'); d.setMonth(d.getMonth() - 1); const ym = iso(d).slice(0, 7); return [ym + '-01', ym + '-' + pad(lastDay(ym))]; }
    if (v === 'thisYear') return [t.slice(0, 4) + '-01-01', t];
    return [t, t];
  }
  const aLabel = { today: 'Today', yesterday: 'Yesterday', 7: 'Last 7 days', thisMonth: 'This month', lastMonth: 'Last month', thisYear: 'This year' };
  document.querySelectorAll('#aChips button').forEach((b) => b.onclick = () => { aPreset = b.dataset.p; loadAdmin(); });
  async function loadAdmin() {
    if (!me || !me.canAdmin) return;
    document.querySelectorAll('#aChips button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.p === aPreset)));
    const [from, to] = aRange(aPreset);
    $('aTitle').textContent = 'Accounts · ' + (from === to ? nice(from) : aLabel[aPreset]);
    if (!aData) $('aBody').innerHTML = skelRows(3);
    try { const [o, t] = await Promise.all([api(`/admin/overview?from=${from}&to=${to}`), api('/admin/teams')]); aData = o; aTeams = t; renderAdmin(); renderTeams(); }
    catch (e) { $('aBody').innerHTML = `<tr><td colspan="7" class="muted">${esc(e.message)}</td></tr>`; }
  }
  function renderAdmin() {
    const d = aData, t = d.totals, tax = (v) => Math.round(Math.round(v * 100) * (100 + (d.taxRate || 0)) / 100) / 100;
    rollTo($('aSpend'), money(t.spend)); $('aTax').textContent = t.spend && d.taxRate ? `With tax ${d.taxRate}%: ${money(tax(t.spend))}` : '';
    rollTo($('aLive'), money(t.live)); $('aLives').textContent = `${t.lives} live${t.lives === 1 ? '' : 's'}`;
    rollTo($('aPost'), money(t.post));
    rollTo($('aAcc'), String(t.accounts)); $('aAccSub').textContent = `of ${d.users.length} account${d.users.length === 1 ? '' : 's'} · ${t.clients} clients with spend`;
    const dash = '<span class="muted">–</span>';
    const ago = (at) => { if (!at) return '<span class="muted">Never</span>'; const m = Math.round((Date.now() - new Date(at)) / 60000); return m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }); };
    const userRows = (u) => {
      const open = aOpen.has(u.id), tt = u.totals;
      const withSpend = u.clients.filter((c) => c.spend > 0).sort((a, b) => b.spend - a.spend), idle = u.clients.filter((c) => !(c.spend > 0));
      const row = `<tr class="drow${open ? ' open' : ''}${tt.spend > 0 ? '' : ' nospend'}" data-uid="${esc(u.id)}" tabindex="0">
        <td class="cname"><div class="nm"><span class="chev" aria-hidden="true">›</span><span class="avatar sm">${esc((u.name || '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase())}</span><b>${esc(u.name)}</b>${u.you ? '<span class="chip meta">You</span>' : ''}${u.expired ? '<span class="chip live">Login expired</span>' : ''}</div></td>
        <td class="r num" data-l="Clients">${tt.active} <span class="muted">/ ${u.clientCount}</span></td>
        <td class="r num" data-l="Lives">${tt.lives || dash}</td>
        <td class="r num" data-l="Live">${tt.live > 0 ? money(tt.live) : dash}</td>
        <td class="r num" data-l="Post">${tt.post > 0 ? money(tt.post) : dash}</td>
        <td class="r num tot" data-l="Total"><b>${money(tt.spend)}</b>${tt.spend && d.taxRate ? `<div class="hint">+tax ${money(tax(tt.spend))}</div>` : ''}</td>
        <td data-l="Last sync" class="hint">${ago(u.lastSync)}</td></tr>`;
      const detail = !open ? '' : `<tr class="dexp"><td colspan="7"><div class="dexp-in">${withSpend.length ? withSpend.map((c) => `<div class="dl ${c.type === 'post' ? 'post' : 'live'}"><span class="dl-n"><b>${esc(c.name)}</b><span class="hint">${c.lives ? ' · ' + c.lives + ' live' + (c.lives === 1 ? '' : 's') : ''}${c.postSpend > 0 ? ' · posts ' + money(c.postSpend) : ''}</span></span><span></span><span class="dl-v"><span class="muted">$</span><span class="box num">${c.spend.toFixed(2)}</span></span></div>`).join('') : '<div class="muted">No client spend in this period.</div>'}${idle.length ? `<div class="hint" style="padding:4px 4px 0">No spend: ${idle.map((c) => esc(c.name)).join(', ')}</div>` : ''}</div></td></tr>`;
      return row + detail;
    };
    const teams = d.teams || [];
    if (!teams.length) $('aBody').innerHTML = d.users.map(userRows).join('') || '<tr><td colspan="7" class="empty-row">Nobody has logged in yet.</td></tr>';
    else {
      // group accounts by team, with a totals row per team
      const groups = teams.map((t) => ({ t, users: d.users.filter((u) => u.team === t.id) }));
      const loose = d.users.filter((u) => !u.team);
      if (loose.length) groups.push({ t: { id: '', name: 'No team' }, users: loose });
      groups.forEach((g) => { g.sum = g.users.reduce((a, u) => ({ spend: a.spend + u.totals.spend, live: a.live + u.totals.live, post: a.post + u.totals.post, lives: a.lives + u.totals.lives, clients: a.clients + u.totals.active }), { spend: 0, live: 0, post: 0, lives: 0, clients: 0 }); });
      groups.sort((a, b) => (!a.t.id) - (!b.t.id) || b.sum.spend - a.sum.spend);
      $('aBody').innerHTML = groups.map((g) => `<tr class="teamrow${g.t.id ? '' : ' loose'}"><td><div class="nm"><span class="teamdot"></span><b>${esc(g.t.name)}</b><span class="hint">${g.users.length} ${g.users.length === 1 ? 'person' : 'people'}</span></div></td>
        <td class="r num" data-l="Clients">${g.sum.clients}</td><td class="r num" data-l="Lives">${g.sum.lives || dash}</td><td class="r num" data-l="Live">${g.sum.live > 0 ? money(g.sum.live) : dash}</td><td class="r num" data-l="Post">${g.sum.post > 0 ? money(g.sum.post) : dash}</td>
        <td class="r num tot" data-l="Total"><b>${money(g.sum.spend)}</b>${g.sum.spend && d.taxRate ? `<div class="hint">+tax ${money(tax(g.sum.spend))}</div>` : ''}</td><td class="hint">${t.spend ? Math.round(g.sum.spend / t.spend * 100) + '% of all' : ''}</td></tr>`
        + (g.users.map(userRows).join('') || '<tr class="teamempty"><td colspan="7" class="hint">No one in this team yet — add people below.</td></tr>')).join('');
    }
    $('aFoot').innerHTML = d.users.length > 1 ? `<tr><td>Total · ${d.users.length} accounts</td><td class="r num" data-l="Clients">${t.clients}</td><td class="r num" data-l="Lives">${t.lives}</td><td class="r num" data-l="Live">${money(t.live)}</td><td class="r num" data-l="Post">${money(t.post)}</td><td class="r num tot" data-l="Total"><b>${money(t.spend)}</b>${d.taxRate ? `<div class="hint">+tax ${money(tax(t.spend))}</div>` : ''}</td><td></td></tr>` : '';
    document.querySelectorAll('#aBody tr.drow').forEach((tr) => {
      const toggle = () => { const id = tr.dataset.uid; aOpen.has(id) ? aOpen.delete(id) : aOpen.add(id); renderAdmin();
        const box = document.querySelector(`#aBody tr.drow[data-uid="${id}"]`)?.nextElementSibling?.querySelector('.dexp-in');
        if (box && !calm && box.animate) { box.animate([{ opacity: 0, transform: 'translateY(-8px)' }, { opacity: 1, transform: 'none' }], { duration: 300, easing: 'cubic-bezier(.2,.8,.2,1)' }); box.querySelectorAll('.dl').forEach((el, i) => el.animate([{ opacity: 0, transform: 'translateX(-14px)' }, { opacity: 1, transform: 'none' }], { duration: 320, delay: 40 + i * 45, fill: 'backwards', easing: 'cubic-bezier(.2,.8,.2,1)' })); } };
      tr.onclick = toggle; tr.onkeydown = (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); } };
    });
  }

  function renderTeams() {
    const { teams, users, canEdit } = aTeams;
    $('teamNewForm').hidden = !canEdit;
    $('teamHint').textContent = canEdit ? 'Group people into teams (e.g. a PM and their media buyers). The Admin table above then shows spend per team. Each person can be in one team.' : 'Teams set up by the app owner.';
    const nameOf = (id) => (users.find((u) => u.id === id) || {}).name || 'Unknown';
    const inTeam = new Set(teams.flatMap((t) => t.members));
    $('teamGrid').innerHTML = teams.map((t) => `<div class="teamcard" data-team="${esc(t.id)}">
      <div class="tc-head"><b class="tc-name">${esc(t.name)}</b><span class="hint">${t.members.length} ${t.members.length === 1 ? 'person' : 'people'}</span><span class="spacer"></span>${canEdit ? '<button class="ghost" data-rename>Rename</button><button class="ghost danger-t" data-deleteteam>Delete</button>' : ''}</div>
      <div class="tc-members">${t.members.map((m) => `<span class="pchip">${esc(nameOf(m))}${canEdit ? `<button type="button" data-removemember="${esc(m)}" aria-label="Remove">×</button>` : ''}</span>`).join('') || '<span class="hint">No one yet</span>'}</div>
      ${canEdit ? `<select data-addmember><option value="">+ Add person…</option>${users.filter((u) => !t.members.includes(u.id)).map((u) => `<option value="${esc(u.id)}">${esc(u.name)}${inTeam.has(u.id) ? ' (move from other team)' : ''}</option>`).join('')}</select>` : ''}
    </div>`).join('') || `<div class="empty">${canEdit ? 'No teams yet. Type a name above and tap <b>+ New team</b>.' : 'No teams yet.'}</div>`;
    document.querySelectorAll('#teamGrid .teamcard').forEach((card) => {
      const id = card.dataset.team, patch = async (body) => { try { await api('/admin/teams/' + id, { method: 'PATCH', body }); await loadAdmin(); } catch (e) { toast(e.message); } };
      const add = card.querySelector('[data-addmember]'); if (add) add.onchange = () => add.value && patch({ add: add.value }).then(() => toast('Added to team'));
      card.querySelectorAll('[data-removemember]').forEach((b) => b.onclick = () => patch({ remove: b.dataset.removemember }));
      const rn = card.querySelector('[data-rename]'); if (rn) rn.onclick = () => { const n = prompt('Team name', card.querySelector('.tc-name').textContent); if (n && n.trim()) patch({ name: n.trim() }); };
      const del = card.querySelector('[data-deleteteam]'); if (del) del.onclick = async () => {
        if (!del.dataset.arm) { del.dataset.arm = '1'; del.textContent = 'Tap again'; setTimeout(() => { del.dataset.arm = ''; del.textContent = 'Delete'; }, 3000); return; }
        try { await api('/admin/teams/' + id, { method: 'DELETE' }); toast('Team deleted — people keep their data'); await loadAdmin(); } catch (e) { toast(e.message); }
      };
    });
  }
  $('teamNewForm').addEventListener('submit', async (ev) => {
    ev.preventDefault(); const name = $('teamNewName').value.trim(); if (!name) return $('teamNewName').focus();
    try { await api('/admin/teams', { method: 'POST', body: { name } }); $('teamNewName').value = ''; toast('Team created — now add people'); await loadAdmin(); } catch (e) { toast(e.message); }
  });

  // ---------- Telegram groups for clients ----------
  let tgChats = [], tgCode = '', tgBot = '';
  async function loadChats() {
    if (!me || !me.telegram || !me.telegram.bot) return;
    try { const r = await api('/telegram/chats'); tgChats = r.chats || []; tgCode = r.code || ''; tgBot = r.bot || ''; } catch (_) { tgChats = []; }
    renderClients();
  }

  // ---------- boot ----------
  (async () => {
    try {
      me = await api('/me');
      loadChats(); loadCheck();
      date = me.today || date;
      $('whoName').textContent = me.name;
      $('whoAvatar').textContent = (me.name || '?').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
      [clients, accounts] = await Promise.all([api('/clients'), api('/accounts')]);
      renderClients(); renderAccounts(); loadPages(); loadClientMonth();
      await loadDay();
      const h = location.hash.slice(1);
      if (me.canAdmin) document.querySelector('nav.tabs [data-tab=admin]').hidden = false;
      showTab(['clients', 'accounts', 'team', 'admin'].includes(h) ? h : 'dashboard');
      window.scrollTo(0, 0);
    } catch (e) { $('list').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  })();
})();
