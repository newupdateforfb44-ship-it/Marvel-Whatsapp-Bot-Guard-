// Pure checks added in Stage 3 (no WhatsApp or database calls), so they are easy to test.

export const digitsOnly = (v) => String(v || '').replace(/\D/g, '');

const PHONE_RE = /\+?\d[\d\s\-().]{6,}\d/g;

// A phone number is 9 to 15 digits, with or without spaces, dashes or brackets between them.
// (8 digits is left out on purpose: that catches dates such as 2026-11-10.)
export function hasPhoneNumber(text) {
  for (const m of String(text || '').match(PHONE_RE) || []) {
    const n = m.replace(/\D/g, '').length;
    if (n >= 9 && n <= 15) return true;
  }
  return false;
}

// True when the number starts with one of the blocked country-code prefixes.
export function countryBlocked(number, prefixes) {
  const d = digitsOnly(number);
  if (!d) return false;
  return (prefixes || []).some((p) => {
    const x = digitsOnly(p);
    return Boolean(x) && d.startsWith(x);
  });
}

// Counts events per key inside a sliding window (joins for anti-raid, deletes for threat alerts).
export class WindowCounter {
  constructor(windowMs) {
    this.windowMs = windowMs;
    this.map = new Map();
  }
  // records one event and returns how many happened inside the window
  add(key, now = Date.now()) {
    const arr = (this.map.get(key) || []).filter((t) => now - t < this.windowMs);
    arr.push(now);
    this.map.set(key, arr);
    if (this.map.size > 2000) {
      for (const [k, v] of this.map) if (now - v[v.length - 1] >= this.windowMs) this.map.delete(k);
    }
    return arr.length;
  }
}

// Slow mode: a sender may post once every N seconds. A message that comes too soon is reported as "too fast"
// and does not restart the timer, so a member who keeps posting stays blocked until the window passes.
export class SlowTracker {
  constructor() {
    this.last = new Map();
  }
  hit(key, now, seconds) {
    const prev = this.last.get(key);
    if (prev && now - prev < seconds * 1000) return true;
    if (this.last.size > 5000) this.last.clear();
    this.last.set(key, now);
    return false;
  }
}

// Hour (0-23) in a given time zone. Falls back to UTC for an unknown zone.
export function hourIn(tz, now = Date.now()) {
  try {
    const h = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(now);
    return Number(h) % 24;
  } catch {
    return new Date(now).getUTCHours();
  }
}

// Night is the window from nightStart (inclusive) to nightEnd (exclusive). It may cross midnight, e.g. 23 to 7.
export function inNight(g, now = Date.now()) {
  const a = Number(g.nightStart);
  const b = Number(g.nightEnd);
  if (!(a >= 0 && a < 24 && b >= 0 && b < 24) || a === b) return false;
  const h = hourIn(g.nightTz || 'UTC', now);
  return a < b ? h >= a && h < b : h >= a || h < b;
}

// Security score 0-100 from the rules a customer has switched on.
export function groupScore(g) {
  const media = Object.values(g.blockMedia || {}).some(Boolean);
  const parts = [
    [g.blockAllLinks, 10],
    [g.maxMentions > 0, 10],
    [g.floodLimit > 0, 10],
    [g.badWordsOn, 10],
    [media, 10],
    [g.maxLength > 0, 5],
    [g.maxEmoji > 0, 5],
    [g.blockForwards, 5],
    [g.blockStatusMention, 5],
    [g.warnLimit > 0, 5],
    [g.muteAt > 0, 5],
    [g.antiNumbers, 5],
    [g.slowMode > 0, 5],
    [g.antiRaid, 5],
    [(g.blockCountries || []).length > 0, 5],
  ];
  return parts.reduce((sum, [on, pts]) => sum + (on ? pts : 0), 0);
}

// Account health 0-100 for the guard's WhatsApp number: failed posts, drops and queue backlog in the last day.
export function accountHealth({ failures24 = 0, drops24 = 0, queue = 0 }) {
  let score = 100;
  score -= Math.min(50, failures24 * 5);
  score -= Math.min(40, drops24 * 10);
  if (queue > 20) score -= 5;
  score = Math.max(0, score);
  const label = score >= 80 ? '🟢 good' : score >= 50 ? '🟡 watch' : '🔴 at risk';
  return { score, label };
}
