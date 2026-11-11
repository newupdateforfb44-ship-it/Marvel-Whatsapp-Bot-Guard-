// Stage 9: referrals. A customer shares a link (t.me/<bot>?start=ref_<code>). When someone new starts the
// bot through it, the referrer gets free days. Free days only matter when subscriptions are required.
import crypto from 'crypto';
import { db, markDirty } from './store.js';
import { extendDays } from './plans.js';

export const REWARD_DAYS = 3;
export const MAX_REWARDS = 10; // per referrer

export function refCodeOf(cust) {
  if (!cust.refCode) {
    cust.refCode = crypto.randomBytes(4).toString('hex');
    markDirty();
  }
  return cust.refCode;
}
export const refLinkOf = (botName, cust) => `https://t.me/${botName}?start=ref_${refCodeOf(cust)}`;

// Called only for a customer who has just been created by /start. Returns the reward, or null.
export function applyReferral(newCust, startPayload, now = Date.now()) {
  const m = String(startPayload || '').match(/^ref_([0-9a-f]{8})$/);
  if (!m || newCust.referredBy) return null;
  const referrer = Object.values(db.customers).find((c) => c.refCode === m[1]);
  if (!referrer || referrer.id === newCust.id) return null;
  if ((referrer.refRewards || 0) >= MAX_REWARDS) return null;
  newCust.referredBy = referrer.id;
  referrer.refRewards = (referrer.refRewards || 0) + 1;
  extendDays(referrer, REWARD_DAYS, now);
  markDirty();
  return { referrerId: referrer.id, days: REWARD_DAYS };
}

export function referralStats(cust) {
  return {
    invited: Object.values(db.customers).filter((c) => c.referredBy === cust.id).length,
    rewards: cust.refRewards || 0,
  };
}
