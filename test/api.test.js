// HTTP checks against the real server (spawned on a free port), logged in as two admins.
// Covers the Payments / invoices routes (src/routes/invoices.js) and that one admin can't reach the other's invoices.
// Needs TEST_DATABASE_URL (see tenant.test.js).
if (!process.env.TEST_DATABASE_URL) { console.log('api: skipped (set TEST_DATABASE_URL to run)'); process.exit(0); }
const assert = require('assert'), crypto = require('crypto'), path = require('path'), { spawn } = require('child_process');
const SECRET = 'api-test-secret', PORT = 3900 + Math.floor(Math.random() * 90);
const env = { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL, SESSION_SECRET: SECRET, ENCRYPTION_KEY: '0'.repeat(64), FB_APP_ID: '1', FB_APP_SECRET: 'x', BASE_URL: `http://localhost:${PORT}`, PORT: String(PORT), AUTO_SYNC: 'off', TELEGRAM_BOT_TOKEN: '', OWNER_FB_ID: '3000000001' };
process.env.DATABASE_URL = env.DATABASE_URL; process.env.SESSION_SECRET = SECRET; process.env.ENCRYPTION_KEY = env.ENCRYPTION_KEY; process.env.FB_APP_ID = '1'; process.env.FB_APP_SECRET = 'x';
const db = require('../src/db');

// a cookie-session cookie for this Facebook ID, signed like the server signs it
const cookieFor = (fbId, name) => {
  const v = Buffer.from(JSON.stringify({ fbId, name })).toString('base64');
  const sig = crypto.createHmac('sha1', SECRET).update('bd_session=' + v).digest('base64').replace(/\/|\+|=/g, (c) => ({ '/': '_', '+': '-', '=': '' }[c]));
  return `bd_session=${v}; bd_session.sig=${sig}`;
};
const call = async (who, method, url, body) => {
  const r = await fetch(`http://localhost:${PORT}/api${url}`, { method, headers: { cookie: who, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const type = r.headers.get('content-type') || '';
  return { status: r.status, type, body: type.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
};

(async () => {
  await db.init();
  const A = '3000000001', B = '3000000002';
  await db.upsertUser(A, 'Api A', 'enc', null); await db.upsertUser(B, 'Api B', 'enc', null);
  const ca = await db.createClient(A, { name: 'Api Shop', pages: ['Api Page'] });
  await db.pool.end();

  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; srv.stdout.on('data', (d) => (log += d)); srv.stderr.on('data', (d) => (log += d));
  const stop = () => { try { srv.kill(); } catch (_) {} };
  try {
    for (let i = 0; i < 60; i++) { try { await fetch(`http://localhost:${PORT}/login`); break; } catch (_) { await new Promise((r) => setTimeout(r, 250)); } }
    const a = cookieFor(A, 'Api A'), b = cookieFor(B, 'Api B');
    assert.strictEqual((await call('', 'GET', '/payments')).status, 401, 'not logged in');

    const next = await call(a, 'GET', '/invoice-next?date=2026-11-20');
    assert.strictEqual(next.status, 200); assert.match(next.body.number, /^IN26-\d{4}$/);
    const made = await call(a, 'POST', '/invoices', { clientId: ca.id, date: '2026-11-20', items: [{ description: 'Boost service', qty: 2, price: 25 }], discount: 5 });
    assert.strictEqual(made.status, 200, JSON.stringify(made.body)); assert.strictEqual(made.body.total, 45);
    const id = made.body.id;
    assert.strictEqual((await call(a, 'POST', '/invoices', { clientId: ca.id, date: '2026-11-20', items: [{ description: 'x', qty: 1, price: 1 }], number: made.body.number })).status, 409, 'a used number is refused');

    const pay = await call(a, 'GET', '/payments?month=2026-11');
    assert.deepStrictEqual(pay.body.invoices.map((x) => x.id), [id]);
    const png = await call(a, 'GET', `/invoices/${id}/png`);
    assert.strictEqual(png.status, 200); assert.strictEqual(png.type, 'image/png'); assert.ok(png.body.subarray(1, 4).toString() === 'PNG');
    const pdf = await call(a, 'GET', `/invoices/${id}/pdf`);
    assert.strictEqual(pdf.status, 200); assert.ok(pdf.body.subarray(0, 4).toString() === '%PDF');
    const paid = await call(a, 'PATCH', `/invoices/${id}`, { paid: true });
    assert.ok(paid.body.paidAt, 'marked paid');

    // the other admin
    assert.deepStrictEqual((await call(b, 'GET', '/payments?month=2026-11')).body.invoices, [], 'B sees none of A\'s invoices');
    assert.strictEqual((await call(b, 'GET', `/invoices/${id}/pdf`)).status, 404, 'B cannot open A\'s invoice');
    assert.strictEqual((await call(b, 'POST', '/invoices', { clientId: ca.id, date: '2026-11-20', items: [{ description: 'x', qty: 1, price: 1 }] })).status, 404, 'B cannot invoice A\'s client');
    await call(b, 'DELETE', `/invoices/${id}`);
    assert.strictEqual((await call(a, 'GET', `/invoices/${id}/png`)).status, 200, 'B cannot delete A\'s invoice');

    assert.strictEqual((await call(a, 'DELETE', `/invoices/${id}`)).status, 200);
    assert.strictEqual((await call(a, 'GET', `/invoices/${id}/png`)).status, 404, 'deleted');
    console.log('api: invoice routes and isolation over HTTP pass');
  } catch (e) { console.error(e); console.error('--- server log ---\n' + log.slice(-3000)); process.exitCode = 1; }
  finally { stop(); }
})().catch((e) => { console.error(e); process.exit(1); });
