// Error log + Telegram alerts to the owner. Alerts are rate limited so a bug can never flood your chat.
import { db, markDirty } from './store.js';

let notifier = null;
export const setNotifier = (fn) => {
  notifier = fn;
};

const lastSent = new Map(); // error key -> time of the last alert
let hourStart = 0;
let hourCount = 0;

export function reportError(src, err) {
  const msg = String(err?.message || err || 'unknown error').slice(0, 300);
  console.error(`[${src}]`, msg);
  const now = Date.now();
  const key = `${src}|${msg}`;
  db.errors ||= [];
  const last = db.errors[db.errors.length - 1];
  if (last && last.key === key) {
    last.n++;
    last.t = now;
  } else {
    db.errors.push({ t: now, src, msg, key, n: 1 });
    if (db.errors.length > 50) db.errors.shift();
  }
  markDirty();

  if (!db.settings?.errorAlerts || !notifier) return;
  if (now - (lastSent.get(key) || 0) < 10 * 60 * 1000) return; // same error: at most once per 10 min
  if (now - hourStart > 3600 * 1000) {
    hourStart = now;
    hourCount = 0;
  }
  if (hourCount >= 10) return; // never more than 10 alerts per hour
  hourCount++;
  if (lastSent.size > 200) lastSent.clear();
  lastSent.set(key, now);
  notifier(`⚠️ Error in ${src}\n${msg}`);
}
