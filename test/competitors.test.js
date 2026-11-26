// Competitor research: which links and pictures are accepted. No database needed.
process.env.DATABASE_URL ||= 'postgres://test/test';
process.env.SESSION_SECRET ||= 'x'; process.env.ENCRYPTION_KEY ||= '0'.repeat(64); process.env.FB_APP_ID ||= '1'; process.env.FB_APP_SECRET ||= 'x';
const assert = require('assert');
const { okLink, okImg } = require('../src/competitors');

for (const u of ['', 'https://www.facebook.com/dcshop', 'https://m.facebook.com/profile.php?id=1', 'https://fb.com/x', 'https://www.tiktok.com/@shop', 'https://instagram.com/shop']) assert.ok(okLink(u), u);
for (const u of ['http://facebook.com/x', 'https://evil.com/facebook.com/', 'javascript:alert(1)', 'https://facebook.com.evil.com/x', 'facebook.com/x']) assert.ok(!okLink(u), u);
assert.ok(okImg('data:image/jpeg;base64,/9j/4AAQ'));
assert.ok(!okImg('data:image/svg+xml;base64,PHN2Zz4='), 'no SVG (could carry script)');
assert.ok(!okImg('data:image/jpeg;base64,' + 'A'.repeat(460000)), 'too big');
assert.ok(!okImg('https://example.com/a.jpg'), 'only uploaded pictures');
console.log('competitors ok');
