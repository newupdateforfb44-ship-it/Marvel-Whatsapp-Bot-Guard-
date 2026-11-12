// Usage counters. Kept in memory and saved by the autosave (see store.js), never one database write per message.
import { db, markDirty } from './store.js';

const KEEP_DAYS = 90;

export function bump(cid, key, jid) {
  const c = db.customers[cid];
  if (!c) return;
  c.stats ||= { msgs: 0, deleted: 0, warned: 0, removed: 0, cmds: 0 };
  c.stats[key] = (c.stats[key] || 0) + 1;
  if (['msgs', 'deleted', 'warned', 'removed'].includes(key)) {
    c.weekly ??= { since: Date.now(), msgs: 0, deleted: 0, warned: 0, removed: 0 };
    c.weekly[key]++;
  }
  if (['msgs', 'deleted', 'warned', 'removed'].includes(key)) {
    c.day ??= { msgs: 0, deleted: 0, warned: 0, removed: 0 };
    c.day[key]++;
  }
  const g = jid && c.groups?.[jid];
  if (g) {
    g[key] = (g[key] || 0) + 1;
    g.last = Date.now();
  }
  db.daily ||= {};
  const day = new Date().toISOString().slice(0, 10);
  if (!db.daily[day]) {
    db.daily[day] = {};
    const keys = Object.keys(db.daily).sort();
    while (keys.length > KEEP_DAYS) delete db.daily[keys.shift()];
  }
  db.daily[day][key] = (db.daily[day][key] || 0) + 1;
  markDirty();
}
