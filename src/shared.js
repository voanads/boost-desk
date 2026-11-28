// Heavy reads that are asked for at the same moment share one run (28 Nov 2026).
// Opening a page asks for clients-status, todo, handoff, orders… in parallel, and each of them builds the same spend
// dashboard and PM to-do from the saved campaign rows. Without this, the same work ran 4–8 times at once on the one
// Node thread and every request waited behind the others (1.5–5 s per page load).
//
// Nothing is kept after a run ends, so there is no cache to go stale: a call shares a run only while that run is still
// working. The key includes db's write counter, so a read that starts after any change to the data starts a fresh run.
// Each caller gets its own copy, so one caller changing the result never changes another's.
const db = require('./db');

const running = new Map();
const copy = (v) => { try { return structuredClone(v); } catch (_) { return v; } };

function shared(key, fn) {
  const k = db.getWriteGen() + '|' + key;
  let p = running.get(k);
  if (!p) {
    p = Promise.resolve().then(fn);
    running.set(k, p);
    p.then(() => running.delete(k), () => running.delete(k));
  }
  return p.then(copy);
}

module.exports = { shared };
