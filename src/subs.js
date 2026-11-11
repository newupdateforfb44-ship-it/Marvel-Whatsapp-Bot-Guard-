// Subscriptions: reminders, auto-disconnect at expiry, resume after renewal.
import { db, save, addLog } from './store.js';
import { events } from './wa.js';
import { stopSession, startSession } from './guard.js';
import { reportError } from './alerts.js';
import { DAY, subActive, isLifetime, mayUse } from './plans.js';

// Runs every 10 minutes (and once at start). Does nothing while "require subscription" is OFF.
export async function subscriptionTick(now = Date.now()) {
  if (!db.settings.requireSubscription) return;
  for (const c of Object.values(db.customers)) {
    if (c.status !== 'connected') continue;
    if (!subActive(c, now)) {
      // auto-disconnect: stop the session but KEEP the WhatsApp login, so renewing reconnects instantly
      await stopSession(c.id);
      c.status = 'expired';
      save();
      addLog('event', `subscription expired: ${c.name || c.id} (+${c.number})`, c.id);
      events.emit('expired', c.id);
      continue;
    }
    if (isLifetime(c)) continue;
    const left = c.expiresAt - now;
    c.reminded ||= {};
    if (left <= DAY && !c.reminded.d1) {
      c.reminded.d1 = c.reminded.d3 = true;
      save();
      events.emit('reminder', c.id, Math.max(1, Math.ceil(left / DAY)));
    } else if (left <= 3 * DAY && !c.reminded.d3) {
      c.reminded.d3 = true;
      save();
      events.emit('reminder', c.id, Math.ceil(left / DAY));
    }
  }
}

// Bring a paused / expired customer back online (if they may use the service). Returns true when resumed.
export async function resume(c) {
  if (c.status !== 'expired' && c.status !== 'suspended') return false;
  if (!mayUse(c)) {
    c.status = 'expired';
    save();
    return false;
  }
  c.status = 'connected';
  c.suspendReason = '';
  save();
  try {
    await startSession(c.id);
  } catch (e) {
    reportError(`resume ${c.id}`, e);
  }
  events.emit('resumed', c.id);
  return true;
}
