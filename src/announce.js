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
module.exports = { run, TEXT };
