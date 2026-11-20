// Finds a customer's phone number in a Messenger message or a comment — the same rules adsbox.biz uses
// (how_we_detected_order, Nov 2026), ported from PHP. Rule: no phone = no order. Pure functions, no database.

const KHMER_DIGITS = { '០': '0', '១': '1', '២': '2', '៣': '3', '៤': '4', '៥': '5', '៦': '6', '៧': '7', '៨': '8', '៩': '9' };

// Khmer numerals → 0-9, and a letter O next to a digit → 0 ("O12345678", "12O345678"). A word like "Orussey" is left alone.
function normalizeDigits(s) {
  return String(s || '')
    .replace(/[០-៩]/g, (c) => KHMER_DIGITS[c])
    .replace(/(?<=\d)[Oo]|[Oo](?=\d)/g, '0');
}

// One comparable form: "+855 12 345 678", "85512345678" and "012-345-678" all become "012345678".
// Anything that does not start with 0 is not a Cambodian phone (prices, dates, ids, product codes) → ''.
function normalizePhone(phone) {
  let p = normalizeDigits(phone).replace(/\D/g, '');
  if (!p) return '';
  if (p.startsWith('855') && p.length >= 11) p = '0' + p.slice(3); // only when long enough to really be +855 (so "855000" stays a price)
  return p[0] === '0' ? p : '';
}

// First match wins, like the adsbox.biz webhook.
const PATTERNS = [
  /\b(0\d{8,9})\b/,                              // 0xxxxxxxx(x)
  /[^\d](0\d{8,9})(?:[^\d]|$)/,                  // after a non-digit
  /^(0\d{8,9})(?!\d)/,                           // at the start (not the first digits of a longer number)
  /\b(0\d{2}[\s\-]?\d{3}[\s\-]?\d{3,4})\b/,      // with spaces or dashes
  /(\+855\s?\d{2}\s?\d{3}\s?\d{3,4})/,           // +855 12 345 678
  /\b(855\d{8,9})\b/,                            // 85512345678
  /\b(\d{3}[\s\-.]\d{3}[\s\-.]\d{3,4})\b/,       // xxx-xxx-xxx(x)
];
const MIN = 9, MAX = 12;

function extractPhone(text) {
  const s = normalizeDigits(text);
  if (!s.trim()) return null;
  for (const re of PATTERNS) {
    const m = s.match(re); if (!m) continue;
    const p = normalizePhone(m[1]);
    if (p.length >= MIN && p.length <= MAX) return p;
  }
  return null;
}

module.exports = { normalizeDigits, normalizePhone, extractPhone };
