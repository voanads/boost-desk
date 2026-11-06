/**
 * AdsCheck Connect Pro — Universal Web-to-Extension Bridge SDK v3.1.0
 * Drop this script into any website (<script src="/adscheck-bridge-sdk.js"></script>)
 * to communicate with the AdsCheck Connect Pro Chrome Extension.
 */
(function (global) {
  const PENDING_REQUESTS = new Map();
  let isExtensionReady = false;
  let extensionInfo = null;
  const READY_LISTENERS = new Set();

  function checkDomMarker() {
    if (typeof document === 'undefined') return false;
    const root = document.documentElement;
    return (
      root.getAttribute('data-adscheck-extension') === 'installed' ||
      root.getAttribute('data-smit-connect') === 'installed'
    );
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('message', (event) => {
      if (event.source !== window || !event.data) return;
      const data = event.data;

      if (data.type === 'EXT_READY' || data.source === 'ADSCHECK_CONNECT_EXTENSION') {
        isExtensionReady = true;
        extensionInfo = data;
        READY_LISTENERS.forEach((cb) => {
          try {
            cb(data);
          } catch {}
        });
      }

      if (data.type === 'EXT_RESPONSE' && data.requestId) {
        const entry = PENDING_REQUESTS.get(data.requestId);
        if (entry) {
          clearTimeout(entry.timer);
          PENDING_REQUESTS.delete(data.requestId);
          entry.resolve(data.response);
        }
      }
    });
  }

  function sendBridgeRequest(payload, timeoutMs = 45000) {
    return new Promise((resolve, reject) => {
      const requestId =
        'req_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);

      const timer = setTimeout(() => {
        PENDING_REQUESTS.delete(requestId);
        reject(
          new Error(
            'AdsCheck Connect Pro extension did not respond. Please make sure the extension is installed and enabled.'
          )
        );
      }, timeoutMs);

      PENDING_REQUESTS.set(requestId, { resolve, reject, timer });

      window.postMessage(
        {
          source: 'ADSCHECK_WEB_APP',
          requestId,
          payload,
        },
        '*'
      );
    });
  }

  const AdsCheckBridge = {
    version: '3.1.0',

    /**
     * Returns true if the extension content-script marker is present on <html>
     */
    isInstalled() {
      return isExtensionReady || checkDomMarker();
    },

    /**
     * Subscribe to when the extension announces readiness
     */
    onReady(callback) {
      if (this.isInstalled()) {
        callback(extensionInfo || { status: 'ready' });
      }
      READY_LISTENERS.add(callback);
      return () => READY_LISTENERS.delete(callback);
    },

    /**
     * Ping the extension and get current Facebook session + cached accounts status
     */
    async ping() {
      try {
        const res = await sendBridgeRequest({ type: 'PING' }, 5000);
        if (res && res.ok) {
          isExtensionReady = true;
        }
        return res;
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },

    /**
     * SMIT-Connect compatible ping ({ cmd: 'ping' })
     */
    async smitPing() {
      return sendBridgeRequest({ cmd: 'ping' }, 5000);
    },

    /**
     * Get cached extension state (session, accounts, bms, lastUpdated, rates)
     */
    async getState() {
      return sendBridgeRequest({ type: 'GET_STATE' }, 10000);
    },

    /**
     * Trigger a live Facebook GraphQL & Graph API sync through the user's browser session
     */
    async syncAccounts(forceRefresh = true) {
      return sendBridgeRequest({ type: 'SYNC_ACCOUNTS', forceRefresh }, 60000);
    },

    /**
     * Execute a bulk action (ADD_USER, REMOVE_USER, SHARE_PIXEL, RENAME_ACCOUNT, UPDATE_SPEND_CAP)
     */
    async bulkAction(payload) {
      return sendBridgeRequest({ type: 'BULK_ACTION', payload }, 60000);
    },

    /**
     * Fetch users/roles for a specific Ad Account ID
     */
    async fetchAccountUsers(accountId) {
      return sendBridgeRequest({ type: 'FETCH_ACCOUNT_USERS', accountId }, 20000);
    },

    /**
     * Search hidden Facebook Ad Targeting Interests with audience sizes
     */
    async searchInterests(query) {
      return sendBridgeRequest({ type: 'SEARCH_INTERESTS', query }, 20000);
    },

    /**
     * SMIT-Connect compatible raw authenticated fetch via the extension background worker
     */
    async fetch(url, options = {}) {
      return sendBridgeRequest({ cmd: 'fetch', url, options }, 30000);
    },

    /**
     * Get Facebook cookies from the user's browser session via SMIT-Connect execute bridge
     */
    async getFacebookCookies() {
      return sendBridgeRequest(
        { cmd: 'execute', function: 'get_cookie', args: ['https://www.facebook.com'] },
        10000
      );
    },
  };

  global.AdsCheckBridge = AdsCheckBridge;
  global.SMITConnectBridge = AdsCheckBridge;
})(typeof window !== 'undefined' ? window : globalThis);
