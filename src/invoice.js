// Service invoices (e.g. monthly Page management fee): drawn as an A4 SVG that follows the Ads Box
// invoice layout, then turned into a PDF (vector) or a PNG preview. Text is shaped with HarfBuzz
// (see textpath.js) so Khmer descriptions come out right.
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const SVGtoPDF = require('svg-to-pdfkit');
const { Resvg } = require('@resvg/resvg-js');
const { svgText, fit } = require('./textpath');

const asset = (f) => { try { return 'data:image/png;base64,' + fs.readFileSync(path.join(__dirname, '..', 'invoice-assets', f)).toString('base64'); } catch (_) { return ''; } };
// Company details printed on every invoice. Each account can change them in Payments → Invoice settings.
const DEFAULT_PROFILE = {
  company: 'ADS BOX',
  address1: 'Building CEO, Street 217, Phum Morl ,Sangkat Dangkao,',
  address2: 'Khan Dangkao, Phnom Penh.',
  phone: 'Phone : (855) 61 713 148',
  bankName: 'Advanced Bank of Asia Ltd.',
  accountName: 'DORN SOVANDARA AND HOR VANNAK',
  accountNo: '009 012 686',
  seller: 'Hor Vannak',
  issuedBy: 'Accountant',
  logo: asset('logo.png'), qr: asset('qr.png'), sign: '',
};
const profileOf = (saved) => { const p = { ...DEFAULT_PROFILE }; for (const [k, v] of Object.entries(saved || {})) if (v != null && (v !== '' || k === 'sign' || k === 'qr' || k === 'logo')) p[k] = v; if (!p.logo) p.logo = DEFAULT_PROFILE.logo; return p; };

// Telegram message sent with an invoice. Words in {curly brackets} are filled in for each invoice.
const DEFAULT_MESSAGE = ['សួស្តីបង', '', 'ខាងប្អូនចង់ជម្រាប សេវាកម្មបងត្រូវដល់ថ្ងៃបង់', 'នៅថ្ងៃទី {date} ។', '', 'តម្លៃសេវាកម្ម =$ {price}', 'Page : {pages}', '', '', 'ទឹកប្រាក់ត្រូវបង់ =$ {total}', '', 'សូមអរគុណ!🙏🏼'].join('\n');
const usd = (n) => { const v = Math.round((Number(n) || 0) * 100) / 100; return Number.isInteger(v) ? String(v) : v.toFixed(2); };
// values: what each {word} becomes. Unknown words are left as typed.
function fillMessage(template, values) {
  return String(template || DEFAULT_MESSAGE).replace(/\{(\w+)\}/g, (m, k) => (k in values ? String(values[k]) : m)).slice(0, 1024);
}
function messageValues(inv, payDay) {
  const ym = inv.date.slice(0, 7), last = new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0).getDate();
  const day = payDay ? Math.min(payDay, last) : Number(inv.date.slice(8)), dmy = (d) => `${String(d).padStart(2, '0')}/${ym.slice(5, 7)}/${ym.slice(0, 4)}`;
  const it = (inv.items || [])[0] || { price: inv.total, qty: 1, description: '' };
  return {
    date: dmy(day), invoice_date: dmy(Number(inv.date.slice(8))), price: usd(it.price), pages: (inv.items || []).reduce((a, x) => a + (Number(x.qty) || 0), 0) || 1,
    total: usd(inv.total), discount: usd(inv.discount), subtotal: usd((Number(inv.total) || 0) + (Number(inv.discount) || 0)),
    customer: inv.customer || '', company: inv.company || '', number: inv.number || '', service: it.description || '',
  };
}
const BLUE = '#2E5FA3', INK = '#111111';
const money = (n) => '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const plain = (n) => (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const niceDate = (d) => { const [y, m, dd] = String(d).split('-').map(Number); return `${String(dd).padStart(2, '0')}-${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]}-${y}`; };
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Totals for an invoice's items (max 6 lines, like the paper form).
function totals(inv) {
  const items = (inv.items || []).slice(0, 6).map((it) => ({ description: String(it.description || ''), qty: Number(it.qty) || 0, price: round2(it.price), amount: round2((Number(it.qty) || 0) * (Number(it.price) || 0)) }));
  const subtotal = round2(items.reduce((a, it) => a + it.amount, 0)), discount = Math.min(subtotal, Math.max(0, round2(inv.discount)));
  return { items, subtotal, discount, total: round2(subtotal - discount) };
}

