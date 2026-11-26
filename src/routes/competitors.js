// 🥊 Competitor research (src/competitors.js) for one client of this workspace.
const db = require('../db');
const comp = require('../competitors');

module.exports = function mountCompetitors(api, { wrap }) {
  const own = wrap(async (req, res, next) => { if (!(await db.ownsClient(req.user.fb_id, Number(req.params.id)))) return res.status(404).json({ error: 'Client not found.' }); next(); });
  const fail = (res, e) => { if (e.status) return res.status(e.status).json({ error: e.message, notSetUp: !!e.notSetUp }); throw e; };
  api.get('/clients/:id/competitors', own, wrap(async (req, res) => res.json(await comp.get(req.user.fb_id, req.params.id))));
  api.put('/clients/:id/competitors', own, wrap(async (req, res) => { try { res.json(await comp.save(req.user.fb_id, req.params.id, req.body)); } catch (e) { fail(res, e); } }));
  api.post('/clients/:id/competitors/ai', own, wrap(async (req, res) => { try { res.json({ analysis: await comp.analyze(req.user, req.params.id, { lang: (req.body || {}).lang === 'en' ? 'en' : 'km' }) }); } catch (e) { fail(res, e); } }));
};
