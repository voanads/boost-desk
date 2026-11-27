// 📄 Page profile (src/pageProfile.js) for one client of this workspace.
const db = require('../db');
const profile = require('../pageProfile');

module.exports = function mountPageProfile(api, { wrap }) {
  const own = wrap(async (req, res, next) => { if (!(await db.ownsClient(req.user.fb_id, Number(req.params.id)))) return res.status(404).json({ error: 'Client not found.' }); next(); });
  api.get('/clients/:id/profile', own, wrap(async (req, res) => res.json(await profile.get(req.user.fb_id, req.params.id))));
  api.put('/clients/:id/profile', own, wrap(async (req, res) => res.json(await profile.save(req.user.fb_id, req.params.id, req.body, req.user.buyer ? req.user.buyer.name : req.user.name))));
};
