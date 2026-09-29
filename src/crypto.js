// AES-256-GCM encryption for Facebook access tokens stored in the database.
const crypto = require('crypto');
const { encryptionKey } = require('./config');

const key = Buffer.from(encryptionKey, 'hex');
if (key.length !== 32) throw new Error('ENCRYPTION_KEY must be 64 hex characters (32 bytes).');

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}

function decrypt(blob) {
  const [iv, tag, enc] = String(blob).split('.').map((s) => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };
