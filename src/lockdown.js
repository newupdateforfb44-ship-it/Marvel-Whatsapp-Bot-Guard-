// Lockdown ("panic button"): strict rules on, protected groups closed to members. Turning it off restores the old rules.
import { db, save, addLog } from './store.js';
import { getMeta, isAdminOf } from './wa.js';
import { protectedGroups } from './plans.js';
import { reportError } from './alerts.js';

export const LOCK_RULES = {
  blockAllLinks: true,
  maxMentions: 3,
  floodLimit: 4,
  blockForwards: true,
  blockStatusMention: true,
  blockMedia: { image: true, video: true, sticker: true, audio: true, document: true, contact: true },
  antiNumbers: true,
  slowMode: 10,
  antiRaid: true,
  muteAt: 2,
};
const LOCK_KEYS = Object.keys(LOCK_RULES);

// Switch the rules only (no WhatsApp calls). Returns true if anything changed.
export function setLockdownSettings(cust, on) {
  const g = cust.guard;
  if (on === Boolean(g.lockdown)) return false;
  if (on) {
    g.lockdownPrev = structuredClone(Object.fromEntries(LOCK_KEYS.map((k) => [k, g[k]])));
    Object.assign(g, structuredClone(LOCK_RULES));
    g.lockdown = true;
  } else {
    Object.assign(g, g.lockdownPrev || {});
    g.lockdown = false;
    g.lockdownPrev = null;
  }
  return true;
}

// Switch the rules and close (or reopen) every protected group where the guard is an admin.
// s can be null when the WhatsApp session is not running: the rules still change.
export async function runLockdown(cid, s, on) {
  const cust = db.customers[cid];
  if (!cust) return { ok: false, closed: 0 };
  setLockdownSettings(cust, on);
  save();
  let closed = 0;
  if (s?.sock) {
    const me = [s.sock.user?.id, s.sock.user?.lid];
    for (const jid of protectedGroups(cust)) {
      try {
        const meta = await getMeta(s, jid);
        if (!isAdminOf(meta, me)) continue;
        s.nightState?.set(jid, on ? 'announcement' : 'not_announcement');
        await s.q.add(() => s.sock.groupSettingUpdate(jid, on ? 'announcement' : 'not_announcement'));
        closed++;
      } catch (e) {
        reportError(`lockdown ${cid}`, e);
      }
    }
  }
  addLog('action', `lockdown ${on ? 'ON' : 'OFF'} (${closed} group${closed === 1 ? '' : 's'} changed)`, cid);
  return { ok: true, closed };
}
