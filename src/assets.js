// Asset URLs with a content hash: index.html's /assets/x.css?v=… and /assets/x.js?v=… get ?v=<hash of the file>,
// so the browser can keep each file for a year and a deploy that changes a file changes its address.
// The Khmer build of app.js (src/km.js) is served at the same path, so its address carries its own hash (v=km-…).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = path.join(__dirname, '..', 'public', 'assets');
const memo = new Map(); // file → { m, hash }
function hashOf(name) {
  const p = path.join(DIR, name);
  if (path.dirname(p) !== DIR) return null; // assets live directly in public/assets
  try {
    const m = fs.statSync(p).mtimeMs, c = memo.get(name);
    if (c && c.m === m) return c.hash;
    const hash = crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex').slice(0, 12);
    memo.set(name, { m, hash }); return hash;
  } catch (_) { return null; }
}
const kmHash = () => { const b = require('./km').build(); return b ? 'km-' + b.etag.replace(/"/g, '').slice(3, 15) : null; };
const wantsKm = (req) => /(?:^|;\s*)bd_lang=km(?:;|$)/.test((req && req.headers.cookie) || '');

// The version a request for /assets/<name> should carry to be cached for good (null: unknown file).
const versionFor = (name, req) => (name === 'app.js' && wantsKm(req) && kmHash()) || hashOf(name);

function rewrite(html, req) {
  return html.replace(/(["'])\/assets\/([\w.-]+\.(?:js|css))\?v=[^"']*\1/g, (all, q, name) => {
    const v = versionFor(name, req);
    return v ? `${q}/assets/${name}?v=${v}${q}` : all;
  });
}
// Cache-Control for an asset request: a year when it asks for the current version, else always revalidate.
function cacheHeader(req, name) {
  const v = req.query && req.query.v;
  return v && v === versionFor(name, req) ? 'public, max-age=31536000, immutable' : 'no-cache';
}

const page = fs.readFileSync.bind(fs, path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
// One site of the app (index.html with its site name and title), with hashed asset addresses.
const sitePage = (req, site, title) => rewrite(page(), req).replace('<body>', `<body data-site="${site}">`).replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`);

module.exports = { rewrite, cacheHeader, versionFor, sitePage };
