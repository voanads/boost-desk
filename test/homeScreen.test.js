// Add to Home Screen: each site has its own manifest that opens that site, with PNG icons that exist.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const A = path.join(__dirname, '..', 'public', 'assets');
for (const [site, start] of [['admin', '/admin'], ['pm', '/projectmanager'], ['mb', '/mediabuyer'], ['owner', '/owner']]) {
  const m = JSON.parse(fs.readFileSync(path.join(A, `app-${site}.webmanifest`), 'utf8'));
  assert.strictEqual(m.start_url, start, site); assert.strictEqual(m.display, 'standalone'); assert.ok(m.short_name.length <= 15, 'short name fits under an icon');
  for (const i of m.icons) assert.ok(fs.existsSync(path.join(A, path.basename(i.src))), i.src);
  assert.ok(m.icons.some((i) => i.sizes === '192x192') && m.icons.some((i) => i.sizes === '512x512'), 'Android needs 192 and 512');
}
assert.ok(fs.existsSync(path.join(A, 'icon-180.png')), 'iPhone icon');
const { sitePage } = require('../src/assets');
const req = { headers: {}, get: () => '' };
const admin = sitePage(req, 'admin', 'Ads Box · Admin');
assert.ok(admin.includes('/assets/app-admin.webmanifest') && admin.includes('content="Ads Box Admin"') && !admin.includes('app-pm.webmanifest'));
assert.ok(sitePage(req, 'pm', 'x').includes('/assets/app-pm.webmanifest'));
for (const f of ['index.html', 'admin-login.html', 'login.html']) assert.ok(/rel="apple-touch-icon"/.test(fs.readFileSync(path.join(A, '..', f), 'utf8')), f);
console.log('homeScreen ok');
