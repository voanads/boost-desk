// Phone detection for Boost Desk's own order counting. Cases from adsbox.biz's examples/test-cases.md (all numbers fake).
// Run: npm test
const assert = require('assert');
const { normalizePhone, extractPhone } = require('../src/orderDetect');

const accept = {
  '012345678': '012345678', '០១២៣៤៥៦៧៨': '012345678', '០១២ ៣៤៥ ៦៧៨': '012345678', '012-345-678': '012345678',
  '012 345 678': '012345678', '+855 12 345 678': '012345678', '85512345678': '012345678', 'O12345678': '012345678',
  '0123456789': '0123456789',
};
for (const [i, want] of Object.entries(accept)) assert.strictEqual(normalizePhone(i), want, 'normalizePhone ' + i);
// '12O345678' is listed as accept in adsbox's doc, but its own PHP turns it into 120345678 and rejects it (no leading 0).
assert.strictEqual(normalizePhone('12O345678'), '');
for (const i of ['$15', '15', '50000', '123456789', '2026-11-19', '855000', '']) assert.strictEqual(normalizePhone(i), '', 'reject ' + i);

const found = {
  '០១២ ៣៤៥ ៦៧៨': '012345678',
  'A001 x2 012345678 ផ្ទះលេខ 39 ច្បារអំពៅ': '012345678',
  'យក1ប្រអប់ ច្បារអំពៅ 0968888888': '0968888888',
  '012345678 តើនៅទេ?': '012345678',
  'លេខ +855 97 111 2222 បង': '0971112222',
  'call O12 345 678': '012345678',
  'សុំ ២ ឈុត ០៨៨៧៧៧៦៦៦': '088777666',
};
for (const [i, want] of Object.entries(found)) assert.strictEqual(extractPhone(i), want, 'extractPhone ' + i);
for (const i of ['A001', 'បង ១ សុំមួយ', 'តម្លៃ $15', '50000៛', 'ថ្ងៃ 2026-11-19', '01234567', '0123456789012', 'Orussey market', 'hello', '']) assert.strictEqual(extractPhone(i), null, 'no phone in ' + i);

console.log('orderDetect: all phone cases pass');
