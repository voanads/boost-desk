// Media buyer dashboard: today's tasks (tick, type reached), target, monthly KPI, clients and history.
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (n) => (Number(n) < 0 ? '-$' : '$') + Math.abs(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const parse = (d) => new Date(d + 'T00:00:00');
  const nice = (d) => parse(d).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  const monLbl = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }); };
  const hhmm = (iso) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  let toastT; const toast = (m) => { const t = $('toast'); t.textContent = m; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 2600); };
  async function api(p, opt = {}) {
    const r = await fetch(p, { headers: { 'content-type': 'application/json' }, method: opt.method || 'GET', body: opt.body ? JSON.stringify(opt.body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { if (j.needsLogin) location.reload(); throw new Error(j.error || 'Something went wrong'); }
    return j;
  }
  // theme: follow the device, tap to switch
  const theme = localStorage.getItem('bd-theme'); if (theme) document.documentElement.dataset.theme = theme;
  $('themeBtn').onclick = () => { const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light'); const n = cur === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = n; localStorage.setItem('bd-theme', n); };
  $('mbLogout').onclick = async () => { await api('/mb/logout', { method: 'POST' }); location.reload(); };

  let D = null;
  const box = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';
  function render() {
    const d = D, c = d.counts;
    $('mbName').textContent = d.me.name; $('mbPm').textContent = d.me.pm ? 'PM: ' + d.me.pm : 'Media buyer';
    $('mbDate').textContent = nice(d.today);
    $('mbStats').innerHTML = `
      <div class="mb-st"><span class="lbl">Completed</span><b class="num ok">${c.done}</b></div>
      <div class="mb-st"><span class="lbl">Pending</span><b class="num">${c.open}</b></div>
      <div class="mb-st ${c.late ? 'bad' : ''}"><span class="lbl">Overdue</span><b class="num">${c.late}</b></div>`;
    const tg = d.target;
    $('mbTarget').hidden = !tg.tasks;
    if (tg.tasks) $('mbTarget').innerHTML = `<div class="mb-tg-h"><b>🎯 My daily target</b><span class="num ${tg.pct >= 100 ? 'ok' : ''}">${tg.pct}%</span></div><div class="tgt-bar"><i style="width:${Math.min(100, tg.pct)}%"></i></div><span class="hint">${tg.reached} of ${tg.total} reached across ${tg.tasks} task${tg.tasks === 1 ? '' : 's'} — type what you reached on each task</span>`;
    $('mbTasks').innerHTML = d.tasks.length ? d.tasks.map((t) => `<div class="mb-task ${t.done ? 'done' : ''} ${t.late ? 'late' : ''}">
        <button type="button" class="tcheck" role="checkbox" aria-checked="${t.done}" data-tick="${t.clientId}|${t.id}" aria-label="Done">${box}</button>
        <div class="mb-tt"><b>${esc(t.text)}</b><span class="hint">${esc(t.client)}${t.pm ? ' · ' + esc(t.pm) : ''}${t.repeat ? ' · 🔁 every day' : ''}${t.late ? ` · <span class="is-danger">late — since ${esc(nice(t.day))}</span>` : ''}${t.kpiName ? ` · <span class="kpi-chip">KPI · ${esc(t.kpiName)}</span>` : ''}${t.done && t.doneAt ? ` · ✅ ${hhmm(t.doneAt)}` : ''}</span>
          ${t.target ? `<span class="mb-reach"><span class="tgt-bar sm"><i style="width:${Math.min(100, Math.round((t.reached || 0) / t.target * 100))}%"></i></span><input type="number" inputmode="numeric" min="0" value="${t.reached || 0}" data-reach="${t.clientId}|${t.id}" aria-label="Reached"> / ${t.target} ${esc(t.unit)}</span>` : ''}</div>
      </div>`).join('') : '<div class="hl-empty">🎉 No tasks for you today. New tasks arrive on Telegram.</div>';
    $('mbTasks').querySelectorAll('[data-tick]').forEach((b) => b.onclick = async () => { const [cid, tid] = b.dataset.tick.split('|'), done = b.getAttribute('aria-checked') !== 'true'; b.disabled = true; try { await api(`/mb/api/tasks/${cid}/${tid}`, { method: 'POST', body: { done } }); await load(); if (done) toast('✅ Marked done'); } catch (e) { toast(e.message); b.disabled = false; } });
    $('mbTasks').querySelectorAll('[data-reach]').forEach((i) => i.onchange = async () => { const [cid, tid] = i.dataset.reach.split('|'); try { await api(`/mb/api/tasks/${cid}/${tid}`, { method: 'POST', body: { reached: Number(i.value) || 0 } }); await load(); } catch (e) { toast(e.message); } });
    $('mbMonth').textContent = monLbl(d.month);
    const ka = $('mbKpiAvg'); ka.hidden = d.kpiAvg == null; if (d.kpiAvg != null) { ka.textContent = d.kpiAvg + '%'; ka.className = 'kpi-score ' + (d.kpiAvg >= 100 ? 'ok' : d.kpiAvg >= 60 ? 'mid' : 'bad'); }
    $('mbKpis').innerHTML = d.kpis.length ? `<div class="mb-list">${d.kpis.map((k) => `<div class="mb-row"><div class="mb-rt"><b>${esc(k.name)}</b><span class="hint">${k.tasks} task${k.tasks === 1 ? '' : 's'} linked${k.estimated ? ' · auto' : ''}</span></div><span class="num mb-rv">${k.result}<small> / ${k.target} ${esc(k.unit)}</small></span>${k.target ? `<span class="kpi-score ${k.score >= 100 ? 'ok' : k.score >= 60 ? 'mid' : 'bad'}">${Math.round(k.score)}%</span>` : ''}</div>`).join('')}</div>` : '<div class="hl-empty">No KPI set for this month yet — your PM sets it on the My Task page.</div>';
    $('mbClHint').textContent = d.clients.length ? `${d.clients.length} client${d.clients.length === 1 ? '' : 's'}` : '';
    $('mbClients').innerHTML = d.clients.length ? `<div class="mb-list">${d.clients.map((c) => `<div class="mb-row"><div class="mb-rt"><b>${esc(c.name)}</b><span class="hint">${c.pm ? 'PM ' + esc(c.pm) + ' · ' : ''}${c.open ? c.open + ' open task' + (c.open === 1 ? '' : 's') : 'nothing open'}</span>${c.plan ? `<span class="mb-plan">📣 Boost plan: ${c.plan.posts} post${c.plan.posts === 1 ? '' : 's'} · ${money(c.plan.total)} · ${esc(nice(c.plan.from))} – ${esc(nice(c.plan.to))}${c.plan.sentAt ? ' · sent to client ✓' : ''}</span>` : ''}</div></div>`).join('')}</div>` : '<div class="hl-empty">No clients yet — they appear when a PM gives you a task.</div>';
    $('mbRate').textContent = d.rate == null ? '' : `${d.rate}% completed · ${d.assigned} tasks in 30 days`;
    const ymd = (dt) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    const days = []; for (let i = 13; i >= 0; i--) { const dt = parse(d.today); dt.setDate(dt.getDate() - i); const k = ymd(dt); days.push([k, d.byDay[k] || 0]); }
    $('mbDays').innerHTML = days.map(([k, n]) => `<span class="mb-day ${n ? 'on' : ''}" title="${esc(nice(k))}: ${n} done"><i style="height:${Math.min(100, n * 25)}%"></i><small>${parse(k).getDate()}</small></span>`).join('');
    $('mbHist').innerHTML = d.history.length ? `<div class="mb-list">${d.history.map((h) => `<div class="mb-row sm"><span class="mb-dot"></span><div class="mb-rt"><b>${esc(h.text)}</b><span class="hint">${esc(h.client)} · ${esc(nice(h.day))} ${hhmm(h.at)}</span></div></div>`).join('')}</div>` : '<div class="hl-empty">Nothing ticked in the last 30 days yet.</div>';
    $('mbTg').innerHTML = `<div class="mb-row"><span class="mb-tgic">✈️</span><div class="mb-rt"><b>Telegram notifications</b><span class="hint">${d.notifications.linked ? 'Connected — new tasks, every-day reminders at 08:00 and your dashboard link come to your Telegram.' : 'Not connected — open the invite link your PM sent you, then tap Start.'}</span></div><span class="pill ${d.notifications.linked ? 'ok' : 'warn'}">${d.notifications.linked ? 'On' : 'Off'}</span></div>`;
  }
  async function load() { try { D = await api('/mb/api/me'); $('mbErr').hidden = true; render(); } catch (e) { $('mbErr').hidden = false; $('mbErr').textContent = e.message; } }
  load(); setInterval(load, 60e3);
})();
