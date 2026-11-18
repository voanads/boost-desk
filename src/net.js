// Network safety, loaded before everything else.
//  1. Every outside call (Meta, Telegram, adsbox, AI) gets a time limit, so one hanging service cannot freeze a job.
//  2. A small in-memory rate limiter for the public addresses (login, public API, webhooks).
const realFetch = global.fetch;
const LIMIT = Number(process.env.FETCH_TIMEOUT_MS) || 60000, UPLOAD = 180000; // uploads (backup file, pictures) may take longer
global.fetch = (url, opts = {}) => {
  if (opts && opts.signal) return realFetch(url, opts); // the caller set its own limit
  const upload = opts && opts.body && typeof opts.body === 'object' && !(opts.body instanceof URLSearchParams);
  return realFetch(url, { ...opts, signal: AbortSignal.timeout(upload ? UPLOAD : LIMIT) }).catch((e) => {
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) { let host = ''; try { host = new URL(String(url)).host; } catch (_) {} const err = new Error(`${host || 'The other service'} did not answer in time. Try again in a minute.`); err.timeout = true; throw err; }
    throw e;
  });
};

// rateLimit(60, 60000): at most 60 requests a minute from one address; more get "429 Too many requests".
function rateLimit(max, windowMs, name = 'x') {
  const hits = new Map();
  const sweep = setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.until <= now) hits.delete(k); }, windowMs); if (sweep.unref) sweep.unref();
  return (req, res, next) => {
    const key = name + ':' + (req.ip || 'unknown'), now = Date.now(); let h = hits.get(key);
    if (!h || h.until <= now) { h = { n: 0, until: now + windowMs }; hits.set(key, h); }
    if (++h.n > max) { res.setHeader('Retry-After', String(Math.ceil((h.until - now) / 1000))); return res.status(429).json({ error: 'Too many requests. Wait a minute and try again.' }); }
    next();
  };
}
// Changes (POST / PUT / PATCH / DELETE) must come from this site's own pages, not from another website.
function sameOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const o = req.get('origin'); if (!o) return next(); // not a browser (or an old one): the session cookie rules still apply
  let host = ''; try { host = new URL(o).host; } catch (_) {}
  if (host && host === req.get('host')) return next();
  res.status(403).json({ error: 'This request came from another website and was blocked.' });
}
module.exports = { rateLimit, sameOrigin };
