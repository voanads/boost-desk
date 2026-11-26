// Client link (src/clientLink.js): the public read-only page /r/<token>, and the PM's create / copy / revoke.
const db = require('../db');
const net = require('../net');
const CL = require('../clientLink');

// Before the login wall: anyone with the link can read it. Limited per address, never cached or indexed.
function mountPublic(app, { wrap }) {
  app.use('/r', net.rateLimit(60, 60000, 'clientlink'));
  app.get('/r/:token', wrap(async (req, res) => {
    res.set({ 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' });
    const link = await CL.find(req.params.token), d = link && (await CL.data(link, String(req.query.m || '')));
    if (!d) return res.status(404).type('html').send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ADS BOX</title><body style="font-family:system-ui,sans-serif;padding:40px;text-align:center;color:#14122A"><h2>Link នេះមិនដំណើរការទៀតទេ</h2><p>សូមសុំ link ថ្មីពី Project Manager របស់អ្នក។</p></body>');
    res.type('html').send(CL.page(d, req.params.token));
  }));
}
// Logged in (PM or media buyer of that workspace): the link of one of their own clients.
function mountApi(api, { wrap }) {
  const own = wrap(async (req, res, next) => { if (!(await db.ownsClient(req.user.fb_id, Number(req.params.id)))) return res.status(404).json({ error: 'Client not found.' }); next(); });
  api.get('/clients/:id/link', own, wrap(async (req, res) => res.json({ link: await CL.get(req.user.fb_id, req.params.id) })));
  api.post('/clients/:id/link', own, wrap(async (req, res) => {
    if (req.user.buyer) return res.status(403).json({ error: 'Media buyers can\'t do this — ask your PM.' });
    res.json({ link: await CL.make(req.user.fb_id, req.params.id, req.user.name) });
  }));
  api.delete('/clients/:id/link', own, wrap(async (req, res) => {
    if (req.user.buyer) return res.status(403).json({ error: 'Media buyers can\'t do this — ask your PM.' });
    res.json(await CL.revoke(req.user.fb_id, req.params.id));
  }));
}
module.exports = { mountPublic, mountApi };
