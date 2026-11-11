// Stage 9: public stats page and an uptime badge. Off unless PUBLIC_STATS=true. Only totals are shown,
// never names, numbers or group names.
import { db } from './store.js';
import { protectedGroups } from './plans.js';

const DAY = 86400000;

export function statsSnapshot(now = Date.now()) {
  const customers = Object.values(db.customers);
  const live = customers.filter((c) => c.status === 'connected');
  let weekMsgs = 0;
  for (const [d, v] of Object.entries(db.daily)) {
    if (now - Date.parse(`${d}T00:00:00Z`) < 7 * DAY) weekMsgs += v?.msgs || 0;
  }
  return {
    connected: live.length,
    groups: live.reduce((n, c) => n + protectedGroups(c).length, 0),
    weekMsgs,
    runningDays: Math.floor(process.uptime() / 86400),
  };
}

export function speedLabel(ms) {
  if (ms < 300) return '🚀 Lightning';
  if (ms < 1000) return '⚡ Fast';
  if (ms < 3000) return '🐢 Slow';
  return '🐌 Very slow';
}

export function renderStatsHtml(s) {
  const card = (label, value) => `<div class="card"><div class="n">${value}</div><div class="l">${label}</div></div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Group Guard stats</title><style>
:root{--bg:#f6f7f9;--fg:#1d2330;--card:#fff;--muted:#6b7280}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#121418;--fg:#e8eaf0;--card:#1c2028;--muted:#9aa3b2}}
:root[data-theme="dark"]{--bg:#121418;--fg:#e8eaf0;--card:#1c2028;--muted:#9aa3b2}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif;padding:16px}
main{max-width:640px;margin:0 auto}.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.card{background:var(--card);border-radius:12px;padding:16px;text-align:center}.n{font-size:28px;font-weight:700}.l{color:var(--muted)}
</style></head><body><main><h1>Group Guard, live</h1><div class="grid">
${card('groups protected now', s.groups)}${card('numbers connected', s.connected)}${card('messages checked this week', s.weekMsgs)}${card('days running', s.runningDays)}
</div><p style="color:var(--muted)">Totals only. No names or numbers are shown.</p></main></body></html>`;
}

export function badgeSvg(label, value) {
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const lw = 8 + label.length * 7;
  const vw = 8 + String(value).length * 7;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${lw + vw}" height="20" role="img" aria-label="${esc(label)}: ${esc(value)}">
<rect width="${lw}" height="20" fill="#555"/><rect x="${lw}" width="${vw}" height="20" fill="#1f9d55"/>
<g fill="#fff" font-family="Verdana,sans-serif" font-size="11" text-anchor="middle">
<text x="${lw / 2}" y="14">${esc(label)}</text><text x="${lw + vw / 2}" y="14">${esc(value)}</text></g></svg>`;
}

// /stats and /badge.svg. Returns false when the URL is not one of these.
export function handlePublicRoute(req, res, enabled) {
  const url = String(req.url || '').split('?')[0];
  if (url !== '/stats' && url !== '/badge.svg') return false;
  if (!enabled) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return true;
  }
  const s = statsSnapshot();
  if (url === '/stats') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderStatsHtml(s));
  } else {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'max-age=300' });
    res.end(badgeSvg('group guard', `online ${s.runningDays}d`));
  }
  return true;
}