async function svg(inv, saved) {
  const p = profileOf(saved), t = totals(inv), W = 595.28, H = 841.89;
  const S = (s, x, y, o = {}) => svgText(s, x, y, { family: 'serif', fill: INK, ...o });   // serif, like the paper invoice
  const N = (s, x, y, o = {}) => svgText(s, x, y, { fill: INK, ...o });                     // sans for numbers / values
  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="#fff"/>`);
  // header
  if (p.logo) out.push(`<image x="33" y="42" width="55" height="58" preserveAspectRatio="xMidYMid meet" href="${p.logo}" xlink:href="${p.logo}"/>`);
  out.push(await S(p.company, W / 2, 60, { size: 17, weight: 700, fill: BLUE, anchor: 'middle' }));
  out.push(await S(p.address1, W / 2, 79, { size: 7.5, fill: BLUE, anchor: 'middle' }));
  out.push(await S(p.address2, W / 2, 95, { size: 7.5, fill: BLUE, anchor: 'middle' }));
  out.push(await S(p.phone, W / 2, 111, { size: 7.5, fill: BLUE, anchor: 'middle' }));
  out.push(`<line x1="31" y1="119" x2="563" y2="119" stroke="#1F4E8C" stroke-width="1.6"/>`);
  out.push(await S('INVOICE', W / 2, 146, { size: 14, weight: 700, fill: BLUE, anchor: 'middle' }));
  // bill to
  out.push(await S('Bill To', 33, 179, { size: 9, weight: 700 }));
  const bill = [['Customer', inv.customer], ['Company Name', inv.company], ['Phone', inv.phone]];
  for (const [i, [k, v]] of bill.entries()) {
    const y = 196 + i * 17;
    out.push(await S(k, 33, y, { size: 8.5, weight: 700 }), await S(':', 105, y, { size: 8.5, weight: 700 }));
    out.push(await S(await fit(v || '', 270, 8.5, 700, 'serif'), 111, y, { size: 8.5, weight: 700 }));
  }
  const meta = [['Invoice N°', inv.number], ['Invoice Date', niceDate(inv.date)], ['Issued By', p.issuedBy]];
  for (const [i, [k, v]] of meta.entries()) {
    const y = 179 + i * 17;
    out.push(await S(k, 398, y, { size: 9, weight: 700 }), await S(':', 463, y, { size: 9, weight: 700 }), await N(v || '', 470, y, { size: 9 }));
  }
  // items table
  const X = [31, 63, 332, 397, 468, 563], top = 256, hh = 27, rh = 30.4, rows = 6;
  out.push(`<rect x="${X[0]}" y="${top}" width="${X[5] - X[0]}" height="${hh}" fill="#5B87C5"/>`);
  const heads = ['N°', 'Description', 'Quantity', 'Unit Price', 'Amount'];
  for (const [i, h] of heads.entries()) out.push(await S(h, (X[i] + X[i + 1]) / 2, top + 17.5, { size: 10, weight: 700, anchor: 'middle' }));
  for (let r = 0; r < rows; r++) {
    const y = top + hh + r * rh, it = t.items[r], mid = y + rh / 2 + 3;
    out.push(await N(String(r + 1), (X[0] + X[1]) / 2, mid, { size: 8.5, anchor: 'middle' }));
    if (it && (it.description || it.amount)) {
      out.push(await N(await fit(it.description, X[2] - X[1] - 10, 9), X[1] + 5, mid, { size: 9 }));
      out.push(await N(String(it.qty), (X[2] + X[3]) / 2, mid, { size: 8.5, anchor: 'middle' }));
      out.push(await N(money(it.price), (X[3] + X[4]) / 2, mid, { size: 8.5, anchor: 'middle' }));
    }
    out.push(await N(money(it ? it.amount : 0), X[5] - 4, mid, { size: 8.5, anchor: 'end' }));
  }
  const bottom = top + hh + rows * rh;
  let grid = '';
  for (const x of X) grid += `M${x} ${top}V${bottom}`;
  grid += `M${X[0]} ${top}H${X[5]}M${X[0]} ${top + hh}H${X[5]}`;
  for (let r = 1; r <= rows; r++) grid += `M${X[0]} ${top + hh + r * rh}H${X[5]}`;
  out.push(`<path d="${grid}" fill="none" stroke="#000" stroke-width="0.75"/>`);
  // totals
  const tot = [['SUBTOTAL', plain(t.subtotal), 9, 400], ['DISCOUNT', t.discount ? plain(t.discount) : '-', 9, 400], ['TOTAL', plain(t.total), 7.5, 700]];
  for (const [i, [k, v, size, weight]] of tot.entries()) {
    const y = bottom + i * 27;
    out.push(`<rect x="${X[4]}" y="${y}" width="${X[5] - X[4]}" height="27" fill="none" stroke="#000" stroke-width="0.75"/>`);
    out.push(await S(k, X[4] - 6, y + 17, { size, weight, anchor: 'end' }));
    out.push(await N('$', X[4] + 10, y + 17.5, { size: 10, weight: 600 }), await N(v, X[5] - 10, y + 17.5, { size: 10, weight: 600, anchor: 'end' }));
  }
  // payment method
  const py = bottom + 12;
  out.push(`<rect x="31" y="${py}" width="333" height="150" rx="22" fill="none" stroke="#4A7CC7" stroke-width="1.5"/>`);
  out.push(await S('Payment Method', 197, py + 22, { size: 11, weight: 700, fill: BLUE, anchor: 'middle' }), `<line x1="152" y1="${py + 25}" x2="242" y2="${py + 25}" stroke="${BLUE}" stroke-width="0.9"/>`);
  const an = String(p.accountName || ''), cut = an.length > 22 ? an.lastIndexOf(' ', an.toUpperCase().indexOf(' AND ') > 0 ? an.toUpperCase().indexOf(' AND ') + 4 : 22) : -1;
  const an1 = cut > 0 ? an.slice(0, cut) : an, an2 = cut > 0 ? an.slice(cut + 1) : '';
  out.push(await S('Bank Name', 43, py + 59, { size: 8, weight: 700 }), await S(':', 101, py + 59, { size: 8, weight: 700 }), await S(p.bankName, 109, py + 59, { size: 8, weight: 700 }));
  out.push(await S('Account Name :', 43, py + 83, { size: 8, weight: 700 }), await S(an1, 111, py + 83, { size: 8, weight: 700 }));
  if (an2) out.push(await S(an2, 111, py + 94, { size: 8, weight: 700 }));
  out.push(await S('Account No', 43, py + 116, { size: 8, weight: 700 }), await S(':', 101, py + 116, { size: 8, weight: 700 }), await S(p.accountNo, 109, py + 116, { size: 9.5, weight: 700 }));
  if (p.qr) out.push(`<image x="252" y="${py + 16}" width="84" height="122" preserveAspectRatio="xMidYMid meet" href="${p.qr}" xlink:href="${p.qr}"/>`);
  // signatures
  out.push(`<line x1="93" y1="737" x2="183" y2="737" stroke="#000" stroke-width="0.6" stroke-dasharray="1 2"/>`);
  out.push(await S('Customer Signature & Name', 138, 749, { size: 8, anchor: 'middle' }));
  if (p.sign) out.push(`<image x="424" y="696" width="84" height="26" preserveAspectRatio="xMidYMid meet" href="${p.sign}" xlink:href="${p.sign}"/>`);
  out.push(await S(p.seller, 466, 735, { size: 8, anchor: 'middle' }), await S("Seller's Signature & Name", 466, 750, { size: 8, anchor: 'middle' }));
  out.push(await S('THANK YOU FOR YOUR BUSINESS !', W / 2, 788, { size: 7.5, weight: 700, anchor: 'middle' }));
  out.push('</svg>');
  return out.join('');
}

async function pdf(inv, saved) {
  const s = await svg(inv, saved);
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0, info: { Title: `Invoice ${inv.number}`, Author: profileOf(saved).company } });
    const chunks = []; doc.on('data', (c) => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    try { SVGtoPDF(doc, s, 0, 0, { width: 595.28, height: 841.89, assumePt: true }); doc.end(); } catch (e) { reject(e); }
  });
}
async function png(inv, saved, width = 1240) {
  return new Resvg(await svg(inv, saved), { font: { loadSystemFonts: false }, fitTo: { mode: 'width', value: width } }).render().asPng();
}

module.exports = { DEFAULT_MESSAGE, fillMessage, messageValues, svg, pdf, png, totals, profileOf, DEFAULT_PROFILE, niceDate, money };
