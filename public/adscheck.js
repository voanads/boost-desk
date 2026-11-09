/**
 * AdsCheck Pro · SMIT Standalone Script (Works inside Chrome Extension & on Web with Zero Login)
 */
(function () {
  const PENDING = new Map();
  let extReady = false;
  const LISTENERS = new Set();

  const isExtensionPage =
    typeof chrome !== 'undefined' &&
    chrome.runtime &&
    typeof chrome.runtime.sendMessage === 'function' &&
    location.protocol === 'chrome-extension:';

  function hasDomMarker() {
    if (isExtensionPage) return true;
    const r = document.documentElement;
    return (
      r.getAttribute('data-adscheck-extension') === 'installed' ||
      r.getAttribute('data-smit-connect') === 'installed' ||
      r.getAttribute('data-threshold-extension') === 'installed'
    );
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data) return;
    const d = ev.data;
    if (
      d.type === 'EXT_READY' ||
      d.source === 'ADSCHECK_CONNECT_EXTENSION' ||
      d.source === 'ADSCHECK_EXT_BRIDGE'
    ) {
      extReady = true;
      LISTENERS.forEach((fn) => {
        try { fn(d); } catch (_) {}
      });
    }
    if (d.type === 'EXT_RESPONSE' && d.requestId) {
      const p = PENDING.get(d.requestId);
      if (p) {
        clearTimeout(p.timer);
        PENDING.delete(d.requestId);
        p.resolve(d.response);
      }
    }
  });

  function sendReq(payload, timeoutMs = 45000) {
    if (isExtensionPage) {
      return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(payload, (response) => {
          const err = chrome.runtime.lastError;
          if (err) return reject(new Error(err.message || 'Extension error'));
          resolve(response);
        });
      });
    }
    return new Promise((resolve, reject) => {
      const requestId = 'req_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);
      const timer = setTimeout(() => {
        PENDING.delete(requestId);
        reject(new Error('AdsCheck Connect Pro extension did not respond. Make sure it is installed and enabled.'));
      }, timeoutMs);
      PENDING.set(requestId, { resolve, reject, timer });
      window.postMessage({ source: 'ADSCHECK_WEB_APP', requestId, payload }, '*');
    });
  }

  window.AdsCheckBridge = {
    isInstalled() {
      return isExtensionPage || extReady || hasDomMarker();
    },
    onReady(fn) {
      if (this.isInstalled()) fn({ status: 'ready' });
      LISTENERS.add(fn);
    },
    async getState() {
      return sendReq({ type: 'GET_STATE' }, 10000);
    },
    async syncNow() {
      return sendReq({ type: 'SYNC_ACCOUNTS', forceRefresh: true }, 60000);
    },
    async bulkAction(opts) {
      return sendReq({ type: 'BULK_ACTION', payload: opts }, 60000);
    }
  };
})();

