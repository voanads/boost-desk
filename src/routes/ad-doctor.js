// 🩺 Ad Doctor (src/adDoctor.js): the rule check (no AI) and the AI advice, for one client of this workspace.
const db = require('../db');
const doctor = require('../adDoctor');

module.exports = function mountAdDoctor(api, { wrap }) {
  const own = wrap(async (req, res, next) => { if (!(await db.ownsClient(req.user.fb_id, Number(req.params.id)))) return res.status(404).json({ error: 'Client not found.' }); next(); });
  const days = (v) => Math.min(Math.max(Number(v) || 7, 1), 30);
  const fail = (res, e) => { if (e.needsLogin) return res.status(401).json({ error: e.message, needsLogin: true }); if (e.status) return res.status(e.status).json({ error: e.message, notSetUp: !!e.notSetUp }); throw e; };
  api.get('/clients/:id/ad-doctor', own, wrap(async (req, res) => { try { res.json(await doctor.gather(req.user, Number(req.params.id), days(req.query.days), req.query.fresh === '1')); } catch (e) { fail(res, e); } }));
  api.post('/clients/:id/ad-doctor/ai', own, wrap(async (req, res) => {
    const b = req.body || {};
    try { res.json(await doctor.advice(req.user, Number(req.params.id), { days: days(b.days), lang: b.lang === 'en' ? 'en' : 'km', fresh: !!b.fresh })); } catch (e) { fail(res, e); }
  }));
};
