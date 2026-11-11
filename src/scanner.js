// Stage 8: scam and link scanner. Heuristics only (no outside lookups), so it runs offline and
// flags links that look like phishing before members click them.
const SHORTENERS = new Set(['bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'is.gd', 'cutt.ly', 'rb.gy', 'ow.ly', 'shorturl.at', 'tiny.cc']);
const RISKY_TLDS = new Set(['zip', 'mov', 'xyz', 'top', 'click', 'gq', 'ml', 'tk', 'cf', 'ga', 'buzz', 'icu', 'rest']);
const LURE = /(free[-_ ]?nitro|gift[-_ ]?card|claim[-_ ]?(your|now|reward)|verify[-_ ]?(your )?(account|identity)|whatsapp[-_ ]?(gold|plus|premium)|crypto[-_ ]?(double|giveaway)|you won|lottery|prize)/i;
const URL_RE = /((?:https?:\/\/|www\.)[^\s<>"']+)/gi;

export function linksIn(text) {
  return [...String(text || '').matchAll(URL_RE)].map((m) => m[1]);
}

// Why a link looks risky (a short reason), or null
export function riskOf(url) {
  let u;
  try {
    u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
  } catch {
    return 'broken link';
  }
  const host = u.hostname.toLowerCase();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[')) return 'IP address instead of a name';
  if (host.includes('xn--')) return 'look-alike letters';
  if (u.username || u.password) return 'login hidden in the link';
  if (SHORTENERS.has(host)) return 'short link hides the target';
  if (RISKY_TLDS.has(host.split('.').pop())) return 'risky domain ending';
  if (host.split('.').length > 4) return 'many subdomains';
  return null;
}

// The first reason a message's links look risky, or null. Scam wording next to a link counts too.
export function riskyLink(text) {
  const links = linksIn(text);
  if (!links.length) return null;
  for (const l of links) {
    const why = riskOf(l);
    if (why) return why;
  }
  if (LURE.test(String(text))) return 'scam wording with a link';
  return null;
}
