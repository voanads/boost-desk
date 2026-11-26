// Minimal S3-compatible upload (Cloudflare R2, Backblaze B2, AWS S3, MinIO…) with AWS Signature V4 — no SDK needed.
// Used for off-site database backups. Path-style URLs: <endpoint>/<bucket>/<key>.
const crypto = require('crypto');

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const hmac = (k, s) => crypto.createHmac('sha256', k).update(s).digest();
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

// Returns the headers to send (Authorization, x-amz-date, x-amz-content-sha256, plus the given ones).
function sign({ method, url, headers = {}, body = '', accessKey, secretKey, region, service = 's3', now = new Date() }) {
  const u = new URL(url);
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''), day = amzDate.slice(0, 8);
  const payloadHash = sha256(body);
  const h = { ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()])), host: u.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  const names = Object.keys(h).sort();
  const path = u.pathname.split('/').map((p) => enc(decodeURIComponent(p))).join('/');
  const query = [...u.searchParams].map(([k, v]) => [enc(k), enc(v)]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('&');
  const canonical = [method, path, query, names.map((n) => `${n}:${h[n]}\n`).join(''), names.join(';'), payloadHash].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac('AWS4' + secretKey, day), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', key).update(toSign).digest('hex');
  return { ...h, authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` };
}

function config() {
  const e = process.env;
  const c = { endpoint: (e.BACKUP_S3_ENDPOINT || '').replace(/\/+$/, ''), bucket: e.BACKUP_S3_BUCKET || '', region: e.BACKUP_S3_REGION || 'auto', accessKey: e.BACKUP_S3_ACCESS_KEY || '', secretKey: e.BACKUP_S3_SECRET_KEY || '' };
  return c.endpoint && c.bucket && c.accessKey && c.secretKey ? c : null;
}

async function put(key, body, contentType = 'application/octet-stream', c = config()) {
  if (!c) throw new Error('Off-site backup storage is not set up (BACKUP_S3_* variables).');
  const url = `${c.endpoint}/${enc(c.bucket)}/${key.split('/').map(enc).join('/')}`;
  const headers = sign({ method: 'PUT', url, headers: { 'content-type': contentType }, body, ...c });
  delete headers.host; // fetch sets it
  const res = await fetch(url, { method: 'PUT', headers, body, signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`Backup storage said ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return url;
}

module.exports = { sign, config, put };
