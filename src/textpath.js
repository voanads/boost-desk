// Text as SVG outlines, shaped with HarfBuzz (the engine browsers use), so Khmer ad names come out
// right in report pictures. Latin text uses Inter; Khmer text uses Noto Sans Khmer.
const fs = require('fs');
const path = require('path');

const FILES = {
  latin: { 400: 'Inter_400Regular.ttf', 600: 'Inter_600SemiBold.ttf' },
  khmer: { 400: 'NotoSansKhmer_400Regular.ttf', 600: 'NotoSansKhmer_600SemiBold.ttf' },
};
let ready = null;
function load() {
  if (!ready) ready = (async () => {
    const hb = await import('harfbuzzjs');
    const fonts = {};
    for (const [script, byWeight] of Object.entries(FILES)) {
      for (const [w, file] of Object.entries(byWeight)) {
        const buf = fs.readFileSync(path.join(__dirname, '..', 'fonts', file));
        const face = new hb.Face(new hb.Blob(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)));
        fonts[script + w] = { font: new hb.Font(face), upem: face.upem, cache: new Map() };
      }
    }
    return { hb, fonts };
  })();
  return ready;
}

const isKhmer = (cp) => (cp >= 0x1780 && cp <= 0x17ff) || (cp >= 0x19e0 && cp <= 0x19ff) || cp === 0x200b || cp === 0x200c || cp === 0x200d;

// Split into runs of Khmer / other text (spaces and punctuation stay with the run they're in).
function runs(text) {
  const out = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    const k = isKhmer(cp) ? 'khmer' : /[\s.,·:;!?()'"\-–—|/]/.test(ch) && out.length ? out[out.length - 1].script : 'latin';
    if (out.length && out[out.length - 1].script === k) out[out.length - 1].text += ch;
    else out.push({ script: k, text: ch });
  }
  return out;
}

// Shape text → [{d (font units), x (font units, scaled later)}], width in px at `size`.
async function layout(text, size, weight = 400) {
  const { hb, fonts } = await load();
  const w = weight >= 600 ? 600 : 400;
  const glyphs = []; let x = 0;
  for (const r of runs(String(text))) {
    const f = fonts[r.script + w];
    const s = size / f.upem;
    const buf = new hb.Buffer();
    buf.addText(r.text); buf.guessSegmentProperties();
    hb.shape(f.font, buf);
    const infos = buf.getGlyphInfos(), pos = buf.getGlyphPositions();
    infos.forEach((g, i) => {
      const p = pos[i];
      let d = f.cache.get(g.codepoint);
      if (d === undefined) { d = f.font.glyphToPath(g.codepoint) || ''; f.cache.set(g.codepoint, d); }
      if (d) glyphs.push({ d, x: x + p.xOffset * s, y: -p.yOffset * s, s });
      x += p.xAdvance * s;
    });
    buf.destroy && buf.destroy();
  }
  return { glyphs, width: x };
}

// SVG for one line of text. anchor: start | middle | end. Returns '' for empty text.
async function svgText(text, x, y, { size = 16, weight = 400, fill = '#000', anchor = 'start' } = {}) {
  if (!text && text !== 0) return '';
  const { glyphs, width } = await layout(text, size, weight);
  const x0 = anchor === 'end' ? x - width : anchor === 'middle' ? x - width / 2 : x;
  const parts = glyphs.map((g) => `<path transform="translate(${(x0 + g.x).toFixed(2)} ${(y + g.y).toFixed(2)}) scale(${g.s.toFixed(5)} ${(-g.s).toFixed(5)})" d="${g.d}"/>`);
  return `<g fill="${fill}">${parts.join('')}</g>`;
}

// Cut text to fit a width in px, adding "…".
async function fit(text, maxW, size, weight = 400) {
  const seg = new Intl.Segmenter('km', { granularity: 'grapheme' }); // never split a Khmer letter cluster
  const t = [...seg.segment(String(text || ''))].map((x) => x.segment);
  if ((await layout(t.join(''), size, weight)).width <= maxW) return t.join('');
  let lo = 0, hi = t.length;
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if ((await layout(t.slice(0, mid).join('') + '…', size, weight)).width <= maxW) lo = mid; else hi = mid - 1; }
  return t.slice(0, lo).join('').trimEnd() + '…';
}

module.exports = { svgText, fit, layout };
