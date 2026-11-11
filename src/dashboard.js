// Stage 9: customer dashboard. A private, read-only page with the customer's own numbers, opened from Telegram.
// Anyone with the link can read it, so the link is random and can be replaced.
import crypto from 'crypto';
import { markDirty } from './store.js';
import { protectedGroups, fmtExpiry, planLabel } from './plans.js';
import { sitesOf, uptimePct } from './uptime.js';
import { referralStats } from './referrals.js';

const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const newDashToken = (cust) => {
  cust.dashToken = crypto.randomBytes(20).toString('hex');
  markDirty();
  return cust.dashToken;
};

const row = (label, value) => `<tr><th>${esc(label)}</th><td>${esc(value)}</td></tr>`;
const count = (x) => ({ msgs: x?.msgs || 0, deleted: x?.deleted || 0, warned: x?.warned || 0, removed: x?.removed || 0 });

export function dashboardHtml(cust, now = Date.now()) {
  const d = count(cust.day);
  const w = count(cust.weekly);
  const r = referralStats(cust);
  const sites = sitesOf(cust);
  const siteRows = sites.length
    ? sites.map((s) => `<li>${esc(s.url)}: ${s.up === null ? 'checking' : s.up ? 'up' : 'down'} (${uptimePct(s) ?? '-'}% uptime)</li>`).join('')
    : '<li>No sites watched.</li>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Group Guard dashboard</title>
<style>
:root{--bg:#f6f7f9;--fg:#1d2330;--card:#fff;--line:#e3e6ec;--muted:#6b7280}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#121418;--fg:#e8eaf0;--card:#1c2028;--line:#2c323d;--muted:#9aa3b2}}
:root[data-theme="dark"]{--bg:#121418;--fg:#e8eaf0;--card:#1c2028;--line:#2c323d;--muted:#9aa3b2}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif;padding:16px}
main{max-width:640px;margin:0 auto}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:12px}
h1{font-size:22px;margin:4px 0 12px} h2{font-size:16px;margin:0 0 8px;color:var(--muted)}
table{width:100%;border-collapse:collapse} th,td{text-align:left;padding:6px 0;border-bottom:1px solid var(--line)} th{color:var(--muted);font-weight:500;width:50%}
ul{margin:0;padding-left:18px}
</style></head><body><main>
<h1>📊 ${esc(cust.name || 'Your dashboard')}</h1>
<div class="card"><h2>Account</h2><table>
${row('Status', cust.status || 'unknown')}
${row('Plan', planLabel(cust.plan))}
${row('Expires', fmtExpiry(cust, now))}
${row('Protected groups', protectedGroups(cust).length)}
${row('Invited friends', r.invited)}
</table></div>
<div class="card"><h2>Today</h2><table>
${row('Messages checked', d.msgs)}${row('Deleted', d.deleted)}${row('Warnings', d.warned)}${row('Removed', d.removed)}
</table></div>
<div class="card"><h2>This week so far</h2><table>
${row('Messages checked', w.msgs)}${row('Deleted', w.deleted)}${row('Warnings', w.warned)}${row('Removed', w.removed)}
</table></div>
<div class="card"><h2>Websites</h2><ul>${siteRows}</ul></div>
<p style="color:var(--muted);font-size:13px">Read-only page. Generated ${esc(new Date(now).toISOString().slice(0, 16).replace('T', ' '))} UTC.</p>
</main></body></html>`;
}

// /dash/<token>: the page for the customer who owns the token
export function handleDash(req, res, customers) {
  const m = String(req.url || '').match(/^\/dash\/([0-9a-f]{40})$/);
  const send = (code, type, body) => {
    res.writeHead(code, { 'Content-Type': type });
    res.end(body);
    return true;
  };
  if (!m) return send(404, 'text/plain', 'Not found');
  const cust = Object.values(customers).find((c) => c.dashToken && c.dashToken === m[1]);
  if (!cust) return send(404, 'text/plain', 'Not found');
  return send(200, 'text/html; charset=utf-8', dashboardHtml(cust));
}
