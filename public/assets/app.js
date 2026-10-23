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
    if (/^Sent|^Auto report on/.test(text)) setTimeout(() => confetti(b, 22), 260); // a small celebration when a report goes out
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

  // ---------- our own calendar (replaces the browser's date / month picker) ----------
  // Each date input stays in the page (so the rest of the code reads / sets .value as before), but is
  // hidden behind a button that shows the date nicely and opens this calendar.
  const Cal = (() => {
    const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const p2 = (n) => String(n).padStart(2, '0'), isoOf = (y, m, d) => `${y}-${p2(m + 1)}-${p2(d)}`;
    const todayIso = () => (typeof me !== 'undefined' && me && me.today) || isoOf(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());
    const show = (inp) => { const v = inp.value; if (!v) return inp.type === 'month' || inp.dataset.cal === 'month' ? 'Pick a month' : 'Pick a day';
      if (inp.dataset.cal === 'month') { const [y, m] = v.split('-').map(Number); return `${MON[m - 1]} ${y}`; }
      const [y, m, d] = v.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('en-GB', inp.dataset.short ? { day: 'numeric', month: 'short', year: 'numeric' } : { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }); };
    let pop = null, cur = null, view = null, mode = 'days', closer = null;
    function close() { if (!pop) return; const el = pop; pop = null; cur && cur._btn.setAttribute('aria-expanded', 'false'); cur = null; document.removeEventListener('pointerdown', closer, true); document.removeEventListener('keydown', onKey, true);
      if (!calm && el.animate) el.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(6px) scale(.97)' }], { duration: 160, easing: 'ease-in' }).onfinish = () => el.remove(); else el.remove(); }
    function onKey(ev) { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); const b = cur && cur._btn; close(); b && b.focus(); } }
    function pick(v) { const inp = cur; inp.value = v; inp.dispatchEvent(new Event('input', { bubbles: true })); inp.dispatchEvent(new Event('change', { bubbles: true })); const b = inp._btn; close(); b.focus(); }
    function draw(dir = 0) {
      const inp = cur, isMonth = inp.dataset.cal === 'month', max = inp.max || '', min = inp.min || '', sel = inp.value, t = todayIso();
      // range partner (From ↔ To) to shade the days in between
      const other = inp.dataset.pair ? document.getElementById(inp.dataset.pair) : null, a = other && other.value && sel ? [sel, other.value].sort() : null;
      let body = '';
      if (mode === 'days' && !isMonth) {
        const first = new Date(view.y, view.m, 1), start = new Date(view.y, view.m, 1 - first.getDay());
        let cells = '';
        for (let i = 0; i < 42; i++) {
          const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i), v = isoOf(d.getFullYear(), d.getMonth(), d.getDate());
          const off = (max && v > max) || (min && v < min), out = d.getMonth() !== view.m;
          cells += `<button type="button" class="cd${out ? ' out' : ''}${v === t ? ' today' : ''}${v === sel ? ' sel' : ''}${a && v > a[0] && v < a[1] ? ' inr' : ''}${a && (v === a[0] || v === a[1]) && v !== sel ? ' edge' : ''}" data-v="${v}"${off ? ' disabled' : ''} aria-label="${d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}"${v === sel ? ' aria-current="date"' : ''}>${d.getDate()}</button>`;
        }
        body = `<div class="cal-w">${['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((x) => `<span>${x}</span>`).join('')}</div><div class="cal-g" data-dir="${dir}">${cells}</div>`;
      } else if (mode === 'years') {
        const y0 = view.y - (view.y % 12);
        body = `<div class="cal-m" data-dir="${dir}">${Array.from({ length: 12 }, (_, i) => y0 + i).map((y) => `<button type="button" class="cm${y === view.y ? ' sel' : ''}${String(y) === t.slice(0, 4) ? ' today' : ''}" data-y="${y}"${max && String(y) > max.slice(0, 4) ? ' disabled' : ''}>${y}</button>`).join('')}</div>`;
      } else { // months
        body = `<div class="cal-m" data-dir="${dir}">${MON.map((n, i) => { const v = `${view.y}-${p2(i + 1)}`; return `<button type="button" class="cm${(isMonth ? sel : sel.slice(0, 7)) === v ? ' sel' : ''}${t.slice(0, 7) === v ? ' today' : ''}" data-m="${i}"${max && v > max.slice(0, 7) ? ' disabled' : ''}>${n.slice(0, 3)}</button>`; }).join('')}</div>`;
      }
      const title = mode === 'years' ? `${view.y - (view.y % 12)} – ${view.y - (view.y % 12) + 11}` : mode === 'months' || isMonth ? String(view.y) : `${MON[view.m]} ${view.y}`;
      const quick = isMonth ? `<button type="button" data-q="${t.slice(0, 7)}">This month</button>` : `<button type="button" data-q="${t}">Today</button><button type="button" data-q="${(() => { const d = new Date(Number(t.slice(0, 4)), Number(t.slice(5, 7)) - 1, Number(t.slice(8)) - 1); return isoOf(d.getFullYear(), d.getMonth(), d.getDate()); })()}">Yesterday</button>`;
      pop.innerHTML = `<div class="cal-h"><button type="button" class="cal-nav" data-nav="-1" aria-label="Previous">‹</button><button type="button" class="cal-t" data-up="1" title="Change month / year">${title}<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button><button type="button" class="cal-nav" data-nav="1" aria-label="Next">›</button></div>${body}<div class="cal-f">${quick}</div>`;
      const g = pop.querySelector('[data-dir]');
      if (g && dir && !calm && g.animate) g.animate([{ opacity: 0, transform: `translateX(${dir * 22}px)` }, { opacity: 1, transform: 'none' }], { duration: 260, easing: 'cubic-bezier(.22,1,.36,1)' });
    }
    function place() {
      const r = cur._btn.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight, phone = innerWidth <= 560;
      if (phone) { pop.style.left = Math.round((innerWidth - w) / 2) + 'px'; pop.style.top = Math.max(10, Math.round(Math.min(innerHeight - h - 10, (innerHeight - h) / 2))) + 'px'; return; }
      let x = Math.min(Math.max(10, r.left), innerWidth - w - 10), y = r.bottom + 8;
      if (y + h > innerHeight - 10) y = Math.max(10, r.top - h - 8);
      pop.style.left = Math.round(x) + 'px'; pop.style.top = Math.round(y) + 'px';
    }
    function open(inp) {
      if (cur === inp) return close(); close();
      cur = inp; const base = inp.value || todayIso(); view = { y: Number(base.slice(0, 4)), m: Number(base.slice(5, 7)) - 1 }; mode = inp.dataset.cal === 'month' ? 'months' : 'days';
      pop = document.createElement('div'); pop.className = 'cal'; pop.setAttribute('role', 'dialog'); pop.setAttribute('aria-label', 'Choose a date');
      (inp.closest('dialog') || document.body).appendChild(pop);
      draw(); place(); inp._btn.setAttribute('aria-expanded', 'true');
      if (!calm && pop.animate) pop.animate([{ opacity: 0, transform: 'translateY(8px) scale(.96)' }, { opacity: 1, transform: 'none' }], { duration: 240, easing: 'cubic-bezier(.22,1,.36,1)' });
      pop.addEventListener('click', (ev) => {
        const b = ev.target.closest('button'); if (!b || b.disabled) return;
        if (b.dataset.v) return pick(b.dataset.v);
        if (b.dataset.q) return pick(b.dataset.q);
        if (b.dataset.m !== undefined) { if (cur.dataset.cal === 'month') return pick(`${view.y}-${p2(Number(b.dataset.m) + 1)}`); view.m = Number(b.dataset.m); mode = 'days'; return draw(); }
        if (b.dataset.y) { view.y = Number(b.dataset.y); mode = 'months'; return draw(); }
        if (b.dataset.up) { mode = mode === 'days' ? 'months' : mode === 'months' ? 'years' : (cur.dataset.cal === 'month' ? 'months' : 'days'); return draw(); }
        if (b.dataset.nav) { const n = Number(b.dataset.nav); if (mode === 'days') { view.m += n; if (view.m < 0) { view.m = 11; view.y--; } if (view.m > 11) { view.m = 0; view.y++; } } else if (mode === 'months') view.y += n; else view.y += n * 12; draw(n); }
      });
      closer = (ev) => { if (pop && !pop.contains(ev.target) && !inp._btn.contains(ev.target)) close(); };
      setTimeout(() => { document.addEventListener('pointerdown', closer, true); document.addEventListener('keydown', onKey, true); }, 0);
    }
    function attach(inp) {
      if (!inp || inp._btn) return;
      inp.dataset.cal = inp.type === 'month' ? 'month' : 'day';
      const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'datebtn'; btn.setAttribute('aria-haspopup', 'dialog'); btn.setAttribute('aria-expanded', 'false');
      btn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4.5" width="18" height="16" rx="3"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/></svg><span></span>';
      if (inp.getAttribute('aria-label')) btn.setAttribute('aria-label', inp.getAttribute('aria-label'));
      inp._btn = btn; inp.type = 'hidden'; inp.after(btn);
      const refresh = () => { btn.querySelector('span').textContent = show(inp); btn.classList.toggle('empty', !inp.value); };
      // keep the button in step when code sets input.value
      const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      Object.defineProperty(inp, 'value', { get() { return desc.get.call(this); }, set(v) { desc.set.call(this, v == null ? '' : v); refresh(); }, configurable: true });
      btn.onclick = () => open(inp);
      refresh();
    }
    addEventListener('resize', () => pop && place());
    addEventListener('scroll', () => pop && place(), true);
    return { attach, close };
  })();
  ['pFrom', 'pTo', 'dFrom', 'dTo'].forEach((id) => { document.getElementById(id).dataset.short = '1'; });
  ['invDate', 'pDay', 'pMonth', 'pFrom', 'pTo', 'dFrom', 'dTo'].forEach((id) => Cal.attach(document.getElementById(id)));
  document.getElementById('pFrom').dataset.pair = 'pTo'; document.getElementById('pTo').dataset.pair = 'pFrom';

  // ---------- theme: Auto → Light → Dark ----------
  const THEMES = ['auto', 'light', 'dark'], THEME_NAME = { auto: 'Auto (follows your device)', light: 'Light', dark: 'Dark' };
  const themePick = () => document.documentElement.getAttribute('data-theme-pick') || 'auto';
  function applyTheme(t) {
    const r = document.documentElement;
    r.setAttribute('data-theme-pick', t);
    if (t === 'auto') r.removeAttribute('data-theme'); else r.setAttribute('data-theme', t);
    try { localStorage.setItem('bd-theme', t); } catch (e) {}
    const b = $('themeBtn'); if (b) { b.title = 'Theme: ' + THEME_NAME[t]; b.setAttribute('aria-label', 'Theme: ' + THEME_NAME[t]); }
    const dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.querySelector('meta[name=theme-color]')?.setAttribute('content', dark ? '#0C0E15' : '#5B45F0');
  }
  if ($('themeBtn')) {
    applyTheme(themePick());
    $('themeBtn').onclick = (ev) => {
      const next = THEMES[(THEMES.indexOf(themePick()) + 1) % THEMES.length];
      // A circle of the new theme grows out from the button.
      if (calm || !document.startViewTransition) { applyTheme(next); toast('Theme: ' + THEME_NAME[next]); return; }
      const x = ev.clientX || innerWidth - 60, y = ev.clientY || 30, rad = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
      document.startViewTransition(() => applyTheme(next)).ready.then(() => {
        document.documentElement.animate({ clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${rad}px at ${x}px ${y}px)`] },
          { duration: 650, easing: 'cubic-bezier(.22,1,.36,1)', pseudoElement: '::view-transition-new(root)' });
      });
      toast('Theme: ' + THEME_NAME[next]);
    };
  }

  // Sync errors in plain words: the same problem on many accounts is said once.
  function syncErrText(errs) {
    const noAccess = errs.filter((e) => /Cannot call API for app/i.test(e.message || ''));
    const out = [];
    if (noAccess.length) out.push(`Meta blocked ${noAccess.length} ad account${noAccess.length === 1 ? '' : 's'} because this Facebook account isn't approved for the Ads Box Meta app yet. Ask the app owner to add you as a Tester, accept the invite at developers.facebook.com/requests, then log out, log in and sync again.`);
    const rest = errs.filter((e) => !noAccess.includes(e)), by = {};
    for (const e of rest) (by[e.message] = by[e.message] || []).push(e.account);
    const groups = Object.entries(by).map(([msg, accs]) => `${accs.slice(0, 4).join(', ')}${accs.length > 4 ? ` +${accs.length - 4} more` : ''}: ${msg}`);
    if (rest.length) out.push(`${rest.length} account(s) failed — ` + groups.join(' · '));
    return out.join(' ');
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
    if (name === 'team') name = 'admin'; // Team & Telegram was removed; auto sync now lives in Admin
    document.querySelectorAll('nav.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
    document.body.dataset.tab = name; // the Clients tab uses the full width
    if ((name === 'admin' || name === 'main') && !(me && me.canAdmin)) name = 'dashboard';
    ['main', 'dashboard', 'clients', 'accounts', 'lives', 'orders', 'payments', 'admin'].forEach((t) => $('tab-' + t).hidden = t !== name);
    if (name !== 'dashboard' && typeof setDock === 'function') setDock(false);
    moveInk();
    if (name === 'dashboard') { loadDash(); loadTodo(); }
    if (name === 'clients') loadClientMonth();
    if (name === 'admin') { showAdm(admSec); if (admSec !== 'health') loadHealth(); }
    if (name === 'lives') loadLives();
    if (name === 'payments') loadPayments();
    if (name === 'orders') loadOrders();
    if (name === 'main') loadMain();
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
      status($('syncStatus'), `Last synced from Meta ${t} by ${m.synced_by}.` + (errs.length ? ' ' + syncErrText(errs) : ''), errs.length > 0);
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
    const gaps = c.checks.filter((x) => x.missing > (x.tol != null ? x.tol : Math.max(0.5, x.meta * 0.003))); // small gaps = spend that came in during the sync, or cent rounding
    const t = new Date(c.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    if (!gaps.length) { status(el, `✓ Checked at ${t}: all spend from ${c.checks.length} ad account${c.checks.length === 1 ? '' : 's'} was found (${nice(c.from).replace(/^\w+, /, '')} – ${nice(c.to).replace(/^\w+, /, '')}).`); return; }
    status(el, `⚠ Checked at ${t}: some spend was not found — ` + gaps.map((g) => `${g.account}: Meta ${money(g.meta)}, found ${money(g.found)} (missing ${money(g.missing)})${g.why ? ` [Meta rows: ${g.why}]` : ''}`).join(' · ') + '. Tell your developer which accounts.', true);
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
        <td class="r num">${money(i.balance)}${cur}</td><td class="r num">${i.threshold != null ? money(i.threshold) : '<span class="muted">—</span>'}</td><td class="r num">${cap}</td><td class="r num">${money(i.amountSpent)}</td></tr>`;
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
  // Threshold extension setup: reveal the per-user endpoint + key to paste into Check My Ads.
  let extLoaded = false;
  $('extBtn').onclick = async () => {
    const box = $('extBox'); const show = box.hidden; box.hidden = !show;
    if (show && !extLoaded) {
      try { const r = await api('/ext/key'); $('extUrl').value = r.url; $('extKey').value = r.key; extLoaded = true; }
      catch (e) { toast(e.message); $('extKey').value = ''; $('extKey').placeholder = 'Could not load key'; }
    }
  };
  const copy = (sel, label) => { const el = $(sel); if (!el.value) return; el.select(); navigator.clipboard?.writeText(el.value).then(() => toast(label + ' copied'), () => toast('Select and copy manually')); };
  $('extCopyUrl').onclick = () => copy('extUrl', 'URL');
  $('extCopyKey').onclick = () => copy('extKey', 'Key');

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
  let cOrdQ = null, cMonth = {}, cOrd = {}, cOrdY = {}, cTodo = null, cWork = {}, cSel = null, cPicked = false;
  let cSort = (() => { try { return localStorage.getItem('cSort') || 'attention'; } catch (_) { return 'attention'; } })();
  async function loadClientMonth() {
    const t = (me && me.today) || iso(new Date()), ym = t.slice(0, 7);
    try {
      const d = await api(`/dashboard?from=${ym}-01&to=${t}`);
      cMonth = Object.fromEntries(d.clients.map((c) => [c.id, c]));
      renderClients();
    } catch (_) {}
    api(`/orders/report?from=${ym}-01&to=${t}`).then((r) => { cOrd = Object.fromEntries((r.clients || []).map((c) => [c.id, c])); cOrdQ = r.quality || null; renderClients(); }).catch(() => {});
    api('/todo').then((r) => { cTodo = r; renderClients(); }).catch(() => {});
    api('/clients-work').then((r) => { cWork = r.clients || {}; renderClients(); }).catch(() => {});
    const y = addD(t, -1); api(`/orders/report?from=${y}&to=${y}`).then((r) => { cOrdY = Object.fromEntries((r.clients || []).map((c) => [c.id, c])); renderClientDetail(); }).catch(() => {});
  }

  // What needs doing for a client today: to-dos not ticked yet + open tasks; "urgent" = a warning or a report to send.
  function attentionOf(c) {
    const w = cWork[c.id] || { openTasks: 0, ticked: [] }, items = cTodo ? [...(cTodo.items || []), ...(cTodo.tips || [])].filter((x) => x.clientId === c.id && !w.ticked.includes(x.kind)) : [];
    const todo = items.filter((x) => x.level !== 'good');
    const urgent = todo.some((x) => x.level === 'bad' || x.level === 'warn' || x.kind === 'report');
    return { n: todo.length + (w.openTasks || 0), urgent };
  }
  function renderClients() {
    const q = ($('cSearch').value || '').trim().toLowerCase();
    const att = Object.fromEntries(clients.map((c) => [c.id, attentionOf(c)]));
    const list = clients.filter((c) => !q || [c.name, ...(c.pages || [])].some((x) => String(x).toLowerCase().includes(q)))
      .sort((a, b) => (a.archived - b.archived) || (cSort === 'attention' ? ((att[b.id].urgent - att[a.id].urgent) || (att[b.id].n - att[a.id].n)) : 0) || ((cMonth[b.id]?.spend || 0) - (cMonth[a.id]?.spend || 0)) || a.name.localeCompare(b.name));
    if ($('cSortSeg')) $('cSortSeg').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.k === cSort)));
    $('cCount').textContent = clients.filter((c) => !c.archived).length;
    if (cSel && !clients.some((c) => c.id === cSel)) cSel = null;
    if ((!cSel || !cPicked) && list.length && matchMedia('(min-width: 901px)').matches) cSel = list[0].id; // until someone picks, show the top client
    $('cGrid').innerHTML = list.map((c, i) => {
      const m = cMonth[c.id], o = cOrd[c.id], cpo = o && o.orders && o.spend ? ordSpendOf(o) / o.orders : null;
      return `<button type="button" class="crow${c.archived ? ' paused' : ''}${c.id === cSel ? ' on' : ''}" role="option" aria-selected="${c.id === cSel}" data-csel="${c.id}" style="--i:${Math.min(i, 14)}">
        <span class="cr-av" aria-hidden="true">${esc(String(c.name || '?').trim().slice(0, 1).toUpperCase())}</span>
        <span class="cr-n"><b>${esc(c.name)}${att[c.id].n ? `<span class="cr-badge${att[c.id].urgent ? ' urgent' : ''}" title="${att[c.id].n} thing${att[c.id].n === 1 ? '' : 's'} to do today">${att[c.id].n}</span>` : ''}</b><span class="cr-tags">${typeTags(c.type)}${c.archived ? '<span class="chip meta">Paused</span>' : ''}${!c.telegram ? '<span class="chip nogroup" title="No Telegram group — reports can\'t be sent">No group</span>' : ''}</span></span>
        <span class="cr-v"><b class="num">${m && m.spend ? money(m.spend) : '–'}</b><span class="hint">${o && o.orders ? `${o.orders.toLocaleString('en-US')} orders${cpo ? ' · ' + money(cpo) : ''}` : 'this month'}</span></span>
      </button>`;
    }).join('') || `<div class="empty">${clients.length ? 'No client matches your search.' : '<b>No clients yet.</b><br>Tap <b>+ Add client</b>, or tap <b>Sync from Meta</b> on the Dashboard and add the Pages it finds.'}</div>`;
    document.querySelectorAll('#cGrid [data-csel]').forEach((b) => b.onclick = () => selectClient(Number(b.dataset.csel)));
    $('cWrap').classList.toggle('show-detail', !!cSel && $('cWrap').classList.contains('show-detail'));
    renderClientDetail();
  }
  function selectClient(id) {
    cSel = id; cPicked = true; cSetOpen = false; $('cWrap').classList.add('show-detail');
    document.querySelectorAll('#cGrid [data-csel]').forEach((b) => { const on = Number(b.dataset.csel) === id; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); });
    renderClientDetail(true);
    if (!matchMedia('(min-width: 901px)').matches) window.scrollTo({ top: $('tab-clients').offsetTop - 70, behavior: calm ? 'auto' : 'smooth' });
  }
  // ---- client detail: numbers, today's work, AI suggestions, settings (the edit form lives here) ----
  const cAi = {}, cFormEl = document.getElementById('cForm'); // the edit form moves between the dialog and the detail panel
  const parkForm = () => { if (cFormEl.parentElement !== $('cDlg')) $('cDlg').appendChild(cFormEl); };
  const monthRange = () => { const t = (me && me.today) || iso(new Date()); return [t.slice(0, 8) + '01', t]; };
  let cSetOpen = false; // the settings form stays hidden until ⚙ is tapped
  const cWb = {}; // per client: { notes, tasks, ai, ticks, today } from /clients/:id/workbook
  const IC_TODO = { report: '📨', nogroup: '✈️', invoice: '🧾', unpaid: '⏳', missing: '🕒', quiet: '💤', high: '🔥', 'cpr-up': '📉', 'cpr-down': '📈', best: '🏆' };
  function renderClientDetail(fresh) {
    const box = $('cDetail'), c = clients.find((x) => x.id === cSel);
    if (!c) { parkForm(); box.innerHTML = '<div class="cd-empty"><div class="cd-empty-ic" aria-hidden="true">👈</div><b>Pick a client</b><span class="hint">See this month\'s numbers, today\'s plan from AI, your notes and tasks, and the client\'s settings in one place.</span></div>'; return; }
    const m = cMonth[c.id] || {}, o = cOrd[c.id] || {}, cpo = o.orders && o.spend ? ordSpendOf(o) / o.orders : null;
    const keepForm = !!box.querySelector('#cdForm') && cFormEl.parentElement === box.querySelector('#cdForm') && !fresh && box.querySelector('.cd-in') && Number(box.querySelector('.cd-in').dataset.cdid) === c.id;
    const notesVal = keepForm && $('cdNotes') ? $('cdNotes').value : null; // keep what is being typed
    parkForm(); // rescue the form before the panel is redrawn
    box.innerHTML = `<div class="cd-in" data-cdid="${c.id}">
      <div class="cd-head"><button type="button" class="ghost sm cd-back" id="cdBack">← All clients</button>
        <div class="cd-head-row"><div class="cd-title"><span class="cr-av lg" aria-hidden="true">${esc(String(c.name || '?').trim().slice(0, 1).toUpperCase())}</span><div><h3>${esc(c.name)}</h3><div class="cr-tags">${typeTags(c.type)}${c.archived ? '<span class="chip meta">Paused</span>' : ''}${c.telegram ? `<span class="tgok">✈ ${esc(c.telegram_title || 'Telegram group')}</span>` : '<span class="cr-warn">No Telegram group</span>'}</div></div></div>
          <button type="button" class="sm cd-setbtn" id="cdSetBtn" aria-expanded="${cSetOpen}" aria-controls="cdSettings">⚙ Client settings</button></div></div>
      <section class="cd-settings" id="cdSettings" ${cSetOpen ? '' : 'hidden'}><div class="cd-sec-h"><h4>⚙ Client settings</h4><span class="spacer"></span><button type="button" class="ghost sm" id="cdSetClose" aria-label="Close settings">✕</button></div><div id="cdForm"></div></section>
      <div class="cd-stats">
        <div class="cd-stat hero"><span class="lbl">Spent this month</span><b class="num">${money(m.spend || 0)}</b>${m.spend && taxRate() ? `<span class="sub">+tax ${money(withTax(m.spend))}</span>` : ''}</div>
        ${(() => { const all = Object.values(cOrd).filter((x) => x.orders && x.spend), avg = all.length ? all.reduce((t, x) => t + ordSpendOf(x), 0) / all.reduce((t, x) => t + x.orders, 0) : null, tn = cpo == null || avg == null ? '' : cpo <= avg * 0.8 ? 'good' : cpo >= avg * 1.5 ? 'bad' : 'mid', y = cOrdY[c.id], ycpo = y && y.orders && y.spend ? ordSpendOf(y) / y.orders : null;
          return `<div class="cd-stat cpo ${tn}"><span class="lbl">Cost per order</span><b class="num">${cpo ? money(cpo) : '–'}</b><span class="sub">${ycpo ? 'Yesterday ' + money(ycpo) : y && y.spend ? 'Yesterday: no orders' : avg ? 'Average ' + money(avg) : 'from adsbox.biz'}</span></div>`; })()}
        <div class="cd-stat"><span class="lbl">Orders</span><b class="num">${o.orders ? o.orders.toLocaleString('en-US') : '–'}</b><span class="sub">${cOrdY[c.id] && cOrdY[c.id].orders ? 'Yesterday ' + cOrdY[c.id].orders.toLocaleString('en-US') : 'this month'}${cOrdQ && cOrdQ.estimate ? ` · <span title="Days from before Boost Desk kept daily order counts come from adsbox.biz's API and may be too high">${cOrdQ.estimate} day${cOrdQ.estimate === 1 ? '' : 's'} estimated</span>` : ''}</span></div>
        <div class="cd-stat"><span class="lbl">Lives · posts</span><b class="num">${m.lives || 0} · ${money(m.postSpend || 0)}</b><span class="sub">${money(m.liveSpend || 0)} on lives · ${m.days || 0} day${m.days === 1 ? '' : 's'}</span></div>
      </div>
      <div class="cd-cols">
        <div class="cd-col">${workSection(c)}
          <section class="cd-sec notesec"><div class="cd-sec-h"><h4>📝 Notes</h4><span class="hint" id="cdNotesSt">${cWb[c.id] && cWb[c.id].notesAt ? 'Saved ' + esc(ago(cWb[c.id].notesAt)) : 'Only you see your notes'}</span></div>
            <textarea id="cdNotes" rows="5" maxlength="5000" placeholder="Notes about this client — what they like, budget agreed, best live times, things to remember…">${esc(notesVal != null ? notesVal : (cWb[c.id] && cWb[c.id].notes) || '')}</textarea></section>
        </div>
        <div class="cd-col">${aiSection(c)}</div>
      </div>
    </div>`;
    const setOpen = (on) => { cSetOpen = on; $('cdSettings').hidden = !on; $('cdSetBtn').setAttribute('aria-expanded', String(on)); if (on && !calm && $('cdSettings').animate) $('cdSettings').animate([{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: 'cubic-bezier(.22,1,.36,1)' }); };
    $('cdSetBtn').onclick = () => setOpen(!cSetOpen); $('cdSetClose').onclick = () => setOpen(false);
    $('cdBack').onclick = () => { $('cWrap').classList.remove('show-detail'); window.scrollTo({ top: $('tab-clients').offsetTop - 70, behavior: calm ? 'auto' : 'smooth' }); };
    let nt; $('cdNotes').oninput = () => { $('cdNotesSt').textContent = 'Saving…'; clearTimeout(nt); nt = setTimeout(async () => { try { const r = await api(`/clients/${c.id}/notes`, { method: 'PUT', body: { notes: $('cdNotes').value } }); if (cWb[c.id]) { cWb[c.id].notes = $('cdNotes').value; cWb[c.id].notesAt = r.notesAt; } if ($('cdNotesSt')) $('cdNotesSt').textContent = 'Saved'; } catch (e) { if ($('cdNotesSt')) $('cdNotesSt').textContent = e.message; } }, 700); };
    if (!keepForm || cEdit !== c) openClientDlg(c, null, { inline: true }); else $('cdForm').appendChild(cFormEl);
    if (!calm && fresh && box.animate) box.animate([{ opacity: 0, transform: 'translateX(10px)' }, { opacity: 1, transform: 'none' }], { duration: 300, easing: 'cubic-bezier(.22,1,.36,1)' });
    bindWork(c);
    if (!cWb[c.id]) loadWorkbook(c.id);
  }
  async function loadWorkbook(cid) {
    cWb[cid] = { loading: true, tasks: [], ticks: {} };
    try { cWb[cid] = await api(`/clients/${cid}/workbook`); } catch (e) { cWb[cid] = { tasks: [], ticks: {}, err: e.message }; }
    if (cid === cSel) { paintWork(); paintAi(); const n = $('cdNotes'); if (n && !n.value && cWb[cid].notes && document.activeElement !== n) n.value = cWb[cid].notes; }
    const w = cWb[cid];
    if (aiReady !== false && !w.err && !(w.ai && w.ai.day === w.today && w.ai.lang === aiLang)) runClientAi(cid);
  }
  // Today's work (from the rules) + tasks (AI plan and your own), all tickable.
  function workSection(c) {
    const w = cWb[c.id] || { tasks: [], ticks: {} }, today = w.today || (cTodo && cTodo.today) || me.today;
    const todo = cTodo ? [...(cTodo.items || []), ...(cTodo.tips || [])].filter((x) => x.clientId === c.id) : [];
    const tick = (k) => !!(w.ticks || {})[today + ':' + k];
    const tasks = (w.tasks || []).slice().sort((a, b) => (a.done - b.done) || (b.day || '').localeCompare(a.day || ''));
    const open = todo.filter((x) => !tick(x.kind)).length + tasks.filter((t) => !t.done).length;
    const box = '<span class="tbox" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg></span>';
    const rows = [
      ...todo.map((x) => `<div class="task ${tick(x.kind) ? 'done' : ''} ${esc(x.level || '')}"><button type="button" class="tcheck" role="checkbox" aria-checked="${tick(x.kind)}" data-ctick="${esc(x.kind)}" aria-label="Done">${box}</button><span class="todo-ic" aria-hidden="true">${IC_TODO[x.kind] || '•'}</span><div class="todo-t"><b>${esc(x.title)}</b><span class="hint">${esc(x.detail || '')}</span>${x.action === 'report' && !tick(x.kind) ? `<button type="button" class="sm primary task-act" data-cdrep="${c.id}">ផ្ញើរបាយការណ៍</button>` : ''}</div></div>`),
      ...tasks.map((t) => `<div class="task ${t.done ? 'done' : ''}"><button type="button" class="tcheck" role="checkbox" aria-checked="${!!t.done}" data-ctask="${esc(t.id)}" aria-label="Done">${box}</button><span class="todo-ic" aria-hidden="true">${t.from === 'ai' ? '✨' : '✍️'}</span><div class="todo-t"><b>${esc(t.text)}</b><span class="hint">${t.from === 'ai' ? 'AI plan' : 'Your task'}${t.day && t.day !== today ? ' · ' + esc(nice(t.day).replace(/ \d{4}$/, '')) : ''}${t.done && t.doneAt ? ' · done ' + esc(ago(t.doneAt)) : ''}</span></div><button type="button" class="ghost sm tdel" data-ctdel="${esc(t.id)}" aria-label="Delete task">✕</button></div>`),
    ];
    return `<section class="cd-sec worksec"><div class="cd-sec-h"><h4>✅ Today's work & tasks</h4><span class="countpill">${open}</span></div>
      <div class="cd-todo">${rows.join('') || '<div class="todo-done">🎉 Nothing to do for this client today.</div>'}</div>
      <form class="ai-ask" id="cdTaskForm"><input type="text" maxlength="200" placeholder="+ Add a task for this client" aria-label="Add a task"><button type="submit" class="sm">Add</button></form></section>`;
  }
  function paintWork() {
    const sec = document.querySelector('#cDetail .worksec'), c = clients.find((x) => x.id === cSel); if (!sec || !c) return;
    const w = cWb[c.id]; if (w && w.tasks) { cWork[c.id] = { openTasks: w.tasks.filter((t) => !t.done).length, ticked: Object.keys(w.ticks || {}).filter((k) => k.startsWith((w.today || '') + ':')).map((k) => k.slice(11)) }; paintBadge(c); }
    sec.outerHTML = workSection(c); bindWork(c);
  }
  // Refresh one client's badge in the list without redrawing the list.
  function paintBadge(c) {
    const row = document.querySelector(`#cGrid [data-csel="${c.id}"] .cr-n b`); if (!row) return;
    const a = attentionOf(c); row.querySelectorAll('.cr-badge').forEach((x) => x.remove());
    if (a.n) row.insertAdjacentHTML('beforeend', `<span class="cr-badge${a.urgent ? ' urgent' : ''}">${a.n}</span>`);
  }
  function bindWork(c) {
    const f = $('cdTaskForm'); if (f) f.onsubmit = async (ev) => { ev.preventDefault(); const inp = f.querySelector('input'), text = inp.value.trim(); if (!text) return; inp.disabled = true; try { cWb[c.id] = await api(`/clients/${c.id}/tasks`, { method: 'POST', body: { text } }); paintWork(); setTimeout(() => $('cdTaskForm') && $('cdTaskForm').querySelector('input').focus(), 0); } catch (e) { toast(e.message); inp.disabled = false; } };
    const rb = document.querySelector('#cDetail [data-cdrep]'); if (rb) rb.onclick = () => openReportDlg({ kind: 'client', cid: c.id, from: (cTodo && cTodo.today) || me.today, to: (cTodo && cTodo.today) || me.today, label: nice((cTodo && cTodo.today) || me.today) });
  }
  async function runClientAi(cid, force = false) {
    const k = cid + '|' + aiLang;
    cAi[k] = { loading: true }; if (cid === cSel) paintAi();
    try { const r = await api(`/clients/${cid}/plan`, { method: 'POST', body: { lang: aiLang, force } }); cWb[cid] = r; cAi[k] = { done: true }; if (cid === cSel) paintWork(); }
    catch (e) { cAi[k] = { err: e.message }; if (/not set up/i.test(e.message)) aiReady = false; }
    if (cid === cSel) paintAi();
  }
  function aiSection(c) {
    const st = cAi[c.id + '|' + aiLang], w = cWb[c.id] || {}, plan = w.ai && w.ai.lang === aiLang ? w.ai : null;
    const body = aiReady === false ? `<div class="hint">${me && me.isOwner ? 'Add a Gemini or Claude key in <b>Admin → Settings → AI advice</b> to get a plan here every morning.' : 'AI plans are not set up yet — ask the app owner.'}</div>`
      : st && st.loading ? '<div class="ai-load"><span class="ai-dot"></span><span class="ai-dot"></span><span class="ai-dot"></span> Making today\'s plan…</div>'
      : st && st.err ? `<div class="note">${esc(st.err)}</div>`
      : plan ? `<div class="ai-text">${mdLite(plan.text)}</div>` : w.loading || !w.today ? '<div class="ai-load"><span class="ai-dot"></span><span class="ai-dot"></span><span class="ai-dot"></span> Loading…</div>' : '<div class="hint">No plan yet for today.</div>';
    const when = plan ? (plan.day === w.today ? 'Today · made ' + new Date(plan.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : 'From ' + nice(plan.day).replace(/ \d{4}$/, '')) : 'Made every morning at 06:40';
    return `<section class="cd-sec aisec"><div class="cd-sec-h"><h4>✨ Today's plan</h4><span class="hint">${esc(when)}</span><span class="spacer"></span>
        <div class="seg ai-lang" role="group" aria-label="Language"><button type="button" data-cdlang="en" aria-pressed="${aiLang === 'en'}">EN</button><button type="button" data-cdlang="km" aria-pressed="${aiLang === 'km'}">ខ្មែរ</button></div>
        ${aiReady === false ? '' : `<button type="button" class="ghost sm" data-cdai="${c.id}" ${st && st.loading ? 'disabled' : ''}>↻ New</button>`}</div>${body}
        ${plan && plan.taskCount ? `<div class="hint ai-tnote">✨ ${plan.taskCount} task${plan.taskCount === 1 ? '' : 's'} from this plan were added to <b>Today's work & tasks</b>.</div>` : ''}</section>`;
  }
  // Repaint only one section, so the form and notes keep what is being typed.
  function paintAi() {
    const sec = document.querySelector('#cDetail .aisec'), c = clients.find((x) => x.id === cSel);
    if (sec && c) sec.outerHTML = aiSection(c);
  }
  document.addEventListener('click', async (ev) => {
    const a = ev.target.closest('[data-cdai]'); if (a) { runClientAi(Number(a.dataset.cdai), true); return; }
    const l = ev.target.closest('[data-cdlang]'); if (l) { aiLang = l.dataset.cdlang; try { localStorage.setItem('aiLang', aiLang); } catch (_) {} const w = cWb[cSel]; if (w && w.ai && w.ai.lang === aiLang && w.ai.day === w.today) paintAi(); else runClientAi(cSel); return; }
    const c = clients.find((x) => x.id === cSel); if (!c || !ev.target.closest('#cDetail')) return;
    const tk = ev.target.closest('[data-ctick]'), ts = ev.target.closest('[data-ctask]'), td = ev.target.closest('[data-ctdel]');
    try {
      if (tk) { const on = tk.getAttribute('aria-checked') !== 'true'; tk.closest('.task').classList.toggle('done', on); cWb[c.id] = await api(`/clients/${c.id}/tick`, { method: 'PUT', body: { key: tk.dataset.ctick, done: on } }); paintWork(); if (on) successBadge('Done ✓'); }
      else if (ts) { const on = ts.getAttribute('aria-checked') !== 'true'; ts.closest('.task').classList.toggle('done', on); cWb[c.id] = await api(`/clients/${c.id}/tasks/${ts.dataset.ctask}`, { method: 'PATCH', body: { done: on } }); paintWork(); }
      else if (td) { cWb[c.id] = await api(`/clients/${c.id}/tasks/${td.dataset.ctdel}`, { method: 'DELETE' }); paintWork(); }
    } catch (e) { toast(e.message); paintWork(); }
  });
  $('cSearch').oninput = () => renderClients();
  document.querySelectorAll('#cSortSeg button').forEach((b) => b.onclick = () => { cSort = b.dataset.k; try { localStorage.setItem('cSort', cSort); } catch (_) {} renderClients(); });

  // Add / edit dialog
  let cEdit = null, cDraft = null, cInline = false;
  // Pages as cards: name, ID, remove, and (when the group has topics) which topic its report goes to.
  let pnKnown = {};
  async function loadDlgPageNames() {
    const ids = cDraft.pages.filter((p) => isId(p) && !(p in pnKnown));
    if (!ids.length) return;
    try { Object.assign(pnKnown, await api('/page-names?ids=' + ids.join(','))); drawDlgPages(); } catch (_) {}
  }
  const groupTopics = () => {
    if (!cDraft.telegram) return [];
    const g = String(cDraft.telegram).split(':')[0];
    const list = tgChats.filter((t) => t.type === 'topic' && String(t.id).split(':')[0] === g);
    for (const v of Object.values(cDraft.topics || {})) if (v && v.id && String(v.id).split(':')[0] === g && !list.some((t) => t.id === v.id)) list.push({ id: v.id, title: v.title || v.id, topic: String(v.title || '').split(' › ').pop(), type: 'topic' });
    return list;
  };
  const topicName = (t) => t.topic || String(t.title).split(' › ').pop();
  const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9ក-៿]+/g, '');
  function drawDlgPages() {
    const topics = groupTopics();
    const label = (p) => (isId(p) ? pnKnown[p] || '' : p);
    // A Page with no topic yet takes the topic whose name matches it.
    for (const p of cDraft.pages) {
      if ((cDraft.topics[p] || {}).id || !topics.length) continue;
      const n = norm(label(p)); if (n.length < 3) continue;
      const t = topics.find((x) => { const tn = norm(topicName(x)); return tn.length >= 3 && (tn.includes(n) || n.includes(tn)); });
      if (t) cDraft.topics[p] = { id: t.id, title: t.title };
    }
    $('cPageCards').innerHTML = cDraft.pages.map((p, i) => {
      const name = label(p), cur = (cDraft.topics[p] || {}).id || '';
      return `<div class="pcard" style="--i:${i}">
        <div class="pcard-h"><span class="pcard-ic" aria-hidden="true">📄</span>
          <div class="pcard-n">${name ? `<b title="${esc(name)}">${esc(name)}</b>` : `<b class="muted">Page without a name</b>`}${isId(p) ? `<span class="hint num">ID …${esc(p.slice(-6))}</span>` : ''}</div>
          ${isId(p) && !name ? `<a class="btn sm" href="https://www.facebook.com/${encodeURIComponent(p)}" target="_blank" rel="noopener">Open ↗</a>` : ''}
          <button type="button" class="ghost pcard-x" data-rm="${i}" aria-label="Remove this Page">✕</button></div>
        ${topics.length ? `<label class="pcard-t"><span>Report to</span><select data-tp="${i}"><option value="">Main group chat</option>${topics.map((t) => `<option value="${esc(t.id)}" ${cur === t.id ? 'selected' : ''}># ${esc(topicName(t))}</option>`).join('')}</select></label>` : ''}
      </div>`;
    }).join('') || '<div class="pcard-empty">No Page yet — add the Facebook Page this client boosts from.</div>';
    $('cPageCards').querySelectorAll('[data-rm]').forEach((b) => b.onclick = () => { const p = cDraft.pages[Number(b.dataset.rm)]; cDraft.pages = cDraft.pages.filter((x) => x !== p); delete cDraft.topics[p]; drawDlgPages(); });
    $('cPageCards').querySelectorAll('[data-tp]').forEach((sel) => sel.onchange = () => {
      const p = cDraft.pages[Number(sel.dataset.tp)], t = topics.find((x) => x.id === sel.value);
      if (t) cDraft.topics[p] = { id: t.id, title: t.title }; else cDraft.topics[p] = { id: '', title: '' }; // '' = chosen main chat, don't auto-match again
    });
    pageEditor($('cPages'), [], 'cpg', (add) => { const v = add[0]; if (v && !cDraft.pages.includes(v)) { cDraft.pages = [...cDraft.pages, v]; drawDlgPages(); loadDlgPageNames(); } });
    $('cpg-add').placeholder = cDraft.pages.length ? '+ Add another Page (name or ID)' : '+ Add a Page (name or ID)';
  }
  function drawDlgTopics() { /* topics now live inside each Page card */ }
  function drawDlgType() { document.querySelectorAll('#cType button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === cDraft.type))); }
  document.querySelectorAll('#cType button').forEach((b) => b.onclick = () => { cDraft.type = b.dataset.v; drawDlgType(); });
  function drawDlgTg() {
    const box = $('cTgBox');
    if (!me || !me.telegram || !me.telegram.bot) { box.innerHTML = '<div class="note">The Telegram bot is not set up on the server yet (TELEGRAM_BOT_TOKEN in Railway), so groups can’t be picked. Reports can still be copied.</div>'; return; }
    const opts = tgChats.filter((t) => t.type !== 'topic');
    if (cDraft.telegram && !opts.some((o) => o.id === cDraft.telegram)) opts.push({ id: cDraft.telegram, title: cDraft.telegram_title || cDraft.telegram });
    box.innerHTML = `<div class="tgrow"><select id="cTg"><option value="">No group</option>${opts.map((o) => `<option value="${esc(o.id)}" ${o.id === cDraft.telegram ? 'selected' : ''}>${esc(o.title)}</option>`).join('')}</select><button type="button" id="cTgRefresh" title="Refresh list">↻ Refresh</button></div>
      <details class="linkhelp-d"><summary>How to connect a group or topic?</summary><div class="linkhelp"> add ${tgBot ? '<b>@' + esc(tgBot) + '</b>' : 'the bot'} to the client's Telegram group, send <code class="lcode" title="Tap to copy">/link${tgBot ? '@' + esc(tgBot) : ''} ${esc(tgCode)}</code> in the group, then tap <b>Refresh list</b>. Only people who linked a group see it, and teammates can each link the same group. To remove yourself, send <code>/unlink${tgBot ? '@' + esc(tgBot) : ''} ${esc(tgCode)}</code>. If nothing happens, make the bot an <b>admin</b> of the group. For a group with topics, also send the <b>/link</b> code inside each topic so it shows next to the Pages above.</div></details>`;
    const lc = box.querySelector('.lcode'); if (lc) lc.onclick = async () => { try { await navigator.clipboard.writeText(lc.textContent); toast('Copied — paste it in the Telegram group'); } catch (_) {} };
    $('cTg').onchange = () => { const o = opts.find((x) => x.id === $('cTg').value); cDraft.telegram = $('cTg').value; cDraft.telegram_title = o ? o.title : ''; drawDlgPages(); };
    $('cTgRefresh').onclick = async () => { await loadChats(); drawDlgTg(); drawDlgPages(); toast(tgChats.length ? `${tgChats.length} group${tgChats.length > 1 ? 's' : ''} found` : 'No groups yet — add the bot to a group and send a message there.'); };
  }
  function openClientDlg(c, preset, opts = {}) {
    cEdit = c || null; cInline = !!opts.inline;
    cDraft = c ? { name: c.name, type: c.type, pages: [...new Set([...(c.pages || []), c.match].filter(Boolean))], telegram: c.telegram || '', telegram_title: c.telegram_title || '', topics: { ...(c.topics || {}) } }
      : { name: '', type: 'live', pages: [], telegram: '', telegram_title: '', topics: {}, ...(preset || {}) };
    $('cDlgTitle').textContent = c ? 'Edit ' + c.name : 'Add client';
    $('cName').value = cDraft.name; $('cSave').textContent = c ? 'Save changes' : 'Add client';
    $('cDel').hidden = !c; $('cPause').hidden = !c; if (c) $('cPause').textContent = c.archived ? 'Resume' : 'Pause';
    $('cDel').textContent = 'Delete'; $('cDel').dataset.arm = '';
    drawDlgType(); drawDlgPages(); drawDlgTg(); loadDlgPageNames();
    $('cCancel').textContent = cInline ? 'Undo changes' : 'Cancel';
    const formEl = document.getElementById('cForm') || cFormEl;
    if (cInline && $('cdForm')) { $('cdForm').appendChild(formEl); return; } // shown inside the Clients tab's detail panel
    if (formEl.parentElement !== $('cDlg')) $('cDlg').appendChild(formEl);
    const d = $('cDlg'); if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '');
    setTimeout(() => (c ? $('cpg-add') : $('cName')).focus(), 60);
  }
  // ---------- auto daily report ----------
  let arSet = null;
  function drawArState() { const el = $('cAutoState'); if (!arSet) { el.textContent = ''; return; } el.textContent = arSet.on ? arSet.time : 'Off'; el.classList.toggle('on', !!arSet.on); }
  async function loadAr() { try { arSet = await api('/auto-report'); drawArState(); } catch (_) {} }
  function drawAr() {
    $('arOn').checked = !!arSet.on; $('arOnTxt').textContent = arSet.on ? 'On' : 'Off'; $('arTime').value = arSet.time; $('arImg').checked = arSet.withImage !== false;
    const list = clients.filter((c) => !c.archived).sort((a, b) => (!!b.telegram - !!a.telegram) || a.name.localeCompare(b.name));
    $('arList').innerHTML = list.map((c) => c.telegram
      ? `<label><input type="checkbox" data-ar="${c.id}" ${arSet.skip.includes(c.id) ? '' : 'checked'}><b>${esc(c.name)}</b><small>✈ ${esc(c.telegram_title || 'Telegram group')}</small></label>`
      : `<label class="off"><input type="checkbox" disabled><b>${esc(c.name)}</b><small>No Telegram group</small></label>`).join('') || '<div class="empty">No clients yet.</div>';
    const count = () => { $('arCount').textContent = `${document.querySelectorAll('#arList [data-ar]:checked').length} of ${list.filter((c) => c.telegram).length} with a group`; };
    document.querySelectorAll('#arList [data-ar]').forEach((x) => x.onchange = count); count();
    const l = arSet.last, t = (x) => new Date(x).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    $('arNote').innerHTML = !arSet.bot ? 'The Telegram bot is not set up on the server yet, so reports can’t be sent.'
      : l && l.at ? `<b>Last run ${esc(t(l.at))}:</b> sent ${l.sent.length}${l.sent.length ? ' (' + esc(l.sent.join(', ')) + ')' : ''}${l.already && l.already.length ? ` · ${l.already.length} already sent by hand` : ''}${l.noSpend ? ` · ${l.noSpend} with no spend` : ''}${l.failed && l.failed.length ? `<br>⚠ Failed: ${esc(l.failed.map((f) => f.name + ' — ' + f.error).join('; '))}` : ''}`
      : `Clients with no boost spend that day get nothing. A report you already sent by hand is not sent again. Time zone: ${esc(arSet.tz || me.tz)}.`;
  }
  const arBody = () => ({ on: $('arOn').checked, time: $('arTime').value, withImage: $('arImg').checked, skip: [...document.querySelectorAll('#arList [data-ar]')].filter((x) => !x.checked).map((x) => Number(x.dataset.ar)) });
  $('arOn').onchange = () => { $('arOnTxt').textContent = $('arOn').checked ? 'On' : 'Off'; };
  $('cAutoBtn').onclick = async () => {
    if (!arSet) await loadAr(); if (!arSet) return toast('Could not load the auto report settings.');
    drawAr(); const d = $('arDlg'); if (typeof d.showModal === 'function') { if (!d.open) d.showModal(); } else d.setAttribute('open', '');
  };
  $('arSave').onclick = async () => {
    try { arSet = { ...arSet, ...(await api('/auto-report', { method: 'PUT', body: arBody() })) }; drawArState(); $('arDlg').close(); successBadge(arSet.on ? `Auto report on · ${arSet.time} every day` : 'Auto report off'); }
    catch (e) { toast(e.message); }
  };
  $('arRun').onclick = async () => {
    const b = $('arRun'); b.disabled = true; b.textContent = 'Sending…';
    try {
      const scr = arBody(), keep = arSet.on; const saved = await api('/auto-report', { method: 'PUT', body: { ...scr, on: keep } }); // use the ticks on screen
      const r = await api('/auto-report/run', { method: 'POST' });
      arSet = { ...arSet, ...saved, last: r }; drawAr(); $('arOn').checked = scr.on; $('arOnTxt').textContent = scr.on ? 'On' : 'Off';
      toast(r.sent.length ? `Sent ${r.sent.length} report${r.sent.length === 1 ? '' : 's'}` : r.already.length ? 'Today’s reports were already sent.' : 'No client has boost spend today.');
    } catch (e) { toast(e.message); } finally { b.disabled = false; b.textContent = 'Send now'; }
  };
  loadAr();

  // ---------- today's to-do (Dashboard) ----------
  const TODO_IC = { report: '📨', nogroup: '✈️', invoice: '🧾', unpaid: '⏳' };
  let todoHidden = false; try { todoHidden = localStorage.getItem('bd-todo') === 'hide'; } catch (_) {}
  async function loadTodo() {
    let d; try { d = await api('/todo'); } catch (_) { return; }
    const items = d.items, tips = d.tips || [], all = [...items, ...tips], panel = $('todoPanel');
    panel.hidden = false;
    $('todoCount').textContent = items.length || '✓';
    $('todoCount').classList.toggle('done', !items.length);
    $('todoToggle').textContent = todoHidden ? 'បង្ហាញ' : 'លាក់'; $('todoToggle').setAttribute('aria-expanded', String(!todoHidden));
    $('todoList').hidden = todoHidden;
    const btn = { report: 'ផ្ញើរបាយការណ៍', nogroup: 'ជ្រើសគ្រុប', invoice: 'បើកការទូទាត់', unpaid: 'បើកការទូទាត់', missing: 'បើកអតិថិជន', quiet: 'បើកអតិថិជន', high: 'បើកអតិថិជន', 'cpr-up': 'បើកអតិថិជន', 'cpr-down': 'បើកអតិថិជន', best: 'មើល Live' };
    const IC = { ...TODO_IC, missing: '🕒', quiet: '💤', high: '🔥', 'cpr-up': '📉', 'cpr-down': '📈', best: '🏆' };
    const row = (it, i) => `<div class="todo-it ${it.level}${i >= items.length ? ' tip' : ''}" style="--i:${i}"><span class="todo-ic" aria-hidden="true">${IC[it.kind] || '•'}</span><div class="todo-t"><b>${esc(it.title)}</b><span class="hint">${esc(it.detail || '')}</span></div><button type="button" class="sm${it.kind === 'report' ? ' primary' : ''}" data-todo="${i}">${btn[it.kind] || 'បើក'}</button></div>`;
    $('todoList').innerHTML = (items.length ? items.map(row).join('') : '<div class="todo-done">🎉 ការងារអតិថិជនថ្ងៃនេះ រួចរាល់ហើយ</div>')
      + (tips.length ? `<div class="todo-sub">💡 ការណែនាំ</div>` + tips.map((t, j) => row(t, items.length + j)).join('') : '');
    $('todoList').querySelectorAll('[data-todo]').forEach((b) => b.onclick = () => {
      const it = all[Number(b.dataset.todo)], c = clients.find((x) => x.id === it.clientId);
      if (it.action === 'report' && c) openReportDlg({ kind: 'client', cid: c.id, from: d.today, to: d.today, label: nice(d.today) });
      else if (it.action === 'client' && c) { showTab('clients'); selectClient(c.id); }
      else if (it.action === 'payments') showTab('payments');
      else if (it.action === 'lives') showTab('lives');
    });
  }
  $('todoToggle').onclick = () => { todoHidden = !todoHidden; try { localStorage.setItem('bd-todo', todoHidden ? 'hide' : 'show'); } catch (_) {} loadTodo(); };

  const closeClientDlg = () => { if ($('cDlg').open) $('cDlg').close(); };
  $('cAddBtn').onclick = () => openClientDlg(null);
  $('cClose').onclick = closeClientDlg;
  $('cCancel').onclick = () => { if (cInline && cEdit) { openClientDlg(cEdit, null, { inline: true }); toast('Changes undone'); } else closeClientDlg(); };
  $('cDlg').addEventListener('click', (ev) => { if (ev.target === $('cDlg')) closeClientDlg(); });
  $('cDlg').addEventListener('close', () => { if (!$('tab-clients').hidden) setTimeout(() => renderClientDetail(), 0); });
  $('cForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const pending = $('cpg-add') && $('cpg-add').value.trim(); if (pending && !cDraft.pages.includes(pending)) cDraft.pages.push(pending);
    const topics = {}, grp = String(cDraft.telegram || '').split(':')[0]; for (const p of cDraft.pages) { const v = cDraft.topics && cDraft.topics[p]; if (v && v.id && grp && String(v.id).split(':')[0] === grp) topics[p] = v; }
    const body = { name: $('cName').value.trim(), type: cDraft.type, pages: cDraft.pages, telegram: cDraft.telegram, telegram_title: cDraft.telegram_title, topics };
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

  // ---------- Main Dashboard (admins / COO): teams → their admins → Pages, with spend and orders ----------
  let mData = null, mSortK = 'spend', mTeam = null, mSug = null, mSugAt = 0, mSugAll = false; const mOpen = new Set();
  const SUG_IC = { unpaid: '⏳', missing: '🕒', quiet: '💤', high: '🔥', 'cpr-up': '📉', 'cpr-down': '📈', best: '🏆', expensive: '💸', cheap: '💎' };
  // Important suggestions for a team (COO view): money at risk and performance only — not day-to-day chores
  // like picking a Telegram group or sending a report.
  const SUG_KEEP = { high: 0, 'cpr-up': 1, quiet: 3, missing: 4, unpaid: 5, best: 7, 'cpr-down': 8 };
  function teamSug(members) {
    if (!mSug || !mSug.users) return [];
    const out = [], avg = mData ? cpoOf(mData.totals.ordSpend, mData.totals.orders) : null;
    for (const u of members) {
      const s2 = mSug.users[u.id];
      if (s2) [...s2.items, ...s2.tips].forEach((x) => { if (x.kind in SUG_KEEP) out.push({ ...x, who: u.name, rank: SUG_KEEP[x.kind] }); });
      // Pages where one order costs far more than the company average
      if (avg) for (const p of u.pages) {
        const c = cpoOf(p.spend, p.orders);
        if (c != null && p.spend >= 20 && c >= avg * 2) out.push({ kind: 'expensive', level: c >= avg * 4 ? 'bad' : 'warn', rank: 2, who: u.name, sort: -p.spend,
          title: `${p.page}${p.client ? ' (' + p.client + ')' : ''}: ${money(c)} per order — ${(c / avg).toFixed(1)}× the average`,
          detail: `${money(p.spend)} spent for ${p.orders.toLocaleString('en-US')} orders in this period · average ${money(avg)} · check the post, audience or price` });
      }
      // The team's cheapest Page with real volume: worth boosting more
      const best = u.pages.filter((p) => p.orders >= 20 && p.spend >= 20).map((p) => ({ p, c: p.spend / p.orders })).sort((a, b2) => a.c - b2.c)[0];
      if (best && avg && best.c <= avg * 0.7) out.push({ kind: 'cheap', level: 'good', rank: 6, who: u.name,
        title: `${best.p.page}${best.p.client ? ' (' + best.p.client + ')' : ''} gets orders cheap: ${money(best.c)} each`,
        detail: `${best.p.orders.toLocaleString('en-US')} orders for ${money(best.p.spend)} · ${Math.round((1 - best.c / avg) * 100)}% below the average — a good one to boost more` });
    }
    const lv = { bad: 0, warn: 1, todo: 2, good: 3 };
    return out.sort((a, b2) => (a.level === 'bad' ? 0 : 1) - (b2.level === 'bad' ? 0 : 1) || a.rank - b2.rank || (lv[a.level] ?? 2) - (lv[b2.level] ?? 2) || (a.sort || 0) - (b2.sort || 0)); // urgent first
  }
  const sugRow = (it, i) => `<div class="todo-it ${esc(it.level || '')}${it.tip ? ' tip' : ''}" style="--i:${Math.min(i, 12)}"><span class="todo-ic" aria-hidden="true">${SUG_IC[it.kind] || '•'}</span><div class="todo-t"><b>${esc(it.title)}</b><span class="hint">${esc(it.detail || '')}</span></div><span class="sug-who"><span class="mini-av">${esc(String(it.who || '?').split(/\s+/).map((x) => x[0]).join('').slice(0, 2).toUpperCase())}</span>${esc(it.who || '')}</span></div>`;
  // Tasks for one day across every person (AI daily plan tasks + their own, from each client's workbook).
  let mTasks = null, mTaskDay = null, mTab = 'tasks', mTaskF = 'all', mShow = false;
  async function loadTasks() {
    const day = mTaskDay;
    try { const x = await api('/main/tasks?day=' + day); if (day === mTaskDay) { mTasks = x; renderMain(); } }
    catch (e) { if (day === mTaskDay) { mTasks = { day, error: e.message, users: {} }; renderMain(); } }
  }
  async function loadMain() {
    if (!dDate) dDate = me.today;
    paintPeriod();
    const [from, to] = dRange();
    // a one-day period also picks the day for tasks
    const want = from === to ? to : (mTaskDay || me.today);
    if (want !== mTaskDay || !mTasks) { mTaskDay = want; mTasks = null; }
    loadTasks(); // always fresh: a task someone just added or ticked shows up
    if (!mData) { $('mTeamList').innerHTML = '<div class="crow skel-card"></div>'.repeat(4); $('mList').innerHTML = '<div class="cd-empty"><div class="muted">Loading…</div></div>'; }
    if (!mSug || Date.now() - mSugAt > 120e3) api('/main/suggestions').then((x) => { mSug = x; mSugAt = Date.now(); renderMain(); }).catch(() => {});
    try { mData = await api(`/main/overview?from=${from}&to=${to}`); renderMain(); }
    catch (e) { $('mList').innerHTML = `<div class="cd-empty">${esc(e.message)}</div>`; }
  }
  const ordSpendOf = (c) => (c && c.ordSpend != null ? c.ordSpend : c ? c.spend : 0); // spend on Pages that got orders
  const cpoOf = (spend, orders) => (orders > 0 && spend > 0 ? spend / orders : null);
  const mIni = (n) => String(n || '?').split(/\s+/).map((x) => x[0]).join('').slice(0, 2).toUpperCase();
  // Teams with their members; people in no team go to "No team". A Page boosted by two members counts its orders once.
  // `ids` = every person in the team (also people with no spend, so their tasks show).
  function mTeams() {
    const d = mData, inTeam = new Set(), out = [];
    const agg = (t, members, ids) => {
      const pg = new Map(); let added = 0;
      for (const u of members) for (const p of u.pages) {
        added += p.spend;
        const k = p.pageId || p.page, x = pg.get(k) || { camps: new Map(), orders: p.orders };
        for (const [id, v] of p.camps || [[u.id + p.page, p.spend]]) if (!x.camps.has(id)) x.camps.set(id, v); // each campaign once
        pg.set(k, x);
      }
      let spend = 0, orders = 0, ordSpend = 0;
      for (const x of pg.values()) { const sp = [...x.camps.values()].reduce((a, b) => a + b, 0); spend += sp; orders += x.orders; if (x.orders > 0) ordSpend += sp; }
      return { ...t, members, ids, spend, orders, ordSpend, pages: pg.size, shared: Math.max(0, added - spend), cpo: cpoOf(ordSpend, orders), task: taskStat(ids) };
    };
    for (const t of d.teams || []) { const ms = d.users.filter((u) => t.members.includes(u.id)); t.members.forEach((id) => inTeam.add(id)); out.push(agg(t, ms, [...t.members])); }
    const everyone = new Set([...d.users.map((u) => u.id), ...Object.keys((mTasks && mTasks.users) || {}).filter((id) => (mTasks.users[id].tasks || []).length)]);
    const restIds = [...everyone].filter((id) => !inTeam.has(id));
    if (restIds.length) out.push(agg({ id: '__none', name: (d.teams || []).length ? 'No team' : 'All accounts', members: [] }, d.users.filter((u) => !inTeam.has(u.id)), restIds));
    return out;
  }
  const personName = (id) => { const u = mData && mData.users.find((x) => x.id === id); return u ? u.name : (mTasks && mTasks.users[id] && mTasks.users[id].name) || 'Someone'; };
  function taskStat(ids) {
    const s = { total: 0, done: 0, late: 0, people: 0, ready: !!(mTasks && !mTasks.error) };
    if (!s.ready) return s;
    for (const id of ids) { const ts = (mTasks.users[id] || {}).tasks || []; if (ts.length) s.people++; for (const t of ts) { s.total++; if (t.done) s.done++; else if (t.late) s.late++; } }
    s.pct = s.total ? Math.round(s.done / s.total * 100) : null;
    return s;
  }
  const taskTone = (s) => (s.pct == null ? '' : s.pct >= 80 ? 'good' : s.pct >= 40 ? 'mid' : 'bad');
  const taskBar = (s, big) => s.ready ? (s.total ? `<span class="tk-bar ${big ? 'big ' : ''}${taskTone(s)}" role="img" aria-label="${s.done} of ${s.total} tasks done"><i style="width:${s.pct}%"></i></span>` : '') : '';
  const dayTxt = (d) => { if (!d) return ''; if (d === me.today) return 'today'; if (d === addD(me.today, -1)) return 'yesterday'; return new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }); };
  const hm = (iso) => { try { return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: me.tz || undefined }); } catch (_) { return ''; } };
  // One person's tasks, grouped by client.
  function personTasks(id, q) {
    const u = (mTasks.users || {})[id] || { tasks: [], plans: 0, clients: 0 }, has = (x) => String(x || '').toLowerCase().includes(q);
    let ts = u.tasks.filter((t) => mTaskF === 'all' || (mTaskF === 'open' ? !t.done : t.done));
    if (q && !has(personName(id))) ts = ts.filter((t) => has(t.text) || has(t.client));
    const st = taskStat([id]);
    if (q && !ts.length && !has(personName(id))) return '';
    const groups = new Map(); for (const t of ts) { if (!groups.has(t.client)) groups.set(t.client, []); groups.get(t.client).push(t); }
    const empty = !u.tasks.length ? `No work or tasks for ${dayTxt(mTasks.day)}.${u.clients ? ` AI plans made for ${u.plans} of ${u.clients} client${u.clients === 1 ? '' : 's'}.` : ''}` : `Nothing ${mTaskF === 'open' ? 'open' : 'done'}.`;
    return `<article class="tk-person${u.tasks.length ? '' : ' quiet'}">
      <header class="tk-ph"><span class="mini-av lg">${esc(mIni(personName(id)))}</span><b>${esc(personName(id))}</b>${st.late ? `<span class="pill warn">${st.late} late</span>` : ''}<span class="spacer"></span><span class="tk-n ${taskTone(st)}"><b class="num">${st.done}</b>/<span class="num">${st.total}</span> done</span>${taskBar(st)}</header>
      ${ts.length ? [...groups].map(([client, list]) => `<div class="tk-client"><div class="tk-cn">${esc(client)}</div><div class="cd-todo">${list.map((t) => `<div class="task${t.done ? ' done' : ''}${t.from === 'work' ? ' ' + esc(t.level || 'todo') : ''}"><span class="tcheck" role="checkbox" aria-checked="${!!t.done}" aria-readonly="true" aria-label="${t.done ? 'Done' : 'Not done'}"><span class="tbox" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg></span></span><span class="todo-ic" aria-hidden="true">${t.from === 'work' ? (IC_TODO[t.kind] || '📋') : t.from === 'ai' ? '✨' : '✍️'}</span><div class="todo-t"><b>${esc(t.text)}</b><span class="hint">${[t.from === 'work' ? (t.detail || '') : t.from === 'ai' ? 'AI plan' : 'Own task', t.late ? 'from ' + dayTxt(t.day) : '', t.done ? `done ${hm(t.doneAt)}${t.doneBy && t.doneBy !== personName(id) ? ' by ' + t.doneBy : ''}` : ''].filter(Boolean).map(esc).join(' · ')}</span></div></div>`).join('')}</div></div>`).join('') : `<div class="tk-empty hint">${esc(empty)}</div>`}
    </article>`;
  }
  function tasksPanel(team, q) {
    const nav = `<div class="tk-tools"><div class="pb-nav tk-day"><button type="button" class="navbtn" data-tday="-1" aria-label="Day before">‹</button><span class="tk-dl">${esc(dayTxt(mTaskDay))}${mTaskDay !== me.today ? ` <button type="button" class="linkbtn" data-tday="0">Today</button>` : ''}</span><button type="button" class="navbtn" data-tday="1" aria-label="Next day" ${mTaskDay >= me.today ? 'disabled' : ''}>›</button></div>
      <div class="seg" role="group" aria-label="Show tasks">${[['all', 'All'], ['open', 'Not done'], ['done', 'Done']].map(([k, l]) => `<button type="button" data-tf="${k}" aria-pressed="${mTaskF === k}">${l}</button>`).join('')}</div></div>`;
    if (!mTasks) return nav + '<div class="muted tk-empty">Loading tasks…</div>';
    if (mTasks.error) return nav + `<div class="over">${esc(mTasks.error)}</div>`;
    if (team) {
      const ids = [...team.ids].sort((a, b) => (taskStat([a]).pct ?? 101) - (taskStat([b]).pct ?? 101)); // least done first, no tasks last
      const html = ids.map((id) => personTasks(id, q)).join('');
      return nav + `<div class="tk-hint hint">Today's work & tasks from each person's Clients page: 📋 today's work (report, payment, quiet client…), ✨ AI plan tasks and ✍️ tasks they added. ${mTaskDay === me.today ? 'Late = left open from an earlier day. Updates every minute.' : "Today's work is only kept for today — older days show tasks."}</div>` + (html || `<div class="tk-empty hint">${team.ids.length ? 'Nothing matches.' : 'No one in this team yet — add people in Admin → Users → Teams.'}</div>`);
    }
    // all teams: one line per team with each person's progress
    return nav + `<div class="tk-teams">${mTeams().map((t) => { const s = t.task; return `<button type="button" class="tk-team" data-mteam="${esc(t.id)}">
      <span class="tk-tn"><b>${esc(t.name)}</b><span class="tk-n ${taskTone(s)}">${s.total ? `<b class="num">${s.done}</b>/<span class="num">${s.total}</span> done${s.late ? ` · <span class="warn-t">${s.late} late</span>` : ''}` : '<span class="hint">no tasks</span>'}</span></span>${taskBar(s, true)}
      <span class="tk-people">${t.ids.map((id) => { const p = taskStat([id]); return `<span class="tk-pp ${taskTone(p)}"><span class="mini-av">${esc(mIni(personName(id)))}</span>${esc(personName(id).split(/\s+/)[0])} <b class="num">${p.total ? `${p.done}/${p.total}` : '–'}</b></span>`; }).join('') || '<span class="hint">No one yet</span>'}</span>
    </button>`; }).join('')}</div>`;
  }
  // Spend on Pages not linked to any client (it has no orders and is not in the totals above).
  const unlinkedRows = (u) => (u.unlinked && u.unlinked.spend > 0.5 ? `<div class="m-unl"><div class="m-unl-h"><b>⚠ Not linked to a client</b><span class="num">${money(u.unlinked.spend)}</span></div><div class="hint">Add these Pages to a client so their spend and orders count.</div>${u.unlinked.pages.map((p) => `<div class="m-unl-p"><span>${esc(p.page)}</span><span class="num">${money(p.spend)}</span></div>`).join('')}</div>` : '');
  function renderMain() {
    const d = mData; if (!d) return;
    const teams = mTeams(), team = mTeam && teams.find((t) => t.id === mTeam);
    if (mTeam && !team) mTeam = null;
    const avg = cpoOf(d.totals.ordSpend, d.totals.orders);
    const all = { spend: d.totals.spend, orders: d.totals.orders, ordSpend: d.totals.ordSpend, task: taskStat(teams.flatMap((t) => t.ids)) };
    const allSug = mSug ? teamSug(d.users) : null;
    { // headline numbers (the whole company, or the picked team)
      const t = team || all, c = cpoOf(t.ordSpend, t.orders), s = t.task, sg = team ? (mSug ? teamSug(team.members) : null) : allSug;
      rollTo($('mSpend'), money(t.spend)); rollTo($('mOrders'), t.orders.toLocaleString('en-US')); rollTo($('mCpo'), c != null ? money(c) : '–');
      rollTo($('mTasks'), s.ready ? (s.total ? `${s.done}/${s.total}` : '0') : '–');
      $('mTasksLbl').textContent = `work & tasks done ${dayTxt(mTaskDay)}`;
      rollTo($('mUrgent'), sg ? String(sg.filter((x) => x.level === 'bad').length) : '–');
    }
    { // notes: older days are estimates · spend on Pages not linked to any client
      const q = d.quality || {}, unl = team ? team.members.reduce((a, u) => a + ((u.unlinked && u.unlinked.spend) || 0), 0) : d.totals.unlinked || 0, msg = [];
      if (q.estimate) msg.push(`ⓘ ${q.estimate} of ${q.estimate + (q.kept || 0)} days are order estimates and may be too high.`);
      if (unl > 0.5) msg.push(`${money(unl)} was spent on Pages not linked to any client — not counted above. See People & Pages.`);
      $('mNote').hidden = !msg.length; $('mNote').innerHTML = msg.map(esc).join('<br>');
    }
    document.querySelectorAll('#mSortSeg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.k === mSortK)));
    const q = ($('mSearch').value || '').trim().toLowerCase();
    const has = (x) => String(x || '').toLowerCase().includes(q);
    const cmp = { spend: (a, b) => b.spend - a.spend, orders: (a, b) => b.orders - a.orders, cpo: (a, b) => (a.cpo ?? 1e9) - (b.cpo ?? 1e9), tasks: (a, b) => (a.task.pct ?? 101) - (b.task.pct ?? 101) }[mSortK];
    const tone = (c) => (c == null || avg == null ? '' : c <= avg * 0.8 ? 'good' : c >= avg * 1.5 ? 'bad' : 'mid');
    const toneTxt = { good: 'cheap', mid: 'about average', bad: 'expensive' };
    const urgentOf = (t) => (mSug ? teamSug(t.members).filter((x) => x.level === 'bad').length : 0);
    const hit = (t) => !q || has(t.name) || t.ids.some((id) => has(personName(id))) || t.members.some((u) => u.pages.some((p) => has(p.page) || has(p.client)))
      || (mTasks && mTasks.users && t.ids.some((id) => ((mTasks.users[id] || {}).tasks || []).some((x) => has(x.text) || has(x.client))));
    // ---- left: teams list
    const list = teams.filter(hit).sort((a, b) => cmp(a, b) || b.spend - a.spend);
    const row = (t, i) => { const s = t.task, u = urgentOf(t); return `<button type="button" class="crow mrow2${(mTeam || '') === (t.id || '') ? ' on' : ''}" data-mteam="${esc(t.id || '')}" style="--i:${i}">
      <span class="cr-av${t.id ? '' : ' all'}">${t.id ? esc(mIni(t.name)) : '★'}</span>
      <span class="cr-n"><span class="cr-nm"><b>${esc(t.name)}</b>${u ? `<span class="pill bad">${u} urgent</span>` : ''}</span><span class="hint"><span class="num">${money(t.spend)}</span> · <span class="num">${t.orders.toLocaleString('en-US')}</span> orders</span>${s.ready && s.total ? `<span class="tk-row">${taskBar(s)}<span class="hint num">${s.done}/${s.total}</span></span>` : ''}</span>
      <span class="cr-v"><b class="num ${tone(t.cpo)}">${t.cpo != null ? money(t.cpo) : '–'}</b><span class="hint">per order</span></span>
    </button>`; };
    $('mTeamList').innerHTML = row({ id: '', name: 'All teams', spend: all.spend, orders: all.orders, cpo: cpoOf(all.ordSpend, all.orders), task: all.task, members: d.users }, 0)
      + (list.map((t, i) => row(t, i + 1)).join('') || `<div class="hint mempty">${q ? 'Nothing matches your search.' : 'No accounts yet.'}</div>`);
    // ---- right: the picked team (or all teams)
    const t = team || { name: 'All teams', members: d.users, ids: teams.flatMap((x) => x.ids), spend: all.spend, orders: all.orders, ordSpend: all.ordSpend, cpo: cpoOf(all.ordSpend, all.orders), pages: d.totals.pages, task: all.task };
    const sg = mSug ? (team ? teamSug(team.members) : allSug).filter((x) => !q || has(x.title) || has(x.detail) || has(x.who)) : null;
    const tn = tone(t.cpo), s = t.task;
    const tabs = [['tasks', `Work & tasks${s.ready && s.total ? ` <span class="countpill">${s.done}/${s.total}</span>` : ''}`], ['people', team ? 'People & Pages' : 'People'], ['sug', `Suggestions${sg && sg.length ? ` <span class="countpill">${sg.length}</span>` : ''}`]];
    let body = '';
    if (mTab === 'tasks') body = tasksPanel(team, q);
    else if (mTab === 'sug') {
      if (!sg) body = '<div class="muted">Loading…</div>';
      else if (!sg.length) body = '<div class="todo-done">🎉 Nothing important to fix.</div>';
      else { const show = mSugAll ? sg : sg.slice(0, 8); body = `<div class="hint tk-hint">Money at risk first, then what's working.</div><div class="todolist msug">${show.map(sugRow).join('')}</div>${sg.length > 8 ? `<button type="button" class="ghost sm" id="mSugMore">${mSugAll ? 'Show less' : `Show all ${sg.length}`}</button>` : ''}`; }
    } else {
      const users = (team ? team.members : d.users).map((u) => {
        const hitUser = !q || has(u.name);
        const pages = u.pages.filter((p) => hitUser || has(p.page) || has(p.guess) || has(p.client)).map((p) => ({ ...p, cpo: cpoOf(p.spend, p.orders) })).sort((a, b) => (mSortK === 'tasks' ? 0 : cmp(a, b)) || b.spend - a.spend);
        return { ...u, pages, cpo: cpoOf(u.ordSpend, u.orders), hit: hitUser || pages.length };
      }).filter((u) => u.hit).sort((a, b) => b.spend - a.spend);
      body = '<div class="mlist">' + (users.map((u, i) => {
        const open = mOpen.has(u.id) || !!q, top = Math.max(0.01, ...u.pages.map((p) => p.spend));
        const tm = !team && (d.teams || []).find((x) => x.members.includes(u.id));
        return `<article class="mcard${open ? ' open' : ''}" style="--i:${Math.min(i, 12)}">
          <button type="button" class="mc-h" data-muser="${esc(u.id)}" aria-expanded="${open}">
            <span class="avatar">${esc(mIni(u.name))}</span>
            <span class="mc-n"><b>${esc(u.name)}</b>${u.you ? ' <span class="pill brand">You</span>' : ''}<span class="hint">${tm ? esc(tm.name) + ' · ' : ''}${u.pages.length} Page${u.pages.length === 1 ? '' : 's'} · ${u.clients} client${u.clients === 1 ? '' : 's'}</span></span>
            <span class="mc-s"><span class="lbl">Spend</span><b class="num">${money(u.spend)}</b></span>
            <span class="mc-s"><span class="lbl">Orders</span><b class="num">${u.orders.toLocaleString('en-US')}</b></span>
            <span class="mc-s"><span class="lbl">Per order</span><b class="num ${tone(u.cpo)}">${u.cpo != null ? money(u.cpo) : '–'}</b></span>
            <span class="chev" aria-hidden="true">›</span>
          </button>
          ${open ? (u.pages.length ? `<div class="mc-b"><div class="mrow mhead"><span>Page</span><span class="r">Spend</span><span class="r">Orders</span><span class="r">Per order</span></div>${u.pages.map((p) => `<div class="mrow">
              <span class="mp"><b>${pageLabel(p)}</b><span class="hint">${p.client ? esc(p.client) : 'No client'}${p.live > 0 && p.post > 0 ? ` · Live ${money(p.live)} · Post ${money(p.post)}` : p.live > 0 ? ' · Live' : ' · Post'}</span><i class="mbar"><i style="width:${Math.max(2, p.spend / top * 100).toFixed(1)}%"></i></i></span>
              <span class="r num" data-l="Spend"><b>${money(p.spend)}</b></span>
              <span class="r num" data-l="Orders">${p.orders ? p.orders.toLocaleString('en-US') : '<span class="muted">–</span>'}</span>
              <span class="r num ${tone(p.cpo)}" data-l="Per order"><b>${p.cpo != null ? money(p.cpo) : '–'}</b></span></div>`).join('')}${unlinkedRows(u)}</div>` : `<div class="mc-b"><div class="muted mempty">No boost spend in this period.</div>${unlinkedRows(u)}</div>`) : ''}
        </article>`;
      }).join('') || `<div class="empty">${q ? 'Nothing matches your search.' : 'No one with boost spend in this period.'}</div>`) + '</div>';
    }
    $('mList').innerHTML = `<div class="cd-in">
      <div class="cd-head"><button type="button" class="ghost sm cd-back" id="mBack">← Teams</button>
        <div class="cd-title"><span class="cr-av lg${team ? '' : ' all'}">${team ? esc(mIni(t.name)) : '★'}</span><div><h3>${esc(t.name)}</h3><div class="hint">${t.ids.length} ${t.ids.length === 1 ? 'person' : 'people'} · ${t.pages} Page${t.pages === 1 ? '' : 's'} · ${esc(periodLabel())}${team && team.shared > 0.009 ? ` · ${money(team.shared)} shared spend counted once` : ''}</div></div></div>
        <div class="cd-stats">
          <div class="cd-stat hero"><span class="lbl">Boost spend</span><b class="num">${money(t.spend)}</b><span class="sub">${esc(periodLabel())}</span></div>
          <div class="cd-stat"><span class="lbl">Orders</span><b class="num">${t.orders.toLocaleString('en-US')}</b><span class="sub">from adsbox.biz</span></div>
          <div class="cd-stat"><span class="lbl">Per order</span><b class="num ${tn}">${t.cpo != null ? money(t.cpo) : '–'}</b><span class="sub">${t.cpo != null ? `${team ? (toneTxt[tn] || '') + ' · ' : ''}avg ${money(avg)}` : 'no orders yet'}</span></div>
          <div class="cd-stat"><span class="lbl">Work & tasks ${esc(dayTxt(mTaskDay))}</span><b class="num ${taskTone(s)}">${s.ready ? (s.total ? `${s.done}/${s.total}` : '0') : '…'}</b><span class="sub">${s.ready ? (s.total ? `${s.pct}% done${s.late ? ` · ${s.late} late` : ''}` : 'no tasks yet') : 'loading'}</span></div>
        </div>
      </div>
      <div class="seg mtabs" role="tablist">${tabs.map(([k, l]) => `<button type="button" role="tab" data-mtab="${k}" aria-selected="${mTab === k}" aria-pressed="${mTab === k}">${l}</button>`).join('')}</div>
      <div class="mtab-b">${body}</div>
    </div>`;
    $('mWrap').classList.toggle('show-detail', mShow);
  }
  // clicks (list + detail)
  $('mWrap').addEventListener('click', (ev) => {
    const tb = ev.target.closest('[data-mteam]');
    if (tb) { mTeam = tb.dataset.mteam || null; mSugAll = false; mOpen.clear(); mShow = true; if (tb.classList.contains('tk-team')) mTab = 'tasks'; renderMain(); if (innerWidth <= 900 || tb.classList.contains('tk-team')) window.scrollTo({ top: $('mWrap').offsetTop - 70, behavior: calm ? 'auto' : 'smooth' }); return; }
    const b = ev.target.closest('button'); if (!b) return;
    if (b.id === 'mBack') { mShow = false; renderMain(); return; }
    if (b.id === 'mSugMore') { mSugAll = !mSugAll; renderMain(); return; }
    if (b.dataset.mtab) { mTab = b.dataset.mtab; renderMain(); return; }
    if (b.dataset.tf) { mTaskF = b.dataset.tf; renderMain(); return; }
    if (b.dataset.tday != null) { const n = Number(b.dataset.tday); mTaskDay = n === 0 ? me.today : addD(mTaskDay, n); if (mTaskDay > me.today) mTaskDay = me.today; mTasks = null; renderMain(); loadTasks(); return; }
    if (b.dataset.muser) { const id = b.dataset.muser; if (mOpen.has(id)) mOpen.delete(id); else mOpen.add(id); renderMain(); }
  });
  document.querySelectorAll('#mSortSeg button').forEach((b) => b.onclick = () => { mSortK = b.dataset.k; renderMain(); });
  // keep the Main Dashboard's tasks fresh while it is open
  setInterval(() => { if (!$('tab-main').hidden && !document.hidden && mData) loadTasks(); }, 60e3);
  $('mSearch').oninput = () => renderMain();

  // ---------- Orders page (adsbox.biz) ----------
  let oData2 = null, oCfg = null;
  const cpoText = (spend, n) => (n > 0 && spend > 0 ? money(spend / n) : '–');
  const oPulled = new Set();
  const oSrc = 'all'; // orders from every source (the Messenger / Comment / Ads filter was removed)
  let oSortK = (() => { try { return localStorage.getItem('oSort') || 'cpo'; } catch (_) { return 'cpo'; } })();
  async function loadOrders() {
    if (!dDate) dDate = me.today;
    paintPeriod();
    document.querySelectorAll('#oSortSeg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.k === oSortK)));
    const [from, to] = dRange(), pk = from + '|' + to;
    if (!oData2) $('oCards').innerHTML = '<div class="ocard skel"></div><div class="ocard skel"></div><div class="ocard skel"></div>';
    try {
      const [cfg, d] = await Promise.all([api('/orders/api'), api(`/orders/report?from=${from}&to=${to}&src=${oSrc}`)]);
      oData2 = d; oCfg = cfg;
      if (cfg.url && cfg.hasKey && from < addD(me.today, -2) && !oPulled.has(pk)) {
        oPulled.add(pk);
        api('/orders/pull', { method: 'POST', body: { from, to } }).then(() => { if (dRange().join('|') === pk) loadOrders(); }).catch(() => {});
      }
      $('oSetBtn').hidden = !(me && me.canAdmin); $('oCmpBtn').hidden = !(me && me.canAdmin && cfg.url && cfg.hasKey);
      $('oUpd').textContent = cfg.last && cfg.last.at ? 'Updated ' + ago(cfg.last.at) : 'Update';
      const note = $('oNote'), ql = d.quality || {}, est = (ql.estimate || 0) + (ql.missing || 0);
      let msg = '';
      if (!cfg.url || !cfg.hasKey) msg = me && me.canAdmin ? '<b>Connect adsbox.biz first:</b> tap ⚙ and paste the API address and key.' : 'Orders from adsbox.biz are not connected yet — ask your admin.';
      else if (cfg.lastError) msg = `⚠ Getting orders failed: ${esc(cfg.lastError.message)}`;
      else if (!d.hasData) msg = 'No orders for this period yet. Tap <b>↻ Update</b> to fetch them.';
      else if (est) msg = `<span title="Days from before Boost Desk started keeping each day's count (18 Oct) come from adsbox.biz's API and may be too high, so cost per order looks cheaper.">ⓘ ${est} of ${est + (ql.kept || 0)} days are estimates and may be too high.</span>`;
      note.hidden = !msg; note.innerHTML = msg;
      renderOrders();
    } catch (e) { $('oCards').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  }
  function renderOrders() {
    const d = oData2; if (!d) return;
    const q = ($('oSearch').value || '').trim().toLowerCase();
    const all = d.clients.filter((c) => c.spend > 0 || c.orders > 0);
    const t = all.reduce((a, c) => ({ spend: a.spend + c.spend, orders: a.orders + c.orders, spendW: a.spendW + (c.orders ? ordSpendOf(c) : 0) }), { spend: 0, orders: 0, spendW: 0 });
    const avg = t.orders ? t.spendW / t.orders : null;
    rollTo($('oCpo'), avg != null ? money(avg) : '–');
    rollTo($('oOrders'), t.orders.toLocaleString('en-US'));
    rollTo($('oSpend'), money(t.spend));
    const p = d.prev, pAvg = p && p.orders ? p.spend / p.orders : null;
    $('oTrend').innerHTML = avg != null && pAvg ? (() => { const ch = Math.round((avg - pAvg) / pAvg * 100); return ch === 0 ? '<span class="muted">Same cost per order as the period before</span>' : `<span class="${ch < 0 ? 'is-ok' : 'is-danger'}">${ch < 0 ? '▼' : '▲'} ${Math.abs(ch)}% ${ch < 0 ? 'cheaper' : 'more expensive'}</span> <span class="muted">than the ${d.from === d.to ? 'day' : 'period'} before (${money(pAvg)})</span>`; })() : '';
    // cards
    const tone = (cpo) => (cpo == null || avg == null ? '' : cpo <= avg * 0.8 ? 'good' : cpo >= avg * 1.5 ? 'bad' : 'mid');
    const toneTxt = { good: 'cheap', mid: 'average', bad: 'expensive', '': '' };
    const minCpo = Math.min(...all.filter((c) => c.orders).map((c) => ordSpendOf(c) / c.orders));
    const list = all.filter((c) => !q || [c.name, ...c.pages.map((x) => x.page)].some((x) => String(x).toLowerCase().includes(q)))
      .map((c) => ({ ...c, cpo: c.orders ? ordSpendOf(c) / c.orders : null }));
    const cmp = { cpo: (a, b) => (a.cpo ?? 1e9) - (b.cpo ?? 1e9), orders: (a, b) => b.orders - a.orders, spend: (a, b) => b.spend - a.spend }[oSortK] || ((a, b) => 0);
    list.sort((a, b) => cmp(a, b) || b.spend - a.spend);
    $('oCards').innerHTML = list.map((c, i) => {
      const tn = tone(c.cpo), score = c.cpo ? Math.max(6, Math.round(minCpo / c.cpo * 100)) : 0;
      const pages = c.pages.filter((x) => x.spend > 0 || x.orders > 0).sort((a, b) => b.orders - a.orders || b.spend - a.spend);
      return `<article class="ocard ${tn}" style="--i:${Math.min(i, 12)}">
        <header><div class="oc-n"><b>${esc(c.name)}</b>${typeTags(c.type)}</div><div class="oc-cpo ${tn}"><span class="num">${c.cpo != null ? money(c.cpo) : '–'}</span><small>${c.cpo != null ? 'per order' : 'no orders'}</small></div></header>
        <div class="oc-sub"><span><b class="num">${c.orders.toLocaleString('en-US')}</b> orders</span><span>·</span><span class="num">${money(c.spend)}</span> spent${c.orders && c.spend - ordSpendOf(c) > 0.5 ? `<span class="oc-noord" title="Spend on this client's Pages that had no orders — not counted in cost per order">· ${money(c.spend - ordSpendOf(c))} on Pages with no orders</span>` : ''}</div>
        ${c.cpo != null ? `<div class="oc-bar ${tn}" title="${toneTxt[tn]} compared with your average ${money(avg)}"><i style="width:${score}%"></i></div><div class="oc-tone ${tn}">${toneTxt[tn] === 'average' ? 'about average' : toneTxt[tn]} · avg ${money(avg)}</div>` : '<div class="oc-tone">Spent but no orders matched — check the Page ID in the client.</div>'}
        ${pages.length > 1 || (pages.length === 1 && pages[0].page !== c.name) ? `<ul class="oc-pages">${pages.map((x) => `<li><span class="op-n" title="${esc(x.page)}">${pageLabel(x)}</span><span class="op-o num">${x.orders ? x.orders.toLocaleString('en-US') : '–'}</span><span class="op-c num ${tone(x.orders ? x.spend / x.orders : null)}">${x.orders ? money(x.spend / x.orders) : '–'}</span></li>`).join('')}</ul>` : ''}
      </article>`;
    }).join('') || `<div class="empty">${q ? 'No client matches your search.' : 'No spend or orders in this period.'}</div>`;
    $('oUnPanel').hidden = !d.unmatched.length;
    $('oUnBody').innerHTML = d.unmatched.map((u) => `<div class="ounrow"><span><b>${esc(u.page || 'Unknown Page')}</b>${u.pageId ? `<span class="hint num"> · ${esc(u.pageId)}</span>` : ''}</span><span class="num">${u.orders.toLocaleString('en-US')} orders</span></div>`).join('');
  }
  document.querySelectorAll('#oSortSeg button').forEach((b) => b.onclick = () => { oSortK = b.dataset.k; try { localStorage.setItem('oSort', oSortK); } catch (_) {} document.querySelectorAll('#oSortSeg button').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); renderOrders(); });
  $('oSearch').oninput = () => renderOrders();
  $('oSync').onclick = async () => {
    const b = $('oSync'); b.disabled = true; b.classList.add('spin');
    const [from, to] = dRange();
    try { await api('/orders/pull', { method: 'POST', body: { from, to, force: true } }); oPulled.add(from + '|' + to); successBadge('Orders updated'); }
    catch (e) { toast(e.message); }
    finally { b.disabled = false; b.classList.remove('spin'); loadOrders(); }
  };
  // ---- check one day against adsbox.biz (admins) ----
  let oCmp = null;
  async function runCompare() {
    const day = $('oCmpDay').value; if (!day) return;
    const out = $('oCmpOut'); out.innerHTML = '<div class="muted">Asking adsbox.biz…</div>'; $('oUseDay').disabled = true;
    try {
      oCmp = await api('/orders/compare?day=' + day);
      const d = oCmp, diff = d.live - d.kept, st = { locked: 'kept from when it was recent', fresh: 'still updating (today / yesterday)', backfill: 'estimate', missing: 'not fetched yet' }[d.state] || d.state;
      const rows = d.pages.filter((x) => x.kept || x.live);
      out.innerHTML = `<div class="cmp-sum"><div><span class="lbl">Boost Desk</span><b class="num">${d.kept.toLocaleString('en-US')}</b></div><div><span class="lbl">adsbox.biz now</span><b class="num">${d.live.toLocaleString('en-US')}</b></div><div><span class="lbl">Difference</span><b class="num ${diff ? (diff > 0 ? 'is-warn' : 'is-danger') : 'is-ok'}">${diff > 0 ? '+' : ''}${diff.toLocaleString('en-US')}</b></div></div>
        <div class="hint">Boost Desk's number for this day: ${esc(st)}. Compare "adsbox.biz now" with the adsbox <b>Sales Overview</b> for the same day.</div>
        ${rows.length ? `<div class="cmp-list"><div class="cmp-row cmp-head"><span>Page</span><span class="r">Boost Desk</span><span class="r">adsbox now</span><span class="r">Diff</span></div>${rows.slice(0, 60).map((x) => `<div class="cmp-row${x.diff ? ' off' : ''}"><span class="cmp-p">${esc(x.page || 'Page ' + x.pageId)}</span><span class="r num">${x.kept}</span><span class="r num">${x.live}</span><span class="r num ${x.diff ? (x.diff > 0 ? 'is-warn' : 'is-danger') : 'is-ok'}">${x.diff > 0 ? '+' : ''}${x.diff || '✓'}</span></div>`).join('')}</div>` : '<div class="muted">No orders on this day.</div>'}`;
      $('oUseDay').disabled = !diff;
    } catch (e) { out.innerHTML = `<div class="note">${esc(e.message)}</div>`; }
  }
  async function useLive(from, to, btn) {
    if (!confirm(`Replace Boost Desk's order numbers for ${from === to ? nice(from) : nice(from) + ' – ' + nice(to)} with adsbox.biz's numbers as they are now?`)) return;
    btn.disabled = true; btn.classList.add('busy');
    try { await api('/orders/use-live', { method: 'POST', body: { from, to } }); successBadge('Orders updated from adsbox.biz'); oData2 = null; loadOrders(); mData = null; if ($('oCmpDay').value) runCompare(); }
    catch (e) { toast(e.message); } finally { btn.disabled = false; btn.classList.remove('busy'); }
  }
  $('oCmpBtn').onclick = () => { if (!$('oCmpDay').value) $('oCmpDay').value = addD(me.today, -1); $('oCmpDay').max = me.today; $('oCmpOut').innerHTML = ''; dlgOpen($('oCmpDlg')); runCompare(); };
  $('oCmpGo').onclick = runCompare; $('oCmpDay').onchange = runCompare;
  $('oUseDay').onclick = () => useLive($('oCmpDay').value, $('oCmpDay').value, $('oUseDay'));
  $('oUse7').onclick = () => useLive(addD(me.today, -7), addD(me.today, -1), $('oUse7'));
  $('oUse30').onclick = () => useLive(addD(me.today, -30), addD(me.today, -1), $('oUse30'));
  $('oSetBtn').onclick = async () => {
    if (!(me && me.canAdmin)) return;
    const c = oCfg || await api('/orders/api').catch(() => ({}));
    $('oUrl').value = c.url || ''; $('oListUrl').value = c.listUrl || ''; $('oKey').value = ''; $('oTestMsg').hidden = true;
    $('oKeyInfo').textContent = c.hasKey ? `A key is saved (${c.keyHint || 'hidden'})${c.savedBy ? ' by ' + c.savedBy : ''}. Leave the key empty to keep it.` : 'No key saved yet.';
    $('oKeyDel').hidden = !c.hasKey;
    const canEdit = !!(me && me.canAdmin); ['oUrl', 'oListUrl', 'oKey', 'oSave', 'oTest', 'oKeyDel', 'oPushOn', 'oPushNow'].forEach((id) => { $(id).disabled = !canEdit; });
    if (!canEdit) $('oKeyInfo').textContent += ' Only admins can change these settings.';
    loadPush();
    dlgOpen($('oDlg'));
  };
  function drawPush(p) {
    $('oPushOn').checked = !!p.on;
    const l = p.last;
    $('oPushSt').innerHTML = !l ? (p.on ? 'Waiting for the first send…' : 'Off') : l.error ? `<span class="over">✕ ${esc(ago(l.at))}: ${esc(l.error)}</span>`
      : `✓ Sent ${esc(ago(l.at))} · ${l.saved} of ${l.received} rows saved (${esc(l.from)} – ${esc(l.to)})${l.noPage ? ` · ${l.noPage} campaign${l.noPage === 1 ? '' : 's'} skipped (no Page)` : ''}${l.errors && l.errors.length ? ` · <span class="over">${l.errors.length} rows refused: ${esc(l.errors[0].error)}</span>` : ''}`;
  }
  async function loadPush() { try { drawPush(await api('/orders/push')); } catch (_) { $('oPushSt').textContent = ''; } }
  $('oPushOn').onchange = async () => { try { drawPush(await api('/orders/push', { method: 'PUT', body: { on: $('oPushOn').checked } })); toast($('oPushOn').checked ? 'Spend will be sent to adsbox.biz every 30 minutes' : 'Stopped sending spend'); } catch (e) { toast(e.message); } };
  $('oPushNow').onclick = async () => {
    const b = $('oPushNow'); b.disabled = true; $('oPushSt').textContent = 'Sending…';
    try { await api('/orders/push', { method: 'POST', body: { days: 7 } }); successBadge('Spend sent to adsbox.biz'); } catch (e) { toast(e.message); }
    finally { b.disabled = false; loadPush(); }
  };
  const saveCfg = (extra = {}) => api('/orders/api', { method: 'PUT', body: { url: $('oUrl').value.trim(), listUrl: $('oListUrl').value.trim(), key: $('oKey').value.trim(), ...extra } });
  $('oSave').onclick = async () => { try { oCfg = await saveCfg(); $('oDlg').close(); successBadge('adsbox.biz API saved'); $('oSync').click(); } catch (e) { toast(e.message); } };
  $('oKeyDel').onclick = async () => { if (!confirm('Remove the saved API key?')) return; try { oCfg = await saveCfg({ key: null }); $('oDlg').close(); toast('API key removed'); loadOrders(); } catch (e) { toast(e.message); } };
  $('oTest').onclick = async () => {
    const m = $('oTestMsg'), b = $('oTest'); b.disabled = true; m.hidden = false; m.textContent = 'Testing…';
    try {
      oCfg = await saveCfg();
      const r = await api('/orders/test', { method: 'POST' });
      if (r.month && r.month.listChosen) $('oListUrl').value = r.month.listChosen;
      m.innerHTML = r.rows ? `✓ Connected. ${r.rows} order row${r.rows === 1 ? '' : 's'} for yesterday (${r.pages} page${r.pages === 1 ? '' : 's'}${r.total ? ', API says ' + r.total : ''})${Object.keys(r.days || {}).length > 1 ? ' · dates in answer: ' + esc(Object.entries(r.days).map(([d, c]) => d + ' ' + c).join(', ')) : ''}${r.rawRows !== r.rows ? ` (${r.rawRows - r.rows} duplicate${r.rawRows - r.rows === 1 ? '' : 's'} skipped)` : ''}${r.perOrder ? ' · one row per order' : ''}.${r.month ? (r.month.error ? `<br>Last month: ${esc(r.month.error)}` : `<br><b>Last month</b> (${esc(r.month.from)} – ${esc(r.month.to)}): by day ${r.month.byDay} orders (${r.month.byDayRows} rows) · by Page ${r.month.byPage} orders (${r.month.byPageRows} rows, group_by=${esc(r.month.byPageGroup || '?')})${r.month.totals ? ' · totals: ' + esc(JSON.stringify(r.month.totals)) : ''}${r.month.page ? `<br><b>${esc(r.month.page.name || r.month.page.id)}</b> (${esc(r.month.page.id)}): month total ${r.month.page.byPage} · days added up ${r.month.page.byDay} (${r.month.page.days} days) · Messenger ${r.month.page.messenger} · customers ${r.month.page.customers}` : ''}${r.month.listChosen ? `<br>✅ <b>Found the order list:</b> <code>${esc(r.month.listChosen)}</code> — Boost Desk now counts from it.` : ''}${r.month.listUrl ? `<br><b>Order list</b> ${esc(r.month.listUrl)}: ${r.month.listError ? '✕ ' + esc(r.month.listError) : `busiest Page last month <b>${r.month.listPage}</b> orders · ${r.month.listAll} orders on all Pages`}` : ''}${(r.month.lists || []).map((l) => `<br>Order list <code>${esc(l.path)}</code>: ${l.status ? 'HTTP ' + l.status : esc(l.error || 'no answer')}${l.json ? ' · JSON' : ''}${l.total != null ? ' · total ' + l.total : ''}${l.keys && l.keys.length ? ' · answer: ' + esc(l.keys.join(', ')) : ''}${l.rowKeys && l.rowKeys.length ? ' · fields: ' + esc(l.rowKeys.join(', ')) : ''}`).join('')}`) : ''}<br>Asked ${esc(r.asked || '')} · adsbox answered: <code>${esc(Object.entries(r.echo || {}).map(([k, v]) => k + '=' + v).join(', '))}</code><br>Answer: <code>${esc((r.keys || []).join(', '))}</code><br>Fields: <code>${esc(r.fields.join(', '))}</code>${Object.entries(r.breakdown || {}).map(([k, v]) => `<br>${esc(k)}: ${Object.entries(v).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([n, c]) => `<b>${esc(n)}</b> ${c}`).join(' · ')}`).join('')}${r.hasPage ? '' : '<br>⚠ No Page ID or Page name in the answer, so orders can’t be matched to clients.'}${r.hasDate ? '' : '<br>⚠ No date in the answer.'}` : '✓ Connected, but no orders came back for yesterday.';
    } catch (e) { m.textContent = '✕ ' + e.message; }
    finally { b.disabled = false; }
  };

  // ---------- auto sync (owner only) ----------
  const ago = (t) => {
    if (!t) return '—';
    const m = Math.round((Date.now() - new Date(t)) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    if (m < 1440) return Math.round(m / 60) + ' h ago';
    return new Date(t).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  };
  const whyLabel = { 'new ad account': 'new ad account found', 'new campaign': 'new campaign found', hourly: 'hourly refresh', 'daily 30-day': '30-day refresh', 'run now': 'run now' };
  // ---------- Admin panel: sections ----------
  let admSec = (() => { try { const v = localStorage.getItem('admSec'); return v && v !== 'overview' ? v : 'users'; } catch (_) { return 'users'; } })();
  function showAdm(sec) {
    if (sec === 'overview') sec = 'users'; // Overview was removed — spend per team is on the Main Dashboard
    admSec = sec; try { localStorage.setItem('admSec', sec); } catch (_) {}
    document.querySelectorAll('#admNav button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.a === sec)));
    for (const k of ['overview', 'users', 'health', 'settings']) $('adm-' + k).hidden = k !== sec;
    if (sec === 'users') { loadUsers(); loadTeams(); }
    if (sec === 'health') loadHealth();
    if (sec === 'settings') loadSettings();
  }
  document.querySelectorAll('#admNav button').forEach((b) => b.onclick = () => showAdm(b.dataset.a));
  const initials = (n) => esc((n || '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase());
  const dateShort = (t) => (t ? new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

  // Users
  let uData = null;
  async function loadUsers() {
    try { uData = await api('/admin/users'); } catch (e) { $('uList').innerHTML = `<div class="muted">${esc(e.message)}</div>`; return; }
    renderUsers();
  }
  function renderUsers() {
    const d = uData; if (!d) return;
    const q = ($('uSearch').value || '').trim().toLowerCase();
    $('admUsersN').textContent = d.users.length || '';
    $('uHint').innerHTML = (d.canEdit ? '<b>Owner</b> manages everything · <b>Admin</b> can see this Admin page · <b>Member</b> sees only their own clients.' : 'Only the app owner can change roles or remove people.')
      + (d.autoSyncServer ? '' : ' <span class="over">Auto sync is switched off on the server (AUTO_SYNC=off).</span>');
    const list = d.users.filter((u) => !q || String(u.name).toLowerCase().includes(q) || String(u.team).toLowerCase().includes(q));
    const day = 864e5;
    $('uList').innerHTML = list.map((u, i) => {
      const exp = u.tokenExpires ? Date.parse(u.tokenExpires) : 0, left = exp ? Math.round((exp - Date.now()) / day) : null;
      let st;
      if (u.expired) st = '<span class="ustat bad">Login expired</span>';
      else if (!u.enabled) st = '<span class="ustat">Auto sync off</span>';
      else if (!u.synced) st = '<span class="ustat">Waiting for first sync</span>';
      else if (u.busy) st = '<span class="ustat run">Syncing…</span>';
      else if (u.lastRun && u.lastRun.error) st = '<span class="ustat bad">Last sync failed</span>';
      else st = '<span class="ustat ok">Running</span>';
      const lr = u.lastRun, last = !lr ? 'Never synced' : lr.error ? `Failed ${ago(lr.at)}: ${esc(lr.error)}` : `Synced ${ago(lr.at)} · ${lr.campaigns} campaigns${lr.errors ? ` · ${lr.errors} account errors` : ''}`;
      const you = u.id === d.me, edit = d.canEdit && u.role !== 'owner';
      const role = u.role === 'owner' ? '<span class="rolechip owner">Owner</span>' : edit ? `<select class="rolesel" data-role="${esc(u.id)}"><option value="member" ${u.role === 'member' ? 'selected' : ''}>Member</option><option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Admin</option></select>` : `<span class="rolechip ${u.role}">${u.role === 'admin' ? 'Admin' : 'Member'}</span>`;
      return `<div class="ucard${u.expired ? ' expired' : ''}" style="--i:${Math.min(i, 12)}">
        <div class="uc-top"><span class="avatar">${initials(u.name)}</span><div class="uc-n"><span class="uc-nm"><b>${esc(u.name)}</b>${you ? '<span class="chip meta">You</span>' : ''}</span><span class="hint">${u.team ? esc(u.team) + ' · ' : ''}${u.accounts} ad accounts · ${u.clients} clients</span></div>${role}</div>
        <div class="uc-grid">
          <div><span class="lbl">Status</span>${st}</div>
          <div><span class="lbl">Last active</span><span>${u.lastSeen ? ago(u.lastSeen) : '—'}</span></div>
          <div><span class="lbl">Facebook login</span><span class="${u.expired ? 'over' : left !== null && left < 7 ? 'warnt' : ''}">${u.expired ? 'Expired' : left !== null ? `${left} day${left === 1 ? '' : 's'} left` : '—'}</span></div>
          <div><span class="lbl">Auto report</span><span>${u.autoReport && u.autoReport.on ? '⏰ ' + esc(u.autoReport.time) : 'Off'}</span></div>
        </div>
        <div class="hint uc-last">${last}</div>
        <div class="uc-acts">${d.canEdit ? `<label class="switch"><input type="checkbox" data-auto="${esc(u.id)}" ${u.enabled ? 'checked' : ''}><span></span> Auto sync</label>` : ''}<span class="spacer"></span>
          ${d.canEdit ? `<button class="sm" data-run="${esc(u.id)}" ${u.expired || u.busy || !u.synced ? 'disabled' : ''}>↻ Sync now</button>` : ''}
          ${edit && !you ? `<button class="sm danger" data-remove="${esc(u.id)}" data-name="${esc(u.name)}">Remove</button>` : ''}</div>
      </div>`;
    }).join('') || '<div class="empty">No one matches.</div>';
    const b = Object.entries(d.blocked || {});
    $('blockedBox').hidden = !b.length;
    $('blockedBody').innerHTML = b.map(([id, x]) => `<tr><td>${esc(x.name || id)}<div class="hint">Facebook ID ${esc(id)} · removed ${esc(ago(x.at))}</div></td><td class="acts"><button data-restore="${esc(id)}">Restore access</button></td></tr>`).join('');
  }
  $('uSearch').oninput = () => renderUsers();
  $('blockedBody').addEventListener('click', async (ev) => {
    const id = ev.target.dataset.restore; if (!id) return;
    try { await api('/blocked/' + encodeURIComponent(id), { method: 'DELETE' }); toast('Access restored — they can log in again'); } catch (e) { toast(e.message); }
    loadUsers();
  });
  $('uList').addEventListener('change', async (ev) => {
    const r = ev.target.dataset.role;
    if (r) { try { await api('/admin/role/' + encodeURIComponent(r), { method: 'PUT', body: { role: ev.target.value } }); successBadge(ev.target.value === 'admin' ? 'Now an Admin' : 'Now a Member'); } catch (e) { toast(e.message); } return loadUsers(); }
    const id = ev.target.dataset.auto; if (!id) return;
    try { await api('/auto-sync/' + encodeURIComponent(id), { method: 'PUT', body: { enabled: ev.target.checked } }); toast('Auto sync ' + (ev.target.checked ? 'on' : 'off')); } catch (e) { toast(e.message); }
    loadUsers();
  });
  async function runSync(id, btn) {
    if (btn) btn.disabled = true;
    try { await api('/auto-sync/' + encodeURIComponent(id) + '/run', { method: 'POST' }); toast('Sync started — refreshing today and yesterday'); } catch (e) { toast(e.message); }
    setTimeout(() => { if (!$('tab-admin').hidden) { if (admSec === 'users') loadUsers(); if (admSec === 'health') loadHealth(); } }, 15000);
  }
  $('uList').addEventListener('click', async (ev) => {
    const b = ev.target.closest('button'); if (!b) return;
    if (b.dataset.remove) {
      const name = b.dataset.name;
      if (!confirm(`Remove ${name}?\n\nThis deletes ${name}'s clients, synced days and settings from Boost Desk, logs them out, and blocks them from logging in again. It does not touch anything in Facebook or Ads Manager.\n\nThis can't be undone (you can restore their login later, but their data will be gone).`)) return;
      try { await api('/users/' + encodeURIComponent(b.dataset.remove), { method: 'DELETE' }); toast(name + ' removed'); } catch (e) { toast(e.message); }
      return loadUsers();
    }
    if (b.dataset.run) { await runSync(b.dataset.run, b); loadUsers(); }
  });

  // Health
  async function loadHealth() {
    let d; try { d = await api('/admin/health'); } catch (e) { $('hList').innerHTML = `<div class="muted">${esc(e.message)}</div>`; return; }
    const sys = $('adm-health').hidden ? null : await loadSystem();
    const n = d.items.filter((x) => x.level !== 'info').length + (sys ? sys.problems.length : 0);
    $('admHealthN').textContent = n || ''; $('admHealthN').classList.toggle('bad', d.items.some((x) => x.level === 'bad'));
    if ($('adm-health').hidden) return;
    const icon = { bad: '⛔', warn: '⚠️', info: 'ℹ️' };
    if (sys) for (const p of sys.problems) d.items.unshift({ level: 'bad', area: 'System', title: p.text.replace(/^\S+\s/, ''), detail: '' });
    $('hList').innerHTML = d.items.length ? d.items.map((x, i) => `<div class="hitem ${x.level}" style="--i:${Math.min(i, 12)}"><span class="hi-ic">${icon[x.level]}</span><div class="hi-t"><span class="hi-area">${esc(x.area)}</span><b>${esc(x.title)}</b><span class="hint">${esc(x.detail || '')}</span></div>${x.action && x.action.kind === 'run' && me.isOwner ? `<button class="sm" data-hrun="${esc(x.action.id)}">↻ Sync now</button>` : x.action && x.action.kind === 'orders' ? '<button class="sm" data-hgo="orders">Open Orders</button>' : ''}</div>`).join('')
      : '<div class="hallgood"><span>✓</span><b>Everything looks good</b><span class="hint">Nothing needs your attention right now.</span></div>';
    $('hOk').innerHTML = d.ok.map((t) => `<div>✓ ${esc(t)}</div>`).join('') + `<div class="hint">Checked ${esc(ago(d.checkedAt))}</div>`;
  }
  // System part of Health
  const upDur = (sec) => { const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60); return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`; };
  const bar = (pct, warnAt = 70, badAt = 85) => `<div class="sbar"><i class="${pct >= badAt ? 'bad' : pct >= warnAt ? 'warn' : ''}" style="width:${Math.min(100, Math.max(2, pct))}%"></i></div>`;
  async function loadSystem() {
    let d; try { d = await api('/admin/system'); } catch (e) { $('sysGrid').innerHTML = `<div class="muted">${esc(e.message)}</div>`; return null; }
    $('sysWhen').textContent = 'Checked ' + ago(d.now);
    const sv = d.services || {}, svc = (n) => sv[n] ? `<div class="srow"><span>${esc(n)}</span><b class="${sv[n].ok ? 'okt' : 'over'}">${sv[n].ok ? '● OK' : '● Error'}</b><span class="hint">${sv[n].ms ? sv[n].ms + ' ms · ' : ''}${ago(sv[n].at)}${sv[n].error ? ' · ' + esc(sv[n].error) : ''}</span></div>` : `<div class="srow"><span>${esc(n)}</span><span class="hint">not used yet since the restart</span></div>`;
    const db = d.db, grow = db.weekAgoMb != null ? db.sizeMb - db.weekAgoMb : null, al = d.alerts;
    const card = (ic, t, st, body) => `<div class="syscard"><div class="sc-h"><span class="sc-ic">${ic}</span><b>${t}</b>${st}</div><div class="sc-b">${body}</div></div>`;
    const ok = (t) => `<span class="sc-st ok">${t}</span>`, bad = (t) => `<span class="sc-st bad">${t}</span>`, warn = (t) => `<span class="sc-st warn">${t}</span>`;
    $('sysGrid').innerHTML = [
      card('🖥', 'Server', d.memory.pct >= 85 ? bad('Memory high') : ok('Running'),
        `<div class="srow"><span>Up for</span><b>${upDur(d.uptimeSec)}</b><span class="hint">since ${esc(new Date(d.startedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))}${d.deploy ? ' · version ' + esc(d.deploy) : ''}</span></div>
         <div class="srow"><span>Memory</span><b>${d.memory.rssMb} MB</b><span class="hint">${d.memory.pct}% of the ${d.memory.limitMb} MB alert level</span></div>${bar(d.memory.pct)}
         <div class="srow"><span>Speed</span><b>${d.speed.n ? d.speed.avg + ' ms' : '—'}</b><span class="hint">${d.speed.n ? `average · slowest 5%: ${d.speed.p95} ms` : ''}</span></div>`),
      card('🗄', 'Database', !db.ok ? bad('Down') : db.ms > 500 ? warn('Slow') : ok('Connected'),
        db.ok ? `<div class="srow"><span>Answer time</span><b>${db.ms} ms</b></div><div class="srow"><span>Size</span><b>${db.sizeMb} MB</b><span class="hint">${grow != null ? (grow >= 0 ? '+' : '') + grow.toFixed(1) + ' MB in a week' : 'growth shows after a week'}</span></div>
          <div class="hint">Biggest: ${db.tables.map((t) => `${esc(t.name)} ${t.mb} MB`).join(' · ')}</div>` : `<div class="over">${esc(db.error)}</div>`),
      card('🌐', 'Outside services', d.meta.max >= 90 ? bad('Meta limit') : d.meta.max >= 70 ? warn('Meta busy') : ok('OK'),
        `<div class="srow"><span>Meta API usage</span><b>${d.meta.max}%</b><span class="hint">${d.meta.top.length ? 'of its rate limit, last 2 hours' : 'no data yet'}</span></div>${bar(d.meta.max)}${svc('Meta API')}${svc('adsbox.biz')}${svc('Telegram')}`),
      card('🔔', 'Alerts to my Telegram', al.on ? ok('On') : warn('Off'),
        al.on ? `Alerts go to <b>${esc(al.name || 'your Telegram')}</b>${al.at ? ` · since ${esc(new Date(al.at).toLocaleDateString('en-GB'))}` : ''}.<div class="hint">You get a message when the database stops, a background job stops or keeps failing, memory gets high, Meta usage is near its limit, or many errors happen — and another when it’s fixed.</div>${al.canEdit ? '<div class="sc-a"><button class="sm" data-al="test">Send test</button><button class="sm ghost" data-al="off">Turn off</button></div>' : ''}`
        : al.canEdit ? `Open <b>@${esc(al.bot || 'the bot')}</b> in Telegram (a private chat, not a group) and send:<div class="alcode"><code class="lcode" title="Tap to copy">/alerts ${esc(al.code)}</code></div><div class="hint">Within a minute this turns on. You'll then get a message whenever something serious happens.</div>` : 'Only the app owner can turn alerts on.'),
    ].join('');
    const lc = $('sysGrid').querySelector('.lcode'); if (lc) lc.onclick = async () => { try { await navigator.clipboard.writeText(lc.textContent); toast('Copied — send it to the bot in Telegram'); } catch (_) {} };
    const stl = { ok: '<span class="okt">● OK</span>', running: '<span class="runt">● Running</span>', failed: '<span class="over">● Failed</span>', late: '<span class="over">● Not running</span>', waiting: '<span class="muted">● Waiting</span>' };
    $('sysJobs').innerHTML = d.jobs.map((j) => `<tr><td><b>${esc(j.name)}</b><div class="hint">${esc(j.schedule || '')}</div></td><td class="num">${j.runs}${j.fails ? ` <span class="over">· ${j.fails} failed</span>` : ''}</td><td>${stl[j.status] || ''}${j.error && j.status === 'failed' ? `<div class="hint over">${esc(j.error)}</div>` : ''}</td><td class="hint">${j.lastEnd ? ago(j.lastEnd) : '—'}</td><td class="r num hint">${j.ms != null ? (j.ms >= 1000 ? (j.ms / 1000).toFixed(1) + ' s' : j.ms + ' ms') : ''}</td><td class="hint">${j.next ? new Date(j.next).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : ''}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No background jobs yet.</td></tr>';
    $('sysErrors').innerHTML = d.errors.length ? d.errors.map((e) => `<div class="serr"><span class="hint num">${esc(new Date(e.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))}</span><span class="serr-w">${esc(e.where)}</span><span class="serr-m">${esc(e.message)}</span></div>`).join('') : '<div class="hallgood small"><span>✓</span><b>No errors</b></div>';
    return d;
  }
  $('sysGrid').addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-al]'); if (!b) return;
    try {
      if (b.dataset.al === 'test') { await api('/admin/alerts/test', { method: 'POST' }); successBadge('Test alert sent'); }
      if (b.dataset.al === 'off') { if (!confirm('Turn off system alerts?')) return; await api('/admin/alerts', { method: 'DELETE' }); toast('Alerts off'); loadSystem(); }
    } catch (e) { toast(e.message); }
  });
  $('hRefresh').onclick = () => loadHealth();
  $('hList').addEventListener('click', async (ev) => {
    const b = ev.target.closest('button'); if (!b) return;
    if (b.dataset.hrun) { await runSync(b.dataset.hrun, b); }
    if (b.dataset.hgo) showTab(b.dataset.hgo);
  });

  // Settings
  async function loadSettings() {
    let d; try { d = await api('/admin/settings'); } catch (e) { $('sGrid').innerHTML = `<div class="muted">${esc(e.message)}</div>`; return; }
    const oc = d.orders || {};
    const card = (ic, title, state, body, acts) => `<div class="setcard"><div class="sc-h"><span class="sc-ic">${ic}</span><b>${title}</b>${state}</div><div class="sc-b">${body}</div>${acts ? `<div class="sc-a">${acts}</div>` : ''}</div>`;
    const on = (t) => `<span class="sc-st ok">${t}</span>`, off = (t) => `<span class="sc-st bad">${t}</span>`;
    $('sGrid').innerHTML = [
      card('📦', 'adsbox.biz orders', oc.hasKey ? (oc.lastError ? off('Error') : on('Connected')) : off('Not connected'),
        `${oc.hasKey ? `Key ${esc(oc.keyHint || '')}${oc.savedBy ? ' · saved by ' + esc(oc.savedBy) : ''}<br>` : 'Connect to see cost per order.<br>'}${oc.last ? 'Last update ' + esc(ago(oc.last.at)) : ''}${oc.lastError ? `<div class="over">${esc(oc.lastError.message)}</div>` : ''}<div class="hint">Updates every 30 minutes for everyone. Only admins see the key.</div>`,
        '<button class="sm" data-sgo="orders-api">⚙ API settings</button>'),
      card('✈️', 'Telegram bot', d.telegram.bot ? on('Set up') : off('Missing'),
        d.telegram.bot ? `Bot: <b>@${esc(d.telegram.username || '…')}</b><div class="hint">Clients' groups are linked with the /link code in each client's window. ${d.telegram.teamGroup ? 'Team report group is set.' : 'No team report group (TELEGRAM_CHAT_ID).'}</div>` : 'Add <code>TELEGRAM_BOT_TOKEN</code> in Railway to send reports.', ''),
      card('🧾', 'Invoice', '', `<div class="sc-inv"><div><b>${esc(d.invoice.company)}</b><br>${esc(d.invoice.bankName)}<br>${esc(d.invoice.accountName)}<br><span class="num">${esc(d.invoice.accountNo)}</span></div>${d.invoice.qr ? `<img class="sc-qr" src="${d.invoice.qr}" alt="Payment QR">` : ''}</div><div class="hint">The payment QR is the same on every user's invoices.</div>`,
        `${d.canEdit ? '<button class="sm" data-sgo="qr">Change QR for everyone</button><input type="file" id="sQrFile" accept="image/png,image/jpeg" hidden>' : ''}<button class="sm ghost" data-sgo="invoice">My invoice details</button>`),
      card('⏰', 'My auto report', '', 'Sends each client’s report to their Telegram group at a set time every day. Each person sets their own.', '<button class="sm" data-sgo="autoreport">Open auto report</button>'),
      card('🔄', 'Auto sync', d.autoSyncServer ? on('On') : off('Off on server'), 'Every 5 minutes: new ad accounts and campaigns · every hour: today and yesterday · 05:30: the last 30 days.', d.canEdit ? '<button class="sm" data-sgo="syncon">Turn on for everyone</button><button class="sm ghost" data-sgo="syncoff">Turn off for everyone</button>' : ''),
      d.canEdit ? card('📤', 'Boost Desk API · spend', '', '<div id="skBox" class="hint">Loading…</div>', '<button class="sm" data-sgo="newkey">+ Create key</button><button class="sm ghost" data-sgo="devdoc">Copy instructions for developer</button>') : '',
      card('✨', 'AI advice', d.ai && d.ai.hasKey ? on(d.ai.provider === 'gemini' ? 'On · Gemini' : 'On · Claude') : off('Off'), d.ai && d.ai.hasKey ? `Key ${esc(d.ai.keyHint || '')}${d.ai.savedBy ? ' · saved by ' + esc(d.ai.savedBy) : ''}<br>Model <code>${esc(d.ai.model)}</code> · up to ${d.ai.dailyLimit} requests per person per day.<div class="hint">Used by the ✨ AI advice button in each client's breakdown. Sends the client's spend, lives, posts and order counts to ${d.ai.provider === 'gemini' ? 'Google' : 'Anthropic'} — no customer data.</div>` : 'Add a Claude key (console.anthropic.com) or a Gemini key (aistudio.google.com) to turn on ✨ AI advice for each client.', d.canEdit ? `<button class="sm" data-sgo="aikey">${d.ai && d.ai.hasKey ? 'Change key' : 'Add key'}</button>${d.ai && d.ai.hasKey ? '<button class="sm ghost" data-sgo="aikeydel">Remove</button>' : ''}` : ''),
      card('🌏', 'General', '', `Time zone: <b>${esc(d.tz)}</b><br>Tax on spend: <b>${d.taxRate || 0}%</b><div class="hint">Changed in Railway variables.</div>`, ''),
      d.canEdit ? card('🗄', 'Database backup', '', '<div id="bkBox" class="hint">Loading…</div>', '<button class="sm" data-sgo="bknow">Back up now</button><a class="btn sm ghost" href="/api/admin/backup/download" download>⬇ Download</a>') : '',
      d.canEdit ? card('🔐', 'Security · change secrets', '', '<div id="secBox" class="hint">Loading…</div>', '') : '',
    ].join('');
    if (d.canEdit) { loadKeys(); loadSecurity(); }
  }
  // Steps to change every secret after a leak (e.g. the Railway incident of 21 Oct 2026). New values are made in
  // this browser only — they are never sent to the server or to chat; you paste them straight into Railway.
  const SEC_STEPS = [
    ['telegram', 'Telegram bot token', 'In Telegram open <b>@BotFather</b> → <code>/revoke</code> → pick the bot → copy the new token. In Railway → boost-desk → Variables, replace <code>TELEGRAM_BOT_TOKEN</code>. Groups stay linked.'],
    ['facebook', 'Facebook App Secret', 'developers.facebook.com → your app → App settings → Basic → App secret → <b>Reset</b>. Replace <code>FB_APP_SECRET</code> in Railway. Logins keep working.'],
    ['session', 'Session secret', 'Make a new value below and replace <code>SESSION_SECRET</code>. Everyone is logged out once and logs in again with Facebook.', 'session'],
    ['encryption', 'Encryption key', 'First add a variable <code>ENCRYPTION_KEY_OLD</code> = the current <code>ENCRYPTION_KEY</code> value. Then replace <code>ENCRYPTION_KEY</code> with a new value from below. After deploy, Boost Desk re-saves every login and API key with the new key — when this card says “0 left on old key”, delete <code>ENCRYPTION_KEY_OLD</code>.', 'key'],
    ['database', 'Database password', 'Make a new value below. Railway → Postgres service → <b>Database → Query</b>, run <code>ALTER USER postgres WITH PASSWORD \'NEW_VALUE\';</code> then on the Postgres service Variables set <code>POSTGRES_PASSWORD</code> and <code>PGPASSWORD</code> to the same value. boost-desk’s <code>DATABASE_URL</code> is a reference, so it follows — after it redeploys, the Health page should show the database OK. Do this one last, after a fresh backup.', 'db'],
  ];
  const randHex = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, '0')).join('');
  async function loadSecurity() {
    let st; try { st = await api('/admin/security'); } catch (e) { const x = $('secBox'); if (x) x.textContent = e.message; return; }
    const bk = st.lastBackup, bx = $('bkBox');
    if (bx) bx.innerHTML = (bk ? `Last backup <b>${esc(ago(bk.at))}</b> · ${bk.sizeMb} MB${bk.sent ? ' · sent to your Telegram' : ''}${bk.error ? `<div class="over">${esc(bk.error)}</div>` : ''}` : '<b>No backup yet.</b>')
      + `<div class="hint">Every night at 03:20 the whole database is saved to one file and sent to your private Telegram chat${st.alertChat ? '' : ' — <b>turn on owner alerts (/alerts code on the Health page) first</b>'}. Facebook logins and API keys inside stay encrypted. Keep the file private: it has your clients and invoices.</div>`;
    const box = $('secBox'); if (!box) return;
    const r = st.rotated || {}, done = SEC_STEPS.filter((x) => r[x[0]]).length;
    box.innerHTML = `<div>Railway had a security incident on 21 Oct 2026 — change these so old copies stop working. <b>${done} of ${SEC_STEPS.length} done.</b> Never paste the values into chat.</div>`
      + (st.oldKey ? `<div class="${st.leftOnOld ? 'over' : 'ok-t'}">ENCRYPTION_KEY_OLD is set · ${st.leftOnOld} value${st.leftOnOld === 1 ? '' : 's'} left on old key${st.leftOnOld ? '' : ' — you can delete ENCRYPTION_KEY_OLD now'}.</div>` : '')
      + `<ol class="secl">${SEC_STEPS.map(([k, t, how, gen]) => `<li class="${r[k] ? 'done' : ''}"><label><input type="checkbox" data-secdone="${k}" ${r[k] ? 'checked' : ''}> <b>${t}</b>${r[k] ? ` <span class="hint">· done ${esc(new Date(r[k]).toLocaleDateString('en-GB'))}</span>` : ''}</label><div class="hint">${how}</div>${gen ? `<div class="secgen"><button class="sm ghost" data-secgen="${gen}">Make new value</button><code class="lcode" data-copy="" hidden></code></div>` : ''}</li>`).join('')}</ol>`;
  }
  let skBase = location.origin;
  const devDoc = (key) => `Boost Desk spend API — read boost spend per Facebook Page per day

URL:     GET ${skBase}/public-api/spend
Auth:    X-API-Key: ${key || '<your key>'}
         (or Authorization: Bearer <key>, or ?api_key=<key>)
Params:  from=YYYY-MM-DD   default: 6 days before "to"
         to=YYYY-MM-DD     default: today
         page_id=<numeric Facebook Page id>   optional
         Max 185 days per call. Dates are Asia/Phnom_Penh days. Money is USD.

Example:
curl -H "X-API-Key: ${key || '<your key>'}" "${skBase}/public-api/spend?from=2026-10-01&to=2026-10-17"

Answer:
{
  "ok": true, "from": "2026-10-01", "to": "2026-10-17",
  "timezone": "Asia/Phnom_Penh", "currency": "USD",
  "totals": { "spend": 1234.56 }, "count": 2,
  "rows": [
    { "date": "2026-10-16", "page_id": "100844805533349", "spend": 17.45 },
    { "date": "2026-10-17", "page_id": "100844805533349", "spend": 9.80 }
  ]
}

Notes:
- One row per Page per day = all boosts on that Page that day added up.
- A day can still change for ~2 days (Meta updates spend late), so re-read the last 7 days each time
  and replace (not add) what you stored for those days.
- Join with your orders on page_id + date: cost per order = spend / orders.
- Errors: 401 key missing/invalid · 400 bad dates or page_id · answer { "ok": false, "error": "..." }.`;
  async function loadKeys(fresh) {
    const box = $('skBox'); if (!box) return;
    let d; try { d = fresh || await api('/admin/spend-keys'); } catch (e) { box.textContent = e.message; return; }
    if (d.base) skBase = d.base;
    box.innerHTML = `<div>Lets adsbox.biz (or any site) read <b>date · Page ID · spend</b> from Boost Desk with a key.</div>`
      + (d.key ? `<div class="newkey"><b>New key — copy it now, it won't be shown again:</b><code class="lcode" data-copy="${esc(d.key)}">${esc(d.key)}</code><button class="sm" data-sgo="devdoc" data-key="${esc(d.key)}">Copy instructions with this key</button></div>` : '')
      + (d.keys.length ? d.keys.map((k) => `<div class="skrow"><span><b>${esc(k.name)}</b> <code>${esc(k.prefix)}…</code><br><span class="hint">${k.calls} call${k.calls === 1 ? '' : 's'}${k.lastUsed ? ' · last used ' + esc(ago(k.lastUsed)) : ' · not used yet'}</span></span><button class="sm ghost danger-t" data-delkey="${esc(k.id)}">Delete</button></div>`).join('') : '<div>No key yet.</div>');
  }
  $('sGrid').addEventListener('change', async (ev) => {
    const t = ev.target.closest('[data-secdone]'); if (!t) return;
    try { await api('/admin/security/done', { method: 'POST', body: { key: t.dataset.secdone, done: t.checked } }); loadSecurity(); } catch (e) { toast(e.message); t.checked = !t.checked; }
  });
  $('sGrid').addEventListener('click', async (ev) => {
    const cp = ev.target.closest('[data-copy]'); if (cp) { try { await navigator.clipboard.writeText(cp.dataset.copy); toast('Key copied'); } catch (_) {} return; }
    const dk = ev.target.closest('[data-delkey]');
    if (dk) { if (!confirm('Delete this key? Anything using it will stop working.')) return; try { loadKeys({ ...(await api('/admin/spend-keys/' + dk.dataset.delkey, { method: 'DELETE' })), base: skBase }); toast('Key deleted'); } catch (e) { toast(e.message); } return; }
    const b = ev.target.closest('button'); if (!b) return;
    const k = b.dataset.sgo;
    if (b.dataset.secgen) { const c = b.nextElementSibling, v = randHex(32); c.textContent = v; c.dataset.copy = v; c.hidden = false; c.title = 'Tap to copy'; try { await navigator.clipboard.writeText(v); toast('New value copied — paste it in Railway'); } catch (_) {} return; }
    if (k === 'bknow') { b.disabled = true; b.textContent = 'Backing up…'; try { const r = await api('/admin/backup', { method: 'POST' }); r.error ? toast(r.error) : successBadge(`Backup sent · ${r.sizeMb} MB`); } catch (e) { toast(e.message); } loadSecurity(); b.disabled = false; b.textContent = 'Back up now'; return; }
    if (k === 'newkey') { const name = prompt('Name for this key (who will use it)', 'adsbox.biz'); if (name === null) return; try { loadKeys(await api('/admin/spend-keys', { method: 'POST', body: { name } })); } catch (e) { toast(e.message); } return; }
    if (k === 'devdoc') { try { await navigator.clipboard.writeText(devDoc(b.dataset.key || '')); successBadge('Instructions copied — paste them to the developer'); } catch (_) { toast('Could not copy'); } return; }
    if (k === 'orders-api') { showTab('orders'); setTimeout(() => $('oSetBtn').click(), 400); }
    if (k === 'invoice') { showTab('payments'); setTimeout(() => $('paySettings').click(), 400); }
    if (k === 'autoreport') $('cAutoBtn').click();
    if (k === 'qr') $('sQrFile').click();
    if (k === 'aikey') { const v = prompt('Paste your Gemini key (from aistudio.google.com) or Claude key (starts with sk-ant-)'); if (!v) return; try { await api('/admin/ai', { method: 'PUT', body: { key: v.trim() } }); successBadge('AI advice is on'); aiReady = true; loadSettings(); } catch (e) { toast(e.message); } return; }
    if (k === 'aikeydel') { if (!confirm('Remove the AI key? AI advice stops working.')) return; try { await api('/admin/ai', { method: 'PUT', body: { key: null } }); toast('AI key removed'); aiReady = false; loadSettings(); } catch (e) { toast(e.message); } return; }
    if (k === 'syncon' || k === 'syncoff') { try { await api('/auto-sync', { method: 'PUT', body: { enabled: k === 'syncon' } }); successBadge('Auto sync ' + (k === 'syncon' ? 'on' : 'off') + ' for everyone'); } catch (e) { toast(e.message); } }
  });
  $('sGrid').addEventListener('change', async (ev) => {
    if (ev.target.id !== 'sQrFile') return;
    const f = ev.target.files[0]; if (!f) return;
    if (f.size > 320000) return toast('Picture is too big — under 300 KB please.');
    const data = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(f); });
    try { await api('/admin/invoice-qr', { method: 'PUT', body: { qr: data } }); successBadge('QR changed for everyone'); loadSettings(); } catch (e) { toast(e.message); }
  });

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
    else if (v === 'custom') { openPeriod(true); return; }
    else if (v === 'more') { openPeriod(); return; }
    loadPeriod();
  }
  // The period bar (Dashboard and Orders share one period).
  const loadPeriod = () => (!$('tab-orders').hidden ? loadOrders() : !$('tab-main').hidden ? loadMain() : loadDash());
  function paintPeriod() {
    const pre = currentPreset(), label = periodLabel();
    const atEnd = (dMode === 'day' && dDate >= me.today) || (dMode === 'month' && dDate.slice(0, 7) >= me.today.slice(0, 7)) || (dMode === 'year' && dDate.slice(0, 4) >= me.today.slice(0, 4)) || (dMode === 'range' && dTo >= me.today);
    document.querySelectorAll('.perbar').forEach((bar) => {
      bar.querySelector('.pb-label').textContent = label;
      bar.querySelector('.pb-next').disabled = atEnd;
      const known = [...bar.querySelectorAll('.pb-chips button')].some((b) => b.dataset.preset === pre);
      bar.querySelectorAll('.pb-chips button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.preset === pre || (b.dataset.preset === 'more' && !known))));
    });
  }
  // Period bar sticks to the top of the page while scrolling (Main Dashboard, Dashboard, Orders), with a little motion.
  (function stickyBars() {
    const head = document.querySelector('header.appbar');
    const topGap = () => (head && getComputedStyle(head).position === 'sticky' ? head.offsetHeight + 6 : 10);
    const setTop = () => document.documentElement.style.setProperty('--pb-top', topGap() + 'px');
    setTop(); addEventListener('resize', setTop);
    if (!('IntersectionObserver' in window)) return;
    // While stuck, the bar also shows the page's key totals (they scroll away with the summary).
    const MINI = { 'tab-main': [['mSpend', 'spend'], ['mOrders', 'orders'], ['mCpo', 'per order']], 'tab-orders': [['oCpo', 'per order'], ['oOrders', 'orders'], ['oSpend', 'spend']], 'tab-dashboard': [['dSpend', 'spent'], ['dLive', 'live'], ['dPost', 'post']] };
    document.querySelectorAll('.perbar').forEach((bar) => {
      const sec = bar.closest('section'), spec = sec && MINI[sec.id];
      if (spec) {
        const mini = document.createElement('div'); mini.className = 'pb-mini'; mini.setAttribute('aria-hidden', 'true');
        bar.querySelector('.pb-nav').after(mini);
        // rollTo() draws digit wheels, so read the value it was given (aria-label), not the wheel text.
        const val = (id) => { const el = $(id); return el ? (el.getAttribute('aria-label') || el._roll || el.textContent || '–').trim() : '–'; };
        const fill = () => { mini.innerHTML = spec.map(([id, l]) => `<span><b class="num">${esc(val(id))}</b> ${l}</span>`).join(''); };
        fill(); const mo = new MutationObserver(() => { if (bar.classList.contains('stuck')) fill(); });
        spec.forEach(([id]) => { if ($(id)) mo.observe($(id), { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['aria-label'] }); });
        bar._fill = fill;
      }
      const s2 = document.createElement('div'); s2.className = 'pb-sentinel'; s2.setAttribute('aria-hidden', 'true');
      bar.before(s2);
      const io = new IntersectionObserver(([en]) => {
        const stuck = !en.isIntersecting && en.boundingClientRect.height > 0 && en.boundingClientRect.top < topGap() && en.rootBounds && en.boundingClientRect.bottom < en.rootBounds.bottom;
        if (stuck === bar.classList.contains('stuck')) return;
        bar.classList.toggle('stuck', stuck); if (stuck && bar._fill) bar._fill();
        if (stuck && !calm && bar.animate) bar.animate([{ transform: 'translateY(-14px) scale(.98)', opacity: .4 }, { transform: 'none', opacity: 1 }], { duration: 420, easing: 'cubic-bezier(.22,1,.36,1)' });
      }, { rootMargin: `-${topGap()}px 0px 0px 0px`, threshold: 0 });
      io.observe(s2);
    });
  })();
  document.querySelectorAll('.pb-chips button').forEach((b) => b.onclick = () => applyPreset(b.dataset.preset));
  document.querySelectorAll('.pb-prev').forEach((b) => b.onclick = () => dShift(-1));
  document.querySelectorAll('.pb-next').forEach((b) => b.onclick = () => dShift(1));
  document.querySelectorAll('.pb-pick').forEach((b) => b.onclick = () => openPeriod());
  const dShift = (n) => {
    if (dMode === 'range') { const len = Math.round((parse(dTo) - parse(dFrom)) / 864e5) + 1; dFrom = addD(dFrom, n * len); dTo = addD(dTo, n * len); }
    else if (dMode === 'day') dDate = addD(dDate, n);
    else if (dMode === 'year') dDate = (Number(dDate.slice(0, 4)) + n) + dDate.slice(4);
    else { const d = parse(dDate); d.setDate(1); d.setMonth(d.getMonth() + n); dDate = iso(d); }
    loadPeriod();
  };

  // ---------- floating period filter (bottom of the screen while scrolled down) ----------
  const dock = $('fDock');
  function syncDock(pre = currentPreset()) {
    $('fLabelText').textContent = periodLabel();
    $('fNext').disabled = $('dNext').disabled;
  }
  $('fPrev').onclick = () => dShift(-1); $('fNext').onclick = () => dShift(1);
  $('fLabel').onclick = () => openPeriod();
  let dockShown = false;
  function setDock(show) {
    show = show && !$('tab-dashboard').hidden;
    if (show === dockShown) return;
    dockShown = show; document.body.classList.toggle('has-dock', show || !$('tab-dashboard').hidden);
    if (show) {
      dock.hidden = false; syncDock();
      if (!calm && dock.animate) dock.animate([{ opacity: 0, transform: 'translate(-50%, 24px) scale(.96)' }, { opacity: 1, transform: 'translate(-50%, 0)' }], { duration: 420, easing: 'cubic-bezier(.22,1,.36,1)' });
    } else if (!calm && dock.animate) {
      dock.animate([{ opacity: 1, transform: 'translate(-50%, 0)' }, { opacity: 0, transform: 'translate(-50%, 24px) scale(.96)' }], { duration: 260, easing: 'cubic-bezier(.4,0,1,1)' }).onfinish = () => { if (!dockShown) dock.hidden = true; };
    } else dock.hidden = true;
  }
  if ('IntersectionObserver' in window) {
    // The bottom dock is replaced by the period bar sticking to the top of the page (see stickyBars below).
    setDock(false);
  }

  // ---------- period sheet: every way to pick a period, big and in one place ----------
  const presetRange = (v) => {
    const t = me.today;
    if (v === 'today') return [t, t];
    if (v === 'yesterday') { const y = addD(t, -1); return [y, y]; }
    if (v === '7') return [addD(t, -6), t];
    if (v === '30') return [addD(t, -29), t];
    if (v === 'thisMonth') return [t.slice(0, 8) + '01', t];
    if (v === 'lastMonth') { const d = parse(t.slice(0, 8) + '01'); d.setMonth(d.getMonth() - 1); const ym = iso(d).slice(0, 7); return [ym + '-01', ym + '-' + pad(lastDay(ym))]; }
    if (v === 'thisYear') return [t.slice(0, 4) + '-01-01', t];
    if (v === 'lastYear') { const y = Number(t.slice(0, 4)) - 1; return [y + '-01-01', y + '-12-31']; }
  };
  const subText = (v) => {
    const [a, b] = presetRange(v);
    if (v === 'thisYear' || v === 'lastYear') return a.slice(0, 4);
    if (v === 'lastMonth') return monthLabel(a.slice(0, 7));
    if (a === b) return parse(a).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
    return `${shortD(a)} – ${shortD(b)}`;
  };
  function openPeriod(custom) {
    const dlg = $('pDlg'), pre = currentPreset(), [from, to] = dRange();
    $('pNow').textContent = periodLabel();
    document.querySelectorAll('#pGrid button').forEach((b) => { b.setAttribute('aria-pressed', String(b.dataset.preset === pre)); b.querySelector('span').textContent = subText(b.dataset.preset); });
    $('pDay').value = dMode === 'day' ? dDate : ''; $('pDay').max = me.today;
    $('pMonth').value = dMode === 'month' ? dDate.slice(0, 7) : ''; $('pMonth').max = me.today.slice(0, 7);
    $('pFrom').value = from; $('pTo').value = to; $('pFrom').max = $('pTo').max = me.today;
    $('pRange').classList.toggle('on', !!custom || pre === 'custom');
    if (typeof dlg.showModal === 'function') { if (!dlg.open) dlg.showModal(); } else dlg.setAttribute('open', '');
    if (custom) setTimeout(() => $('pFrom')._btn.focus(), 60);
    if (!calm) document.querySelectorAll('#pGrid button').forEach((b, i) => b.animate([{ opacity: 0, transform: 'translateY(8px) scale(.97)' }, { opacity: 1, transform: 'none' }], { duration: 380, delay: 40 + i * 30, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'backwards' }));
  }
  const closePeriod = () => { const d = $('pDlg'); if (d.open) d.close(); };
  document.querySelectorAll('#pGrid button').forEach((b) => b.onclick = () => { closePeriod(); applyPreset(b.dataset.preset); });
  $('pDay').onchange = () => { if ($('pDay').value) { dMode = 'day'; dDate = $('pDay').value; forceCustom = false; closePeriod(); loadPeriod(); } };
  $('pMonth').onchange = () => { if ($('pMonth').value) { dMode = 'month'; dDate = $('pMonth').value + '-01'; forceCustom = false; closePeriod(); loadPeriod(); } };
  $('pApply').onclick = () => {
    let a = $('pFrom').value, b = $('pTo').value; if (!a || !b) return toast('Pick both dates.');
    if (a > b) [a, b] = [b, a];
    if ((parse(b) - parse(a)) / 864e5 > 366) return toast('Pick at most one year.');
    dMode = 'range'; dFrom = a; dTo = b; forceCustom = true; closePeriod(); loadPeriod();
  };
  $('pFrom')._btn.onfocus = $('pTo')._btn.onfocus = () => $('pRange').classList.add('on');
  $('pDlg').addEventListener('click', (ev) => { if (ev.target === $('pDlg')) closePeriod(); }); // tap outside closes
  $('dDay').onchange = () => { if ($('dDay').value) { dDate = $('dDay').value; loadDash(); } };
  $('dMonth').onchange = () => { if ($('dMonth').value) { dDate = $('dMonth').value + '-01'; loadDash(); } };
  $('dFrom').onchange = () => { if ($('dFrom').value) { dFrom = $('dFrom').value; if (dTo < dFrom) dTo = dFrom; loadDash(); } };
  $('dTo').onchange = () => { if ($('dTo').value) { dTo = $('dTo').value; if (dFrom > dTo) dFrom = dTo; loadDash(); } };
  $('dSearch').oninput = () => renderDash(); $('dShowIdle').onchange = () => renderDash();
  document.querySelectorAll('#dTypeSeg button').forEach((b) => b.onclick = () => {
    dTypeF = b.dataset.type; document.querySelectorAll('#dTypeSeg button').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); renderDash();
  });
  document.querySelectorAll('.dtable th[data-sort]').forEach((th) => th.onclick = () => {
    const k = th.dataset.sort; dSort = { key: k, asc: dSort.key === k ? !dSort.asc : k === 'name' || k === 'cpr' }; renderDash();
  });

  let dEntries = {}, dPages = {}, dKey = '', dSent = {}; const dOpen = new Set();
  const skelRows = (n) => Array.from({ length: n }, (_, i) => `<tr class="skel"><td colspan="9"><div class="sk" style="--w:${60 + ((i * 37) % 35)}%"></div></td></tr>`).join('');
  async function loadDash(quiet) {
    if (!dDate) dDate = me.today;
    // Sync status and "Spend not matched" follow the day you're looking at (today for longer periods).
    const infoDay = dMode === 'day' ? dDate : me.today;
    if (date !== infoDay) { date = infoDay; loadDay(); }
    const pre = currentPreset();
    paintPeriod();
    syncDock(pre);
    $('dDay').value = dDate; $('dMonth').value = dDate.slice(0, 7);
    const custom = dMode === 'range' && pre === 'custom';
    $('dRangeBox').hidden = !custom; $('dPick').hidden = custom;
    if (dMode === 'range') { $('dFrom').value = dFrom; $('dTo').value = dTo; }
    $('dTable').classList.toggle('oneday', dMode === 'day');
    const [from, to] = dRange();
    $('dTableTitle').textContent = 'Clients · ' + periodLabel() + (dTypeF ? (dTypeF === 'live' ? ' · Live only' : ' · Boost posts only') : '');
    const key = from + '|' + to, samePeriod = key === dKey;
    const dir = !dKey ? 0 : samePeriod ? 0 : (from > dKey.split('|')[0] ? 1 : -1);
    const prevSpend = samePeriod && dData ? Object.fromEntries(dData.clients.map((c) => [c.id, c.spend])) : null;
    // 9) skeleton while a new period loads
    const skel = !samePeriod ? setTimeout(() => { $('dBody').innerHTML = skelRows(5); $('dFoot').innerHTML = ''; document.querySelectorAll('#tab-dashboard .summary .val').forEach((v) => v.classList.add('skel-v')); }, 120) : null;
    try {
      const [d, rows, pg, sr] = await Promise.all([api(`/dashboard?from=${from}&to=${to}`), api(`/entries?from=${from}&to=${to}`).catch(() => []), api(`/dashboard/pages?from=${from}&to=${to}`).catch(() => ({})), api('/sent-reports').catch(() => ({}))]);
      dPages = pg || {}; dSent = sr || {};
      clearTimeout(skel); document.querySelectorAll('.skel-v').forEach((v) => v.classList.remove('skel-v'));
      dData = d; dEntries = {}; dKey = key;
      for (const r of rows) (dEntries[r.client_id] = dEntries[r.client_id] || {})[r.day] = r.data || {};
      renderDash();
      // 5) the new period slides in from the direction you moved
      if (dir && !calm) ['#tab-dashboard .summary', '#dChartPanel', '#dTable tbody'].forEach((sel, i) => { const el = document.querySelector(sel); if (el && !el.hidden) el.animate([{ opacity: 0, transform: `translateX(${dir * 28}px)` }, { opacity: 1, transform: 'none' }], { duration: 520, delay: i * 60, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'backwards' }); });
      // 2) rows whose spend went up since the last refresh flash green with a "+$" label
      if (prevSpend) dData.clients.forEach((c) => {
        const inc = c.spend - (prevSpend[c.id] || 0);
        if (inc > 0.009) { const tr = document.querySelector(`#dBody tr.drow[data-cid="${c.id}"]`); if (tr) { tr.classList.remove('flash'); void tr.offsetWidth; tr.classList.add('flash'); floatUp(tr.querySelector('td.tot b') || tr, '+' + money(inc), 'up'); } }
      });
    }
    catch (e) { $('dBody').innerHTML = `<tr><td colspan="9" class="muted">${esc(e.message)}</td></tr>`; }
  }

  // Page names under the client (hide raw Page ID numbers and the client's own name).
  // Spend per Facebook Page, when a client's spend came from 2 or more Pages.
  const pageSplit = (c) => {
    const l = (dPages[c.id] || []).map((p) => (dTypeF === 'live' ? { ...p, spend: p.live, post: 0 } : dTypeF === 'post' ? { ...p, spend: p.post, live: 0 } : p)).filter((p) => p.spend > 0.0049).sort((a, b) => b.spend - a.spend);
    return l.length > 1 ? l : null;
  };
  const pageLine = (c) => { const l = pageSplit(c); if (!l) return ''; const top = l.slice(0, 3).map((p) => `${pageLabel(p)} <b>${money(p.spend)}</b>`); return top.join(' · ') + (l.length > 3 ? ` · +${l.length - 3} more` : ''); };
  function pageBlock(c) {
    const l = pageSplit(c); if (!l) return '';
    const tot = l.reduce((a, p) => a + p.spend, 0) || 1;
    return `<div class="pgsplit"><div class="pgsplit-h">Spend by Page</div>${l.map((p, i) => `<div class="pgrow" style="--i:${i}">
      <div class="pgrow-n"><div class="pgrow-t"><b>${pageLabel(p)}</b>${p.pageId ? `<button class="pgname" type="button" data-pgid="${esc(p.pageId)}" data-pgname="${p.named ? esc(p.page) : ''}">${p.named ? 'Rename' : 'Add name'}</button>` : ''}</div><span class="hint">${[p.live > 0 ? 'Live ' + money(p.live) : '', p.post > 0 ? 'Post ' + money(p.post) : ''].filter(Boolean).join(' · ')}</span></div>
      <div class="pgbar"><i style="width:${Math.max(2, p.spend / tot * 100).toFixed(1)}%"></i></div>
      <div class="pgrow-v num"><b>${money(p.spend)}</b><span class="hint">${Math.round(p.spend / tot * 100)}%</span></div></div>`).join('')}</div>`;
  }
  document.addEventListener('click', async (ev) => {
    const b = ev.target.closest('.pgname'); if (!b) return;
    ev.stopPropagation();
    openPageNames(b.dataset.pgid);
  });
  // All Pages without a name in the period, in one list: open each on Facebook and type its name.
  function openPageNames(first) {
    const rows = [];
    for (const c of dData ? dData.clients : []) for (const p of dPages[c.id] || []) {
      if (!p.pageId || p.named || rows.some((r) => r.id === p.pageId)) continue;
      const ex = (p.list || []).map((x) => x.name).find((n) => n && !/^\d+$/.test(n)) || '';
      rows.push({ id: p.pageId, client: c.name, guess: p.guess || '', ex, spend: p.spend });
    }
    rows.sort((a, b) => (a.id === first ? -1 : b.id === first ? 1 : b.spend - a.spend));
    if (!rows.length) { toast('All Pages in this period have a name.'); return; }
    $('pnList').innerHTML = rows.map((r) => `<div class="pnrow"><div class="pn-h"><b>${esc(r.client)}</b><span class="hint num">Page ID ${esc(r.id)}</span><a class="btn sm" href="https://www.facebook.com/${encodeURIComponent(r.id)}" target="_blank" rel="noopener">Open ↗</a></div>${r.ex ? `<div class="hint pn-ex" title="${esc(r.ex)}">e.g. ${esc(r.ex)}</div>` : ''}<input type="text" data-pn="${esc(r.id)}" maxlength="120" placeholder="Page name" value="${esc(r.guess)}"></div>`).join('');
    dlgOpen($('pnDlg'));
    setTimeout(() => { const i = $('pnList').querySelector('input'); if (i) i.focus(); }, 80);
  }
  $('pnSave').onclick = async () => {
    const b = $('pnSave'); b.disabled = true; let n = 0;
    try {
      for (const i of $('pnList').querySelectorAll('[data-pn]')) { const v = i.value.trim(); if (!v) continue; await api('/page-names/' + i.dataset.pn, { method: 'PUT', body: { name: v } }); n++; }
      $('pnDlg').close(); dPages = await api(`/dashboard/pages?from=${dRange()[0]}&to=${dRange()[1]}`); renderDash(); successBadge(n ? `${n} Page name${n === 1 ? '' : 's'} saved` : 'Nothing to save');
    } catch (e) { toast(e.message); } finally { b.disabled = false; }
  };
  // Tick / untick a live or the boost post for the report.
  function togglePick(line) {
    const cid = Number(line.dataset.cid), off = offSet(cid, line.dataset.day || dDate), k = line.dataset.pick;
    if (off.has(k)) off.delete(k); else off.add(k);
    line.classList.toggle('off', off.has(k)); line.setAttribute('aria-checked', String(!off.has(k)));
    const lines = [...document.querySelectorAll(`#dBody .dl.pick[data-cid="${cid}"]`)], on = lines.filter((l) => !l.classList.contains('off'));
    const btn = document.querySelector(`#dBody [data-dreport="${cid}"]`), lab = btn && btn.querySelector('.rlabel');
    if (lab) lab.textContent = on.length === lines.length ? '' : on.length ? ` · ${on.length} of ${lines.length} ticked · ${money(on.reduce((a, l) => a + Number(l.dataset.spend), 0))}` : ' · nothing ticked';
    if (!calm && line.animate) line.animate([{ transform: 'scale(.985)' }, { transform: 'none' }], { duration: 260, easing: 'cubic-bezier(.22,1,.36,1)' });
  }
  document.addEventListener('click', (ev) => { const l = ev.target.closest('.dl.pick'); if (l && !ev.target.closest('button, input, a')) togglePick(l); });
  document.addEventListener('keydown', (ev) => { if ((ev.key === ' ' || ev.key === 'Enter') && ev.target.classList && ev.target.classList.contains('pick')) { ev.preventDefault(); togglePick(ev.target); } });
  const pageNames = (c) => { const n = c.pages.filter((p) => p !== c.name && !/^\d{6,}$/.test(p)); return n.length > 2 ? n.slice(0, 2).join(' · ') + ` +${n.length - 2}` : n.join(' · '); };
  const hasL = (c) => c.type === 'live' || c.type === 'both', hasP = (c) => c.type === 'post' || c.type === 'both';

  // The breakdown under a client: lives (start time, campaigns, spend) and boost posts — one day, or day by day.
  // Results (messages, engagements…) and cost per result.
  const resName = (n, type) => { type = type || 'result'; if (n === 1) return type; return type === 'person reached' ? 'people reached' : type + 's'; };
  const resText = (n, type) => `${Math.round(n).toLocaleString('en-US')} ${resName(n, type)}`;
  const cpr = (spend, n) => (n > 0 && spend > 0 ? spend / n : null);
  const cprMoney = (v) => (v == null ? '–' : '$' + (v < 0.1 ? v.toFixed(3) : v.toFixed(2)));
  const mergeType = (a, b) => (!a ? b : !b || a === b ? a : 'result');
  function dayParts(c, e) {
    const out = [];
    if (hasL(c) && dTypeF !== 'post') Object.entries(e.lives || {}).sort(([a], [b]) => Number(a.slice(1)) - Number(b.slice(1)))
      .forEach(([k, l]) => { if (l && Number(l.spend) > 0) out.push({ key: k, kind: 'live', label: 'Live ' + k.slice(1), time: l.time || '', n: l.campaigns || 0, spend: Number(l.spend), results: l.results, resultType: l.resultType, ids: l.ids || [] }); });
    if (dTypeF === 'live') return out;
    if (hasP(c) && Number((e.post || {}).spend) > 0) out.push({ key: 'post', kind: 'post', label: 'Boost post', time: '', n: e.post.campaigns || 0, spend: Number(e.post.spend), results: e.post.results, resultType: e.post.resultType, ids: e.post.ids || [] });
    return out;
  }
  // Unticked lines per client + day: those are left out of the report. Everything starts ticked.
  const dOff = {};
  // Pages left out of a client's report (unticked under the breakdown), per client + period.
  const dSkip = {};
  const skipKey = (cid) => cid + '|' + dRange().join('|');
  const skipSetOf = (cid) => dSkip[skipKey(cid)] || (dSkip[skipKey(cid)] = new Set());
  const reportPages = (c) => (dPages[c.id] || []).map((p) => ({ ...p, amt: dTypeF === 'live' ? p.live : dTypeF === 'post' ? p.post : p.spend })).filter((p) => p.amt > 0.0049).sort((a, b) => b.amt - a.amt);
  function pagePick(c) {
    const l = reportPages(c); if (l.length < 2) return '';
    const off = skipSetOf(c.id); for (const k of [...off]) if (!l.some((p) => p.page === k)) off.delete(k);
    const on = l.filter((p) => !off.has(p.page));
    return `<div class="pgpick"><div class="pgpick-h"><b>Pages in this report</b><span class="hint">${on.length === l.length ? 'Tap a Page to leave it out' : `${on.length} of ${l.length} Pages · ${money(on.reduce((a, p) => a + p.amt, 0))}`}</span></div><div class="pgpick-l">${l.map((p) => `<button type="button" class="pgchip" data-pgcid="${c.id}" data-pgk="${esc(p.page)}" aria-pressed="${!off.has(p.page)}"><span class="tick" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg></span><span class="pgchip-n">${pageLabel(p)}</span><b class="num">${money(p.amt)}</b></button>`).join('')}</div></div>`;
  }
  function skipList(c) { // what the server needs: Page ID and name of every unticked Page
    const off = skipSetOf(c.id), out = [];
    for (const p of reportPages(c)) if (off.has(p.page)) { if (p.pageId) out.push(p.pageId); out.push(p.page); }
    return out;
  }
  document.addEventListener('click', (ev) => {
    const b = ev.target.closest('.pgchip'); if (!b) return;
    const set = skipSetOf(Number(b.dataset.pgcid)), k = b.dataset.pgk;
    if (set.has(k)) set.delete(k); else set.add(k);
    renderDash();
  });
  const offSet = (cid, day) => dOff[cid + '|' + day] || (dOff[cid + '|' + day] = new Set());
  const TICK = '<span class="tick" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg></span>';
  const partLine = (p, pick) => `<div class="dl ln ${p.kind}${pick ? ' pick' + (pick.off.has(p.key) ? ' off' : '') : ''}"${pick ? ` data-pick="${p.key}" data-cid="${pick.cid}"${pick.day ? ` data-day="${pick.day}"` : ''} data-spend="${p.spend}" role="checkbox" tabindex="0" aria-checked="${!pick.off.has(p.key)}" title="Tap to include or leave out of the report"` : ''}>`
    + `<div class="ln-h">${pick ? TICK : ''}<span class="ln-t"><b>${esc(p.label)}</b>${p.time ? `<span class="ln-time num"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>${esc(p.time)}</span>` : ''}${p.n ? `<span class="ln-meta">${p.n} campaign${p.n > 1 ? 's' : ''}</span>` : ''}${p.kind === 'post' && p.results > 0 ? `<span class="dl-r">${esc(resText(p.results, p.resultType))} · <b class="num">${cprMoney(cpr(p.spend, p.results))}</b> each</span>` : ''}</span><b class="ln-v num">${money(p.spend)}</b></div>`
    + `${p.sub ? `<div class="ln-sub">${p.sub}</div>` : ''}</div>`;
  function pickLabel(c) {
    if (dMode === 'year') return '';
    if (dMode !== 'day') { // every day of the period
      const all = []; for (const [d, e] of Object.entries(dEntries[c.id] || {})) for (const p of dayParts(c, e)) all.push({ ...p, off: offSet(c.id, d).has(p.key) });
      const on = all.filter((p) => !p.off);
      return all.length < 2 || on.length === all.length ? '' : on.length ? ` · ${on.length} of ${all.length} ticked · ${money(on.reduce((a, p) => a + p.spend, 0))}` : ' · nothing ticked';
    }
    const parts = dayParts(c, (dEntries[c.id] || {})[dDate] || {}), off = offSet(c.id, dDate), on = parts.filter((p) => !off.has(p.key));
    return parts.length < 2 || on.length === parts.length ? '' : on.length ? ` · ${on.length} of ${parts.length} ticked · ${money(on.reduce((a, p) => a + p.spend, 0))}` : ' · nothing ticked';
  }
  // What Meta says about each campaign (Page, scheduled run time), to show why it counts as live or post.
  const runText = (m) => (m === 'unknown' || m === undefined ? '' : m === null ? 'no end date' : m < 60 ? `${m} min boost` : m < 1440 ? `${Math.floor(m / 60)}h${m % 60 ? ' ' + (m % 60) + 'm' : ''} boost` : `${Math.round(m / 1440)}-day boost`);
  const pageLabel = (p) => (p.named || !p.pageId ? esc(p.page) : p.guess ? `${esc(p.guess)} <span class="hint" title="Page ID ${esc(p.pageId)} — name guessed from the campaign names">…${esc(p.pageId.slice(-4))}</span>` : `Page …${esc(p.pageId.slice(-6))}`);
  const nameBtn = (p) => (p.pageId && !p.named ? `<button class="pgname" type="button" data-pgid="${esc(p.pageId)}" data-pgname="${esc(p.guess || '')}">${p.guess ? 'Save name' : 'Add name'}</button>` : '');
  // One campaign, with a switch to correct live/post by hand (remembered for future syncs and reports).
  const campRow = (x) => !x.id ? '' : `<div class="camp${x.set ? ' set' : ''}"><span class="cn" title="${esc(x.name)}">${esc(x.name || 'Campaign')}</span><span class="hint">${[runText(x.run), money(x.spend), x.set ? 'set by you' : ''].filter(Boolean).join(' · ')}</span><span class="camp-b"><button type="button" class="kbtn" data-camp="${esc(x.id)}" data-to="${x.live ? 'post' : 'live'}" title="Correct this campaign">${x.live ? '📌 It’s a post' : '🔴 It’s a live'}</button>${x.set ? `<button type="button" class="kbtn ghost" data-camp="${esc(x.id)}" data-to="" title="Let the app decide again">Auto</button>` : ''}</span></div>`;
  document.addEventListener('click', async (ev) => {
    const b = ev.target.closest('.kbtn'); if (!b) return;
    ev.stopPropagation(); b.disabled = true;
    try {
      b.textContent = 'Saving…';
      await api('/kind-override', { method: 'PUT', body: { campaignId: b.dataset.camp, kind: b.dataset.to || null } });
      toast(b.dataset.to === 'post' ? 'Moved to Boost posts' : b.dataset.to === 'live' ? 'Moved to Lives' : 'Back to automatic');
      clients = await api('/clients').catch(() => clients); loadDash(); loadDay();
    } catch (e) { toast(e.message); b.disabled = false; }
  });
  function campMap(c) { const m = {}; for (const p of dPages[c.id] || []) for (const x of p.list || []) if (x.id) m[x.id] = { ...x, p }; return m; }
  function runSummary(list) {
    const runs = [...new Set(list.map((x) => runText(x.run)).filter(Boolean))];
    return runs.length === 1 ? runs[0] : runs.length ? runs.slice(0, 2).join(' / ') : '';
  }
  // One day, grouped: all lives first (with their Page and boost length), then posts split by Page.
  function dayGroups(c, parts, pick) {
    const cm = campMap(c), lives = parts.filter((p) => p.kind === 'live'), posts = parts.filter((p) => p.kind === 'post');
    for (const p of lives) {
      const xs = p.ids.map((id) => cm[id]).filter(Boolean), pages = [...new Map(xs.map((x) => [x.p.page, x.p])).values()];
      p.sub = xs.length ? `${pages.map((pg) => `📄 ${pageLabel(pg)} ${nameBtn(pg)}`).join(' · ')}${runSummary(xs) ? ` <span class="hint">· ${esc(runSummary(xs))}</span>` : ''}<div class="camps">${xs.map(campRow).join('')}</div>` : '';
      p.title = xs.map((x) => x.name).join('\n');
    }
    let html = '';
    if (lives.length) html += `<div class="kgrp live"><div class="kgrp-h"><span>🔴 Lives <span class="hint">${lives.length}</span></span><b class="num">${money(lives.reduce((a, p) => a + p.spend, 0))}</b></div>${lives.map((p) => partLine(p, pick)).join('')}</div>`;
    if (posts.length) {
      const pp = posts[0], pages = (dPages[c.id] || []).filter((p) => p.post > 0.0049).sort((a, b) => b.post - a.post);
      pp.label = 'All posts'; pp.sub = '';
      const rows = pages.map((pg) => { const xs = (pg.list || []).filter((x) => !x.live); return `<div class="psub"><span class="psub-n">📄 ${pageLabel(pg)} ${nameBtn(pg)}<span class="hint"> · ${xs.length} campaign${xs.length === 1 ? '' : 's'}${runSummary(xs) ? ' · ' + esc(runSummary(xs)) : ''}</span></span><b class="num">${money(pg.post)}</b></div><div class="camps psub-c">${xs.map(campRow).join('')}</div>`; }).join('');
      html += `<div class="kgrp post"><div class="kgrp-h"><span>📌 Boost posts</span><b class="num">${money(pp.spend)}</b></div>${partLine(pp, pick)}${pages.length ? `<div class="psubs">${rows}</div>` : ''}</div>`;
    }
    return html;
  }
  // A report sent in the last 48 hours for this client + period: it can be deleted from the Telegram group.
  const sentRec = (c) => dSent[`${c.id}|${dRange().join('|')}`] || null;
  function sentLine(c) {
    const r = sentRec(c); if (!r) return '';
    const t = new Date(r.at), when = t.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) + (t.toDateString() === new Date().toDateString() ? '' : ' ' + t.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }));
    return `<div class="dsent2"><span><b>✓ Report sent ${esc(when)}</b>${r.by ? ' by ' + esc(r.by) : ''}${r.to ? ` · <span class="hint">${esc(r.to)}</span>` : ''}</span><button type="button" class="danger sm" data-delrep="${c.id}" title="The bot removes its report from the Telegram group (possible for 48 hours after sending)">Delete from group</button></div>`;
  }
  document.addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-delrep]'); if (!b) return;
    const cid = Number(b.dataset.delrep), c = dData && dData.clients.find((x) => x.id === cid), r = c && sentRec(c);
    if (!r || !confirm(`Delete the report for ${c.name} · ${periodLabel()} from the Telegram group?${r.count > 1 ? ` (${r.count} messages)` : ''}`)) return;
    b.disabled = true; b.textContent = 'Deleting…';
    try {
      const [from, to] = dRange();
      const x = await api(`/client-report/${cid}/delete`, { method: 'POST', body: { from, to } });
      try { if (from === to && from === date && day && day.entries[cid]) { day.entries[cid].reportSent = null; refreshValues(); } } catch (_) { /* Home tab not loaded */ }
      if (x.failed && !x.deleted) toast('Telegram did not allow deleting it (older than 48 hours, or already deleted). Delete it in the group as an admin.');
      else successBadge(x.failed ? `Deleted ${x.deleted}, ${x.failed} could not be deleted` : 'Report deleted from the group');
      loadTodo(); loadDash();
    } catch (e) { toast(e.message); b.disabled = false; b.textContent = 'Delete from group'; }
  });
  // ---------- ✨ AI advice for one client (Claude) ----------
  let aiReady = null; const aiState = {};
  let aiLang = (() => { try { return localStorage.getItem('aiLang') || 'en'; } catch (_) { return 'en'; } })();
  api('/ai/status').then((x) => { aiReady = !!x.hasKey; }).catch(() => { aiReady = false; });
  const aiKey = (cid) => cid + '|' + dRange().join('|') + '|' + aiLang;
  // Light Markdown: headings, bullets, numbered lines, **bold**.
  function mdLite(t) {
    const out = []; let list = null;
    const inline = (x) => esc(x).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
    for (const raw of String(t || '').split('\n')) {
      const l = raw.trim();
      if (!l) { close(); continue; }
      let m;
      if ((m = l.match(/^#{1,4}\s+(.*)$/))) { close(); out.push(`<h4>${inline(m[1])}</h4>`); }
      else if ((m = l.match(/^[-*•]\s+(.*)$/))) { if (list !== 'ul') { close(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inline(m[1])}</li>`); }
      else if ((m = l.match(/^\d+[.)]\s+(.*)$/))) { if (list !== 'ol') { close(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inline(m[1])}</li>`); }
      else { close(); out.push(`<p>${inline(l)}</p>`); }
    }
    close(); return out.join('');
  }
  function aiBox(c) {
    const st = aiState[aiKey(c.id)]; if (!st) return '';
    const langBtns = `<div class="seg ai-lang" role="group" aria-label="Language"><button type="button" data-ailang="en" aria-pressed="${aiLang === 'en'}">EN</button><button type="button" data-ailang="km" aria-pressed="${aiLang === 'km'}">ខ្មែរ</button></div>`;
    const body = st.loading ? '<div class="ai-load"><span class="ai-dot"></span><span class="ai-dot"></span><span class="ai-dot"></span> Reading this client\'s numbers…</div>'
      : st.err ? `<div class="note">${esc(st.err)}</div>` : `<div class="ai-text">${mdLite(st.text)}</div>`;
    return `<div class="aibox" data-aicid="${c.id}"><div class="ai-h"><b>✨ AI advice</b><span class="hint">${esc(periodLabel())}${st.cached ? ' · saved answer' : ''}</span><span class="spacer"></span>${langBtns}<button type="button" class="ghost sm" data-airefresh="${c.id}" ${st.loading ? 'disabled' : ''}>↻ New answer</button><button type="button" class="ghost sm" data-aiclose="${c.id}" aria-label="Close AI advice">✕</button></div>${body}
      ${st.loading || st.err ? '' : `<form class="ai-ask" data-aiask="${c.id}"><input type="text" maxlength="300" placeholder="Ask about this client… e.g. Which live time works best?" aria-label="Ask about this client"><button type="submit" class="sm">Ask</button></form>`}</div>`;
  }
  async function runAi(cid, { fresh = false, question = '' } = {}) {
    const k = aiKey(cid), [from, to] = dRange();
    aiState[k] = { loading: true }; renderDash();
    try { const r = await api(`/ai/client/${cid}`, { method: 'POST', body: { from, to, lang: aiLang, fresh, question } }); aiState[k] = { text: r.text, cached: r.cached }; }
    catch (e) { aiState[k] = { err: e.message }; }
    renderDash();
    const box = document.querySelector(`.aibox[data-aicid="${cid}"]`); if (box && !calm && box.animate) box.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 320, easing: 'cubic-bezier(.22,1,.36,1)' });
  }
  document.addEventListener('click', (ev) => {
    const go = ev.target.closest('[data-aigo]'); if (go) { ev.stopPropagation(); if (aiReady === false) return toast(me && me.isOwner ? 'Add a Claude or Gemini key in Admin → Settings → AI advice first.' : 'AI advice is not set up yet — ask the app owner.'); const cid = Number(go.dataset.aigo); const st = aiState[aiKey(cid)]; if (st && !st.err) { delete aiState[aiKey(cid)]; renderDash(); return; } runAi(cid); return; }
    const rf = ev.target.closest('[data-airefresh]'); if (rf) { runAi(Number(rf.dataset.airefresh), { fresh: true }); return; }
    const cl = ev.target.closest('[data-aiclose]'); if (cl) { delete aiState[aiKey(Number(cl.dataset.aiclose))]; renderDash(); return; }
    const lg = ev.target.closest('[data-ailang]'); if (lg) { const box = lg.closest('[data-aicid]'); aiLang = lg.dataset.ailang; try { localStorage.setItem('aiLang', aiLang); } catch (_) {} if (box) runAi(Number(box.dataset.aicid)); return; }
  });
  document.addEventListener('submit', (ev) => {
    const f = ev.target.closest('[data-aiask]'); if (!f) return; ev.preventDefault();
    const q = f.querySelector('input').value.trim(); if (q) runAi(Number(f.dataset.aiask), { question: q });
  });
  function detailRow(c) {
    const days = dEntries[c.id] || {};
    let body = '';
    if (dMode === 'day') {
      const e = days[dDate] || {}, parts = dayParts(c, e);
      const pick = parts.length > 1 ? { cid: c.id, off: offSet(c.id, dDate) } : null; // ticks only make sense with 2+ lines
      if (pick) for (const k of [...pick.off]) if (!parts.some((p) => p.key === k)) pick.off.delete(k);
      body = (parts.length ? dayGroups(c, parts, pick) : '<div class="muted">No boost spend on this day.</div>')
        + (e.note ? `<div class="dnote">📝 ${esc(e.note)}</div>` : '')
        + (sentRec(c) ? '' : e.reportSent && e.reportSent.at ? `<div class="dsent">✓ Report sent ${new Date(e.reportSent.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}${e.reportSent.by ? ' by ' + esc(e.reportSent.by) : ''}</div>` : '');
    } else if (dMode === 'year') {
      const months = {};
      for (const d of Object.keys(days)) {
        const parts = dayParts(c, days[d]); if (!parts.length) continue;
        const m = months[d.slice(0, 7)] || (months[d.slice(0, 7)] = { live: 0, post: 0, lives: 0, days: 0, res: 0, resSpend: 0, type: '' });
        m.days++; for (const p of parts) { if (p.kind === 'live') { m.live += p.spend; m.lives++; } else m.post += p.spend; if (p.kind === 'post' && p.results !== undefined) m.resSpend += p.spend; if (p.kind === 'post' && p.results > 0) { m.res += p.results; m.type = mergeType(m.type, p.resultType); } }
      }
      const keys = Object.keys(months).sort().reverse();
      body = keys.length ? keys.map((ym) => { const m = months[ym];
        return `<div class="dl mrow"><span class="dl-n"><b>${esc(monthLabel(ym))}</b><span class="hint"> · ${m.days} day${m.days === 1 ? '' : 's'}${m.lives ? ` · ${m.lives} live${m.lives === 1 ? '' : 's'}` : ''}${m.post ? ` · posts ${money(m.post)}` : ''}</span>${m.res ? `<span class="dl-r">${esc(resText(m.res, m.type))} · <b class="num">${cprMoney(cpr(m.resSpend, m.res))}</b> each</span>` : ''}</span><span></span><span class="dl-v"><span class="muted">$</span><span class="box num">${(m.live + m.post).toFixed(2)}</span></span></div>`;
      }).join('') : '<div class="muted">No boost spend this year.</div>';
    } else {
      const list = Object.keys(days).sort().reverse().map((d) => ({ d, parts: dayParts(c, days[d]) })).filter((x) => x.parts.length);
      const many = list.reduce((a, x) => a + x.parts.length, 0) > 1; // ticks: leave a live or post of any day out of the report
      body = list.length ? list.map((x) => {
        const tot = x.parts.reduce((s2, p) => s2 + p.spend, 0), pick = many ? { cid: c.id, off: offSet(c.id, x.d), day: x.d } : null;
        return `<div class="dday"><div class="dday-h"><b>${esc(nice(x.d).replace(/ \d{4}$/, ''))}</b><span class="num">${money(tot)}</span></div>${x.parts.map((p) => partLine(p, pick)).join('')}</div>`;
      }).join('') : '<div class="muted">No boost spend in this period.</div>';
    }
    return `<tr class="dexp"><td colspan="9"><div class="dexp-in">${dMode === 'day' ? '' : pageBlock(c)}${body}${sentLine(c)}${aiBox(c)}${pagePick(c)}<div class="dexp-foot"><button type="button" class="aibtn" data-aigo="${c.id}">✨ AI advice</button><span class="spacer"></span><button class="primary${sentFlash && sentFlash.cid === c.id && Date.now() < sentFlash.until ? ' sent-ok' : ''}" data-dreport="${c.id}"><span class="plane"><svg class="pl" viewBox="0 0 24 24" aria-hidden="true"><path d="M21.5 11.2 3.4 3.1a.9.9 0 0 0-1.2 1.1L4.6 11 2.2 17.8a.9.9 0 0 0 1.2 1.1l18.1-8.1a.9.9 0 0 0 0-1.6Z" fill="currentColor"/><path d="M4.6 11h7" stroke="rgba(0,0,0,.25)" stroke-width="1.4" stroke-linecap="round"/></svg></span> Send ${dTypeF === 'post' ? 'post ' : dTypeF === 'live' ? 'live ' : ''}report · ${esc(periodLabel())}<span class="rlabel">${pickLabel(c)}${(() => { const l = reportPages(c), n = l.filter((p) => !skipSetOf(c.id).has(p.page)).length; return l.length > 1 && n < l.length ? ` · ${n} of ${l.length} Pages` : ''; })()}</span></button></div></div></td></tr>`;
  }

  // ---------- open / close motion ----------
  const ease = 'cubic-bezier(.22,1,.36,1)';
  const PLANE_SVG = `<svg class="pl" viewBox="0 0 24 24" aria-hidden="true"><path d="M21.5 11.2 3.4 3.1a.9.9 0 0 0-1.2 1.1L4.6 11 2.2 17.8a.9.9 0 0 0 1.2 1.1l18.1-8.1a.9.9 0 0 0 0-1.6Z" fill="currentColor"/><path d="M4.6 11h7" stroke="rgba(0,0,0,.25)" stroke-width="1.4" stroke-linecap="round"/></svg>`;
  // The breakdown unfolds, and each live / post line slides in one after another.
  function unfoldClient(id) {
    const tr = document.querySelector(`#dBody tr.drow[data-cid="${id}"]`), box = tr && tr.nextElementSibling && tr.nextElementSibling.querySelector('.dexp-in');
    if (!box || calm || !box.animate) return;
    const h = box.offsetHeight;
    box.style.overflow = 'hidden';
    const a = box.animate([{ height: '0px', opacity: 0 }, { height: h + 'px', opacity: 1 }], { duration: Math.min(620, 380 + h / 4), easing: ease });
    a.onfinish = a.oncancel = () => { box.style.overflow = ''; };
    const chev = tr.querySelector('.chev');
    if (chev) chev.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(90deg)' }], { duration: 380, easing: ease });
    tr.querySelectorAll('td').forEach((td) => td.animate([{ backgroundColor: 'transparent' }, {}], { duration: 380, easing: 'ease' }));
    [...box.querySelectorAll('.dl, .dday-h, .dnote, .dsent, .dexp-foot')].slice(0, 24).forEach((el, i) => el.animate(
      [{ opacity: 0, transform: 'translateY(8px) scale(.985)' }, { opacity: 1, transform: 'none' }],
      { duration: 460, delay: 40 + i * 40, easing: ease, fill: 'backwards' }));
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
      const N = 64, frames = []; let prev = null, turn = 0;
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
  const pop = (el) => { if (el && !calm && el.animate) el.animate([{ transform: 'scale(.4) rotate(-20deg)', opacity: 0 }, { transform: 'scale(1.15) rotate(4deg)', opacity: 1, offset: .6 }, { transform: 'none' }], { duration: 520, easing: ease }); };

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
    const chev = tr.querySelector('.chev');
    if (chev) chev.animate([{ transform: 'rotate(90deg)' }, { transform: 'rotate(0deg)' }], { duration: 340, easing: ease, fill: 'forwards' });
    const hh = box.offsetHeight;
    const a = box.animate([{ height: hh + 'px', opacity: 1 }, { height: '0px', opacity: 0 }], { duration: Math.min(460, 280 + hh / 6), easing: 'cubic-bezier(.65,0,.35,1)', fill: 'forwards' });
    a.onfinish = reopen; a.oncancel = reopen;
  }

  // 3) "Live now": today, a live started less than 2 hours ago.
  function liveNow(c) {
    if (dMode !== 'day' || dDate !== me.today) return false;
    const e = (dEntries[c.id] || {})[dDate] || {}, now = new Date(), mins = now.getHours() * 60 + now.getMinutes();
    return Object.values(e.lives || {}).some((l) => { if (!l || !(Number(l.spend) > 0) || !/^\d{1,2}:\d{2}$/.test(l.time || '')) return false; const [h, m] = l.time.split(':').map(Number), d = mins - (h * 60 + m); return d >= 0 && d <= 120; });
  }

  // Live / Post filter: show only that kind of spend (a client doing both keeps just that part).
  function kindDaySpend(c, e) {
    let live = 0, post = 0;
    if (hasL(c)) for (const l of Object.values(e.lives || {})) live += Number(l && l.spend) || 0;
    if (hasP(c)) post += Number((e.post || {}).spend) || 0;
    return { live, post };
  }
  function viewOf(c) {
    if (!dTypeF) return c;
    const days = Object.values(dEntries[c.id] || {}).filter((e) => kindDaySpend(c, e)[dTypeF] > 0.0049).length;
    if (dTypeF === 'live') return { ...c, spend: c.liveSpend, postSpend: 0, results: 0, resSpend: 0, days };
    return { ...c, spend: c.postSpend, liveSpend: 0, lives: 0, days };
  }
  let rowsKey = '';
  function renderDash() {
    if (!dData) return;
    const rk = `${dData.from}|${dData.to}|${dTypeF}`, rowsEnter = rk !== rowsKey; rowsKey = rk; // rows slide in only when the period changes
    $('dTableTitle').textContent = 'Clients · ' + periodLabel() + (dTypeF ? (dTypeF === 'live' ? ' · Live only' : ' · Boost posts only') : '');
    const q = $('dSearch').value.trim().toLowerCase(), idle = !$('dShowIdle').checked; // all clients by default
    let list = dData.clients.filter((c) => !dTypeF || (dTypeF === 'live' ? hasL(c) : hasP(c))).map(viewOf)
      .map((c) => ({ ...c, perDay: c.days ? c.spend / c.days : 0, cprV: cpr(c.resSpend, c.results) }))
      .filter((c) => !c.archived || c.spend > 0)
      .filter((c) => idle || c.spend > 0)
      .filter((c) => !q || [c.name, ...c.pages].some((x) => x.toLowerCase().includes(q)));
    const k = dSort.key, dir = dSort.asc ? 1 : -1;
    list.sort((a, b) => ((b.spend > 0) - (a.spend > 0)) || (k === 'name' ? a.name.localeCompare(b.name) * dir : k === 'cpr' ? ((a.cprV == null) - (b.cprV == null)) || (a.cprV - b.cprV) * dir : (a[k] - b[k]) * dir) || a.name.localeCompare(b.name));
    document.querySelectorAll('.dtable th[data-sort]').forEach((th) => { th.classList.toggle('sorted', th.dataset.sort === k); th.classList.toggle('asc', th.dataset.sort === k && dSort.asc); });

    const t = list.reduce((a, c) => ({ spend: a.spend + c.spend, live: a.live + c.liveSpend, post: a.post + c.postSpend, lives: a.lives + c.lives, active: a.active + (c.spend > 0 ? 1 : 0), posters: a.posters + (c.postSpend > 0 ? 1 : 0), res: a.res + (c.results || 0), resSpend: a.resSpend + (c.results > 0 ? c.resSpend : 0), type: c.results > 0 ? mergeType(a.type, c.resultType) : a.type }), { spend: 0, live: 0, post: 0, lives: 0, active: 0, posters: 0, res: 0, resSpend: 0, type: '' });
    const tCpr = cpr(t.resSpend, t.res);
    rollTo($('dSpend'), money(t.spend));
    $('dTax').textContent = t.spend && taxRate() ? `With tax ${taxRate()}%: ${money(withTax(t.spend))}` : '';
    rollTo($('dLive'), money(t.live)); $('dLives').textContent = `${t.lives} live${t.lives === 1 ? '' : 's'}`;
    rollTo($('dPost'), money(t.post)); $('dPosts').textContent = `${t.posters} client${t.posters === 1 ? '' : 's'} boosted posts`;
    rollTo($('dActive'), String(t.active)); $('dActiveSub').textContent = `of ${dData.clients.filter((c) => !c.archived).length} clients`;
    rollTo($('dCpr'), tCpr == null ? '–' : cprMoney(tCpr));
    $('dRes').textContent = t.res ? (t.type === 'result' ? `${Math.round(t.res).toLocaleString('en-US')} results (mixed types)` : resText(t.res, t.type)) : 'Sync from Meta to load results';

    const top = Math.max(0.01, ...list.map((c) => c.spend));
    const dash = '<span class="muted">–</span>';
    $('dBody').innerHTML = list.map((c, i) => {
      const share = t.spend ? c.spend / t.spend * 100 : 0, pg = pageNames(c);
      const tags = (hasL(c) ? (liveNow(c) ? '<span class="chip livenow" title="A live started in the last 2 hours">Live now</span>' : '<span class="chip live">Live</span>') : '') + (hasP(c) ? '<span class="chip post">Post</span>' : '');
      const open = dOpen.has(c.id);
      return `<tr data-cid="${c.id}" style="--i:${Math.min(i, 14)}" class="drow${rowsEnter ? ' enter' : ''}${open ? ' open' : ''}${c.spend > 0 ? '' : ' nospend'}" tabindex="0" aria-expanded="${open}">
        <td class="cname"><div class="nm"><span class="chev" aria-hidden="true">›</span><b>${esc(c.name)}</b>${tags}</div>${pageSplit(c) ? `<div class="pg pgmoney">${pageLine(c)}</div>` : pg ? `<div class="pg">${esc(pg)}</div>` : ''}</td>
        <td class="r num" data-l="Lives">${hasL(c) && c.lives ? c.lives : dash}</td>
        <td class="r num" data-l="Live">${c.liveSpend > 0 ? money(c.liveSpend) : dash}</td>
        <td class="r num" data-l="Post">${c.postSpend > 0 ? money(c.postSpend) : dash}</td>
        <td class="r num multi" data-l="Days">${c.days || dash}</td>
        <td class="r num multi" data-l="Per day">${c.days ? money(c.perDay) : dash}</td>
        <td class="r num cprc" data-l="Post cost / result">${c.cprV != null ? `<b>${cprMoney(c.cprV)}</b><div class="hint">${esc(resText(c.results, c.resultType))}</div>` : dash}</td>
        <td class="r num tot" data-l="Total"><b>${money(c.spend)}</b>${c.spend && taxRate() ? `<div class="hint">+tax ${money(withTax(c.spend))}</div>` : ''}</td>
        <td class="actc">${open ? '' : `<button class="rbtn${c.telegram ? ' tg' : ''}" data-report="${c.id}" title="${c.telegram ? 'Preview and send to the client\u2019s Telegram group' : 'No Telegram group yet \u2014 you can copy the report'}"><span class="plane"><svg class="pl" viewBox="0 0 24 24" aria-hidden="true"><path d="M21.5 11.2 3.4 3.1a.9.9 0 0 0-1.2 1.1L4.6 11 2.2 17.8a.9.9 0 0 0 1.2 1.1l18.1-8.1a.9.9 0 0 0 0-1.6Z" fill="currentColor"/><path d="M4.6 11h7" stroke="rgba(0,0,0,.25)" stroke-width="1.4" stroke-linecap="round"/></svg></span> Report</button>`}</td></tr>${open ? detailRow(c) : ''}`;
    }).join('') || `<tr><td colspan="9" class="empty-row">${dData.clients.length ? 'No client spend for this period.' : 'No clients yet. Add them in the Clients tab.'}</td></tr>`;
    $('dFoot').innerHTML = list.length > 1 ? `<tr><td>Total · ${list.length} clients</td><td class="r num" data-l="Lives">${t.lives}</td><td class="r num" data-l="Live">${money(t.live)}</td><td class="r num" data-l="Post">${money(t.post)}</td><td class="multi"></td><td class="multi"></td><td class="r num cprc" data-l="Post cost / result">${tCpr != null ? `<b>${cprMoney(tCpr)}</b><div class="hint">${t.type === 'result' ? Math.round(t.res).toLocaleString('en-US') + ' results' : esc(resText(t.res, t.type))}</div>` : ''}</td><td class="r num tot" data-l="Total"><b>${money(t.spend)}</b>${taxRate() ? `<div class="hint">+tax ${money(withTax(t.spend))}</div>` : ''}</td><td></td></tr>` : '';
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
      const [from, to] = dRange(), cid = Number(b.dataset.dreport);
      const lines = [...document.querySelectorAll(`#dBody .dl.pick[data-cid="${cid}"]`)], on = lines.filter((l) => !l.classList.contains('off')).map((l) => l.dataset.pick);
      if (lines.length && !on.length) return toast('Tick at least one line to send.');
      const c = dData.clients.find((x) => x.id === cid), pl = c ? reportPages(c) : [], skip = c ? skipList(c) : [];
      if (pl.length > 1 && pl.every((p) => skipSetOf(cid).has(p.page))) return toast('Tick at least one Page to send.');
      // One day: the ticked lines. Longer periods: the unticked lines of each day ('!day:key').
      const multi = lines.some((l) => l.dataset.day);
      const parts = !lines.length || on.length === lines.length ? null : multi ? lines.filter((l) => l.classList.contains('off')).map((l) => `!${l.dataset.day}:${l.dataset.pick}`) : on;
      openReportDlg({ kind: 'client', cid, from, to, label: periodLabel(), only: dTypeF, parts, skip: skip.length ? skip : null });
    });
    document.querySelectorAll('#dBody [data-report]').forEach((b) => b.onclick = () => {
      const [from, to] = dRange(); openReportDlg({ kind: 'client', cid: Number(b.dataset.report), from, to, label: periodLabel(), only: dTypeF });
    });

    // Daily chart for months and ranges, filtered to the visible clients.
    $('dChartPanel').hidden = dMode === 'day';
    if (dMode !== 'day') {
      const ids = new Set(list.map((c) => c.id));
      let days = dData.days.map((d) => ({ day: d.day, spend: dData.clients.filter((c) => ids.has(c.id)).reduce((s, c) => s + (dTypeF ? kindDaySpend(c, (dEntries[c.id] || {})[d.day] || {})[dTypeF] : (c.daily[d.day] || 0)), 0) }));
      if (dMode === 'year') { // one bar per month
        const by = {}; for (const d of days) by[d.day.slice(0, 7)] = (by[d.day.slice(0, 7)] || 0) + d.spend;
        const y = dDate.slice(0, 4);
        days = Array.from({ length: 12 }, (_, i) => { const ym = y + '-' + pad(i + 1); return { day: ym + '-01', ym, spend: by[ym] || 0 }; });
      }
      const max = Math.max(1, ...days.map((d) => d.spend));
      $('dChartTitle').textContent = dMode === 'year' ? 'Spend per month' : 'Spend per day';
      $('dChartHint').textContent = dMode === 'year' ? 'Tap a bar to see that month' : 'Tap a bar to see that day';
      const chartHtml = days.map((d, i) => `<button style="--i:${i}" class="col${(d.ym ? d.ym === me.today.slice(0, 7) : d.day === me.today) ? ' today' : ''}" data-day="${d.day}"  aria-label="${nice(d.day)}: ${money(d.spend)}"><span class="b" style="height:${Math.max(1, d.spend / max * 100)}%" data-tip="${esc(d.ym ? monthLabel(d.ym) : nice(d.day).replace(/ \d{4}$/, ''))} · ${money(d.spend)}"></span><span class="d">${d.ym ? parse(d.day).toLocaleDateString('en-GB', { month: 'short' }) : Number(d.day.slice(8))}</span></button>`).join('');
      if ($('dChart')._html !== chartHtml) { $('dChart').innerHTML = chartHtml; $('dChart')._html = chartHtml; }
      document.querySelectorAll('#dChart .col').forEach((b) => b.onclick = () => { dMode = dMode === 'year' ? 'month' : 'day'; dDate = b.dataset.day; loadDash(); });
    }
  }

  // ---------- report dialog (Home + Dashboard + team summary) ----------
  let ckTarget = null;
  async function openReportDlg(o) {
    const dlg = $('ckDlg'); ckTarget = o;
    $('ckTitle').textContent = 'Report'; $('ckTo').textContent = ''; $('ckPic').hidden = true; $('ckText').value = 'Loading…'; $('ckSend').disabled = true;
    if (typeof dlg.showModal === 'function') { if (!dlg.open) dlg.showModal(); } else dlg.setAttribute('open', '');
    const bot = me.telegram && me.telegram.bot;
    try {
      if (o.kind === 'client') {
        const r = await api(`/client-report/${o.cid}?from=${o.from}&to=${o.to}${o.only ? '&kind=' + o.only : ''}${o.parts ? '&parts=' + encodeURIComponent(o.parts.join(',')) : ''}${o.skip ? '&skip=' + encodeURIComponent(JSON.stringify(o.skip)) : ''}`);
        if (ckTarget !== o) return;
        $('ckTitle').textContent = `${r.client.name} · ${o.label}${o.only === 'post' ? ' · Boost posts only' : o.only === 'live' ? ' · Lives only' : ''}${o.parts ? ' · ticked only' : ''}${o.skip ? ' · some Pages left out' : ''}`;
        $('ckText').value = r.text;
        $('ckTo').textContent = !r.client.telegram ? 'No Telegram group for this client yet — copy the text, or pick a group in the Clients tab.'
          : !bot ? 'Telegram bot is not set up on the server, so you can only copy the text.'
          : `Sends to Telegram group: ${r.client.telegramTitle || r.client.telegram}`;
        $('ckSend').textContent = 'Send to Telegram';
        $('ckSend').disabled = !r.client.telegram || !bot;
        o.routes = r.routes || null; o.route = null; o.allText = r.text;
        if (o.routes) drawRoutes(o); else { $('ckRoutes').hidden = true; $('ckText').readOnly = false; loadReportPic(o); }
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
  // Pages with their own Telegram topic: send all (one report per topic) or pick one Page.
  function drawRoutes(o) {
    const bot = me.telegram && me.telegram.bot, rs = o.routes;
    $('ckRoutes').hidden = false;
    $('ckRoutes').innerHTML = `<button type="button" data-rt="" aria-pressed="${o.route == null}">Each Page → its topic (${rs.length})</button>` + rs.map((r, i) => `<button type="button" data-rt="${i + 1}" aria-pressed="${o.route === r.key}">${esc(r.label)}</button>`).join('');
    document.querySelectorAll('#ckRoutes [data-rt]').forEach((b) => b.onclick = () => { o.route = b.dataset.rt ? rs[Number(b.dataset.rt) - 1].key : null; drawRoutes(o); });
    const r = o.route != null && rs.find((x) => x.key === o.route);
    if (!rs.length) { $('ckText').value = o.allText; $('ckText').readOnly = true; $('ckTo').textContent = 'No boost spend to report.'; $('ckSend').disabled = true; $('ckPic').hidden = true; return; }
    if (!r) {
      $('ckText').value = rs.map((x) => `➜ ${x.chat ? x.title || 'Telegram' : 'No group — not sent'}\n${x.text}`).join('\n\n────────\n\n');
      $('ckText').readOnly = true;
      $('ckTo').textContent = `Sends ${rs.filter((x) => x.chat).length} report${rs.filter((x) => x.chat).length === 1 ? '' : 's'}, one to each Page's topic. Pick a Page above to edit its text.`;
      $('ckSend').disabled = !bot || !rs.some((x) => x.chat); $('ckSend').textContent = 'Send all';
      picOk = true; $('ckPic').hidden = false; $('ckImg').hidden = true; $('ckImgMsg').hidden = false; $('ckImgMsg').textContent = 'Each Page gets its own ads picture.'; $('ckWithImg').disabled = false; $('ckImgBox').classList.remove('loading');
    } else {
      $('ckText').value = r.text; $('ckText').readOnly = false;
      $('ckTo').textContent = r.chat ? `Sends to: ${r.title || r.chat}` : 'This part has no Telegram group yet — pick one in the Clients tab.';
      $('ckSend').disabled = !bot || !r.chat; $('ckSend').textContent = 'Send to Telegram';
      loadReportPic(o);
    }
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
  // The ads picture (a table of the client's ads, drawn by the server from Meta) sent with the report.
  let picOk = false, picUrl = null;
  async function loadReportPic(o, fresh = false) {
    picOk = false; $('ckPic').hidden = false; $('ckImg').hidden = true; $('ckImgMsg').hidden = false;
    $('ckImgMsg').textContent = 'Making the ads picture from Meta…'; $('ckImgBox').classList.add('loading');
    $('ckWithImg').disabled = true;
    try {
      const res = await fetch(`/api/client-report/${o.cid}/image?from=${o.from}&to=${o.to}${o.only ? '&kind=' + o.only : ''}${o.parts ? '&parts=' + encodeURIComponent(o.parts.join(',')) : ''}${o.skip ? '&skip=' + encodeURIComponent(JSON.stringify(o.skip)) : ''}${fresh ? '&fresh=1' : ''}${o.route != null ? '&page=' + encodeURIComponent(o.route) : ''}`);
      if (ckTarget !== o) return;
      if (res.status === 204) { $('ckImgMsg').textContent = 'No ads with spend in this period — the report goes as text only.'; return; }
      if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.error || 'Could not make the picture.'); }
      if (picUrl) URL.revokeObjectURL(picUrl);
      picUrl = URL.createObjectURL(await res.blob());
      $('ckImg').src = picUrl; $('ckImg').hidden = false; $('ckImgMsg').hidden = true; picOk = true; $('ckWithImg').disabled = false;
      if (!calm && $('ckImg').animate) $('ckImg').animate([{ opacity: 0, transform: 'scale(.98)' }, { opacity: 1, transform: 'none' }], { duration: 420, easing: 'cubic-bezier(.22,1,.36,1)' });
    } catch (e) { if (ckTarget === o) $('ckImgMsg').textContent = e.message + ' The report can still go as text.'; }
    finally { if (ckTarget === o) $('ckImgBox').classList.remove('loading'); }
  }
  $('ckImgRefresh').onclick = () => { if (ckTarget && ckTarget.kind === 'client' && !(ckTarget.routes && ckTarget.route == null)) loadReportPic(ckTarget, true); };
  $('ckImg').onclick = () => { if (picUrl) window.open(picUrl, '_blank'); };

  $('ckSend').onclick = async () => {
    const o = ckTarget; if (!o) return;
    const b = $('ckSend'); b.disabled = true; b.classList.add('busy');
    try {
      if (o.kind === 'client') {
        const r = await api(`/client-report/${o.cid}/send`, { method: 'POST', body: { from: o.from, to: o.to, text: $('ckText').value, withImage: picOk && $('ckWithImg').checked, kind: o.only || '', parts: o.parts || null, skip: o.skip || [], page: o.routes && o.route != null ? o.route : undefined } });
        if (o.from === o.to && o.from === date) { day.entries[o.cid] = merge(day.entries[o.cid] || {}, { reportSent: { at: r.sentAt, by: me.name } }); refreshValues(); }
        planeOff(b); $('ckDlg').close();
        successBadge('Sent to ' + r.sentTo);
        loadTodo();
        sentFlash = { cid: o.cid, until: Date.now() + 2600 };
        if (!$('tab-dashboard').hidden) { loadDash(); setTimeout(() => { if (dData) renderDash(); }, 2700); }
      } else { await api('/summary/send', { method: 'POST', body: { from: o.from, to: o.to, text: $('ckText').value } }); planeOff(b); $('ckDlg').close(); successBadge('Sent to the team group'); }
    } catch (e) { toast(e.message); } finally { b.disabled = false; b.classList.remove('busy'); }
  };

  // ---------- live videos ----------
  let lPreset = '7', lData = null, lShown = 20, lEnter = false; const lOpen = new Set();
  const OBJ = { OUTCOME_ENGAGEMENT: 'Engagement', OUTCOME_AWARENESS: 'Awareness', OUTCOME_TRAFFIC: 'Traffic', OUTCOME_LEADS: 'Leads', OUTCOME_SALES: 'Sales', OUTCOME_APP_PROMOTION: 'App promotion', MESSAGES: 'Messages', POST_ENGAGEMENT: 'Post engagement', VIDEO_VIEWS: 'Video views', REACH: 'Reach', BRAND_AWARENESS: 'Brand awareness', LINK_CLICKS: 'Traffic', CONVERSIONS: 'Conversions' };
  const GOAL = { CONVERSATIONS: 'Messages (conversations)', REPLIES: 'Messages', POST_ENGAGEMENT: 'Post engagement', THRUPLAY: 'ThruPlay', VIDEO_VIEWS: 'Video views', REACH: 'Reach', IMPRESSIONS: 'Impressions', LINK_CLICKS: 'Link clicks', LANDING_PAGE_VIEWS: 'Landing page views', PAGE_LIKES: 'Page likes', LEAD_GENERATION: 'Leads', OFFSITE_CONVERSIONS: 'Conversions' };
  const nice$ = (v) => '$' + (Math.round(v * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 });
  const dur = (m) => (m == null ? '' : m < 60 ? m + 'm' : Math.floor(m / 60) + 'h' + (m % 60 ? ' ' + (m % 60) + 'm' : ''));
  const num = (n) => Math.round(n).toLocaleString('en-US');
  const setupsOf = (l) => l.campaigns.map((c) => lData.setups[c.id]).filter(Boolean);
  const mainSetup = (l) => setupsOf(l)[0] || null;
  const lSig = (st) => { if (!st) return ''; const t = st.targeting || {}; return JSON.stringify([st.goal, t.gender, t.ageMin, t.ageMax, [...(t.places || [])].sort(), [...(t.interests || [])].sort(), [...(t.placements || [])].sort(), t.advantage]); };
  const ageTxt = (t) => (t.ageMin || t.ageMax ? `${t.ageMin || 18}–${t.ageMax && t.ageMax < 65 ? t.ageMax : '65+'}` : 'All ages');
  const setupName = (st) => { const t = st.targeting || {}; return `${t.gender === 'All' ? 'Everyone' : t.gender} ${ageTxt(t)} · ${(t.places || [])[0] || 'Anywhere'}`; };
  // "3 campaigns · $180 total · 2h 30m each"
  function budgetLine(sts) {
    if (!sts.length) return '';
    const life = sts.filter((x) => x.lifetimeBudget != null), daily = sts.filter((x) => x.dailyBudget != null && x.lifetimeBudget == null);
    const mins = [...new Set(sts.map((x) => x.minutes).filter((m) => m != null))].sort((a, b) => a - b);
    const parts = [sts.length + ' campaign' + (sts.length > 1 ? 's' : '')];
    if (life.length) parts.push(`${nice$(life.reduce((a, x) => a + x.lifetimeBudget, 0))} total budget`);
    if (daily.length) parts.push(`${nice$(daily.reduce((a, x) => a + x.dailyBudget, 0))}/day budget`);
    if (mins.length) parts.push(mins.length === 1 ? `runs ${dur(mins[0])}${sts.length > 1 ? ' each' : ''}` : `runs ${dur(mins[0])}–${dur(mins[mins.length - 1])}`);
    return parts.join(' · ');
  }
  const campBudget = (st) => (!st ? '' : st.lifetimeBudget != null ? `${nice$(st.lifetimeBudget)} budget` : st.dailyBudget != null ? `${nice$(st.dailyBudget)}/day` : '') + (st && st.minutes != null ? ` for ${dur(st.minutes)}` : '');
  const tags = (xs) => (xs && xs.length ? `<div class="tags">${xs.map((x) => `<i>${esc(x)}</i>`).join('')}</div>` : '<b class="muted">–</b>');
  function setupText(st, sts = [st]) {
    const t = st.targeting || {};
    return [`Objective: ${OBJ[st.objective] || st.objective || '–'}`, `Optimised for: ${GOAL[st.goal] || st.goal || '–'}`, `Budget & run time: ${budgetLine(sts)}`,
      `Location: ${(t.places || []).join(', ') || '–'}`, `Age: ${ageTxt(t)} · Gender: ${t.gender || 'All'}`, `Interests: ${(t.interests || []).join(', ') || 'None (broad)'}${t.advantage ? ' · Advantage+ audience on' : ''}`,
      `Placements: ${(t.placements || []).join(', ')}`].join('\n');
  }

  document.querySelectorAll('#lChips button').forEach((b) => b.onclick = () => { lPreset = b.dataset.p; lShown = 20; loadLives(); });
  $('lSort').onchange = () => { lShown = 20; renderLives(); fetchSetups(); };
  $('lClient').onchange = () => { lShown = 20; renderLives(); fetchSetups(); };
  $('lMore').onclick = () => { lShown += 20; lEnter = true; renderLives(); fetchSetups(); };
  async function loadLives() {
    document.querySelectorAll('#lChips button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.p === lPreset)));
    const [from, to] = aRange(lPreset);
    if (!lData) $('lList').innerHTML = '<div class="sk" style="--w:90%;height:90px"></div><div class="sk" style="--w:80%;height:90px"></div>';
    try {
      lData = await api(`/lives?from=${from}&to=${to}`);
      const cl = [...new Map(lData.lives.map((l) => [l.clientId, l.client])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
      const cur = $('lClient').value;
      $('lClient').innerHTML = '<option value="">All clients</option>' + cl.map(([id, n]) => `<option value="${id}"${String(id) === cur ? ' selected' : ''}>${esc(n)}</option>`).join('');
      lEnter = true; renderLives(); fetchSetups();
    } catch (e) { $('lList').innerHTML = `<div class="muted">${esc(e.message)}</div>`; }
  }
  function visibleLives() {
    const cid = $('lClient').value, k = $('lSort').value;
    const list = lData.lives.filter((l) => !cid || String(l.clientId) === cid);
    const cmp = { comments: (a, b) => (b.comments ?? -1) - (a.comments ?? -1), messages: (a, b) => (b.messages ?? -1) - (a.messages ?? -1), spend: (a, b) => b.spend - a.spend,
      cpc: (a, b) => (a.perComment == null) - (b.perComment == null) || (a.perComment - b.perComment), new: (a, b) => (b.day + b.time).localeCompare(a.day + a.time) }[k];
    return list.sort((a, b) => cmp(a, b) || b.spend - a.spend);
  }
  // Load how each shown live was boosted (Meta is only asked once per campaign; after that it's saved).
  let lFetching = false;
  async function fetchSetups() {
    if (!lData || lFetching) return;
    const need = visibleLives().slice(0, lShown).flatMap((l) => l.campaigns).filter((c) => c.id && c.accountId && !lData.setups[c.id] && !c.tried);
    if (!need.length) return;
    need.forEach((c) => { c.tried = true; });
    lFetching = true; const my = lData;
    try { const got = await api('/lives/setups', { method: 'POST', body: { campaigns: need.map((c) => ({ id: c.id, accountId: c.accountId })) } }); if (my === lData) { Object.assign(lData.setups, got); renderLives(); } }
    catch (e) { toast(e.message); }
    finally { lFetching = false; }
  }
  function renderLives() {
    const all = visibleLives(), list = all.slice(0, lShown);
    const withC = all.filter((l) => l.comments != null);
    const T = all.reduce((a, l) => ({ spend: a.spend + l.spend, comments: a.comments + (l.comments || 0), messages: a.messages + (l.messages || 0), cSpend: a.cSpend + (l.comments != null ? l.spend : 0) }), { spend: 0, comments: 0, messages: 0, cSpend: 0 });
    rollTo($('lCount'), String(all.length)); $('lCountSub').textContent = `from ${new Set(all.map((l) => l.clientId)).size} client${new Set(all.map((l) => l.clientId)).size === 1 ? '' : 's'}`;
    rollTo($('lComments'), num(T.comments)); rollTo($('lCpc'), T.comments ? '$' + (T.cSpend / T.comments).toFixed(2) : '–');
    rollTo($('lMsgs'), num(T.messages)); $('lMsgSub').textContent = T.messages ? `$${(T.cSpend / T.messages).toFixed(2)} per message` : 'from boosts';
    rollTo($('lSpend'), money(T.spend)); $('lSpendSub').textContent = all.length ? `${money(T.spend / all.length)} per live` : '';
    $('lTitle').textContent = `Live videos · ${{ comments: 'most comments', cpc: 'cheapest per comment', messages: 'most messages', spend: 'most spend', new: 'newest' }[$('lSort').value]}`;
    const missing = all.length - withC.length;
    $('lNote').hidden = !missing;
    $('lNote').textContent = missing ? `${missing} live${missing === 1 ? ' has' : 's have'} no comment counts yet — tap Sync from Meta on the Dashboard (use Custom for older dates) to load them.` : '';
    const most = withC.length ? withC.reduce((a, b) => (b.comments > a.comments ? b : a)) : null;
    const cheap = withC.filter((l) => l.comments >= 20).reduce((a, b) => (!a || b.perComment < a.perComment ? b : a), null);
    $('lList').innerHTML = list.map((l, i) => {
      const st = mainSetup(l), open = lOpen.has(l.key), thumb = setupsOf(l).map((x) => x.thumb).find(Boolean);
      const badges = (l === most && l.comments ? '<span class="badge">🏆 Most comments</span>' : '') + (l === cheap ? '<span class="badge g">Cheapest</span>' : '');
      const text = setupsOf(l).map((x) => x.text).find(Boolean);
      const stat = (lbl, v, hi) => `<div class="st${hi ? ' hi' : ''}"><span>${lbl}</span><b class="num">${v}</b></div>`;
      const nd = '<span class="muted" title="Sync from Meta to load">–</span>';
      return `<div class="lv${lEnter ? ' enter' : ''}${i === 0 && l.comments ? ' top' : ''}${open ? ' open' : ''}" data-lk="${esc(l.key)}" style="--i:${i}">
        <div class="rank">${i + 1}</div>
        <div class="thumb">${thumb ? `<img src="${esc(thumb)}" alt="" loading="lazy" onerror="this.remove()">` : ''}<span class="lb">LIVE</span><span class="rk">#${i + 1}</span>${st && st.minutes != null ? `<span class="dur">${dur(st.minutes)}</span>` : ''}</div>
        <div class="lv-t"><b>${esc(l.client)}</b>${badges}
          <div class="meta">${text ? `“${esc(text.length > 70 ? text.slice(0, 70) + '…' : text)}” · ` : ''}${esc(nice(l.day).replace(/ \d{4}$/, ''))}${l.time ? ', ' + esc(l.time) : ''}${l.page && l.page !== l.client ? ' · ' + esc(l.page) : ''}</div>
          <div class="stats">${stat('Comments', l.comments == null ? nd : num(l.comments), 1)}${stat('Messages', l.messages == null ? nd : num(l.messages))}${stat('Boost spend', money(l.spend))}${stat('Per comment', l.perComment != null ? '$' + l.perComment.toFixed(l.perComment < 0.1 ? 3 : 2) : nd, 1)}${stat('Campaigns', l.campaigns.length)}</div>
        </div>
        <div class="lv-a">${st ? `<button class="primary" data-lsave="${esc(l.key)}"${lData.saved.some((x) => x.sig === lSig(st)) ? ' disabled' : ''}>${lData.saved.some((x) => x.sig === lSig(st)) ? '✓ Saved' : '★ Save setup'}</button>` : ''}<button data-ltog="${esc(l.key)}">${open ? 'Hide setup ▴' : 'Show setup ▾'}</button></div>
        ${open ? liveSetup(l) : ''}
      </div>`;
    }).join('') || `<div class="empty-row">No boosted lives in this period${$('lClient').value ? ' for this client' : ''}.</div>`;
    lEnter = false;
    $('lMore').hidden = all.length <= lShown;
    document.querySelectorAll('#lList [data-ltog]').forEach((b) => b.onclick = () => {
      const k = b.dataset.ltog; if (lOpen.has(k)) lOpen.delete(k); else lOpen.add(k);
      renderLives();
      const box = document.querySelector(`#lList .lv[data-lk="${CSS.escape(k)}"] .setup`);
      if (box && !calm) { const h = box.offsetHeight; box.style.overflow = 'hidden'; const a = box.animate([{ height: '0px', opacity: 0 }, { height: h + 'px', opacity: 1 }], { duration: 420, easing: 'cubic-bezier(.22,1,.36,1)' }); a.onfinish = () => { box.style.overflow = ''; }; }
    });
    document.querySelectorAll('#lList [data-lsave]').forEach((b) => b.onclick = async () => {
      const l = lData.lives.find((x) => x.key === b.dataset.lsave), st = mainSetup(l); if (!st) return;
      const name = prompt('Name this setup', setupName(st)); if (name === null) return;
      try {
        lData.saved = await api('/live-setups', { method: 'POST', body: { name: name.trim() || setupName(st), sig: lSig(st), setup: { ...st, budgetLine: budgetLine(setupsOf(l)) }, from: { client: l.client, day: l.day, time: l.time } } });
        renderLives(); successBadge('Setup saved');
      } catch (e) { toast(e.message); }
    });
    renderSaved();
  }
  function liveSetup(l) {
    const sts = setupsOf(l), st = sts[0];
    if (!st) return `<div class="setup"><div class="muted" style="grid-column:1/-1">${l.campaigns.some((c) => !c.accountId || !c.id) ? 'This live was synced before setups were saved. Sync this day again from the Dashboard to load it.' : 'Loading how this live was boosted…'}</div></div>`;
    const t = st.targeting || {};
    const kv = (k, v) => `<div class="kv"><span>${k}</span>${v}</div>`;
    return `<div class="setup">
      <h3>How this live was boosted <button class="ghost sm" data-lcopy="${esc(l.key)}">Copy setup</button></h3>
      ${kv('Objective', `<b>${esc(OBJ[st.objective] || st.objective || '–')}</b>`)}
      ${kv('Optimised for', `<b>${esc(GOAL[st.goal] || st.goal || '–')}</b>`)}
      ${kv('Budget & run time', `<b>${esc(budgetLine(sts))}</b>`)}
      ${kv('Location', tags(t.places))}
      ${kv('Age · Gender', `<b>${esc(ageTxt(t))} · ${esc(t.gender || 'All')}</b>`)}
      ${kv('Placements', tags(t.placements))}
      ${kv('Interests', (t.interests || []).length ? tags(t.interests) : `<b>None — broad audience${t.advantage ? ' (Advantage+ audience)' : ''}</b>`)}
      ${(t.customAudiences || []).length ? kv('Custom audiences', tags(t.customAudiences)) : ''}
      <div class="camps">${l.campaigns.map((c) => { const s2 = lData.setups[c.id]; return `<div><b>${esc(c.time || '–')}</b> · ${esc(campBudget(s2) || 'budget –')} · spent ${money(c.spend)}${c.comments != null ? ` · ${num(c.comments)} comments` : ''}</div>`; }).join('')}</div>
    </div>`;
  }
  document.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-lcopy]'); if (!b || !lData) return;
    const l = lData.lives.find((x) => x.key === b.dataset.lcopy), sts = l && setupsOf(l); if (!sts || !sts.length) return;
    navigator.clipboard.writeText(setupText(sts[0], sts)).then(() => toast('Setup copied'), () => toast('Could not copy'));
  });
  function renderSaved() {
    const saved = lData.saved || [];
    const bySig = {};
    for (const l of lData.lives) { const st = mainSetup(l); if (!st) continue; const k = lSig(st); (bySig[k] = bySig[k] || []).push(l); }
    $('lSaved').innerHTML = saved.map((x) => {
      const ls = (bySig[x.sig] || []).filter((l) => l.comments != null), c = ls.reduce((a, l) => a + l.comments, 0), sp = ls.reduce((a, l) => a + l.spend, 0);
      const t = x.setup.targeting || {};
      return `<div class="tp"><b>★ ${esc(x.name)}</b>
        <span class="muted">${esc(GOAL[x.setup.goal] || x.setup.goal || '')}${x.setup.budgetLine ? ' · ' + esc(x.setup.budgetLine) : ''}</span>
        <span class="muted">${esc(ageTxt(t))} · ${esc(t.gender || 'All')} · ${esc((t.places || []).slice(0, 2).join(', ') || 'Anywhere')}${(t.interests || []).length ? ` · ${t.interests.length} interest${t.interests.length === 1 ? '' : 's'}` : ' · broad'}</span>
        <span class="muted">${ls.length ? `Used on <b>${ls.length} live${ls.length === 1 ? '' : 's'}</b> this period · avg <b style="color:var(--brand)">${c ? '$' + (sp / c).toFixed(2) + ' / comment' : 'no comments'}</b>` : 'Not used on a live in this period'}${x.from ? ` · saved from ${esc(x.from.client)}` : ''}</span>
        <div class="tp-a"><button data-scopy="${x.id}">Copy setup</button><button class="ghost" data-sdel="${x.id}" aria-label="Remove">Remove</button></div></div>`;
    }).join('') || '<div class="hint">No saved setups yet.</div>';
    document.querySelectorAll('#lSaved [data-scopy]').forEach((b) => b.onclick = () => { const x = saved.find((y) => y.id === b.dataset.scopy); navigator.clipboard.writeText(`${x.name}\n` + setupText(x.setup).replace(/Budget & run time: .*/, 'Budget & run time: ' + (x.setup.budgetLine || '–'))).then(() => toast('Setup copied'), () => toast('Could not copy')); });
    document.querySelectorAll('#lSaved [data-sdel]').forEach((b) => b.onclick = async () => { if (!confirm('Remove this saved setup?')) return; lData.saved = await api('/live-setups/' + b.dataset.sdel, { method: 'DELETE' }); renderLives(); });
  }

  // ---------- payments: service fees + invoices ----------
  let payMonth = null, payData = null, payEnter = true;
  const DEF_DESC = 'សេវាកម្មគ្រប់គ្រង Page';
  const dlgOpen = (d) => { if (typeof d.showModal === 'function') { if (!d.open) d.showModal(); } else d.setAttribute('open', ''); };
  const dueDate = (c, ym) => `${ym}-${pad(Math.min(c.service.day || 1, lastDay(ym)))}`;
  const hasSvc = (c) => c.service && Number(c.service.price) > 0;
  $('payPrev').onclick = () => { const d = parse(payMonth + '-01'); d.setMonth(d.getMonth() - 1); payMonth = iso(d).slice(0, 7); payEnter = true; loadPayments(); };
  $('payNext').onclick = () => { const d = parse(payMonth + '-01'); d.setMonth(d.getMonth() + 1); payMonth = iso(d).slice(0, 7); payEnter = true; loadPayments(); };
  $('paySearch').oninput = () => renderPayments();
  async function loadPayments() {
    if (!payMonth) payMonth = me.today.slice(0, 7);
    $('payMonth').textContent = monthLabel(payMonth);
    if (!payData) $('payList').innerHTML = '<div class="sk" style="--w:92%;height:64px"></div><div class="sk" style="--w:84%;height:64px"></div>';
    try { payData = await api('/payments?month=' + payMonth); renderPayments(); }
    catch (e) { $('payList').innerHTML = `<div class="muted">${esc(e.message)}</div>`; }
  }
  function renderPayments() {
    const d = payData; if (!d) return;
    const q = $('paySearch').value.trim().toLowerCase(), ym = d.month, cur = ym === d.today.slice(0, 7);
    const invOf = (c) => d.invoices.filter((i) => i.clientId === c.id);
    const svc = d.clients.filter(hasSvc).filter((c) => !q || [c.name, c.service.company || '', ...c.pages].some((x) => x.toLowerCase().includes(q)))
      .sort((a, b) => dueDate(a, ym).localeCompare(dueDate(b, ym)) || a.name.localeCompare(b.name));
    const exp = svc.reduce((a, c) => a + Number(c.service.price), 0), inv = d.invoices.reduce((a, i) => a + i.total, 0), paid = d.invoices.filter((i) => i.paidAt).reduce((a, i) => a + i.total, 0);
    rollTo($('payExp'), money(exp)); $('payExpSub').textContent = `${svc.length} client${svc.length === 1 ? '' : 's'}`;
    rollTo($('payInv'), money(inv)); $('payInvSub').textContent = `${d.invoices.length} invoice${d.invoices.length === 1 ? '' : 's'}`;
    rollTo($('payPaid'), money(paid)); $('payPaidSub').textContent = `${d.invoices.filter((i) => i.paidAt).length} paid`;
    rollTo($('payDue'), money(Math.max(0, inv - paid))); $('payDueSub').textContent = `${d.invoices.filter((i) => !i.paidAt).length} waiting`;
    $('payTitle').textContent = 'Service clients · ' + monthLabel(ym);
    const plane = '<svg class="pl" viewBox="0 0 24 24" aria-hidden="true"><path d="M21.5 11.2 3.4 3.1a.9.9 0 0 0-1.2 1.1L4.6 11 2.2 17.8a.9.9 0 0 0 1.2 1.1l18.1-8.1a.9.9 0 0 0 0-1.6Z" fill="currentColor"/></svg>';
    const invRow = (v, c) => `<div class="payinv" data-inv="${v.id}">
          <button type="button" class="invno" data-view="${v.id}" title="Open this invoice"><b>${esc(v.number)}</b><span class="hint">${esc(nice(v.date).replace(/ \d{4}$/, ''))} · ${money(v.total)}${v.paidAt ? ' · paid' : v.sentAt ? ' · sent' : ''}</span></button>
          <span class="spacer"></span>
          <a class="btn sm" href="/api/invoices/${v.id}/pdf" target="_blank" rel="noopener">PDF</a>
          <button type="button" class="sm rbtn${c && c.telegram ? ' tg' : ''}" data-send="${v.id}"><span class="plane">${plane}</span> ${v.sentAt ? 'Send again' : 'Send to group'}</button>
          ${d.tgSent && d.tgSent[v.id] ? `<button type="button" class="sm danger" data-unsend="${v.id}" title="The bot removes this invoice from the Telegram group (possible for 48 hours after sending)">Delete from group</button>` : ''}
          <button type="button" class="sm${v.paidAt ? ' paidbtn' : ''}" data-paid="${v.id}" data-on="${v.paidAt ? 1 : 0}">${v.paidAt ? '✓ Paid' : 'Mark paid'}</button>
          <button type="button" class="sm ghost" data-delinv="${v.id}" aria-label="Delete invoice ${esc(v.number)}">Delete</button></div>`;
    // Invoices whose client no longer has a service fee (or was removed): still shown, so they can be deleted or marked paid.
    const svcIds = new Set(d.clients.filter(hasSvc).map((c) => c.id)), loose = {};
    for (const v of d.invoices) if (!svcIds.has(v.clientId)) (loose[v.clientId] = loose[v.clientId] || []).push(v);
    const looseHtml = q ? '' : Object.entries(loose).map(([id, list]) => { const c = d.clients.find((x) => x.id === Number(id)); return `<div class="payrow"><div class="payrow-top"><div class="payname"><b>${esc(c ? c.name : 'Removed client')}</b><span class="hint">Service fee removed — delete the invoice if it is no longer needed</span></div></div>${list.map((v) => invRow(v, c)).join('')}</div>`; }).join('');
    $('payList').innerHTML = svc.map((c, i) => {
      const due = dueDate(c, ym), list = invOf(c), last = list[0];
      const days = Math.round((parse(due) - parse(d.today)) / 864e5);
      let st = '', cls = '';
      if (last && last.paidAt) { st = 'Paid'; cls = 'ok'; }
      else if (last && last.sentAt) { st = 'Sent · not paid'; cls = 'warn'; }
      else if (last) { st = 'Invoice ready'; cls = 'info'; }
      else if (cur) { st = days > 0 ? `Due in ${days} day${days === 1 ? '' : 's'}` : days === 0 ? 'Due today' : `Overdue ${-days} day${days === -1 ? '' : 's'}`; cls = days > 3 ? '' : days >= 0 ? 'warn' : 'bad'; }
      else st = 'No invoice';
      const invs = list.map((v) => invRow(v, c)).join('');
      return `<div class="payrow${payEnter ? ' enter' : ''}" style="--i:${i}">
        <div class="payrow-top">
          <button type="button" class="payname" data-svc="${c.id}" title="Edit service fee"><b>${esc(c.name)}</b><span class="hint">${esc(c.service.company || c.pages[0] || '')}${c.service.description ? ' · ' + esc(c.service.description) : ''}</span></button>
          <div class="paydate"><span>Pay date</span><b class="num">${esc(parse(due).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }))}</b></div>
          <div class="payprice"><span>Price</span><b class="num">${money(c.service.price)}</b></div>
          <span class="paystat ${cls}">${esc(st)}</span>
          <button type="button" class="${last ? '' : 'primary'}" data-newinv="${c.id}">${last ? '+ New invoice' : 'Create invoice'}</button>
        </div>${invs}</div>`;
    }).join('') + looseHtml || `<div class="empty-row">${d.clients.some(hasSvc) ? 'No client matches your search.' : 'No service clients yet. Add a price and pay date to a client below.'}</div>`;
    payEnter = false;
    const others = d.clients.filter((c) => !hasSvc(c));
    $('payOtherPanel').hidden = !others.length;
    $('payOther').innerHTML = others.map((c) => `<button type="button" data-svc="${c.id}">+ ${esc(c.name)}</button>`).join('');
    document.querySelectorAll('#tab-payments [data-svc]').forEach((b) => b.onclick = () => openSvc(Number(b.dataset.svc)));
    document.querySelectorAll('#payList [data-newinv]').forEach((b) => b.onclick = () => openInvoice(payData.clients.find((c) => c.id === Number(b.dataset.newinv)), null));
    document.querySelectorAll('#payList [data-view]').forEach((b) => b.onclick = () => { const v = payData.invoices.find((x) => x.id === Number(b.dataset.view)); openInvoice(payData.clients.find((c) => c.id === v.clientId), v); });
    document.querySelectorAll('#payList [data-send]').forEach((b) => b.onclick = () => sendInvoice(Number(b.dataset.send), b));
    document.querySelectorAll('#payList [data-paid]').forEach((b) => b.onclick = async () => { try { await api('/invoices/' + b.dataset.paid, { method: 'PATCH', body: { paid: b.dataset.on !== '1' } }); if (b.dataset.on !== '1') { successBadge('Marked as paid'); if (typeof confetti === 'function') confetti(b); } loadPayments(); } catch (e) { toast(e.message); } });
    document.querySelectorAll('#payList [data-unsend]').forEach((b) => b.onclick = async () => {
      const v = payData.invoices.find((x) => x.id === Number(b.dataset.unsend));
      if (!confirm(`Delete invoice ${v ? v.number : ''} from the Telegram group? The invoice stays in Boost Desk.`)) return;
      b.disabled = true; b.textContent = 'Deleting…';
      try {
        const x = await api(`/invoices/${b.dataset.unsend}/unsend`, { method: 'POST' });
        if (x.failed && !x.deleted) toast('Telegram did not allow deleting it (older than 48 hours, or already deleted). Delete it in the group as an admin.');
        else successBadge('Invoice deleted from the group');
        loadPayments();
      } catch (e) { toast(e.message); b.disabled = false; b.textContent = 'Delete from group'; }
    });
    document.querySelectorAll('#payList [data-delinv]').forEach((b) => b.onclick = async () => {
      if (!confirm('Delete this invoice? Its number will not be used again.')) return;
      try {
        if (payData.tgSent && payData.tgSent[b.dataset.delinv] && confirm('It was sent to the Telegram group. Delete it from the group too?')) await api(`/invoices/${b.dataset.delinv}/unsend`, { method: 'POST' }).catch(() => {});
        await api('/invoices/' + b.dataset.delinv, { method: 'DELETE' }); loadPayments();
      } catch (e) { toast(e.message); }
    });
  }
  async function sendInvoice(id, btn) {
    const v = payData.invoices.find((x) => x.id === id), c = v && payData.clients.find((x) => x.id === v.clientId);
    if (c && !c.telegram) return toast(`${c.name} has no Telegram group yet. Pick one in the Clients tab.`);
    if (!payData.bot) return toast('Telegram bot is not set up on the server (TELEGRAM_BOT_TOKEN).');
    if (btn) { btn.disabled = true; btn.classList.add('busy'); }
    try { const r = await api(`/invoices/${id}/send`, { method: 'POST' }); if (btn && typeof planeOff === 'function') planeOff(btn); successBadge('Invoice sent to ' + r.sentTo); loadPayments(); return true; }
    catch (e) { toast(e.message); return false; }
    finally { if (btn) { btn.disabled = false; btn.classList.remove('busy'); } }
  }

  // service fee per client
  let svcId = null;
  function openSvc(id) {
    const c = payData.clients.find((x) => x.id === id), v = c.service || {}; svcId = id;
    $('svcTitle').textContent = `Service fee · ${c.name}`;
    $('svcPrice').value = v.price || ''; $('svcDay').value = v.day || ''; $('svcDesc').value = v.description || (hasSvc(c) ? '' : DEF_DESC);
    $('svcCustomer').value = v.customer || c.name; $('svcCompany').value = v.company || c.pages.find((p) => !/^\d{6,}$/.test(p) && p !== c.name) || ''; $('svcPhone').value = v.phone || '';
    $('svcRemove').hidden = !hasSvc(c);
    dlgOpen($('svcDlg')); setTimeout(() => $('svcPrice').focus(), 60);
  }
  async function saveSvc(remove) {
    const price = remove ? 0 : Number($('svcPrice').value) || 0, day = parseInt($('svcDay').value, 10) || 0;
    if (!remove && !(price > 0)) return toast('Type the price.');
    if (!remove && !(day >= 1 && day <= 31)) return toast('Type the pay date as a day from 1 to 31.');
    try {
      await api('/clients/' + svcId, { method: 'PATCH', body: { service: { price, day, description: $('svcDesc').value, customer: $('svcCustomer').value, company: $('svcCompany').value, phone: $('svcPhone').value } } });
      $('svcDlg').close(); successBadge(remove ? 'Service fee removed' : 'Service fee saved'); loadPayments();
    } catch (e) { toast(e.message); }
  }
  $('svcSave').onclick = () => saveSvc(false);
  $('svcRemove').onclick = () => { if (confirm('Remove the service fee from this client? Existing invoices stay.')) saveSvc(true); };

  // invoice: create (editable, live preview) or view (saved)
  let invClient = null, invSaved = null, invPrevUrl = null, invTimer = null;
  const itemRow = (it = {}) => `<div class="invitem"><input type="text" class="i-d" maxlength="160" placeholder="Description" value="${esc(it.description || '')}"><input type="number" class="i-q" min="0" step="1" inputmode="numeric" value="${it.qty == null ? 1 : it.qty}"><input type="number" class="i-p" min="0" step="0.01" inputmode="decimal" value="${it.price || ''}"><button type="button" class="ghost sm i-x" aria-label="Remove line">✕</button></div>`;
  function invBody() {
    const items = [...document.querySelectorAll('#invItems .invitem')].map((r) => ({ description: r.querySelector('.i-d').value.trim(), qty: Number(r.querySelector('.i-q').value) || 0, price: Number(r.querySelector('.i-p').value) || 0 })).filter((it) => it.description || it.price);
    return { clientId: invClient.id, number: $('invNumber').value.trim(), date: $('invDate').value, customer: $('invCustomer').value, company: $('invCompany').value, phone: $('invPhone').value, items, discount: Number($('invDiscount').value) || 0 };
  }
  function invRecalc() {
    const b = invBody(), sub = b.items.reduce((a, it) => a + it.qty * it.price, 0);
    $('invTotal').textContent = money(Math.max(0, sub - Math.min(sub, b.discount)));
    $('invAdd').hidden = !!invSaved || document.querySelectorAll('#invItems .invitem').length >= 6;
    if (invSaved) return;
    clearTimeout(invTimer); invTimer = setTimeout(invPreview, 450);
  }
  async function invPreview() {
    const my = invSaved || invClient; $('invPrevBox').classList.add('loading');
    try {
      const res = invSaved ? await fetch(`/api/invoices/${invSaved.id}/png`) : await fetch('/api/invoices/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(invBody()) });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || 'Could not draw the invoice.'); }
      const url = URL.createObjectURL(await res.blob());
      if (my !== (invSaved || invClient)) return URL.revokeObjectURL(url);
      if (invPrevUrl) URL.revokeObjectURL(invPrevUrl); invPrevUrl = url;
      $('invPrev').src = url; $('invPrev').hidden = false; $('invPrevMsg').hidden = true;
    } catch (e) { $('invPrev').hidden = true; $('invPrevMsg').hidden = false; $('invPrevMsg').textContent = e.message; }
    finally { $('invPrevBox').classList.remove('loading'); }
  }
  function invFooter() {
    const f = $('invFoot');
    if (!invSaved) { f.innerHTML = '<span class="hint">The preview updates as you type. You can change the invoice number.</span><span class="spacer"></span><button type="button" class="primary" id="invCreate">Create invoice</button>'; $('invCreate').onclick = createInvoice; return; }
    const v = invSaved;
    f.innerHTML = `<span class="hint">${v.paidAt ? 'Paid.' : v.sentAt ? 'Sent to the group as a picture.' : 'Created — not sent yet.'}</span><span class="spacer"></span><a class="btn" href="/api/invoices/${v.id}/pdf?download=1">Download PDF</a><a class="btn" href="/api/invoices/${v.id}/pdf" target="_blank" rel="noopener">Open PDF</a><button type="button" class="primary" id="invSend">${v.sentAt ? 'Send again' : 'Send to group'}</button>`;
    $('invSend').onclick = async () => { if (await sendInvoice(v.id, $('invSend'))) $('invDlg').close(); };
  }
  function openInvoice(c, saved) {
    invClient = c; invSaved = saved || null;
    const v = saved || {}, s2 = c.service || {};
    $('invTitle').textContent = saved ? `Invoice ${saved.number}` : `New invoice · ${c.name}`;
    $('invSub').textContent = c.telegram ? `Sends to Telegram group: ${c.telegramTitle || c.telegram}` : 'No Telegram group for this client yet — you can still download the PDF.';
    const due = payData && payMonth !== payData.today.slice(0, 7) ? dueDate(c, payMonth) : (payData ? payData.today : me.today);
    $('invDate').value = v.date || due; $('invCustomer').value = v.customer || s2.customer || c.name; $('invCompany').value = v.company != null && saved ? v.company : (s2.company || ''); $('invPhone').value = v.phone != null && saved ? v.phone : (s2.phone || '');
    $('invItems').innerHTML = (saved ? v.items : [{ description: s2.description || DEF_DESC, qty: 1, price: s2.price || '' }]).map(itemRow).join('');
    $('invDiscount').value = v.discount || '';
    $('invForm').querySelectorAll('input, button').forEach((el) => { el.disabled = !!saved; });
    // The invoice number can always be changed: before creating, and on a saved invoice.
    $('invNumber').disabled = false; $('invNumber').value = saved ? saved.number : ''; $('invNumber').dataset.auto = '';
    if (!saved) api('/invoice-next?date=' + $('invDate').value).then((n) => { if (invClient === c && !invSaved && !$('invNumber').value) { $('invNumber').value = n.number; $('invNumber').dataset.auto = n.number; invPreview(); } }).catch(() => {});
    $('invPrev').hidden = true; $('invPrevMsg').hidden = false; $('invPrevMsg').textContent = 'Drawing the invoice…';
    invFooter(); dlgOpen($('invDlg')); invRecalc(); invPreview();
  }
  $('invForm').addEventListener('input', invRecalc);
  // Changing the number of a saved invoice: saved when you leave the box or press Enter.
  async function saveInvNumber() {
    if (!invSaved) return; const n = $('invNumber').value.trim();
    if (!n) { $('invNumber').value = invSaved.number; return; }
    if (n === invSaved.number) return;
    try { invSaved = await api('/invoices/' + invSaved.id, { method: 'PATCH', body: { number: n } }); $('invNumber').value = invSaved.number; $('invTitle').textContent = `Invoice ${invSaved.number}`; invPreview(); successBadge('Invoice number changed'); loadPayments(); }
    catch (e) { toast(e.message); $('invNumber').value = invSaved.number; }
  }
  $('invNumber').addEventListener('change', saveInvNumber);
  $('invNumber').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); $('invNumber').blur(); } });
  $('invForm').addEventListener('click', (ev) => { const x = ev.target.closest('.i-x'); if (x && !invSaved) { if (document.querySelectorAll('#invItems .invitem').length > 1) x.closest('.invitem').remove(); else x.closest('.invitem').querySelectorAll('input').forEach((i) => { i.value = i.classList.contains('i-q') ? 1 : ''; }); invRecalc(); } });
  $('invAdd').onclick = () => { if (document.querySelectorAll('#invItems .invitem').length < 6) { $('invItems').insertAdjacentHTML('beforeend', itemRow({ qty: 1 })); invRecalc(); $('invItems').lastElementChild.querySelector('.i-d').focus(); } };
  async function createInvoice() {
    const b = $('invCreate'); b.disabled = true; b.classList.add('busy');
    try {
      invSaved = await api('/invoices', { method: 'POST', body: invBody() });
      $('invTitle').textContent = `Invoice ${invSaved.number}`;
      $('invForm').querySelectorAll('input, button').forEach((el) => { el.disabled = true; });
      $('invNumber').disabled = false; $('invNumber').value = invSaved.number;
      invFooter(); invPreview(); successBadge(`Invoice ${invSaved.number} created`); loadPayments();
    } catch (e) { toast(e.message); b.disabled = false; b.classList.remove('busy'); }
  }

  // invoice settings (company, bank, pictures)
  const SET_F = { setCompany: 'company', setAddress1: 'address1', setAddress2: 'address2', setPhone: 'phone', setBankName: 'bankName', setAccountNo: 'accountNo', setAccountName: 'accountName', setSeller: 'seller', setIssuedBy: 'issuedBy' };
  let setImgs = {};
  const drawSetImg = (k, src) => { const box = document.querySelector(`.setimg[data-img="${k}"]`), img = box.querySelector('img'); img.src = src || ''; img.hidden = !src; box.classList.toggle('empty', !src); const up = box.querySelector('.up'); if (k !== 'logo') up.textContent = src ? 'Change' : 'Add'; const rm = box.querySelector('.rm'); if (rm) rm.hidden = !src; };
  $('paySettings').onclick = async () => {
    try {
      const [p, n] = await Promise.all([api('/invoice-profile'), api('/invoice-next')]);
      for (const [id, k] of Object.entries(SET_F)) $(id).value = p[k] || '';
      setImgs = {}; for (const k of ['logo', 'qr', 'sign']) drawSetImg(k, p[k]);
      $('setNext').value = n.next; $('setNext').dataset.was = n.next; $('setNextBox').hidden = !n.canSet;
      $('setMessage').value = p.message; $('setMessage').dataset.def = p.defaultMessage; drawMsgPrev();
      dlgOpen($('setDlg'));
    } catch (e) { toast(e.message); }
  };
  // Telegram message template: tap a {word} to insert it; the preview fills it with sample values.
  const MSG_TAGS = { date: ['Pay date', '30/10/2026'], price: ['Service price', '120'], pages: ['Pages / quantity', '1'], total: ['Amount to pay', '120'], discount: ['Discount', '0'], customer: ['Customer', 'Mut Sopheak'], company: ['Company', 'CosMe'], number: ['Invoice number', 'IN26-1468'], subtotal: ['Price before discount', '120'], invoice_date: ['Invoice date', '05/10/2026'], service: ['Service', 'សេវាកម្មគ្រប់គ្រង Page'] };
  $('setMsgTags').innerHTML = Object.entries(MSG_TAGS).map(([k, [label]]) => `<button type="button" data-tag="${k}" title="${esc(label)}">{${k}} <span>${esc(label)}</span></button>`).join('');
  const drawMsgPrev = () => { $('setMsgPrev').textContent = ($('setMessage').value || $('setMessage').dataset.def || '').replace(/\{(\w+)\}/g, (m, k) => (MSG_TAGS[k] ? MSG_TAGS[k][1] : m)); };
  $('setMessage').addEventListener('input', drawMsgPrev);
  $('setMsgTags').addEventListener('click', (ev) => { const b = ev.target.closest('[data-tag]'); if (!b) return; const t = $('setMessage'), a = t.selectionStart ?? t.value.length, z = t.selectionEnd ?? a, ins = `{${b.dataset.tag}}`; t.value = t.value.slice(0, a) + ins + t.value.slice(z); t.focus(); t.setSelectionRange(a + ins.length, a + ins.length); drawMsgPrev(); });
  // Ready-made messages: tap one to load it into the box, then edit as you like.
  const MSG_PRESETS = {
    'Polite': `សួស្តីបង {customer} 🙏

ខាងក្រុមការងារ Ads Box សូមជម្រាបជូនបងថា សេវាកម្មរបស់បងនឹងដល់ថ្ងៃបង់ប្រាក់ នៅថ្ងៃទី {date}។

🧾 វិក្កយបត្រលេខ ៖ {number}
📄 សេវាកម្ម ៖ {service}
📌 ចំនួន Page ៖ {pages}
💵 តម្លៃសេវាកម្ម ៖ \${price}

💰 ទឹកប្រាក់ត្រូវបង់សរុប ៖ \${total}

បងអាចស្កេន QR ក្នុងវិក្កយបត្រខាងលើ ដើម្បីទូទាត់បាន។
សូមអរគុណបងសម្រាប់ការគាំទ្រ! 🙏`,
    'Short': `សួស្តីបង 🙏
សេវាកម្មរបស់បងដល់ថ្ងៃបង់ នៅថ្ងៃទី {date}។

💰 ទឹកប្រាក់ត្រូវបង់ ៖ \${total}

សូមអរគុណបង!`,
    'Friendly reminder': `ជម្រាបសួរបង {customer} 😊

ខាងប្អូនសូមរំលឹកបងបន្តិច វិក្កយបត្រសេវាកម្មប្រចាំខែ ត្រូវបង់នៅថ្ងៃទី {date}។

• សេវាកម្ម ៖ {service}
• តម្លៃ ៖ \${price} x {pages} Page
• សរុបត្រូវបង់ ៖ \${total}

បើបងបានបង់រួចហើយ សូមផ្ញើវិក្កយបត្របង់ប្រាក់មកខាងប្អូនផង។
អរគុណច្រើនបង! 🙏`,
    'With discount': `សួស្តីបង {customer} 🙏

សេវាកម្មរបស់បងដល់ថ្ងៃបង់ នៅថ្ងៃទី {date}។

💵 តម្លៃសេវាកម្ម ៖ \${subtotal}
🎁 បញ្ចុះតម្លៃ ៖ \${discount}
💰 ទឹកប្រាក់ត្រូវបង់ ៖ \${total}

សូមអរគុណបង!`,
    'English': `Hello {customer},

Your service payment is due on {date}.

Invoice: {number}
Service: {service}
Price: \${price} x {pages} Page
Amount due: \${total}

You can pay by scanning the QR code on the invoice.
Thank you for working with Ads Box!`,
  };
  $('setMsgPresets').innerHTML = Object.keys(MSG_PRESETS).map((k) => `<button type="button" data-preset-msg="${esc(k)}">${esc(k)}</button>`).join('');
  $('setMsgPresets').addEventListener('click', (ev) => { const b = ev.target.closest('[data-preset-msg]'); if (!b) return; $('setMessage').value = MSG_PRESETS[b.dataset.presetMsg]; drawMsgPrev(); $('setMsgPresets').querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); });
  $('setMsgReset').onclick = () => { $('setMessage').value = $('setMessage').dataset.def || ''; drawMsgPrev(); };

  // Shrink a picked picture in the browser so it stays small.
  const shrink = (file, max = 700) => new Promise((resolve, reject) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => { const k = Math.min(1, max / Math.max(img.width, img.height)), cv = document.createElement('canvas'); cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k); cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height); URL.revokeObjectURL(url); resolve(cv.toDataURL('image/png')); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That picture could not be read.')); }; img.src = url;
  });
  document.querySelectorAll('.setimg').forEach((box) => {
    const k = box.dataset.img, inp = box.querySelector('input');
    box.querySelector('.up').onclick = () => inp.click();
    inp.onchange = async () => { const f = inp.files[0]; inp.value = ''; if (!f) return; try { setImgs[k] = await shrink(f); drawSetImg(k, setImgs[k]); } catch (e) { toast(e.message); } };
    const rm = box.querySelector('.rm'); if (rm) rm.onclick = () => { setImgs[k] = ''; drawSetImg(k, ''); };
  });
  $('setSave').onclick = async () => {
    const body = { ...setImgs, message: $('setMessage').value }; for (const [id, k] of Object.entries(SET_F)) body[k] = $(id).value;
    if (!$('setNextBox').hidden && $('setNext').value !== $('setNext').dataset.was) body.nextNumber = $('setNext').value;
    const b = $('setSave'); b.disabled = true;
    try { await api('/invoice-profile', { method: 'PUT', body }); $('setDlg').close(); successBadge('Invoice settings saved'); } catch (e) { toast(e.message); } finally { b.disabled = false; }
  };

  // ---------- admin dashboard (owner only) ----------
  let aPreset = 'today', aData = null, aTeams = { teams: [], users: [], canEdit: false }; const aOpen = new Set();
  function aRange(v) {
    const t = me.today;
    if (v === 'today') return [t, t];
    if (v === 'yesterday') { const y = addD(t, -1); return [y, y]; }
    if (v === '7') return [addD(t, -6), t];
    if (v === '30') return [addD(t, -29), t];
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
    catch (e) { $('aBody').innerHTML = `<tr><td colspan="9" class="muted">${esc(e.message)}</td></tr>`; }
  }
  function renderAdmin() {
    const d = aData, t = d.totals, tax = (v) => Math.round(Math.round(v * 100) * (100 + (d.taxRate || 0)) / 100) / 100;
    rollTo($('aSpend'), money(t.spend)); $('aTax').textContent = (t.spend && d.taxRate ? `With tax ${d.taxRate}%: ${money(tax(t.spend))}` : '') + (t.added - t.spend > 0.009 ? ` · ${money(t.added - t.spend)} shared, counted once` : '');
    rollTo($('aLive'), money(t.live)); $('aLives').textContent = `${t.lives} live${t.lives === 1 ? '' : 's'}`;
    rollTo($('aPost'), money(t.post));
    rollTo($('aOrd'), t.orders ? t.orders.toLocaleString('en-US') : '–'); $('aOrdSub').textContent = t.orders ? `${money(t.orderSpend / t.orders)} per order` : 'adsbox.biz';
    rollTo($('aAcc'), String(t.accounts)); $('aAccSub').textContent = `of ${d.users.length} account${d.users.length === 1 ? '' : 's'} · ${t.clients} client${t.clients === 1 ? '' : 's'} with spend`;
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
        <td class="r num" data-l="Orders">${u.orders ? u.orders.toLocaleString('en-US') : dash}</td><td class="r num" data-l="Cost / order">${u.orders ? '<b class="cpo">' + money(u.orderSpend / u.orders) + '</b>' : dash}</td>
        <td data-l="Last sync" class="hint">${ago(u.lastSync)}</td></tr>`;
      const detail = !open ? '' : `<tr class="dexp"><td colspan="9"><div class="dexp-in">${withSpend.length ? withSpend.map((c) => `<div class="dl ${c.type === 'post' ? 'post' : 'live'}"><span class="dl-n"><b>${esc(c.name)}</b><span class="hint">${c.lives ? ' · ' + c.lives + ' live' + (c.lives === 1 ? '' : 's') : ''}${c.postSpend > 0 ? ' · posts ' + money(c.postSpend) : ''}</span></span><span></span><span class="dl-v"><span class="muted">$</span><span class="box num">${c.spend.toFixed(2)}</span></span></div>`).join('') : '<div class="muted">No client spend in this period.</div>'}${idle.length ? `<div class="hint" style="padding:4px 4px 0">No spend: ${idle.map((c) => esc(c.name)).join(', ')}</div>` : ''}</div></td></tr>`;
      return row + detail;
    };
    const teams = d.teams || [];
    if (!teams.length) $('aBody').innerHTML = d.users.map(userRows).join('') || '<tr><td colspan="9" class="empty-row">Nobody has logged in yet.</td></tr>';
    else {
      // group accounts by team, with a totals row per team
      const groups = teams.map((t) => ({ t, users: d.users.filter((u) => u.team === t.id) }));
      const loose = d.users.filter((u) => !u.team);
      if (loose.length) groups.push({ t: { id: '', name: 'No team' }, users: loose });
      groups.forEach((g) => {
        g.sum = g.users.reduce((a, u) => ({ spend: a.spend + u.totals.spend, live: a.live + u.totals.live, post: a.post + u.totals.post, lives: a.lives + u.totals.lives, clients: a.clients + u.totals.active }), { spend: 0, live: 0, post: 0, lives: 0, clients: 0 });
        g.ord = g.users.reduce((a, u) => a + (u.orders || 0), 0); g.ordSpend = g.users.reduce((a, u) => a + (u.orderSpend || 0), 0);
        const tt = (d.teamTotals || {})[g.t.id];
        if (tt) { g.shared = Math.max(0, Math.round((g.sum.spend - tt.spend) * 100) / 100); g.sum = { spend: tt.spend, live: tt.live, post: tt.post, lives: tt.lives, clients: tt.clients }; }
      });
      groups.sort((a, b) => (!a.t.id) - (!b.t.id) || b.sum.spend - a.sum.spend);
      $('aBody').innerHTML = groups.map((g) => `<tr class="teamrow${g.t.id ? '' : ' loose'}"><td><div class="nm"><span class="teamdot"></span><b>${esc(g.t.name)}</b><span class="hint">${g.users.length} ${g.users.length === 1 ? 'person' : 'people'}</span></div></td>
        <td class="r num" data-l="Clients">${g.sum.clients}</td><td class="r num" data-l="Lives">${g.sum.lives || dash}</td><td class="r num" data-l="Live">${g.sum.live > 0 ? money(g.sum.live) : dash}</td><td class="r num" data-l="Post">${g.sum.post > 0 ? money(g.sum.post) : dash}</td>
        <td class="r num tot" data-l="Total"><b>${money(g.sum.spend)}</b>${g.sum.spend && d.taxRate ? `<div class="hint">+tax ${money(tax(g.sum.spend))}</div>` : ''}${g.shared > 0.009 ? `<div class="sharednote" title="Campaigns synced by more than one person in this team are counted once">${money(g.shared)} shared, counted once</div>` : ''}</td><td class="r num" data-l="Orders">${g.ord ? g.ord.toLocaleString('en-US') : dash}</td><td class="r num" data-l="Cost / order">${g.ord ? money(g.ordSpend / g.ord) : dash}</td><td class="hint">${t.spend ? Math.round(g.sum.spend / t.spend * 100) + '% of all' : ''}</td></tr>`
        + (g.users.map(userRows).join('') || '<tr class="teamempty"><td colspan="9" class="hint">No one in this team yet — add people below.</td></tr>')).join('');
    }
    $('aFoot').innerHTML = d.users.length > 1 ? `<tr><td>Total · ${d.users.length} accounts</td><td class="r num" data-l="Clients">${t.clients}</td><td class="r num" data-l="Lives">${t.lives}</td><td class="r num" data-l="Live">${money(t.live)}</td><td class="r num" data-l="Post">${money(t.post)}</td><td class="r num tot" data-l="Total"><b>${money(t.spend)}</b>${d.taxRate ? `<div class="hint">+tax ${money(tax(t.spend))}</div>` : ''}</td><td class="r num" data-l="Orders">${t.orders ? t.orders.toLocaleString('en-US') : ''}</td><td class="r num" data-l="Cost / order">${t.orders ? money(t.orderSpend / t.orders) : ''}</td><td></td></tr>` : '';
    document.querySelectorAll('#aBody tr.drow').forEach((tr) => {
      const toggle = () => { const id = tr.dataset.uid; aOpen.has(id) ? aOpen.delete(id) : aOpen.add(id); renderAdmin();
        const box = document.querySelector(`#aBody tr.drow[data-uid="${id}"]`)?.nextElementSibling?.querySelector('.dexp-in');
        if (box && !calm && box.animate) { box.animate([{ opacity: 0, transform: 'translateY(-8px)' }, { opacity: 1, transform: 'none' }], { duration: 300, easing: 'cubic-bezier(.2,.8,.2,1)' }); box.querySelectorAll('.dl').forEach((el, i) => el.animate([{ opacity: 0, transform: 'translateX(-14px)' }, { opacity: 1, transform: 'none' }], { duration: 320, delay: 40 + i * 45, fill: 'backwards', easing: 'cubic-bezier(.2,.8,.2,1)' })); } };
      tr.onclick = toggle; tr.onkeydown = (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); } };
    });
  }

  async function loadTeams() { try { aTeams = await api('/admin/teams'); renderTeams(); } catch (e) { $('teamGrid').innerHTML = `<div class="muted">${esc(e.message)}</div>`; } }
  function renderTeams() {
    const { teams, users, canEdit } = aTeams;
    $('teamNewForm').hidden = !canEdit;
    $('teamHint').textContent = canEdit ? 'Group people into teams (e.g. a PM and their media buyers). The Main Dashboard then shows spend, orders and suggestions per team. Each person can be in one team.' : 'Teams set up by the app owner.';
    const nameOf = (id) => (users.find((u) => u.id === id) || {}).name || 'Unknown';
    const inTeam = new Set(teams.flatMap((t) => t.members));
    $('teamGrid').innerHTML = teams.map((t) => `<div class="teamcard" data-team="${esc(t.id)}">
      <div class="tc-head"><b class="tc-name">${esc(t.name)}</b><span class="hint">${t.members.length} ${t.members.length === 1 ? 'person' : 'people'}</span><span class="spacer"></span>${canEdit ? '<button class="ghost" data-rename>Rename</button><button class="ghost danger-t" data-deleteteam>Delete</button>' : ''}</div>
      <div class="tc-members">${t.members.map((m) => `<span class="pchip">${esc(nameOf(m))}${canEdit ? `<button type="button" data-removemember="${esc(m)}" aria-label="Remove">×</button>` : ''}</span>`).join('') || '<span class="hint">No one yet</span>'}</div>
      ${canEdit ? `<select data-addmember><option value="">+ Add person…</option>${users.filter((u) => !t.members.includes(u.id)).map((u) => `<option value="${esc(u.id)}">${esc(u.name)}${inTeam.has(u.id) ? ' (move from other team)' : ''}</option>`).join('')}</select>` : ''}
    </div>`).join('') || `<div class="empty">${canEdit ? 'No teams yet. Type a name above and tap <b>+ New team</b>.' : 'No teams yet.'}</div>`;
    document.querySelectorAll('#teamGrid .teamcard').forEach((card) => {
      const id = card.dataset.team, patch = async (body) => { try { await api('/admin/teams/' + id, { method: 'PATCH', body }); await loadTeams(); mData = null; } catch (e) { toast(e.message); } };
      const add = card.querySelector('[data-addmember]'); if (add) add.onchange = () => add.value && patch({ add: add.value }).then(() => toast('Added to team'));
      card.querySelectorAll('[data-removemember]').forEach((b) => b.onclick = () => patch({ remove: b.dataset.removemember }));
      const rn = card.querySelector('[data-rename]'); if (rn) rn.onclick = () => { const n = prompt('Team name', card.querySelector('.tc-name').textContent); if (n && n.trim()) patch({ name: n.trim() }); };
      const del = card.querySelector('[data-deleteteam]'); if (del) del.onclick = async () => {
        if (!del.dataset.arm) { del.dataset.arm = '1'; del.textContent = 'Tap again'; setTimeout(() => { del.dataset.arm = ''; del.textContent = 'Delete'; }, 3000); return; }
        try { await api('/admin/teams/' + id, { method: 'DELETE' }); toast('Team deleted — people keep their data'); await loadTeams(); mData = null; } catch (e) { toast(e.message); }
      };
    });
  }
  $('teamNewForm').addEventListener('submit', async (ev) => {
    ev.preventDefault(); const name = $('teamNewName').value.trim(); if (!name) return $('teamNewName').focus();
    try { await api('/admin/teams', { method: 'POST', body: { name } }); $('teamNewName').value = ''; toast('Team created — now add people'); await loadTeams(); mData = null; } catch (e) { toast(e.message); }
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
      if (me.canAdmin) { document.querySelector('nav.tabs [data-tab=admin]').hidden = false; document.querySelector('nav.tabs [data-tab=main]').hidden = false; }
      showTab(['main', 'clients', 'accounts', 'lives', 'orders', 'payments', 'team', 'admin'].includes(h) ? h : 'dashboard');
      window.scrollTo(0, 0);
    } catch (e) { $('list').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  })();

  // ---------- extra motion ----------
  if (!calm) {
    // Purple ripple from where a button is tapped.
    document.addEventListener('pointerdown', (ev) => {
      const b = ev.target.closest('button, a.btn'); if (!b || b.disabled || b.closest('nav.tabs') || b.classList.contains('ccard')) return;
      const r = b.getBoundingClientRect(), d = Math.max(r.width, r.height) * 2.2, w = document.createElement('span');
      w.className = 'ripple'; w.style.width = w.style.height = d + 'px'; w.style.left = ev.clientX - r.left - d / 2 + 'px'; w.style.top = ev.clientY - r.top - d / 2 + 'px';
      if (getComputedStyle(b).position === 'static') b.style.position = 'relative';
      b.classList.add('has-ripple'); b.appendChild(w); w.addEventListener('animationend', () => w.remove());
    }, { passive: true });
    // Light that follows the mouse over the panels and the total card (desktop).
    if (matchMedia('(hover:hover)').matches) {
      document.addEventListener('pointermove', (ev) => {
        const el = ev.target.closest('.summary, .panel, .ccard, .lv, .payrow'); if (!el) return;
        const r = el.getBoundingClientRect(); el.style.setProperty('--mx', ev.clientX - r.left + 'px'); el.style.setProperty('--my', ev.clientY - r.top + 'px');
        // Client cards tilt a little toward the mouse.
        if (el.classList.contains('ccard')) { const x = (ev.clientX - r.left) / r.width - .5, y = (ev.clientY - r.top) / r.height - .5; el.style.transform = `perspective(700px) rotateX(${(-y * 5).toFixed(2)}deg) rotateY(${(x * 6).toFixed(2)}deg) translateY(-3px)`; }
      }, { passive: true });
      document.addEventListener('pointerout', (ev) => { const el = ev.target.closest && ev.target.closest('.ccard'); if (el && !el.contains(ev.relatedTarget)) el.style.transform = ''; }, { passive: true });
    }
  }
})();
