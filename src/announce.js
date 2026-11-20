// One-off announcement to every PM and media buyer who linked Telegram (owner's request, 19 Nov 2026). Sent once.
const db = require('./db');
const telegram = require('./telegram');
const buyers = require('./buyers');

const KEY = 'announce-2026-11-19';
const TEXT = `📢 Boost Desk — មុខងារថ្មី (19 វិច្ឆិកា 2026)

សួស្ដីក្រុមការងារទាំងអស់គ្នា 🙏
ចាប់ពីថ្ងៃនេះ Boost Desk ផ្ដោតលើការមើលថែភ្ញៀវ។ KPI និង Task ប្រចាំថ្ងៃ សូមបំពេញក្នុង GenZ KPI។

🟢🟡🔴 1. ស្ថានភាពភ្ញៀវ
• Dashboard មានផ្នែក «Clients today»៖ ភ្ញៀវនីមួយៗមានពណ៌ បៃតង (ល្អ), លឿង (ត្រូវមើល), ក្រហម (មានបញ្ហា)។
• ក្រហម = Ad account ត្រូវបិទ, បង់ប្រាក់បរាជ័យ, Plan ថា Boost ថ្ងៃនេះតែគ្មានចំណាយ (ក្រោយម៉ោង 14:00), ឬចំណាយលើស Plan។
• សូមចុច «Checked» ពេលបានពិនិត្យភ្ញៀវ ហើយចុច «I'm on it» ពេលកំពុងដោះស្រាយបញ្ហា។

🔔 2. សារ Telegram
• ពេលភ្ញៀវឡើងក្រហម MB និង PM ទទួលសារភ្លាម។ សូមចុច «ខ្ញុំកំពុងមើល»។
• បើគ្មានអ្នកចុចក្នុង 30 នាទី សារទៅថ្នាក់ដឹកនាំ។
• ម៉ោង 8:00៖ សារព្រឹកបង្ហាញភ្ញៀវដែលត្រូវមើលមុនគេ។
• ម៉ោង 9:00៖ PM ទទួលសាររំលឹក Plan ដែលជិតចប់ ដើម្បីទាក់ទងភ្ញៀវ។

📣 3. Boost plan
• បន្ថែម post ទៅ Plan ដែលកំពុងដើរ៖ ចុច «Edit» (កុំចុច «New plan»)។
• ពេលចុច «Send plan» អាចជ្រើស post ដែលចង់ផ្ញើ។ តម្លៃសរុបគិតតែ post ដែលធីក។
• Plan ចាស់មិនបាត់ទៀតទេ៖ វានៅក្រោម «Past plans» ហើយយកមកវិញបាន។

📨 4. របាយការណ៍ជូនភ្ញៀវ
• Auto report មិនផ្ញើទេ បើទាញលេខថ្មីពី Meta មិនបាន។ វាសាកម្ដងទៀត ហើយប្រាប់ PM។
• អាចបើករបាយការណ៍ប្រចាំសប្ដាហ៍ (ថ្ងៃច័ន្ទ) និងប្រចាំខែ (ថ្ងៃទី 1) ក្នុង Auto report។

🤖 5. យុទ្ធសាស្ត្រ AI ប្រចាំសប្ដាហ៍
• ក្នុងទំព័រភ្ញៀវ ផ្នែក «Weekly strategy»៖ PM បើក «Every Monday» សម្រាប់ភ្ញៀវដែលចង់បាន។
• AI សរសេរផែនការខ្លី និងសកម្មភាព 3 ជាខ្មែរ និង English។
• វាជា draft សម្រាប់ក្រុម។ ភ្ញៀវទទួលតែពេល PM អាន កែ ហើយចុចផ្ញើ។

👥 6. ភ្ញៀវ
• ភ្ញៀវឈ្មោះស្ទួនត្រូវបានបញ្ចូលជាមួយហើយ។ ចាប់ពីនេះ បង្កើតភ្ញៀវឈ្មោះដែលមានរួចមិនបានទេ។
• ទំព័រភ្ញៀវមានផ្ទាំង «Status today» និងប្រវត្តិ៖ អ្នកណាពិនិត្យ ពេលណា។
• Dashboard បង្ហាញរូប Page របស់ភ្ញៀវ។

✅ អ្វីដែលសុំឱ្យធ្វើរាល់ថ្ងៃ
1. ព្រឹក៖ បើក «Clients today» ហើយមើលភ្ញៀវក្រហម និងលឿងមុន។
2. ពិនិត្យភ្ញៀវរួច ចុច «Checked»។
3. ទទួលសារ 🔴 ចុច «ខ្ញុំកំពុងមើល» ហើយដោះស្រាយ។

បើឃើញសារ ឬលេខណាខុស សូមថត screenshot ហើយផ្ញើជូន PM ឬថ្នាក់ដឹកនាំ។ អរគុណ 🙏`;

