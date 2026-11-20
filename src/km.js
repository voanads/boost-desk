// Khmer build of the front end (owner, 20 Nov 2026): "Khmer = everything Khmer, English = everything English".
// public/assets/app.js is written in English. Phrases with numbers or names inside them cannot be translated word by word
// on screen (i18n.js does that for plain words), so src/km-pairs.json holds [english fragment, khmer fragment] pairs and this
// file swaps them into a copy of app.js. The copy is served instead of app.js to a browser whose cookie says bd_lang=km.
// A pair whose English fragment is no longer in app.js is skipped (that phrase then shows in English) and logged once.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const SRC = path.join(__dirname, '..', 'public', 'assets', 'app.js');
let cache = null;
function build() {
  try {
    const m = fs.statSync(SRC).mtimeMs;
    if (cache && cache.m === m) return cache.ok ? cache : null;
    const pairs = JSON.parse(fs.readFileSync(path.join(__dirname, 'km-pairs.json'), 'utf8')).slice().sort((a, b) => b[0].length - a[0].length);
    let text = fs.readFileSync(SRC, 'utf8'), miss = 0;
    for (const [en, km] of pairs) { if (!text.includes(en)) { miss++; continue; } text = text.split(en).join(km); }
    let ok = true; try { new vm.Script(text, { filename: 'app.km.js' }); } catch (e) { ok = false; console.error('[km] the Khmer build does not parse — serving English:', e.message); }
    cache = { m, ok, text, etag: '"km-' + crypto.createHash('sha1').update(text).digest('hex').slice(0, 20) + '"' };
    console.log(`[km] Khmer build: ${pairs.length - miss} of ${pairs.length} phrases${miss ? ` (${miss} not found in app.js — those show in English)` : ''}`);
    return ok ? cache : null;
  } catch (e) { console.error('[km]', e.message); return null; }
}
module.exports = { build };
