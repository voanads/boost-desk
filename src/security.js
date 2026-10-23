// Secret rotation helpers. After ENCRYPTION_KEY changes (old one moved to ENCRYPTION_KEY_OLD), rekey() re-saves
// every encrypted value — Facebook logins and the stored API keys — with the new key, so nobody has to log in again.
const db = require('./db');
const { encrypt, decrypt, isOld, hasOldKey } = require('./crypto');

async function rekey() {
  const out = { at: new Date().toISOString(), logins: 0, keys: 0, failed: 0, oldKey: hasOldKey() };
  if (!hasOldKey()) return out;
  for (const u of (await db.pool.query('SELECT fb_id, token_enc FROM users')).rows) {
    if (!isOld(u.token_enc)) continue;
    try { await db.pool.query('UPDATE users SET token_enc=$1 WHERE fb_id=$2', [encrypt(decrypt(u.token_enc)), u.fb_id]); out.logins++; } catch (_) { out.failed++; }
  }
  for (const s of (await db.pool.query(`SELECT key, value FROM settings WHERE value ? 'keyEnc'`)).rows) {
    if (!isOld(s.value.keyEnc)) continue;
    try { await db.setSetting(s.key, { ...s.value, keyEnc: encrypt(decrypt(s.value.keyEnc)) }); out.keys++; } catch (_) { out.failed++; }
  }
  await db.setSetting('lastRekey', out);
  return out;
}
// How many stored values still need the old key (0 = ENCRYPTION_KEY_OLD can be deleted).
async function leftOnOld() {
  if (!hasOldKey()) return 0;
  let n = 0;
  for (const u of (await db.pool.query('SELECT token_enc FROM users')).rows) if (isOld(u.token_enc)) n++;
  for (const s of (await db.pool.query(`SELECT value FROM settings WHERE value ? 'keyEnc'`)).rows) if (isOld(s.value.keyEnc)) n++;
  return n;
}
async function status() {
  return {
    oldKey: hasOldKey(), leftOnOld: await leftOnOld(), lastRekey: await db.getSetting('lastRekey', null),
    rotated: await db.getSetting('secretsRotated', {}),
    lastBackup: await db.getSetting('lastBackup', null),
    alertChat: !!((await db.getSetting('alertChat', null)) || {}).id,
  };
}
module.exports = { rekey, leftOnOld, status };
