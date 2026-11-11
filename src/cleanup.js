// Stage 7: keeps the database from growing forever. Old entries are dropped; the current data is never touched.
import { db, markDirty } from './store.js';

const DAY = 86400000;
const cap = (arr, n) => {
  if (Array.isArray(arr) && arr.length > n) arr.splice(0, arr.length - n);
};

export function pruneStorage(now = Date.now()) {
  cap(db.log, 2000);
  cap(db.errors, 300);
  cap(db.evidence, 1000);
  for (const [k, v] of Object.entries(db.activity)) {
    for (const [who, e] of Object.entries(v)) if (now - (e.t || 0) > 30 * DAY) delete v[who];
    if (!Object.keys(v).length) delete db.activity[k];
  }
  for (const [k, t] of Object.entries(db.greeted)) if (now - t > 180 * DAY) delete db.greeted[k];
  for (const d of Object.keys(db.daily)) if (now - Date.parse(`${d}T00:00:00Z`) > 90 * DAY) delete db.daily[d];
  markDirty();
}
