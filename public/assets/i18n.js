// Khmer / English switch. The app is written in English; in Khmer mode this file translates the words it knows
// as they appear on screen (menus, headings, buttons, labels, statuses). Anything it does not know stays in English,
// and names, numbers and what people typed are never touched. The choice is kept on this device (bd-lang).
(function () {
  'use strict';
  var KEY = 'bd-lang', lang = 'en';
  try { lang = localStorage.getItem(KEY) === 'km' ? 'km' : 'en'; } catch (_) {}

  // English → Khmer. Product words the team already says in English stay in English (Boost, Live, Page, KPI, Telegram…).
  var D = {
    // menu
    'Work': 'ការងារ', 'Manage': 'គ្រប់គ្រង', 'Sites': 'គេហទំព័រ', 'More': 'ផ្សេងៗ', 'Dashboard': 'ផ្ទាំងដើម', 'My Task': 'ការងារខ្ញុំ', 'Clients': 'ភ្ញៀវ', 'Live videos': 'វីដេអូ Live', 'Lives': 'Live',
    'Orders': 'ការកុម្ម៉ង់', 'Reports': 'របាយការណ៍', 'Payments': 'ការបង់ប្រាក់', 'Pay': 'បង់ប្រាក់', 'Ad accounts': 'Ad accounts', 'Accounts': 'Accounts', 'Settings': 'ការកំណត់', 'Admin': 'Admin',
    'Main Dashboard': 'ផ្ទាំងដើមរួម', 'Main': 'រួម', 'Clients Board': 'តារាងភ្ញៀវ', 'Board': 'តារាង', 'Team reports': 'របាយការណ៍ក្រុម', 'All ad accounts': 'Ad accounts ទាំងអស់', 'All ads': 'Ads ទាំងអស់',
    'Log out': 'ចេញ', 'Owner site': 'គេហទំព័រ Owner', 'Admin site': 'គេហទំព័រ Admin', 'Project Manager': 'Project Manager', 'Media buyer': 'Media buyer', 'Owner': 'Owner',
    // common buttons
    'Save': 'រក្សាទុក', 'Cancel': 'បោះបង់', 'Add': 'បន្ថែម', 'Delete': 'លុប', 'Remove': 'ដកចេញ', 'Edit': 'កែ', 'Change': 'ប្តូរ', 'Close': 'បិទ', 'Copy': 'ចម្លង', 'Send': 'ផ្ញើ', 'Send now': 'ផ្ញើឥឡូវ', 'Preview': 'មើលជាមុន',
    'Rename': 'ប្តូរឈ្មោះ', 'Refresh': 'ផ្ទុកឡើងវិញ', 'Update': 'ធ្វើបច្ចុប្បន្នភាព', 'Show': 'បង្ហាញ', 'Show more': 'បង្ហាញបន្ថែម', 'Connect': 'ភ្ជាប់', 'Reconnect': 'ភ្ជាប់ឡើងវិញ', 'Log in again': 'ចូលម្តងទៀត', 'Unlink': 'ផ្តាច់',
    'Check': 'ពិនិត្យ', 'Turn on': 'បើក', 'Turn off': 'បិទ', 'Pause': 'ផ្អាក', 'Reset to default': 'ត្រឡប់ទៅដើម', 'Add client': 'បន្ថែមភ្ញៀវ', 'Add KPI': 'បន្ថែម KPI', 'New team': 'ក្រុមថ្មី', 'Add line': 'បន្ថែមបន្ទាត់',
    'Sync from Meta': 'Sync ពី Meta', 'Refresh from Facebook': 'ផ្ទុកពី Facebook ឡើងវិញ', 'Refresh from Meta': 'ផ្ទុកពី Meta ឡើងវិញ', 'Send to Telegram': 'ផ្ញើទៅ Telegram', 'Send test message': 'ផ្ញើសារសាកល្បង', 'Send test': 'ផ្ញើសាកល្បង',
    'Change password': 'ប្តូរពាក្យសម្ងាត់', 'Create username': 'បង្កើត username', 'Submit plan': 'ដាក់ផែនការ', 'Submit result': 'ដាក់លទ្ធផល', 'Suggest from KPI': 'ស្នើពី KPI', 'Save note': 'រក្សាទុក note', 'See the messages': 'មើលសារ',
    'Add a Facebook account to the team': 'បន្ថែម Facebook account ទៅក្រុម', 'Merge into…': 'បញ្ចូលទៅ…', 'Copy link': 'ចម្លង link', 'Username': 'Username', 'Choose clients': 'ជ្រើសភ្ញៀវ', 'Send all unsent': 'ផ្ញើទាំងអស់ដែលមិនទាន់ផ្ញើ',
    'Reset to the standard list': 'ត្រឡប់ទៅបញ្ជីស្តង់ដារ', 'Add person…': 'បន្ថែមមនុស្ស…', 'Copy to all Project Managers': 'ចម្លងទៅ Project Manager ទាំងអស់', 'Copy to all media buyers': 'ចម្លងទៅ media buyer ទាំងអស់', 'Use the recommended KPIs': 'ប្រើ KPI ដែលស្នើ',
    // time
    'Today': 'ថ្ងៃនេះ', 'Yesterday': 'ម្សិលមិញ', 'Tomorrow': 'ស្អែក', '7 days': '7 ថ្ងៃ', '30 days': '30 ថ្ងៃ', 'This month': 'ខែនេះ', 'Last month': 'ខែមុន', 'This year': 'ឆ្នាំនេះ', 'Last year': 'ឆ្នាំមុន', 'Last 7 days': '7 ថ្ងៃចុងក្រោយ',
    'Last 30 days': '30 ថ្ងៃចុងក្រោយ', 'One day': 'មួយថ្ងៃ', 'One month': 'មួយខែ', 'Custom range': 'ជ្រើសចន្លោះ', 'Every day': 'រៀងរាល់ថ្ងៃ', 'From': 'ពី', 'To': 'ដល់', 'Day': 'ថ្ងៃ', 'Days': 'ថ្ងៃ', 'Time': 'ម៉ោង', 'Choose period': 'ជ្រើសរយៈពេល',
    // numbers and tables
    'Spend': 'ចំណាយ', 'Spent': 'បានចំណាយ', 'Total': 'សរុប', 'Total spent': 'ចំណាយសរុប', 'Live spend': 'ចំណាយ Live', 'Boost post spend': 'ចំណាយ Boost post', 'Boost spend': 'ចំណាយ Boost', 'Per day': 'ក្នុងមួយថ្ងៃ', 'Per order': 'ក្នុងមួយ order',
    'Cost / order': 'ថ្លៃ / order', 'Client': 'ភ្ញៀវ', 'Report': 'របាយការណ៍', 'Actions': 'សកម្មភាព', 'Status': 'ស្ថានភាព', 'Balance': 'សមតុល្យ', 'Active': 'សកម្ម', 'Problems': 'បញ្ហា', 'Off': 'បិទ', 'On': 'បើក', 'All': 'ទាំងអស់', 'Done': 'រួចរាល់',
    'Work left': 'ការងារនៅសល់', 'Needs attention': 'ត្រូវយកចិត្តទុកដាក់', 'Need attention': 'ត្រូវយកចិត្តទុកដាក់', 'Most spend': 'ចំណាយច្រើនជាងគេ', 'Cheapest': 'ថោកជាងគេ', 'Costliest': 'ថ្លៃជាងគេ', 'Newest': 'ថ្មីជាងគេ', 'Pages': 'Pages', 'Company': 'ក្រុមហ៊ុន',
    'Target': 'គោលដៅ', 'Result': 'លទ្ធផល', 'Score': 'ពិន្ទុ', 'Name': 'ឈ្មោះ', 'Team': 'ក្រុម', 'Teams': 'ក្រុម', 'People': 'មនុស្ស', 'Person': 'មនុស្ស', 'Account': 'Account', 'Phone': 'ទូរស័ព្ទ', 'Description': 'ពិពណ៌នា', 'Picture': 'រូបភាព', 'Password': 'ពាក្យសម្ងាត់',
    'Clients with spend': 'ភ្ញៀវដែលមានចំណាយ', 'Lives with spend': 'Live ដែលមានចំណាយ', 'Boost posts': 'Boost posts', 'New clients': 'ភ្ញៀវថ្មី', 'All clients': 'ភ្ញៀវទាំងអស់', 'All accounts': 'Account ទាំងអស់', 'Spent today': 'ចំណាយថ្ងៃនេះ',
    // statuses
    'Loading…': 'កំពុងផ្ទុក…', 'Saving…': 'កំពុងរក្សាទុក…', 'Saved': 'បានរក្សាទុក', 'Connected': 'បានភ្ជាប់', 'Linked': 'បានភ្ជាប់', 'Not linked': 'មិនទាន់ភ្ជាប់', 'Not yet': 'មិនទាន់', 'Not set': 'មិនទាន់កំណត់', 'Set': 'បានកំណត់', 'Ready': 'រួចរាល់',
    'Sent': 'បានផ្ញើ', 'Not sent': 'មិនទាន់ផ្ញើ', 'Not sent yet': 'មិនទាន់ផ្ញើ', 'No spend': 'គ្មានចំណាយ', 'No Telegram group': 'គ្មាន Telegram group', 'Login expired': 'Login ផុតកំណត់', 'First account': 'Account ដំបូង', 'Running': 'កំពុងដំណើរការ',
    'Syncing…': 'កំពុង sync…', 'Report off': 'របាយការណ៍បិទ', 'no plan yet': 'មិនទាន់មានផែនការ', 'plan sent': 'បានផ្ញើផែនការ', 'result sent': 'បានផ្ញើលទ្ធផល', 'no menu': 'គ្មានបញ្ជី', 'Paid': 'បានបង់', 'Not paid yet': 'មិនទាន់បង់', 'Invoiced': 'បានចេញវិក្កយបត្រ',
    'Empty': 'ទទេ', 'Leaders': 'ថ្នាក់ដឹកនាំ', 'second account': 'account ទីពីរ', 'Optional': 'ជាជម្រើស',
    // page headings
    'My settings': 'ការកំណត់របស់ខ្ញុំ', 'My account': 'Account របស់ខ្ញុំ', 'Team Facebook accounts': 'Facebook accounts របស់ក្រុម', 'Telegram account': 'Telegram', 'My auto report': 'របាយការណ៍ស្វ័យប្រវត្តិ', 'Alerts to my Telegram': 'ការជូនដំណឹងទៅ Telegram ខ្ញុំ',
    'AI advice': 'ដំបូន្មាន AI', 'Username & password': 'Username និងពាក្យសម្ងាត់', 'My media buyers on Telegram': 'Media buyer របស់ខ្ញុំលើ Telegram', 'Handoff': 'ការប្រគល់ការងារ', 'Teams today': 'ក្រុមថ្ងៃនេះ', 'Overdue tasks': 'ការងារហួសកំណត់',
    'Urgent on clients': 'បន្ទាន់លើភ្ញៀវ', 'Money, clients and KPIs': 'លុយ ភ្ញៀវ និង KPI', 'Monthly targets & KPIs': 'គោលដៅប្រចាំខែ និង KPI', 'Invoice settings': 'ការកំណត់វិក្កយបត្រ', 'Service fee': 'ថ្លៃសេវា', 'Invoice': 'វិក្កយបត្រ',
    'Removed accounts': 'Account ដែលបានដក', 'Background jobs': 'ការងារផ្ទៃក្រោយ', 'Recent errors': 'កំហុសថ្មីៗ', 'System': 'ប្រព័ន្ធ', 'Users': 'អ្នកប្រើ', 'Health': 'សុខភាពប្រព័ន្ធ', 'App settings': 'ការកំណត់កម្មវិធី', 'Telegram messages': 'សារ Telegram',
    'Getting started': 'ចាប់ផ្តើម', 'Font & size': 'ពុម្ពអក្សរ និងទំហំ', 'Text size': 'ទំហំអក្សរ', 'Font': 'ពុម្ពអក្សរ', 'Only on this device': 'តែលើឧបករណ៍នេះ', 'Suggested actions': 'សកម្មភាពដែលស្នើ', 'Monthly KPI': 'KPI ប្រចាំខែ',
    // forms
    'Client name': 'ឈ្មោះភ្ញៀវ', 'Boost type': 'ប្រភេទ Boost', 'Telegram group': 'Telegram group', 'Current password': 'ពាក្យសម្ងាត់បច្ចុប្បន្ន', 'New password (8+ characters)': 'ពាក្យសម្ងាត់ថ្មី (8 តួឡើង)', 'Customer name': 'ឈ្មោះអតិថិជន',
    'Company name': 'ឈ្មោះក្រុមហ៊ុន', 'Invoice number': 'លេខវិក្កយបត្រ', 'Invoice date': 'ថ្ងៃវិក្កយបត្រ', 'Customer': 'អតិថិជន', 'Bank name': 'ឈ្មោះធនាគារ', 'Account number': 'លេខគណនី', 'Account name': 'ឈ្មោះគណនី', 'Address line 1': 'អាសយដ្ឋាន បន្ទាត់ 1',
    'Address line 2': 'អាសយដ្ឋាន បន្ទាត់ 2', 'With picture': 'មានរូបភាព', 'Text only': 'អត្ថបទតែប៉ុណ្ណោះ', 'Search people': 'ស្វែងរកមនុស្ស', 'Search a team or a person': 'ស្វែងរកក្រុម ឬមនុស្ស', 'Ad account': 'Ad account',
    'Daily $': '$ ក្នុងមួយថ្ងៃ', 'Add tax by default': 'បន្ថែមពន្ធជាលំនាំដើម', 'Pause or delete': 'ផ្អាក ឬលុប', 'Basics': 'ព័ត៌មានមូលដ្ឋាន', 'Post boost plan': 'ផែនការ Boost post',
    // short sentences
    'Ad account payment failed or disabled': 'Ad account បង់ប្រាក់បរាជ័យ ឬត្រូវបានបិទ', 'Client spends over plan': 'ភ្ញៀវចំណាយលើសផែនការ', 'A client who boosts every day has no boost yet today': 'ភ្ញៀវដែល Boost រៀងរាល់ថ្ងៃ មិនទាន់មាន Boost ថ្ងៃនេះ',
    'Send every client\'s report by itself each day.': 'ផ្ញើរបាយការណ៍របស់ភ្ញៀវនីមួយៗដោយស្វ័យប្រវត្តិរៀងរាល់ថ្ងៃ។', 'Your account, your team\'s Facebook accounts, and Telegram.': 'Account របស់អ្នក, Facebook accounts របស់ក្រុម និង Telegram។',
    'Your profile, username and password, Facebook accounts and Telegram.': 'Profile, username និងពាក្យសម្ងាត់, Facebook accounts និង Telegram។', 'No one yet.': 'មិនទាន់មាននរណា។', 'none yet': 'មិនទាន់មាន', 'not connected': 'មិនទាន់ភ្ជាប់',
    'Nothing in this filter.': 'គ្មានអ្វីក្នុង filter នេះ។', 'The menu is empty — add your first task below.': 'បញ្ជីទទេ — បន្ថែមការងារដំបូងខាងក្រោម។', 'Add a task to the menu': 'បន្ថែមការងារទៅបញ្ជី', 'Add a task for today': 'បន្ថែមការងារសម្រាប់ថ្ងៃនេះ',
    'tap one to see their day': 'ចុចមួយដើម្បីមើលថ្ងៃរបស់ពួកគេ', 'how it works': 'របៀបដំណើរការ', 'Plan': 'ផែនការ', 'Result ': 'លទ្ធផល', 'Leader': 'ថ្នាក់ដឹកនាំ', 'This is the PM': 'នេះជា PM', 'Also here': 'នៅទីនេះដែរ', 'Facebook': 'Facebook', 'Telegram': 'Telegram',
  };
  // Phrases with a number in them.
  // added 19 Nov 2026: leader board, grouped pages, activity, nudge (only words that are not in the list above)
  var D2 = {"Teams today": "ក្រុមថ្ងៃនេះ", "My own tasks": "Task របស់ខ្ញុំ", "Tasks done today": "Task រួចថ្ងៃនេះ", "Plans sent": "Plan បានផ្ញើ", "Furthest behind": "យឺតជាងគេ", "Furthest ahead": "នាំមុខគេ", "Who is where": "អ្នកណាដល់ណា", "Team / person": "ក្រុម / មនុស្ស", "Role": "តួនាទី", "Plan": "Plan", "Today's tasks": "Task ថ្ងៃនេះ", "Result": "លទ្ធផល", "KPI this month": "KPI ខែនេះ", "Behind": "យឺត", "On the way": "កំពុងធ្វើ", "On track": "ល្អ", "No menu": "គ្មាន menu", "Not sent": "មិនទាន់ផ្ញើ", "Overview": "ទិដ្ឋភាពរួម", "My ad accounts": "Ad accounts របស់ខ្ញុំ", "All ad accounts": "Ad accounts ទាំងអស់", "Activity": "សកម្មភាព", "When": "ពេលណា", "Who": "អ្នកណា", "What": "ធ្វើអ្វី", "Where": "កន្លែង", "Media buyers · ranking": "Media Buyer · ចំណាត់ថ្នាក់", "Results sent": "លទ្ធផលបានផ្ញើ", "Tasks done": "Task រួច", "Weakest KPI": "KPI ខ្សោយជាងគេ", "Average": "មធ្យម", "All Project Managers": "Project Manager ទាំងអស់", "Project Managers · KPIs": "Project Manager · KPI", "Behind pace": "យឺតជាងគោល", "Close": "ជិតដល់", "On pace": "ទាន់គោល", "🔔 Nudge": "🔔 រំលឹក", "needs attention first · tap a person to open their day": "ក្រុមត្រូវយកចិត្តទុកដាក់នៅខាងលើ · ចុចលើមនុស្សដើម្បីមើលថ្ងៃរបស់គេ", "No media buyer in this team yet.": "ក្រុមនេះមិនទាន់មាន Media Buyer ទេ។", "No Project Manager in this team yet.": "ក្រុមនេះមិនទាន់មាន Project Manager ទេ។", "all teams are level": "គ្រប់ក្រុមស្មើគ្នា", "Behind · under 50%": "យឺត · ក្រោម 50%", "On the way · 50–84%": "កំពុងធ្វើ · 50–84%", "On track · 85%+": "ល្អ · 85%+", "who changed what · the last 300 changes": "អ្នកណាកែអ្វី · 300 ការកែចុងក្រោយ", "No changes recorded yet. Changes made from now on appear here.": "មិនទាន់មានការកែត្រូវបានកត់ទេ។ ការកែចាប់ពីឥឡូវនឹងបង្ហាញនៅទីនេះ។", "Media buyer": "Media buyer"};
  for (var k2 in D2) if (!Object.prototype.hasOwnProperty.call(D, k2)) D[k2] = D2[k2];
  var P = [
    [/^(\d+) clients?$/, '$1 ភ្ញៀវ'], [/^(\d+) ad accounts?$/, '$1 ad accounts'], [/^(\d+) to fix$/, '$1 ត្រូវជួសជុល'], [/^(\d+) connected$/, 'បានភ្ជាប់ $1'], [/^(\d+) of (\d+) connected$/, 'បានភ្ជាប់ $1 ក្នុង $2'],
    [/^(\d+) of (\d+) done$/, 'រួច $1 ក្នុង $2'], [/^(\d+) \/ (\d+) done$/, 'រួច $1 / $2'], [/^(\d+) (person|people)$/, '$1 នាក់'], [/^(\d+) teams?$/, '$1 ក្រុម'], [/^(\d+) KPIs?$/, '$1 KPI'], [/^(\d+) days?$/, '$1 ថ្ងៃ'],
    [/^(\d+) not sent$/, '$1 មិនទាន់ផ្ញើ'], [/^(\d+) no group$/, '$1 គ្មាន group'], [/^(\d+) orders?$/, '$1 orders'], [/^all sent ✓$/, 'ផ្ញើអស់ហើយ ✓'], [/^Expires in (\d+) days?$/, 'ផុតកំណត់ក្នុង $1 ថ្ងៃ'], [/^valid until (.+)$/, 'ប្រើបានដល់ $1'],
  ];

  var SKIP = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, PRE: 1, CODE: 1, NOSCRIPT: 1 };
  function tr(text) {
    var m = /^(\s*)([\s\S]*?)(\s*)$/.exec(text), core = m[2]; if (!core || core.length > 90 || !/[A-Za-z]/.test(core)) return null;
    var hit = D[core]; if (hit) return m[1] + hit + m[3];
    // "+ Add client", "↻ Refresh", "⚙ App settings", "Save…": keep the mark, translate the words
    var pm = /^([^A-Za-z0-9]{1,4}\s?)?([\s\S]*?)(\s?[:…]|\.\.\.)?$/.exec(core);
    if (pm && (pm[1] || pm[3]) && D[pm[2]]) return m[1] + (pm[1] || '') + D[pm[2]] + (pm[3] || '') + m[3];
    for (var i = 0; i < P.length; i++) if (P[i][0].test(core)) return m[1] + core.replace(P[i][0], P[i][1]) + m[3];
    return null;
  }
  function node(n) {
    if (n.nodeType === 3) { var p = n.parentNode; if (!p || SKIP[p.nodeName] || (p.closest && p.closest('[data-notr],[contenteditable="true"]'))) return; var t = tr(n.nodeValue); if (t !== null && t !== n.nodeValue) n.nodeValue = t; return; }
    if (n.nodeType !== 1 || SKIP[n.nodeName] || n.hasAttribute('data-notr')) return;
    ['placeholder', 'title', 'aria-label'].forEach(function (a) { var v = n.getAttribute(a); if (v) { var t = tr(v); if (t !== null && t !== v) n.setAttribute(a, t); } });
    for (var c = n.firstChild; c; c = c.nextSibling) node(c);
  }
  function start() {
    document.documentElement.lang = 'km'; node(document.body);
    var queue = [], busy = false;
    new MutationObserver(function (list) {
      for (var i = 0; i < list.length; i++) { var m = list[i]; if (m.type === 'characterData') queue.push(m.target); else for (var j = 0; j < m.addedNodes.length; j++) queue.push(m.addedNodes[j]); }
      if (busy) return; busy = true;
      requestAnimationFrame(function () { var q = queue; queue = []; busy = false; for (var k = 0; k < q.length; k++) if (q[k].isConnected) node(q[k]); });
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  }
  function button() {
    var b = document.getElementById('langBtn'); if (!b) return;
    b.textContent = lang === 'km' ? 'EN' : 'ខ្មែរ'; b.setAttribute('data-notr', '');
    b.setAttribute('aria-label', lang === 'km' ? 'Switch to English' : 'ប្តូរទៅភាសាខ្មែរ'); b.title = lang === 'km' ? 'Switch to English' : 'ប្តូរទៅភាសាខ្មែរ';
    b.onclick = function () { try { localStorage.setItem(KEY, lang === 'km' ? 'en' : 'km'); } catch (_) {} location.reload(); };
  }
  function boot() { button(); if (lang === 'km') start(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
  window.bdLang = function () { return lang; };
})();
