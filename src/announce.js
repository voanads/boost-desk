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

async function runGuide(log = console.log) {
  if (!telegram.hasBot() || (await db.getSetting(KEY2, null))) return null;
  const hm = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Phnom_Penh' });
  if (hm < '08:10' || hm > '20:00') return null; // not at night
  await db.setSetting(KEY2, { at: new Date().toISOString(), running: true }); // claim first: never twice
  const to = new Map();
  for (const u of await db.allUsers()) { const c = await db.getUserSetting(u.fb_id, 'tgChat', null); if (c && c.id) to.set(String(c.id), `PM ${u.name}`); }
  for (const b of await buyers.list()) if (b.chat && !to.has(String(b.chat))) to.set(String(b.chat), `MB ${b.name}`);
  const sent = [], failed = [];
  for (const [chat, who] of to) { try { await telegram.send(GUIDE, chat); sent.push(who); } catch (e) { failed.push(`${who} (${e.message})`); } await new Promise((ok) => setTimeout(ok, 400)); }
  log(`[announce] guide sent to ${sent.length}: ${sent.join(', ')}${failed.length ? ` — failed ${failed.length}: ${failed.join('; ')}` : ''}`);
  await db.setSetting(KEY2, { at: new Date().toISOString(), sent, failed });
  return { sent, failed };
}
module.exports = { run, runGuide, TEXT, GUIDE };
