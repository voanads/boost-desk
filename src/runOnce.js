// One run per time slot across every running copy of the app. Railway can run two copies at once (during a deploy
// the old and the new one overlap for a while, or when the service is scaled), and each copy has its own timers.
// Without this, a 03:20 backup, a morning brief or a client alert would go out twice.
// The first copy to claim (job, slot) runs it; the others skip. Nothing is held while the job runs.
const db = require('./db');

let ready = null, warned = false;
const table = () => (ready = ready || db.pool.query(`CREATE TABLE IF NOT EXISTS job_runs (
    name TEXT NOT NULL, slot BIGINT NOT NULL, at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (name, slot))`).catch((e) => { ready = null; throw e; }));

// slotMs: how long one run "owns" its slot — one minute for cron jobs, the interval for setInterval jobs.
async function claim(name, slotMs = 60e3, now = Date.now()) {
  try {
    await table();
    const r = await db.pool.query('INSERT INTO job_runs (name, slot) VALUES ($1, $2) ON CONFLICT DO NOTHING', [name, Math.floor(now / slotMs)]);
    if (Math.random() < 0.005) db.pool.query(`DELETE FROM job_runs WHERE at < now() - interval '3 days'`).catch(() => {});
    return r.rowCount === 1;
  } catch (e) {
    // database unreachable: run anyway (the job itself will report the problem) rather than silently skip it
    if (!warned) { warned = true; console.error('[runOnce] could not claim a slot, running anyway:', e.message); }
    return true;
  }
}
// Wrap a job: fn runs only in the copy that claimed this slot.
const once = (name, fn, slotMs) => async (...a) => {
  if (await claim(name, slotMs)) return fn(...a);
  try { require('./health').ranElsewhere(name); } catch (_) { /* health page is optional */ }
};

module.exports = { claim, once };
