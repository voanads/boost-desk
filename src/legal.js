// Public Privacy Policy and Data Deletion pages (no login) — required by Meta to publish the Boost Desk app.
// /privacy and /data-deletion. Plain HTML, English + Khmer summary.
const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · Boost Desk (ADS BOX)</title><link rel="icon" href="/assets/logo.svg">
<style>body{margin:0;font-family:Inter,system-ui,-apple-system,sans-serif;background:#f6f7f9;color:#0f172a;line-height:1.6}
main{max-width:760px;margin:0 auto;padding:40px 20px 64px}h1{font-size:28px;margin:0 0 4px}h2{font-size:18px;margin:28px 0 6px}
.muted{color:#64748b;font-size:14px}a{color:#1d4ed8}ul{padding-left:20px}.box{background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:16px 18px;margin-top:20px}
header{display:flex;align-items:center;gap:10px;margin-bottom:24px}header img{width:36px;height:36px}</style></head>
<body><main><header><img src="/assets/logo.svg" alt=""><b>Boost Desk · ADS BOX</b></header>${body}</main></body></html>`;

const CONTACT = `<p>ADS BOX, TL05, Phum Preysor, Sangkat Dangkao, Khan Dangkao, Phnom Penh, Cambodia · <a href="https://adsbox.agency">adsbox.agency</a></p>`;

const privacy = page('Privacy Policy', `
<h1>Privacy Policy</h1><div class="muted">Last updated: 20 November 2026</div>
<p>Boost Desk is an internal tool of ADS BOX, a Facebook advertising agency in Cambodia. Our team uses it to run and report Facebook boosts for our clients. It is not offered to the public.</p>
<h2>What we receive from Meta</h2>
<ul>
<li><b>Facebook login:</b> the name, Facebook ID and profile picture of team members who log in.</li>
<li><b>Ad accounts</b> (ads_read, business_management): campaigns, spend and results of the ad accounts our team manages, to report to our clients.</li>
<li><b>Pages</b> (pages_show_list, pages_messaging, pages_read_engagement, pages_manage_metadata, pages_read_user_content): for Pages our team manages for clients, new Messenger messages and comments (including comments on Live videos) are read automatically to count how many customers placed an order — a message or comment that contains a phone number counts as one order.</li>
</ul>
<h2>What we keep</h2>
<ul>
<li>Only <b>daily order counts per Page</b> (for example "12 orders today, 3 from comments"). We do <b>not</b> store message text, comments, customer names, phone numbers or addresses.</li>
<li>To avoid counting the same customer twice in one day and to tell new from returning customers, we keep a one-way keyed hash of the phone number and of the sender's Page-scoped ID. It cannot be turned back into the number or the person.</li>
<li>Page access tokens are stored encrypted and are used only for the purposes above.</li>
</ul>
<h2>What we don't do</h2>
<ul><li>We do not sell or share any data with third parties, do not use it for advertising profiles, and do not send messages to customers.</li></ul>
<h2>How long</h2>
<p>Order counts and spend are kept as long as we serve the client, for reporting. A Page can be disconnected at any time (Boost Desk → Orders → Pages → Remove, or by removing the app in Facebook settings); after that no new data is read.</p>
<h2>Your choices and deletion</h2>
<p>See <a href="/data-deletion">Data deletion</a>.</p>
<h2>Contact</h2>${CONTACT}
<div class="box"><b>សង្ខេបជាភាសាខ្មែរ</b><br>Boost Desk ជាឧបករណ៍ផ្ទៃក្នុងរបស់ ADS BOX។ វាអានសារ Messenger និង comment ថ្មីរបស់ Page ដែលក្រុមយើងគ្រប់គ្រង ដើម្បីរាប់ចំនួន order តែប៉ុណ្ណោះ។ យើងមិនរក្សាទុកសារ ឈ្មោះ លេខទូរស័ព្ទ ឬអាសយដ្ឋានអតិថិជនទេ ហើយមិនចែករំលែកទិន្នន័យឲ្យអ្នកណាទេ។</div>`);

const deletion = page('Data deletion', `
<h1>Data deletion</h1><div class="muted">Boost Desk · ADS BOX</div>
<p>Boost Desk does not store message text, customer names, phone numbers or addresses — only daily order counts and one-way hashes (see the <a href="/privacy">Privacy Policy</a>).</p>
<h2>To stop and delete data</h2>
<ol>
<li><b>Remove the app:</b> Facebook → Settings &amp; privacy → Settings → Business integrations (or Apps and websites) → Boost Desk → Remove. For a Page: Page settings → Business integrations → Remove. Boost Desk then can no longer read anything.</li>
<li><b>Ask us to delete what is stored:</b> send a message to the ADS BOX Facebook Page or contact us at the address below with the Facebook account or Page name. We delete the account's login data, its Page tokens and the Page's order counts and hashes within 30 days and confirm when it is done.</li>
</ol>
<h2>Contact</h2>${CONTACT}
<div class="box"><b>ការលុបទិន្នន័យ</b><br>ដក app Boost Desk ចេញពី Facebook settings ឬផ្ញើសារមក Page ADS BOX ដោយប្រាប់ឈ្មោះគណនី ឬ Page។ យើងនឹងលុបទិន្នន័យក្នុងរយៈពេល ៣០ ថ្ងៃ។</div>`);

module.exports = (app) => {
  app.get(['/privacy', '/privacy-policy'], (req, res) => res.set('Cache-Control', 'public, max-age=300').type('html').send(privacy));
  app.get('/data-deletion', (req, res) => res.set('Cache-Control', 'public, max-age=300').type('html').send(deletion));
};
