// AES-256-GCM encryption for Facebook access tokens and API keys stored in the database.
// Key rotation: put the old key in ENCRYPTION_KEY_OLD and a new one in ENCRYPTION_KEY. Values are read with
// either key, and rekey() (run at start) re-saves everything with the new key. Then ENCRYPTION_KEY_OLD can go.
const crypto = require('crypto');
const { encryptionKey } = require('./config');

const key = Buffer.from(encryptionKey, 'hex');
if (key.length !== 32) throw new Error('ENCRYPTION_KEY must be 64 hex characters (32 bytes).');
const oldKey = process.env.ENCRYPTION_KEY_OLD ? Buffer.from(process.env.ENCRYPTION_KEY_OLD.trim(), 'hex') : null;
if (oldKey && oldKey.length !== 32) throw new Error('ENCRYPTION_KEY_OLD must be 64 hex characters (32 bytes).');

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}
function decryptWith(k, blob) {
  const [iv, tag, enc] = String(blob).split('.').map((s) => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', k, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}
function decrypt(blob) {
  try { return decryptWith(key, blob); }
  catch (e) { if (oldKey) return decryptWith(oldKey, blob); throw e; }
}
// true when the value was made with the old key (so it should be re-saved with the new one)
function isOld(blob) {
  if (!oldKey || !blob) return false;
  try { decryptWith(key, blob); return false; } catch (_) { try { decryptWith(oldKey, blob); return true; } catch (__) { return false; } }
}

module.exports = { encrypt, decrypt, isOld, hasOldKey: () => !!oldKey };