async function run(log = console.log) {
  if (!telegram.hasBot() || (await db.getSetting(KEY, null))) return null;
  await db.setSetting(KEY, { at: new Date().toISOString(), running: true }); // claim first: never twice
  const to = new Map();
  for (const u of await db.allUsers()) { const c = await db.getUserSetting(u.fb_id, 'tgChat', null); if (c && c.id) to.set(String(c.id), `PM ${u.name}`); }
  for (const b of await buyers.list()) if (b.chat && !to.has(String(b.chat))) to.set(String(b.chat), `MB ${b.name}`);
  const sent = [], failed = [];
  for (const [chat, who] of to) { try { await telegram.send(TEXT, chat); sent.push(who); } catch (e) { failed.push(`${who} (${e.message})`); } await new Promise((ok) => setTimeout(ok, 400)); }
  log(`[announce] sent to ${sent.length}: ${sent.join(', ')}${failed.length ? ` — failed ${failed.length}: ${failed.join('; ')}` : ''}`);
  await db.setSetting(KEY, { at: new Date().toISOString(), sent, failed });
  return { sent, failed };
}

// Second one-off (owner's request, 20 Nov 2026): how to use the three cards of the Dashboard. Asked for after midnight, so it
// goes out in the morning (from 08:10 Phnom Penh time), not at night. Sent once.
const KEY2 = 'guide-2026-11-20';
const GUIDE = `📘 Boost Desk — របៀបប្រើ 3 ប្រអប់លើ Dashboard

Dashboard ឥឡូវមាន 3 ប្រអប់ជាប់គ្នា៖ Clients today · My tasks today · Handoff

━━━━━━━━━━
1️⃣ Clients today — ស្ថានភាពភ្ញៀវ
• Tab «Boosting now»៖ ភ្ញៀវដែលកំពុង Boost (មានចំណាយថ្ងៃនេះ ឬម្សិលមិញ ឬ Plan ត្រូវដើរថ្ងៃនេះ)។
  🔴 urgent = ធ្វើឥឡូវ · 🟠 to watch = មើលថ្ងៃនេះ · 🟢 fine = ល្អ
• ជួរភ្ញៀវបង្ហាញ៖ មូលហេតុ, ចំណាយថ្ងៃនេះ, តម្លៃក្នុងមួយលទ្ធផល, % នៃ Plan។
• ភ្ញៀវ 🔴៖ ចុច «I'm on it» ពេលចាប់ផ្ដើមដោះស្រាយ។
• ពិនិត្យភ្ញៀវរួច៖ ចុច «Checked»។
• Tab «Not boosting»៖ ភ្ញៀវដែលឈប់ Boost។ មើលស្លាកតាមដាន៖ «ទារប្រាក់ដែលលើស», «ស្នើ Plan ថ្មី», «ទាក់ទងសួរបន្ត»។
• ចុចឈ្មោះភ្ញៀវ ដើម្បីបើកទំព័ររបស់គាត់។

━━━━━━━━━━
2️⃣ My tasks today — ការងារលើភ្ញៀវថ្ងៃនេះ
របៀបដាក់ការងារ (PM)៖
1. ចូល Clients → បើកភ្ញៀវ → ផ្នែក «Clients Task»
2. វាយការងារ ឧ. «Boost post ថ្មី $10»
3. ជ្រើសអ្នកធ្វើ៖ «Media buyer» ឬ «Me»
4. ចុច «Add»
• ការងាររបស់អ្នកចេញក្នុង «My tasks today»។ ធ្វើរួច ធីកប្រអប់។
• Tab៖ Open (មិនទាន់រួច) · Done (រួច) · All

━━━━━━━━━━
3️⃣ Handoff — ប្រគល់ការងារ MB ↔ PM
សម្រាប់ MB៖
• 08:00 bot ផ្ញើសារព្រឹក៖ ស្ថានភាពភ្ញៀវ, កំណត់ចំណាំពី PM, ការងារថ្ងៃនេះ។
• 16:45 bot សួររកកំណត់ចំណាំ។ គ្រាន់តែវាយឆ្លើយ bot ក្នុង Telegram (ឬវាយក្នុងប្រអប់ Handoff)៖ អ្វីធ្វើរួច, អ្វីនៅសល់, អ្វី PM ត្រូវប្រយ័ត្នយប់នេះ។
សម្រាប់ PM៖
• «What your media buyer did today»៖ ការងារដែលអ្នកប្រគល់ឱ្យ MB និងមួយណារួច។
• «Note for tonight»៖ កំណត់ចំណាំពី MB។
• «Your note for your media buyer»៖ វាយអ្វីដែល MB ត្រូវធ្វើមុនគេស្អែក (មួយបន្ទាត់មួយចំណុច) → «Save note»។ MB ទទួលម៉ោង 08:00។

━━━━━━━━━━
✅ ទម្លាប់ប្រចាំថ្ងៃ
MB ព្រឹក៖ អានសារ 08:00 → មើល 🔴🟠 ក្នុង Clients today → ធ្វើការងារ ហើយធីក → 16:45 សរសេរកំណត់ចំណាំ។
PM ល្ងាច៖ អានកំណត់ចំណាំ MB → ពិនិត្យភ្ញៀវ ចុច «Checked» → ដាក់ការងារ និងកំណត់ចំណាំសម្រាប់ស្អែក។

បើប្រអប់ណាទទេ មានន័យថាថ្ងៃនេះមិនទាន់មាននរណាដាក់ការងារ ឬកំណត់ចំណាំទេ។`;

