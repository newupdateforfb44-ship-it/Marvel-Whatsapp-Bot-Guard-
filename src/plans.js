// Plans, expiry and per-customer limits. Pure helpers (no Telegram, no WhatsApp).
import config from '../config.js';
import { db } from './store.js';

export const DAY = 86400000;
export const LIFETIME = 4102444800000; // 2100-01-01

const ownerIds = () => config.ADMIN_IDS.map(String);

export const planLabel = (p) => config.PLANS[p]?.label || (p ? p : 'No plan');
export const isLifetime = (c) => Boolean(c.expiresAt && c.expiresAt >= LIFETIME - DAY);
export const subRequired = () => Boolean(db.settings.requireSubscription);

// Owners never expire. Everybody else needs a future expiry date.
export const subActive = (c, now = Date.now()) => ownerIds().includes(String(c.id)) || Boolean(c.expiresAt && c.expiresAt > now);

// Is the customer allowed to use the service right now?
export const mayUse = (c, now = Date.now()) => !subRequired() || subActive(c, now);

// A brand-new customer gets a free trial on first connect (only when subscriptions are required).
export const canStartTrial = (c) =>
  subRequired() && !c.trialUsed && !c.expiresAt && !c.everConnected && db.settings.trialDays > 0;

export const daysLeft = (c, now = Date.now()) => (c.expiresAt ? Math.ceil((c.expiresAt - now) / DAY) : null);

export function fmtExpiry(c, now = Date.now()) {
  if (!c.expiresAt) return 'no expiry date';
  if (isLifetime(c)) return 'lifetime';
  const d = daysLeft(c, now);
  const date = new Date(c.expiresAt).toISOString().slice(0, 10);
  if (d > 0) return `${date} (${d} day${d === 1 ? '' : 's'} left)`;
  return `${date} (expired ${-d} day${d === -1 ? '' : 's'} ago)`;
}

// Short form for list buttons: 12d, exp, ∞, -
export function shortExpiry(c, now = Date.now()) {
  if (!c.expiresAt) return '-';
  if (isLifetime(c)) return '∞';
  const d = daysLeft(c, now);
  return d > 0 ? `${d}d` : 'exp';
}

// Add days on top of the current expiry (or from today if already expired).
export function extendDays(c, days, now = Date.now()) {
  if (isLifetime(c)) return;
  const base = c.expiresAt && c.expiresAt > now ? c.expiresAt : now;
  c.expiresAt = base + days * DAY;
  c.reminded = {};
}

// How many groups the guard protects for this customer (0 = unlimited). Customer override wins over the plan.
export function maxGroups(c) {
  const l = c.limits?.maxGroups;
  if (Number.isInteger(l) && l > 0) return l;
  return config.PLANS[c.plan]?.maxGroups || 0;
}

export const maxBadWords = (c) => (c.limits?.maxBadWords > 0 ? c.limits.maxBadWords : 100);

// Groups the guard protects right now. 'allowed' mode: the groups added with an invite link.
// 'all' mode: the first groups the bot saw, up to the plan limit. Paused groups are never protected.
export function protectedGroups(c) {
  const list = c.groupList || {};
  if (c.guard?.groupMode === 'allowed') return Object.keys(list).filter((jid) => !list[jid].paused);
  const seen = Object.keys(c.groups || {});
  const limit = maxGroups(c);
  return (limit > 0 ? seen.slice(0, limit) : seen).filter((jid) => !list[jid]?.paused);
}