(function () {
  const STORAGE_KEY = 'adscheck_standalone_accounts_v1';
  const BANNER_KEY = 'adscheck_standalone_hide_banner';
  const $ = (id) => document.getElementById(id);
  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[c]));

  let accounts = [];
  let sortCol = '';
  let sortAsc = true;
  let statusFilter = 'all';
  let currentView = 'all';

  function toast(msg) {
    const el = $('toastEl');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), 3200);
  }

  function smitNum(v, zeroAsZero = true) {
    if (v == null || v === '' || Number.isNaN(Number(v))) return zeroAsZero ? '0' : '-';
    const n = Math.round(Number(v) * 100) / 100;
    if (n === 0 && !zeroAsZero) return '-';
    return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  }

  function normalizeAccount(raw) {
    const cleanId = String(raw.accountId || raw.id || '').replace(/^act_/, '');
    const statusRaw = String(raw.status || raw.account_status || 'ACTIVE').toUpperCase();
    let statusCode = Number(raw.statusCode || raw.account_status) || 1;
    if (!raw.statusCode && typeof raw.status === 'string') {
      if (statusRaw.includes('ACTIVE')) statusCode = 1;
      else if (statusRaw.includes('UNSETTLED') || statusRaw.includes('GRACE')) statusCode = 3;
      else statusCode = 2;
    }
    const ok = [1, 201].includes(statusCode) || statusRaw === 'ACTIVE';
    const warn = [3, 7, 8, 9, 100].includes(statusCode) || statusRaw.includes('UNSETTLED') || statusRaw.includes('GRACE');
    const balance = Number(raw.balance) || 0;
    const threshold = raw.threshold != null && Number(raw.threshold) > 0 ? Number(raw.threshold) : null;
    const dailyLimit = raw.dailyLimit != null && Number(raw.dailyLimit) > 0 ? Number(raw.dailyLimit) : null;
    const spendCap = raw.spendCap != null && Number(raw.spendCap) > 0 ? Number(raw.spendCap) : null;
    const totalSpend = Number(raw.totalSpend ?? raw.amountSpent ?? 0) || 0;
    const origId = String(raw.businessId || raw.originalId || raw.owner || '-').trim() || '-';

    return {
      id: 'act_' + cleanId,
      numId: cleanId,
      name: String(raw.name || ('Account ' + cleanId)).trim(),
      statusCode,
      ok,
      warn,
      statusLabel: ok ? 'Active' : (warn ? 'Unsettled' : 'Disabled'),
      disableReason: String(raw.disableReason || ''),
      originalId: origId,
      businessName: String(raw.businessName || raw.business || '').trim(),
      balance,
      threshold,
      dailyLimit,
      spendCap,
      limit: dailyLimit != null ? dailyLimit : spendCap,
      totalSpend,
      card: String(raw.paymentMethods || raw.card || '').trim(),
      currency: String(raw.currency || 'USD'),
      checked: raw.checked !== false
    };
  }

  function loadSavedAccounts() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      if (Array.isArray(saved) && saved.length) {
        accounts = saved.map(normalizeAccount);
      }
    } catch (_) {}
  }

  function saveAccounts() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(accounts));
    } catch (_) {}
  }

  function renderSubDrawer() {
    const drawer = $('subViewDrawer');
    if (!drawer) return;
    if (currentView === 'all') {
      drawer.hidden = true;
      return;
    }
    drawer.hidden = false;

    if (currentView === 'cards') {
      const withCards = accounts.filter((a) => a.card);
      drawer.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center">
          <b>💳 Payment Methods (${withCards.length} accounts with cards detected)</b>
          <span style="color:var(--muted);font-size:12px">Synced from your Facebook Billing session</span>
        </div>
        ${withCards.length ? `<div class="drawer-grid">${withCards.map((a) => `
          <div class="mini-card">
            <div style="font-weight:700">${esc(a.name)}</div>
            <div style="font-size:11.5px;color:var(--muted)">${esc(a.numId)}</div>
            <div style="margin-top:8px;font-weight:600;color:#1d4ed8">💳 ${esc(a.card)}</div>
            <div style="margin-top:4px;font-size:12px;color:var(--muted)">Balance: <b>${smitNum(a.balance, true)}</b> · Threshold: <b>${a.threshold != null ? smitNum(a.threshold, false) : '-'}</b></div>
          </div>
        `).join('')}</div>` : `<div style="color:var(--muted);margin-top:8px">No card strings detected yet. Click <b>⚡ Sync from Browser Extension</b> while logged into Facebook.</div>`}
      `;
    } else if (currentView === 'bm') {
      const groups = new Map();
      for (const a of accounts) {
        const key = a.originalId !== '-' ? a.originalId : 'Personal / No BM';
        const g = groups.get(key) || { id: key, name: a.businessName || key, count: 0, active: 0, balance: 0, spent: 0 };
        g.count++;
        if (a.ok) g.active++;
        g.balance += a.balance;
        g.spent += a.totalSpend;
        groups.set(key, g);
      }
      const list = [...groups.values()].sort((a, b) => b.count - a.count);
      drawer.innerHTML = `
        <b>🏢 Business Manager / Original ID Breakdown (${list.length} groups)</b>
        <div class="drawer-grid">${list.map((g) => `
          <div class="mini-card">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
              <b>🏢 ${esc(g.id)}</b>
              <span style="font-size:11.5px;background:#e2e8f0;padding:2px 8px;border-radius:99px;font-weight:600">${g.count} accts (${g.active} active)</span>
            </div>
            <div style="margin-top:8px;font-size:12.5px;color:var(--muted);display:flex;justify-content:space-between">
              <span>Balance: <b>${smitNum(g.balance, true)}</b></span>
              <span>Spent: <b>${smitNum(g.spent, true)}</b></span>
            </div>
          </div>
        `).join('')}</div>
      `;
    } else if (currentView === 'share') {
      const ticked = accounts.filter((a) => a.checked);
      drawer.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:10px">
          <div>
            <b>👥 Super Share — Bulk Grant / Remove Ad Account Roles</b>
            <div style="color:var(--muted);font-size:12.5px">Applies to all <b>${ticked.length} ticked ad accounts</b> via the AdsCheck Connect Pro extension.</div>
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center">
            <input type="text" id="shareUidsInput" class="search-input" placeholder="Facebook User IDs (comma or space separated)…" style="flex:1;min-width:240px">
            <select id="shareRoleSelect" class="search-input" style="min-width:190px">
              <option value="281423141961500">Admin (Full control)</option>
              <option value="461336843905730">Advertiser (Campaigns)</option>
              <option value="498940650138739">Analyst (View only)</option>
            </select>
            <button type="button" class="btn btn-primary" id="grantShareBtn">Grant Role to Ticked</button>
            <button type="button" class="btn" id="revokeShareBtn">Remove User</button>
          </div>
          <div id="shareStatusMsg" style="font-size:12.5px;color:var(--muted)"></div>
        </div>
      `;
      const runShare = async (action) => {
        const uids = ($('shareUidsInput')?.value || '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
        const role = $('shareRoleSelect')?.value || '281423141961500';
        const ids = accounts.filter((a) => a.checked).map((a) => a.numId);
        if (!uids.length) return toast('Enter at least 1 Facebook User ID');
        $('shareStatusMsg').textContent = `Running ${action} across ${ids.length} accounts…`;
        try {
          const r = await window.AdsCheckBridge.bulkAction({ action, accountIds: ids, userIds: uids, role });
          const okCount = Array.isArray(r?.results) ? r.results.filter((x) => x.ok).length : ids.length;
          $('shareStatusMsg').textContent = `✓ Completed on ${okCount}/${ids.length} accounts.`;
          toast(`Super Share finished (${okCount}/${ids.length})`);
        } catch (e) {
          $('shareStatusMsg').textContent = e.message;
        }
      };
      if ($('grantShareBtn')) $('grantShareBtn').onclick = () => runShare('ADD_USER');
      if ($('revokeShareBtn')) $('revokeShareBtn').onclick = () => runShare('REMOVE_USER');
    } else if (currentView === 'pixel') {
      const ticked = accounts.filter((a) => a.checked);
      drawer.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:10px">
          <div>
            <b>🔗 Bulk Share Meta Pixel / Dataset</b>
            <div style="color:var(--muted);font-size:12.5px">Shares your Meta Pixel ID with all <b>${ticked.length} ticked ad accounts</b>.</div>
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center">
            <input type="text" id="pixelIdInput" class="search-input" placeholder="Meta Pixel ID (e.g. 948102938471625)…">
            <input type="text" id="pixelBmInput" class="search-input" placeholder="Owning Business Manager ID…">
            <button type="button" class="btn btn-primary" id="runPixelBtn">Share Pixel to Ticked Accounts</button>
          </div>
          <div id="pixelStatusMsg" style="font-size:12.5px;color:var(--muted)"></div>
        </div>
      `;
      if ($('runPixelBtn')) $('runPixelBtn').onclick = async () => {
        const pixelId = ($('pixelIdInput')?.value || '').trim();
        const businessId = ($('pixelBmInput')?.value || '').trim();
        const ids = accounts.filter((a) => a.checked).map((a) => a.numId);
        if (!pixelId) return toast('Enter a Meta Pixel ID');
        $('pixelStatusMsg').textContent = `Sharing Pixel ${pixelId} to ${ids.length} accounts…`;
        try {
          const r = await window.AdsCheckBridge.bulkAction({ action: 'SHARE_PIXEL', accountIds: ids, pixelId, businessId });
          const okCount = Array.isArray(r?.results) ? r.results.filter((x) => x.ok).length : ids.length;
          $('pixelStatusMsg').textContent = `✓ Shared Pixel ${pixelId} to ${okCount}/${ids.length} accounts.`;
          toast(`Pixel shared to ${okCount} accounts`);
        } catch (e) {
          $('pixelStatusMsg').textContent = e.message;
        }
      };
    }
  }

  function renderTable() {
    const q = ($('searchInput')?.value || '').trim().toLowerCase();
    let actCount = 0;
    let badCount = 0;
    let allBal = 0;
    let allThr = 0;
    let allSpent = 0;

    for (const a of accounts) {
      if (a.ok) actCount++;
      else badCount++;
      allBal += a.balance;
      if (a.threshold != null) allThr += a.threshold;
      allSpent += a.totalSpend;
    }

    $('kpiTotal').textContent = accounts.length;
    $('kpiActive').textContent = actCount;
    $('kpiDisabled').textContent = badCount;
    $('kpiBalance').textContent = smitNum(allBal, true);
    $('kpiThreshold').textContent = smitNum(allThr, true);
    $('kpiSpent').textContent = smitNum(allSpent, true);

    const filtered = accounts.filter((a) => {
      if (statusFilter === 'active' && !a.ok) return false;
      if (statusFilter === 'bad' && a.ok) return false;
      if (q && !(
        a.name.toLowerCase().includes(q) ||
        a.numId.toLowerCase().includes(q) ||
        a.originalId.toLowerCase().includes(q) ||
        a.card.toLowerCase().includes(q) ||
        a.businessName.toLowerCase().includes(q)
      )) return false;
      return true;
    });

    if (sortCol) {
      const dir = sortAsc ? 1 : -1;
      filtered.sort((a, b) => {
        if (sortCol === 'status') return ((a.ok ? 1 : 0) - (b.ok ? 1 : 0)) * dir;
        if (sortCol === 'name') return a.name.localeCompare(b.name) * dir;
        if (sortCol === 'originalId') return a.originalId.localeCompare(b.originalId) * dir;
        if (sortCol === 'balance') return (a.balance - b.balance) * dir;
        if (sortCol === 'threshold') return ((a.threshold ?? -1) - (b.threshold ?? -1)) * dir;
        if (sortCol === 'remain') {
          const ra = a.threshold != null ? a.threshold - a.balance : -1e9;
          const rb = b.threshold != null ? b.threshold - b.balance : -1e9;
          return (ra - rb) * dir;
        }
        if (sortCol === 'limit') return ((a.limit ?? -1) - (b.limit ?? -1)) * dir;
        if (sortCol === 'spent') return (a.totalSpend - b.totalSpend) * dir;
        return 0;
      });
    }

    let totBalance = 0;
    let totThreshold = 0;
    let totLimit = 0;
    let totSpent = 0;

    if (!filtered.length) {
      $('acctBody').innerHTML = `<tr><td colspan="9" style="text-align:center;padding:32px;color:var(--muted)">
        ${accounts.length ? 'No matching ad accounts for this filter.' : 'No ad accounts loaded yet. Click <b>⚡ Sync from Browser Extension</b> (or <b>🔑 Token Sync</b>) above to load your Facebook Ad Accounts.'}
      </td></tr>`;
    } else {
      $('acctBody').innerHTML = filtered.map((a) => {
        const numId = a.numId;
        const origId = a.originalId || '-';
        const hasOrig = origId !== '-' && /^\d+$/.test(origId);
        const adsManagerUrl = 'https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=' + encodeURIComponent(numId);
        const billingUrl = 'https://business.facebook.com/billing_hub/accounts/details?asset_id=' + encodeURIComponent(numId) + (hasOrig ? '&business_id=' + encodeURIComponent(origId) : '');
        const origUrl = hasOrig ? 'https://business.facebook.com/settings/ad-accounts?business_id=' + encodeURIComponent(origId) : adsManagerUrl;
        const statusUrl = a.ok ? adsManagerUrl : 'https://business.facebook.com/accountquality/?landing_page=overview&act=' + encodeURIComponent(numId);
        const ttHtml = `<a class="smit-tt ${a.ok ? 'is-active' : a.warn ? 'is-warn' : 'is-disabled'}" href="${esc(statusUrl)}" target="_blank" rel="noopener" title="${esc(a.disableReason || a.statusLabel)} — Click to open ${a.ok ? 'Ads Manager' : 'Account Quality'}"><i class="smit-dot"></i>${esc(a.statusLabel)}</a>`;
        const rem = a.threshold != null ? Math.round(a.threshold - a.balance) : null;

        totBalance += a.balance;
        if (a.threshold != null) totThreshold += a.threshold;
        if (a.limit != null) totLimit += a.limit;
        totSpent += a.totalSpend;

        return `<tr data-smit-row="${esc(numId)}">
          <td class="smit-td-chk"><input type="checkbox" data-row-chk="${esc(numId)}" ${a.checked ? 'checked' : ''} aria-label="Select account"></td>
          <td>${ttHtml}</td>
          <td>
            <a class="smit-acct-link" href="${esc(adsManagerUrl)}" target="_blank" rel="noopener" title="Open ${esc(a.name)} (${esc(numId)}) in Facebook Ads Manager">
              <div class="smit-acct-name">${esc(a.name)}</div>
              <div class="smit-acct-id">${esc(numId)}</div>
            </a>
          </td>
          <td class="smit-td-orig">${hasOrig ? `<a class="smit-orig-link" href="${esc(origUrl)}" target="_blank" rel="noopener" title="Open Business Settings (${esc(origId)})">${esc(origId)}</a>` : esc(origId)}</td>
          <td class="smit-td-num"><a class="smit-billing-link" href="${esc(billingUrl)}" target="_blank" rel="noopener" title="Open Facebook Billing &amp; Payment details">${smitNum(a.balance, true)}</a></td>
          <td class="smit-td-num"><a class="smit-billing-link" href="${esc(billingUrl)}" target="_blank" rel="noopener" title="Open Facebook Billing Threshold">${a.threshold != null ? smitNum(a.threshold, false) : '-'}</a></td>
          <td class="smit-td-num"><a class="smit-billing-link" href="${esc(billingUrl)}" target="_blank" rel="noopener" title="Open Facebook Billing details">${rem != null ? smitNum(rem, true) : '-'}</a></td>
          <td class="smit-td-num"><a class="smit-acct-link-num" href="${esc(adsManagerUrl)}" target="_blank" rel="noopener" title="Open Ads Manager">${a.limit != null ? smitNum(a.limit, false) : '-'}</a></td>
          <td class="smit-td-num"><a class="smit-acct-link-num" href="${esc(adsManagerUrl)}" target="_blank" rel="noopener" title="Open Ads Manager">${smitNum(a.totalSpend, true)}</a></td>
        </tr>`;
      }).join('');
    }

    const totRemain = Math.round(totThreshold - totBalance);
    $('acctFoot').innerHTML = `<tr>
      <td colspan="2" style="text-align:center">
        <span class="brand-badge" style="padding:2px 7px;font-size:13px"><span class="s1">S</span><span class="s2">M</span><span class="s3">I</span><span class="s4">T</span></span>
      </td>
      <td><b>${filtered.length} Advertising Account</b></td>
      <td></td>
      <td class="smit-td-num"><b>${smitNum(totBalance, true)}</b></td>
      <td class="smit-td-num"><b>${smitNum(totThreshold, true)}</b></td>
      <td class="smit-td-num"><b>${smitNum(totRemain, true)}</b></td>
      <td class="smit-td-num"><b>${smitNum(totLimit, true)}</b></td>
      <td class="smit-td-num"><b>${smitNum(totSpent, true)}</b></td>
    </tr>`;

    document.querySelectorAll('[data-row-chk]').forEach((cb) => {
      cb.onchange = () => {
        const item = accounts.find((x) => x.numId === cb.dataset.rowChk);
        if (item) {
          item.checked = cb.checked;
          saveAccounts();
          if (currentView !== 'all') renderSubDrawer();
        }
      };
    });

    renderSubDrawer();
  }

  async function syncFromExtension(force = true) {
    const btn = $('syncExtBtn');
    const origText = btn.textContent;
    btn.disabled = true;
    btn.textContent = '⟳ Syncing from Extension…';
    try {
      const res = force
        ? await window.AdsCheckBridge.syncNow()
        : await window.AdsCheckBridge.getState();
      if (res && Array.isArray(res.accounts) && res.accounts.length > 0) {
        accounts = res.accounts.map(normalizeAccount);
        saveAccounts();
        renderTable();
        $('lastSyncText').textContent = `Synced ${accounts.length} accounts from browser session at ${new Date().toLocaleTimeString()}`;
        toast(`✓ Synced ${accounts.length} ad accounts!`);
      } else if (force) {
        toast(res?.error || 'Make sure you are logged into Facebook in this browser and try again.');
      }
    } catch (err) {
      if (force) toast(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = origText;
    }
  }

  async function syncWithAccessToken() {
    const token = ($('fbTokenInput')?.value || '').trim();
    if (!token) return toast('Please paste your Facebook Access Token (EAAB... / EAAG...)');
    const btn = $('runTokenSyncBtn');
    const origText = btn.textContent;
    btn.disabled = true;
    btn.textContent = '⟳ Fetching from Meta Graph API…';
    try {
      const fields = 'account_id,name,account_status,disable_reason,currency,balance,amount_spent,spend_cap,adtrust_dsl,owner,business{id,name},adspaymentcycle{threshold_amount},funding_source_details';
      const url = `https://graph.facebook.com/v21.0/me/adaccounts?fields=${encodeURIComponent(fields)}&limit=250&access_token=${encodeURIComponent(token)}`;
      const r = await fetch(url);
      const data = await r.json();
      if (!r.ok || data.error) throw new Error(data.error?.message || 'Failed to fetch ad accounts from Meta');
      const rawList = Array.isArray(data.data) ? data.data : [];
      accounts = rawList.map((row) => {
        const cur = String(row.currency || 'USD').toUpperCase();
        const zeroDec = ['VND', 'JPY', 'KRW', 'CLP', 'IDR', 'TWD'].includes(cur);
        const div = zeroDec ? 1 : 100;
        const cycle = Array.isArray(row.adspaymentcycle?.data) ? row.adspaymentcycle.data[0] : row.adspaymentcycle;
        const thrRaw = cycle && cycle.threshold_amount != null ? Number(cycle.threshold_amount) : null;
        return normalizeAccount({
          accountId: row.account_id || String(row.id || '').replace(/^act_/, ''),
          name: row.name,
          statusCode: Number(row.account_status) || 1,
          currency: cur,
          balance: row.balance != null ? Number(row.balance) / div : 0,
          threshold: thrRaw != null && thrRaw > 0 ? thrRaw / div : null,
          dailyLimit: row.adtrust_dsl != null && Number(row.adtrust_dsl) > 0 ? Number(row.adtrust_dsl) : null,
          spendCap: row.spend_cap != null && Number(row.spend_cap) > 0 ? Number(row.spend_cap) / div : null,
          totalSpend: row.amount_spent != null ? Number(row.amount_spent) / div : 0,
          businessId: row.business?.id || row.owner || '-',
          businessName: row.business?.name || '',
          card: row.funding_source_details?.display_string || ''
        });
      });
      saveAccounts();
      renderTable();
      $('tokenDrawer').hidden = true;
      $('lastSyncText').textContent = `Synced ${accounts.length} accounts via Token at ${new Date().toLocaleTimeString()}`;
      toast(`✓ Loaded ${accounts.length} ad accounts via Token!`);
    } catch (e) {
      toast('Error: ' + e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = origText;
    }
  }

  $('exportCsvBtn').onclick = () => {
    if (!accounts.length) return toast('No accounts to export yet');
    const headers = ['Status', 'Account Name', 'Account ID', 'Original ID', 'Balance', 'Threshold', 'Remain Threshold', 'Limit', 'Total Spent', 'Card'];
    const rows = accounts.map((a) => [
      a.statusLabel,
      `"${a.name.replace(/"/g, '""')}"`,
      a.numId,
      a.originalId,
      a.balance,
      a.threshold ?? '',
      a.threshold != null ? Math.round(a.threshold - a.balance) : '',
      a.limit ?? '',
      a.totalSpend,
      `"${(a.card || '').replace(/"/g, '""')}"`
    ]);
    const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `adscheck-accounts-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  };

  $('syncExtBtn').onclick = () => syncFromExtension(true);
  $('toggleTokenBtn').onclick = () => { $('tokenDrawer').hidden = !$('tokenDrawer').hidden; };
  $('closeTokenDrawerBtn').onclick = () => { $('tokenDrawer').hidden = true; };
  $('runTokenSyncBtn').onclick = syncWithAccessToken;
  $('searchInput').oninput = renderTable;
  $('clearCacheBtn').onclick = () => {
    accounts = [];
    localStorage.removeItem(STORAGE_KEY);
    renderTable();
    toast('Cleared cached accounts');
  };

  $('selectAllChk').onchange = (e) => {
    const checked = e.target.checked;
    accounts.forEach((a) => { a.checked = checked; });
    saveAccounts();
    renderTable();
  };

  document.querySelectorAll('#smitStandaloneTable th[data-sort]').forEach((th) => {
    th.onclick = () => {
      const col = th.dataset.sort;
      if (sortCol === col) sortAsc = !sortAsc;
      else { sortCol = col; sortAsc = false; }
      renderTable();
    };
  });

  $('viewSeg').querySelectorAll('button[data-view]').forEach((btn) => {
    btn.onclick = () => {
      currentView = btn.dataset.view;
      $('viewSeg').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
      renderSubDrawer();
    };
  });

  $('filterSeg').querySelectorAll('button[data-filter]').forEach((btn) => {
    btn.onclick = () => {
      statusFilter = btn.dataset.filter;
      $('filterSeg').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
      renderTable();
    };
  });

  try {
    if (localStorage.getItem(BANNER_KEY) === '1') $('smitBannerRow').hidden = true;
  } catch (_) {}
  $('bannerCloseBtn').onclick = () => {
    if ($('bannerDontShow')?.checked) {
      try { localStorage.setItem(BANNER_KEY, '1'); } catch (_) {}
    }
    $('smitBannerRow').hidden = true;
  };
  $('bannerSyncLink').onclick = (e) => {
    e.preventDefault();
    syncFromExtension(true);
  };

  function updateExtPill(ready) {
    const pill = $('extStatusPill');
    const lbl = $('extStatusLabel');
    if (ready) {
      pill.classList.add('is-ready');
      lbl.textContent = 'Extension Connected';
    } else {
      pill.classList.remove('is-ready');
      lbl.textContent = 'Extension Not Detected (or use Token Sync)';
    }
  }

  window.AdsCheckBridge.onReady(() => {
    updateExtPill(true);
    syncFromExtension(false);
  });

  setTimeout(() => {
    updateExtPill(window.AdsCheckBridge.isInstalled());
    if (window.AdsCheckBridge.isInstalled()) {
      syncFromExtension(false);
    }
  }, 400);

  loadSavedAccounts();
  renderTable();
})();