// Sent just before the guide (owner's request, 20 Nov morning): everything that is new since the 19 Nov announcement.
const NEWS = `📢 Boost Desk — មុខងារថ្មីបន្ថែម (20 វិច្ឆិកា 2026)

សួស្ដីក្រុមការងារ 🙏 នេះជាអ្វីដែលថ្មីចាប់ពីម្សិលមិញ និងរបៀបប្រើ។ សារទី 2 បន្ទាប់ពីនេះពន្យល់ 3 ប្រអប់លើ Dashboard។

━━━━━━━━━━
🆕 1. ទំព័រ «Boosts» — ជំនួសតារាងស្ថានភាពចាស់ (Google Sheet)
ចូល Clients → ចុច «Boosts» ខាងលើ។
• មួយជួរក្នុងមួយ post៖ Post, Client, $/ថ្ងៃ, Ad account, Start, End, ថ្ងៃនៅសល់, State, ចំណាយថ្ងៃនេះ, % នៃ Plan។
• State បំពេញដោយខ្លួនឯង៖ New · Active · No spend (ក្រហម) · Ended។ មិនបាច់កែដោយដៃទេ។
• Tab៖ Running · Ended · All។ ស្វែងរកតាម post, ភ្ញៀវ ឬ ad account។

➕ របៀបបញ្ចូល post ថ្មី (2 វិធី)
ក) «Found on Meta today, not in a plan»៖ ប្រព័ន្ធរកឃើញ campaign ដែលកំពុងចំណាយ តែមិនទាន់មានក្នុង Plan។ ចុច «Add to plan» → វាយតែ $/ថ្ងៃ និងចំនួនថ្ងៃ → «Add to the plan»។
ខ) «+ Add boost»៖ សម្រាប់ post ដែលមិនទាន់ចាប់ផ្ដើម។ ជ្រើសភ្ញៀវ, វាយ post, $/ថ្ងៃ, ចំនួនថ្ងៃ, ថ្ងៃចាប់ផ្ដើម, Ad account។

⚠️ សំខាន់៖ ភ្ញៀវដែលកំពុង Boost ត្រូវមាន Plan។ បើគ្មាន Plan ប្រព័ន្ធមិនដឹងថ្ងៃចប់ និង budget ហើយមិនអាចជូនដំណឹង «គ្មានចំណាយ», «លើស Plan», «ជិតចប់» បានទេ។ ទំព័រ Boosts បង្ហាញបញ្ជីភ្ញៀវ «boosting without a plan» — សូមបញ្ចូលឱ្យគ្រប់ថ្ងៃនេះ។

━━━━━━━━━━
🆕 2. ភ្ញៀវ «កំពុង Boost» និង «មិនកំពុង Boost» បែកគ្នា
• កំពុង Boost = មានចំណាយថ្ងៃនេះ ឬម្សិលមិញ ឬ Plan ត្រូវដើរថ្ងៃនេះ។ ពណ៌ 🔴🟠🟢 និងសារ Telegram បន្ទាន់ គិតតែលើភ្ញៀវទាំងនេះ។
• មិនកំពុង Boost = នៅផ្នែកដាច់ដោយឡែក គ្មានក្រហម។ មានស្លាកតាមដាន៖ «ទារប្រាក់ដែលលើស», «ស្នើ Plan ថ្មី», «ទាក់ទងសួរបន្ត»។
• បញ្ជី Clients ក៏រៀបដូចគ្នា៖ «Boosting now» ខាងលើ, «Not boosting now» ខាងក្រោម។

━━━━━━━━━━
🆕 3. Dashboard រៀបថ្មី
ក្រោមលេខសរុប មាន 3 ប្រអប់ជាប់គ្នា៖ Clients today · My tasks today · Handoff។ តារាង Clients នៅខាងក្រោម។

━━━━━━━━━━
🆕 4. កាត់ការងារស្ទួន
• «Clients Task» ឥឡូវមានតែការងារដែលមនុស្សសរសេរ។ អ្វីដែលប្រព័ន្ធរកឃើញ (លើស Plan, របាយការណ៍មិនទាន់ផ្ញើ…) នៅតែក្នុង «Status today» ខាងលើទំព័រភ្ញៀវ។ មិនបាច់ធីករឿងដដែលពីរដងទេ។
• PM ទទួលសារព្រឹកតែមួយ (08:00) ដែលរួមទាំង «🔔 Plan ជិតចប់»។ សារ 09:00 លែងមាន។
• «ចំណាយលើស Plan» ជា 🔴 តែពេល post នៅចំណាយថ្ងៃនេះ។

━━━━━━━━━━
🆕 5. ភ្ញៀវឈ្មោះស្ទួន
• ភ្ញៀវឈ្មោះដូចគ្នាត្រូវបានបញ្ចូលជាមួយហើយ។ បើឃើញស្ទួនទៀត៖ បើកភ្ញៀវ → ⚙ Edit → «Merge a duplicate…»។
• បង្កើតភ្ញៀវឈ្មោះដែលមានរួចហើយ មិនបានទេ។`;

