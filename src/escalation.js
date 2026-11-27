// Who gets the 30-minute escalation of a red client (src/status.js): the COO (owner's decision, 27 Nov 2026).
// Role rules are the same as routes/team.js roleOf(): the owner is 'ceo'; a role set in Admin → Users wins; an admin
// viewer with no role is 'coo'. When no COO has linked Telegram, the alert goes to the old leaders (owner, CEO, COO, CMO
// and the alert group) instead, so an escalation is never lost — Admin → Health says so.
const db = require('./db');

const ROLES = ['ceo', 'coo', 'cmo', 'pm', 'mb'], LEAD = new Set(['ceo', 'coo', 'cmo']);
function roleFor(id, { owner, roles = {}, viewers = new Set() }) {
  if (id === owner) return 'ceo';
  if (ROLES.includes(roles[id])) return roles[id];
  return viewers.has(id) ? 'coo' : 'pm';
}
// people: [{ id, name, chat }] (chat = linked Telegram chat id or null). Pure, so it can be tested.
function pick(people, ctx, alertChat) {
  const coo = people.filter((p) => roleFor(p.id, ctx) === 'coo');
  const cooChats = coo.filter((p) => p.chat).map((p) => String(p.chat));
  if (cooChats.length) return { chats: [...new Set(cooChats)], to: 'coo', coo, fallback: false };
  const old = new Set(alertChat ? [String(alertChat)] : []);
  for (const p of people) if (p.chat && LEAD.has(roleFor(p.id, ctx))) old.add(String(p.chat));
  return { chats: [...old], to: 'leaders', coo, fallback: true };
}
async function resolve() {
  const ctx = { owner: await db.ownerId(), roles: (await db.getSetting('roles', {})) || {}, viewers: new Set((await db.getSetting('adminViewers', [])) || []) };
  const people = [];
  for (const u of await db.allUsers()) { const c = await db.getUserSetting(u.fb_id, 'tgChat', null); people.push({ id: u.fb_id, name: u.name, chat: c && c.id ? c.id : null }); }
  const a = await db.getSetting('alertChat', null);
  return pick(people, ctx, a && a.id);
}
module.exports = { roleFor, pick, resolve };
