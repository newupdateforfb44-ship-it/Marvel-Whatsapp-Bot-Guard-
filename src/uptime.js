// Stage 7: website uptime keeper. Each site is checked every 5 to 14 minutes (random). The customer gets a
// Telegram message when a site goes down and when it is back. Only public addresses are checked.
import { db, markDirty } from './store.js';
import { events } from './wa.js';
import { checkSite } from './utility.js';
import { mayUse } from './plans.js';

export const MAX_SITES = 5;
const MIN = 60000;
export const sitesOf = (cust) => (cust.sites ??= []);

export function normSite(input) {
  let u;
  try {
    u = new URL(/^https?:\/\//i.test(String(input || '')) ? input : `https://${input}`);
  } catch {
    return null;
  }
  return u.hostname.includes('.') ? u.href : null;
}

export function addSite(cust, input) {
  const url = normSite(input);
  if (!url) return { error: 'That does not look like a web address.' };
  const list = sitesOf(cust);
  if (list.some((s) => s.url === url)) return { error: 'That site is already on the list.' };
  if (list.length >= MAX_SITES) return { error: `You can watch up to ${MAX_SITES} sites.` };
  list.push({ url, up: null, since: Date.now(), checks: 0, okChecks: 0, ms: 0, nextAt: 0 });
  markDirty();
  return { ok: true, url };
}

export function removeSite(cust, n) {
  const list = sitesOf(cust);
  if (!(n >= 1 && n <= list.length)) return false;
  list.splice(n - 1, 1);
  markDirty();
  return true;
}

export const uptimePct = (s) => (s.checks ? Math.round((s.okChecks / s.checks) * 100) : null);

// Checks the sites that are due. `check` can be replaced in tests.
export async function runSites(cust, now = Date.now(), check = checkSite) {
  for (const site of sitesOf(cust)) {
    if (site.nextAt > now) continue;
    site.nextAt = now + (5 + Math.random() * 9) * MIN;
    let r;
    try {
      r = await check(site.url);
    } catch (e) {
      r = { error: e.message };
    }
    const ok = !r.error && r.status < 500;
    site.checks++;
    if (ok) site.okChecks++;
    site.ms = r.ms || 0;
    if (site.up !== ok) {
      const was = site.up;
      site.up = ok;
      site.since = now;
      if (was !== null) events.emit('site', cust.id, { url: site.url, up: ok, reason: r.error || `HTTP ${r.status}` });
    }
    markDirty();
  }
}

export async function runAllSites(now = Date.now()) {
  for (const cust of Object.values(db.customers)) {
    if (!cust.sites?.length || !mayUse(cust)) continue;
    await runSites(cust, now).catch(() => {});
  }
}
