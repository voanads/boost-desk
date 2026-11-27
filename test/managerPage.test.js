// The manager's phone page (/admin/m) is one HTML string with its script inline: make sure the script still parses
// (escaping inside a template string is easy to break) and the page links its manifest.
const assert = require('assert');
const vm = require('vm');
const h = require('../src/managerPage').html();
const s = h.slice(h.indexOf('<script>') + 8, h.lastIndexOf('</script>'));
assert.ok(s.length > 1000, 'script is there');
new vm.Script(s); // throws on a syntax error
assert.ok(!/\$\{/.test(s), 'no leftover ${} from the template');
assert.ok(h.includes('/admin/m/manifest.webmanifest') && h.includes('viewport-fit=cover'));
for (const tab of ['today', 'teams', 'ads']) assert.ok(h.includes(`data-tab="${tab}"`), tab);
console.log('managerPage ok');