async function runGuide(log = console.log) {
  if (!telegram.hasBot() || (await db.getSetting(KEY2, null))) return null;
  const hm = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Phnom_Penh' });
  if (hm < '08:10' || hm > '20:00') return null; // not at night
  await db.setSetting(KEY2, { at: new Date().toISOString(), running: true }); // claim first: never twice
  const to = new Map();
  for (const u of await db.allUsers()) { const c = await db.getUserSetting(u.fb_id, 'tgChat', null); if (c && c.id) to.set(String(c.id), `PM ${u.name}`); }
  for (const b of await buyers.list()) if (b.chat && !to.has(String(b.chat))) to.set(String(b.chat), `MB ${b.name}`);
  const sent = [], failed = [];
  for (const [chat, who] of to) { try { await telegram.send(NEWS, chat); await new Promise((ok) => setTimeout(ok, 600)); await telegram.send(GUIDE, chat); sent.push(who); } catch (e) { failed.push(`${who} (${e.message})`); } await new Promise((ok) => setTimeout(ok, 400)); }
  log(`[announce] news + guide sent to ${sent.length}: ${sent.join(', ')}${failed.length ? ` — failed ${failed.length}: ${failed.join('; ')}` : ''}`);
  await db.setSetting(KEY2, { at: new Date().toISOString(), sent, failed });
  return { sent, failed };
}
// Third one-off (owner's request, 20 Nov 2026 13:42): PMs connect their client Pages so Boost Desk counts orders itself.
// To PMs / leaders only (not media buyers — they don't manage the Facebook Pages). Sent once, in the daytime.
const KEY3 = 'connect-pages-2026-11-20';
const CONNECT = `🛒 Boost Desk រាប់ Order ដោយខ្លួនឯងហើយ — សូមភ្ជាប់ Page ភ្ញៀវ

សួស្ដី PM ទាំងអស់គ្នា 🙏
ចាប់ពីថ្ងៃនេះ Boost Desk រាប់ order ពី Messenger និង comment (ទាំង Live) ដោយខ្លួនឯង លែងយកពី adsbox.biz ទៀតហើយ។
👉 Page ភ្ញៀវដែលមិនទាន់ភ្ជាប់ នឹងបង្ហាញ Order = 0 និងគ្មាន $/order។

━━━━━━━━━━
✅ សូមធ្វើតែម្ដង (ប្រហែល 2 នាទី)

0️⃣ បើទទួលការអញ្ជើញ Tester ពី Meta (Facebook notification ឬ developers.facebook.com/requests) សូមចុច Accept មុន។

1️⃣ បើក Chrome → log in Facebook ដោយគណនីដែលជា admin របស់ Page ភ្ញៀវ។

2️⃣ បើក Boost Desk → ម៉ឺនុយ «Orders» → ចុចប៊ូតុង «Pages» (ខាងលើស្ដាំ) → ចុច «Connect Pages»។

3️⃣ លើផ្ទាំង Facebook៖ ចុច «Edit access» → ធីក Page ភ្ញៀវទាំងអស់ → Allow សិទ្ធិទាំងអស់ → «Save»។

4️⃣ ត្រឡប់មក Boost Desk ឃើញ «X Pages connected» ✅ រួចរាល់។

🔁 Page នៅក្នុងគណនី Facebook ទី 2 / ទី 3? ប្ដូរ Facebook ទៅគណនីនោះ ហើយធ្វើជំហាន 2–4 ម្ដងទៀត។

━━━━━━━━━━
ℹ️ ដឹងបន្ថែម
• Page មួយភ្ជាប់តែម្ដងគ្រប់គ្រាន់ — order បង្ហាញឲ្យគ្រប់គ្នា។ MB មិនបាច់ធ្វើទេ។
• ក្រោយនេះ ពេល log in Boost Desk ដោយ Facebook ហើយ Allow សិទ្ធិ Page, Page ភ្ញៀវថ្មីនឹងភ្ជាប់ដោយខ្លួនឯង។
• Boost Desk រក្សាទុកតែចំនួន order — មិនរក្សាទុកសារ ឈ្មោះ ឬលេខទូរស័ព្ទអតិថិជនទេ។
• Order = អតិថិជនផ្ញើលេខទូរស័ព្ទ (សារ ឬ comment)។ មួយនាក់ ក្នុងមួយ Page ក្នុងមួយថ្ងៃ = 1 order។

❗ បើ Facebook មិនបង្ហាញ Page ឬឃើញ error សូមថត screenshot ផ្ញើមកថ្នាក់ដឹកនាំ។ អរគុណ 🙏`;

async function runConnect(log = console.log) {
  if (!telegram.hasBot() || (await db.getSetting(KEY3, null))) return null;
  const hm = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Phnom_Penh' });
  if (hm < '08:10' || hm > '20:00') return null; // not at night
  await db.setSetting(KEY3, { at: new Date().toISOString(), running: true }); // claim first: never twice
  const to = new Map();
  for (const u of await db.allUsers()) { const c = await db.getUserSetting(u.fb_id, 'tgChat', null); if (c && c.id) to.set(String(c.id), `PM ${u.name}`); }
  const sent = [], failed = [];
  for (const [chat, who] of to) { try { await telegram.send(CONNECT, chat); sent.push(who); } catch (e) { failed.push(`${who} (${e.message})`); } await new Promise((ok) => setTimeout(ok, 400)); }
  log(`[announce] connect-pages sent to ${sent.length}: ${sent.join(', ')}${failed.length ? ` — failed ${failed.length}: ${failed.join('; ')}` : ''}`);
  await db.setSetting(KEY3, { at: new Date().toISOString(), sent, failed });
  return { sent, failed };
}
module.exports = { run, runGuide, runConnect, TEXT, GUIDE, NEWS, CONNECT };
