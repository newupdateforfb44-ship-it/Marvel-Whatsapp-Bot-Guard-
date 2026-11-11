// Owner + staff admin panel (Telegram buttons). Owner = ADMIN_IDS. Staff = people the owner adds, with limited power.
import { InlineKeyboard } from 'grammy';
import crypto from 'crypto';
import fs from 'fs';
import config from '../config.js';
import { db, save, usedSlots, removeCustomer, addLog, flush } from './store.js';
import { stopSession, sessionInfo, runningCount, restartSession, restartAll } from './guard.js';
import { subscriptionTick, resume } from './subs.js';
import { DAY, LIFETIME, isLifetime, planLabel, fmtExpiry, shortExpiry, subActive, subRequired, extendDays, maxGroups, maxBadWords } from './plans.js';
import { bot, show, waiting, isOwner, isStaff, canAdmin, msgs } from './tg.js';

// ---------- permissions ----------
// Staff can: look at customers/stats/logs, extend up to 30 days, pause/resume, message one customer.
// Everything else (plans, limits, ban, remove, broadcast, settings, restart, staff, lock) is owner only.
const STAFF_CAN = ['view', 'extend', 'suspend', 'message'];
export const STAFF_MAX_DAYS = 30;
const can = (uid, perm) => isOwner(uid) || (isStaff(uid) && STAFF_CAN.includes(perm));
const OWNER_ONLY = new Set([
  'plan', 'pl', 'trial', 'lim', 'lg', 'lw', 'ban', 'unban', 'del', 'rst', 'rstall', 'boot',
  'gs', 'limit', 'msgs', 'edit', 'reset', 'staff', 'lock', 'pin', 'cast', 'ca', 'cs', 'ct', 'cw', 'cgo',
]);

// ---------- small helpers ----------
const nm = (c) => c.name || (c.username ? `@${c.username}` : c.id);
const ICON = { connected: '🟢', pairing: '🟡', disconnected: '🟠', expired: '⏰', suspended: '⏸', banned: '🚫', none: '⚪' };
const back = (to = 'a:home') => new InlineKeyboard().text('⬅️ Back', to);
const denied = (ctx) => show(ctx, '🔒 Only the owner can do that.', back());
const fmtDur = (ms) => {
  const m = Math.floor(ms / 60000);
  if (m < 1) return '<1m';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
};
const ago = (t) => (t ? `${fmtDur(Date.now() - t)} ago` : 'never');
const stamp = (t) => new Date(t).toISOString().slice(5, 16).replace('T', ' ');

export function audit(ctx, action, c, detail = '') {
  const by = [ctx.from.first_name, ctx.from.username && `@${ctx.from.username}`].filter(Boolean).join(' ') || ctx.from.id;
  addLog('audit', `${isOwner(ctx.from.id) ? 'owner' : 'staff'} ${by}: ${action}${c ? ` · ${nm(c)}` : ''}${detail ? ` · ${detail}` : ''}`, c?.id);
}
const tell = (c, text) => bot.api.sendMessage(c.id, text).catch(() => {});

// ---------- admin lock (PIN) ----------
const unlocked = new Map(); // telegram id -> unlocked until
const pinFails = new Map(); // telegram id -> { n, until }
const UNLOCK_MIN = 30;
export const isLocked = (uid) => Boolean(db.settings.pin) && !(unlocked.get(String(uid)) > Date.now());
export function hashPin(pin, salt = crypto.randomBytes(8).toString('hex')) {
  return `${salt}:${crypto.scryptSync(String(pin), salt, 32).toString('hex')}`;
}
export function checkPin(pin, stored) {
  const [salt, h] = String(stored || '').split(':');
  if (!salt || !h) return false;
  const a = Buffer.from(h, 'hex');
  const b = crypto.scryptSync(String(pin), salt, 32);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- audiences for broadcasts ----------
export function audience(aud, sel = new Set(), now = Date.now()) {
  const all = Object.values(db.customers).filter((c) => c.status !== 'banned');
  const soon = (c) => c.expiresAt && !isLifetime(c) && c.expiresAt > now && c.expiresAt - now <= 7 * DAY;
  switch (aud) {
    case 'all':
      return all;
    case 'act':
      return all.filter((c) => c.status === 'connected');
    case 'exp':
      return all.filter((c) => c.status === 'expired' || (c.expiresAt && c.expiresAt < now));
    case 'soon':
      return all.filter(soon);
    case 'sel':
      return Object.values(db.customers).filter((c) => sel.has(c.id));
  }
  return [];
}
const AUD_LABEL = { all: 'Everyone', act: 'Connected customers', exp: 'Expired customers', soon: 'Expiring within 7 days', sel: 'Selected customers' };
const casts = new Map(); // owner id -> { aud, sel:Set, text }

// ---------- customer list (search + filters) ----------
const FILTERS = [['all', 'All'], ['connected', 'Connected'], ['expiring', 'Expiring soon'], ['expired', 'Expired'], ['suspended', 'Paused'], ['banned', 'Blocked'], ['new', 'No number yet']];
const views = new Map(); // admin id -> { f, q, page }
const view = (uid) => {
  if (!views.has(uid)) views.set(uid, { f: 'all', q: '', page: 0 });
  return views.get(uid);
};
export function filterCustomers(v, now = Date.now()) {
  const q = v.q.trim().toLowerCase();
  const list = Object.values(db.customers).filter((c) => {
    if (q) {
      const hay = [c.name, c.username, c.id, c.number, planLabel(c.plan), c.status].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    const listed = Boolean(c.number) || c.status === 'banned';
    switch (v.f) {
      case 'connected':
        return c.status === 'connected';
      case 'expiring':
        return listed && c.status !== 'banned' && c.expiresAt && !isLifetime(c) && c.expiresAt - now < 7 * DAY;
      case 'expired':
        return c.status === 'expired' || (listed && c.expiresAt && c.expiresAt < now);
      case 'suspended':
        return c.status === 'suspended';
      case 'banned':
        return c.status === 'banned';
      case 'new':
        return !c.number && c.status !== 'banned';
      default:
        return q ? true : listed;
    }
  });
  list.sort(v.f === 'expiring' ? (a, b) => a.expiresAt - b.expiresAt : (a, b) => b.createdAt - a.createdAt);
  return list;
}

const PAGE = 8;
async function listView(ctx, uid) {
  const v = view(uid);
  const list = filterCustomers(v);
  const maxPage = Math.max(0, Math.ceil(list.length / PAGE) - 1);
  v.page = Math.min(v.page, maxPage);
  const slice = list.slice(v.page * PAGE, v.page * PAGE + PAGE);
  const kb = new InlineKeyboard();
  slice.forEach((c) => kb.text(`${ICON[c.status] || '⚪'} ${nm(c)} · ${planLabel(c.plan)} · ${shortExpiry(c)}`, `a:c:${c.id}`).row());
  const nav = [];
  if (v.page > 0) nav.push(['◀️ Prev', `a:list:${v.page - 1}`]);
  if (v.page < maxPage) nav.push(['Next ▶️', `a:list:${v.page + 1}`]);
  nav.forEach(([t, d]) => kb.text(t, d));
  if (nav.length) kb.row();
  const i = FILTERS.findIndex(([k]) => k === v.f);
  const [nextKey] = FILTERS[(i + 1) % FILTERS.length];
  kb.text(`🔽 Filter: ${FILTERS[i][1]}`, `a:flt:${nextKey}`).text('🔎 Search', 'a:search').row();
  if (v.q) kb.text(`✖️ Clear "${v.q.slice(0, 20)}"`, 'a:clrq').row();
  kb.text('⬅️ Back', 'a:home');
  await show(ctx, `👥 Customers (${list.length})${v.q ? `\n🔎 Search: ${v.q}` : ''}\n${ICON.connected} connected ${ICON.expired} expired ${ICON.suspended} paused ${ICON.banned} blocked`, kb);
}

// ---------- one customer ----------
function customerText(c) {
  const info = sessionInfo(c.id);
  const lim = maxGroups(c);
  const groups = Object.keys(c.groups || {}).length;
  return (
    `👤 ${c.name || '(no name)'}${c.username ? ` @${c.username}` : ''}\n` +
    `Telegram ID: ${c.id}\n` +
    `WhatsApp: ${c.number ? `+${c.number}` : '-'}\n` +
    `Status: ${ICON[c.status] || '⚪'} ${c.status}${info ? ` (${info.state}, up ${fmtDur(Date.now() - info.since)})` : ''}\n` +
    (c.status === 'suspended' && c.suspendReason ? `Pause reason: ${c.suspendReason}\n` : '') +
    (c.status === 'banned' && c.banReason ? `Block reason: ${c.banReason}\n` : '') +
    `Plan: ${planLabel(c.plan)}\n` +
    `Expires: ${fmtExpiry(c)}\n` +
    `Groups seen: ${groups}${lim ? ` / ${lim} allowed` : ' (no limit)'}\n` +
    `Joined: ${new Date(c.createdAt).toISOString().slice(0, 10)}`
  );
}

async function customerView(ctx, id) {
  const uid = String(ctx.from.id);
  const c = db.customers[id];
  if (!c) return listView(ctx, uid);
  const owner = isOwner(uid);
  const kb = new InlineKeyboard();
  if (can(uid, 'extend')) kb.text('➕ Extend days', `a:ext:${id}`);
  if (owner) kb.text('📦 Plan', `a:plan:${id}`);
  kb.row();
  if (owner) kb.text('🎁 Give trial', `a:trial:${id}`).text('🎯 Limits', `a:lim:${id}`).row();
  if (c.status === 'suspended' || c.status === 'expired') kb.text('▶️ Resume', `a:res:${id}`);
  else if (c.number && c.status !== 'banned') kb.text('⏸ Pause', `a:susp:${id}`);
  if (owner) kb.text(c.status === 'banned' ? '✅ Unblock' : '🚫 Block', c.status === 'banned' ? `a:unban:${id}` : `a:ban:${id}`);
  kb.row().text('📊 Usage', `a:use:${id}`).text('💬 Message', `a:msg:${id}`).row();
  if (owner) kb.text('🔄 Restart session', `a:rst:${id}`).text('🗑 Remove', `a:del:${id}`).row();
  kb.text('⬅️ Back', 'a:list:0');
  await show(ctx, customerText(c), kb);
}

function extendView(ctx, c, uid) {
  const kb = new InlineKeyboard();
  [7, 14, 30].forEach((d) => kb.text(`+${d} days`, `a:ext:${c.id}:${d}`));
  kb.row();
  if (isOwner(uid)) {
    [60, 90, 365].forEach((d) => kb.text(`+${d} days`, `a:ext:${c.id}:${d}`));
    kb.row().text('♾ Lifetime', `a:ext:${c.id}:life`);
  }
  kb.text('✍️ Custom days', `a:ext:${c.id}:custom`).row().text('⬅️ Back', `a:c:${c.id}`);
  return show(ctx, `➕ Extend ${nm(c)}\n\nExpires: ${fmtExpiry(c)}\nDays are added on top of the current expiry (or from today if already expired).${isOwner(uid) ? '' : `\nStaff can add up to ${STAFF_MAX_DAYS} days at a time.`}`, kb);
}

async function doExtend(ctx, c, days) {
  const uid = String(ctx.from.id);
  if (!Number.isInteger(days) || days < 1 || days > 3650) return ctx.reply('Send a whole number of days between 1 and 3650.');
  if (!isOwner(uid) && days > STAFF_MAX_DAYS) return ctx.reply(`Staff can add at most ${STAFF_MAX_DAYS} days at a time.`);
  extendDays(c, days);
  save();
  audit(ctx, `extended ${days} days`, c, fmtExpiry(c));
  tell(c, `✅ Your subscription was extended by ${days} days.\nExpires: ${fmtExpiry(c)}`);
  if (c.status === 'expired') await resume(c);
  return customerView(ctx, c.id);
}

function planView(ctx, c) {
  const kb = new InlineKeyboard();
  Object.entries(config.PLANS).forEach(([k, p]) => kb.text(`${c.plan === k ? '✅ ' : ''}${p.label}${p.maxGroups ? ` (${p.maxGroups} groups)` : ' (unlimited)'}`, `a:pl:${c.id}:${k}`).row());
  kb.text(`${c.plan ? '' : '✅ '}No plan`, `a:pl:${c.id}:none`).row().text('⬅️ Back', `a:c:${c.id}`);
  return show(ctx, `📦 Plan for ${nm(c)}\n\nCurrent: ${planLabel(c.plan)}\nChanging the plan does not change the expiry date.`, kb);
}

function limitsView(ctx, c) {
  const kb = new InlineKeyboard();
  const g = c.limits.maxGroups || 0;
  kb.text(`👥 Max groups (now ${maxGroups(c) || 'unlimited'})`, 'noop').row();
  [0, 1, 2, 3, 5, 10, 20, 50].forEach((n) => kb.text((n === g ? '✅ ' : '') + (n === 0 ? 'Plan' : n), `a:lg:${c.id}:${n}`));
  kb.row();
  const w = c.limits.maxBadWords || 0;
  kb.text(`🤬 Max bad words (now ${maxBadWords(c)})`, 'noop').row();
  [0, 20, 50, 100, 200].forEach((n) => kb.text((n === w ? '✅ ' : '') + (n === 0 ? 'Default' : n), `a:lw:${c.id}:${n}`));
  kb.row().text('⬅️ Back', `a:c:${c.id}`);
  return show(ctx, `🎯 Limits for ${nm(c)}\n\n"Plan" = use the limit of their plan (${planLabel(c.plan)}). Groups over the limit are simply not guarded, and the customer gets one Telegram notice.`, kb);
}

function usageText(c) {
  const s = c.stats || {};
  const groups = Object.entries(c.groups || {}).sort((a, b) => (b[1].msgs || 0) - (a[1].msgs || 0));
  return (
    `📊 Usage · ${nm(c)}\n\n` +
    `Messages checked: ${s.msgs || 0}\nDeleted: ${s.deleted || 0} · Warnings: ${s.warned || 0} · Removed: ${s.removed || 0} · Commands: ${s.cmds || 0}\n\n` +
    `Groups (${groups.length}):\n` +
    (groups.slice(0, 10).map(([, g]) => `• ${g.name || 'unnamed'}: ${g.msgs || 0} msgs, ${g.deleted || 0} deleted, last ${ago(g.last)}`).join('\n') || 'none yet') +
    (groups.length > 10 ? `\n…and ${groups.length - 10} more` : '')
  );
}

// ---------- pause / block with a reason ----------
function askReason(ctx, kind, c) {
  const uid = String(ctx.from.id);
  waiting.set(uid, { type: 'reason', kind, id: c.id });
  return show(
    ctx,
    `${kind === 'ban' ? '🚫 Block' : '⏸ Pause'} ${nm(c)}\n\nType the reason (the customer will see it), or skip.`,
    new InlineKeyboard().text('⏭ No reason', `a:rs:${kind}:${c.id}`).row().text('⬅️ Cancel', `a:c:${c.id}`)
  );
}

async function applyReason(ctx, kind, c, reason) {
  reason = reason.slice(0, 200);
  if (kind === 'ban') {
    await stopSession(c.id, { wipe: true, logout: true });
    c.status = 'banned';
    c.banReason = reason;
    save();
    audit(ctx, 'blocked', c, reason);
    tell(c, `🚫 Your access has been blocked by the admin.${reason ? `\n\nReason: ${reason}` : ''}`);
  } else {
    if (!c.number) return ctx.reply('This customer has no WhatsApp number linked.');
    await stopSession(c.id); // keeps the WhatsApp login, so resuming is instant
    c.status = 'suspended';
    c.suspendReason = reason;
    save();
    audit(ctx, 'paused', c, reason);
    tell(c, `⏸ Your service was paused by the admin.${reason ? `\n\nReason: ${reason}` : ''}\n\nContact the admin if you think this is a mistake.`);
  }
  return customerView(ctx, c.id);
}

// ---------- home ----------
export async function adminHome(ctx) {
  const uid = String(ctx.from.id);
  const owner = isOwner(uid);
  const all = Object.values(db.customers);
  const now = Date.now();
  const expSoon = all.filter((c) => c.status === 'connected' && c.expiresAt && !isLifetime(c) && c.expiresAt > now && c.expiresAt - now < 7 * DAY).length;
  const text =
    `🛠 Admin panel${owner ? '' : ' (staff)'}\n\n` +
    `Slots used: ${usedSlots()} / ${db.settings.maxCustomers}\n` +
    `Connected: ${all.filter((c) => c.status === 'connected').length} (sessions running: ${runningCount()})\n` +
    `Expiring in 7 days: ${expSoon} · Expired: ${all.filter((c) => c.status === 'expired').length} · Paused: ${all.filter((c) => c.status === 'suspended').length}\n` +
    `Subscriptions: ${subRequired() ? 'required' : 'not required'}` +
    (db.settings.maintenance ? '\n🚧 MAINTENANCE MODE IS ON' : '');
  const kb = new InlineKeyboard().text('👥 Customers', 'a:list:0').text('🔎 Search', 'a:search').row().text('📡 Live monitor', 'a:mon').text('📊 Stats', 'a:stats').row().text('📜 Logs', 'a:log:audit:0');
  if (owner) {
    kb.text('📢 Broadcast', 'a:cast').row().text('⚙️ Global settings', 'a:gs').text('🎚 Customer limit', 'a:limit').row().text('✏️ Edit messages', 'a:msgs').text('👮 Staff', 'a:staff').row().text(`🔒 Admin lock${db.settings.pin ? ' (on)' : ''}`, 'a:lock').row().text('💾 Backup', 'bak').text('♻️ Restore', 'rst').row();
  } else kb.row();
  kb.text('⬅️ Home', 'home');
  await show(ctx, text, kb);
}

// ---------- monitor ----------
export function baileysVersion() {
  try {
    return JSON.parse(fs.readFileSync('./node_modules/@whiskeysockets/baileys/package.json', 'utf8')).version;
  } catch {
    return 'unknown';
  }
}

async function monitorView(ctx, uid) {
  const connected = Object.values(db.customers).filter((c) => c.status === 'connected');
  const rows = connected.map((c) => {
    const i = sessionInfo(c.id);
    if (!i) return { c, line: `🔴 ${nm(c)} · NOT RUNNING`, bad: true };
    const ok = i.state === 'open';
    return { c, bad: !ok, line: `${ok ? '🟢' : '🟠'} ${nm(c)} · ${i.state} · up ${fmtDur(Date.now() - i.since)} · queue ${i.queue} · last msg ${ago(i.lastMsgAt)} · reconnects ${i.reconnects}` };
  });
  const mem = Math.round(process.memoryUsage().rss / 1048576);
  const kb = new InlineKeyboard().text('🔄 Refresh', 'a:mon').row();
  if (isOwner(uid)) {
    rows.filter((r) => r.bad).forEach((r) => kb.text(`🔄 Restart ${nm(r.c).slice(0, 18)}`, `a:rst:${r.c.id}`).row());
    kb.text('♻️ Restart all sessions', 'a:rstall').row().text('⏻ Restart whole bot', 'a:boot').row();
  }
  kb.text('⬅️ Back', 'a:home');
  await show(
    ctx,
    `📡 Live monitor\n\nBot uptime: ${fmtDur(process.uptime() * 1000)} · RAM: ${mem} MB\nStorage: ${config.MYSQL_URL ? 'MySQL' : 'local files'} · Node ${process.version}\nBaileys: ${baileysVersion()}\nSessions running: ${runningCount()} / connected customers: ${connected.length}\n\n${rows.map((r) => r.line).join('\n') || 'No connected customers.'}`,
    kb
  );
}

// ---------- stats ----------
export function statsText() {
  const all = Object.values(db.customers);
  const count = (f) => all.filter(f).length;
  const plans = {};
  all.filter((c) => c.number).forEach((c) => (plans[planLabel(c.plan)] = (plans[planLabel(c.plan)] || 0) + 1));
  const sum = (k) => all.reduce((n, c) => n + (c.stats?.[k] || 0), 0);
  const days = Object.keys(db.daily || {}).sort().slice(-7);
  const maxDel = Math.max(1, ...days.map((d) => db.daily[d].deleted || 0));
  const top = all.filter((c) => c.stats?.deleted).sort((a, b) => b.stats.deleted - a.stats.deleted).slice(0, 5);
  return (
    `📊 Stats\n\n` +
    `Customers: ${count((c) => c.number)} with a number · ${count((c) => c.status === 'connected')} connected · ${count((c) => c.status === 'expired')} expired · ${count((c) => c.status === 'suspended')} paused · ${count((c) => c.status === 'banned')} blocked\n` +
    `Plans: ${Object.entries(plans).map(([k, n]) => `${k} ${n}`).join(' · ') || '-'}\n` +
    `Groups seen: ${all.reduce((n, c) => n + Object.keys(c.groups || {}).length, 0)}\n\n` +
    `All time: ${sum('msgs')} messages checked · ${sum('deleted')} deleted · ${sum('warned')} warnings · ${sum('removed')} removed · ${sum('cmds')} commands\n\n` +
    `Last 7 days (deleted · warned · removed):\n` +
    (days.map((d) => `${d.slice(5)} ${'█'.repeat(Math.round(((db.daily[d].deleted || 0) / maxDel) * 8)).padEnd(8, '░')} ${db.daily[d].deleted || 0} · ${db.daily[d].warned || 0} · ${db.daily[d].removed || 0}`).join('\n') || 'No data yet.') +
    (top.length ? `\n\nTop by deletions:\n${top.map((c) => `• ${nm(c)}: ${c.stats.deleted}`).join('\n')}` : '')
  );
}

// ---------- logs ----------
const LOG_TABS = [['audit', '📜 Actions'], ['event', '📌 Events'], ['err', '⚠️ Errors']];
async function logView(ctx, tab, page) {
  if (!LOG_TABS.some(([k]) => k === tab)) tab = 'audit';
  const items = (tab === 'err' ? db.errors.map((e) => ({ t: e.t, text: `${e.src}: ${e.msg}${e.n > 1 ? ` (x${e.n})` : ''}` })) : db.log.filter((l) => l.kind === tab)).slice().reverse();
  const SIZE = 10;
  const maxPage = Math.max(0, Math.ceil(items.length / SIZE) - 1);
  page = Math.min(Math.max(0, page), maxPage);
  const kb = new InlineKeyboard();
  LOG_TABS.forEach(([k, label]) => kb.text(`${k === tab ? '• ' : ''}${label}`, `a:log:${k}:0`));
  kb.row();
  if (page > 0) kb.text('◀️ Newer', `a:log:${tab}:${page - 1}`);
  if (page < maxPage) kb.text('Older ▶️', `a:log:${tab}:${page + 1}`);
  if (page > 0 || page < maxPage) kb.row();
  kb.text('⬅️ Back', 'a:home');
  const body = items.slice(page * SIZE, page * SIZE + SIZE).map((l) => `${stamp(l.t)} ${l.text}`).join('\n');
  await show(ctx, `${LOG_TABS.find(([k]) => k === tab)[1]} (UTC, newest first)\n\n${body || 'Nothing yet.'}`, kb);
}

// ---------- global settings ----------
async function settingsView(ctx) {
  const s = db.settings;
  const kb = new InlineKeyboard()
    .text(`${s.maintenance ? '✅' : '⬜'} Maintenance mode`, 'a:gs:maint').row()
    .text(`${s.requireSubscription ? '✅' : '⬜'} Require subscription`, 'a:gs:req').row()
    .text(`🎁 Free trial for new customers: ${s.trialDays ? `${s.trialDays} days` : 'off'}`, 'noop').row();
  [0, 1, 3, 7, 14].forEach((n) => kb.text((n === s.trialDays ? '✅ ' : '') + (n === 0 ? 'Off' : `${n}d`), `a:gs:trial:${n}`));
  kb.row().text(`${s.errorAlerts ? '✅' : '⬜'} Alerts to me (errors, drops, new customers)`, 'a:gs:err').row().text('⬅️ Back', 'a:home');
  await show(
    ctx,
    `⚙️ Global settings\n\n🚧 Maintenance: customers see the maintenance message in the bot and cannot connect. Groups stay protected.\n💳 Require subscription: customers need an active plan; expired ones are disconnected automatically (their login is kept, so renewing reconnects them). OFF = nobody expires.\n🎁 Trial: given once, when a new customer first connects (only while subscriptions are required).`,
    kb
  );
}

async function toggleRequire(ctx, step) {
  const s = db.settings;
  const now = Date.now();
  if (s.requireSubscription) {
    if (step !== 'yes')
      return show(ctx, 'Turn OFF required subscriptions?\n\nEveryone gets service regardless of expiry. Expired customers are reconnected.', new InlineKeyboard().text('✅ Turn off', 'a:gs:req:yes').row().text('⬅️ Cancel', 'a:gs'));
    s.requireSubscription = false;
    save();
    audit(ctx, 'subscriptions: not required');
    for (const c of Object.values(db.customers)) if (c.status === 'expired') await resume(c);
    return settingsView(ctx);
  }
  const lacking = Object.values(db.customers).filter((c) => c.status === 'connected' && !subActive(c, now));
  if (!step) {
    const kb = new InlineKeyboard();
    if (lacking.length) {
      kb.text(`✅ Turn on + 7 days grace for ${lacking.length}`, 'a:gs:req:grace').row().text(`⚠️ Turn on, disconnect ${lacking.length} now`, 'a:gs:req:yes').row();
    } else kb.text('✅ Turn on', 'a:gs:req:yes').row();
    kb.text('⬅️ Cancel', 'a:gs');
    return show(ctx, `Turn ON required subscriptions?\n\n${lacking.length ? `${lacking.length} connected customer(s) have no active subscription:\n${lacking.slice(0, 10).map((c) => `• ${nm(c)}`).join('\n')}\n\nThey would be disconnected within 10 minutes unless you give them a grace period.` : 'Everyone connected already has an active subscription.'}`, kb);
  }
  if (step === 'grace') {
    for (const c of lacking) {
      c.expiresAt = now + 7 * DAY;
      c.reminded = {};
      tell(c, '📣 Subscriptions are now required. You have 7 days to renew. Contact the admin.');
    }
  }
  s.requireSubscription = true;
  save();
  audit(ctx, 'subscriptions: required', null, step === 'grace' ? `grace for ${lacking.length}` : '');
  await subscriptionTick();
  return settingsView(ctx);
}

// ---------- staff + lock ----------
async function staffView(ctx) {
  const kb = new InlineKeyboard();
  db.settings.staff.forEach((id) => kb.text(`❌ ${db.customers[id] ? nm(db.customers[id]) : id}`, `a:staff:del:${id}`).row());
  kb.text('➕ Add staff', 'a:staff:add').row().text('⬅️ Back', 'a:home');
  await show(
    ctx,
    `👮 Staff (${db.settings.staff.length})\n\nStaff can open the admin panel and: view customers, stats and logs, extend up to ${STAFF_MAX_DAYS} days, pause/resume, and message one customer.\nThey cannot: change plans or limits, block or remove customers, broadcast, change settings, restart, or manage staff.\n\nEvery staff action is written to the action history.`,
    kb
  );
}

async function lockView(ctx) {
  const on = Boolean(db.settings.pin);
  const kb = new InlineKeyboard().text(on ? '🔑 Change PIN' : '🔑 Set PIN', 'a:pin:set').row();
  if (on) kb.text('🔒 Lock now', 'a:pin:now').row().text('🗑 Remove PIN', 'a:pin:rm').row();
  kb.text('⬅️ Back', 'a:home');
  await show(ctx, `🔒 Admin lock\n\n${on ? `ON. The admin panel (owner and staff) asks for the PIN, then stays open for ${UNLOCK_MIN} minutes. 5 wrong tries lock it for 15 minutes.\n\nForgot it? Set the environment variable RESET_ADMIN_PIN=true, redeploy once, then remove it.` : 'OFF. Set a 4-8 digit PIN so nobody can use the admin panel if they get hold of your phone.'}`, kb);
}

// ---------- customer limit + messages (moved here from bot.js) ----------
async function limitView(ctx) {
  const kb = new InlineKeyboard();
  [5, 10, 20, 50].forEach((n) => kb.text(String(n), `a:limit:set:${n}`));
  kb.row().text('✍️ Custom number', 'a:limit:custom').row().text('⬅️ Back', 'a:home');
  await show(ctx, `🎚 Customer limit: ${db.settings.maxCustomers}\nSlots used: ${usedSlots()}\n\nWhen the limit is reached, new customers see the "limit reached" message and are told to contact you.`, kb);
}

const MSG_LABELS = { welcome: 'Welcome message', howItWorks: 'How it works', limitReached: 'Limit reached message', maintenance: 'Maintenance message', expired: 'Subscription ended message' };
async function msgsView(ctx) {
  const kb = new InlineKeyboard();
  Object.entries(MSG_LABELS).forEach(([k, label]) => kb.text(`✏️ ${label}`, `a:edit:${k}`).row());
  kb.text('⬅️ Back', 'a:home');
  await show(ctx, '✏️ Which message do you want to edit?', kb);
}

// ---------- broadcast ----------
async function castAudienceView(ctx) {
  const kb = new InlineKeyboard();
  Object.keys(AUD_LABEL).forEach((k) => kb.text(`${AUD_LABEL[k]}${k === 'sel' ? '' : ` (${audience(k).length})`}`, k === 'sel' ? 'a:cs:0' : `a:ca:${k}`).row());
  kb.text('⬅️ Back', 'a:home');
  await show(ctx, '📢 Broadcast\n\nWho should get the message?', kb);
}

async function castSelectView(ctx, uid, page) {
  const st = casts.get(uid) || casts.set(uid, { aud: 'sel', sel: new Set(), text: '' }).get(uid);
  st.aud = 'sel';
  const list = Object.values(db.customers).filter((c) => c.status !== 'banned' && (c.number || c.status !== 'none')).sort((a, b) => b.createdAt - a.createdAt);
  const maxPage = Math.max(0, Math.ceil(list.length / PAGE) - 1);
  page = Math.min(Math.max(0, page), maxPage);
  const kb = new InlineKeyboard();
  list.slice(page * PAGE, page * PAGE + PAGE).forEach((c) => kb.text(`${st.sel.has(c.id) ? '✅' : '⬜'} ${nm(c)}`, `a:ct:${c.id}:${page}`).row());
  if (page > 0) kb.text('◀️ Prev', `a:cs:${page - 1}`);
  if (page < maxPage) kb.text('Next ▶️', `a:cs:${page + 1}`);
  if (page > 0 || page < maxPage) kb.row();
  if (st.sel.size) kb.text(`✍️ Write message (${st.sel.size} selected)`, 'a:cw').row();
  kb.text('⬅️ Back', 'a:cast');
  await show(ctx, '📢 Pick the customers who get the message.', kb);
}

function castPreview(ctx, uid) {
  const st = casts.get(uid);
  const n = audience(st.aud, st.sel).length;
  return show(ctx, `📢 To: ${AUD_LABEL[st.aud]} (${n})\n\n${st.text}`, new InlineKeyboard().text(`📤 Send to ${n}`, 'a:cgo').row().text('⬅️ Cancel', 'a:home'));
}

async function castSend(ctx, uid) {
  const st = casts.get(uid);
  if (!st?.text) return adminHome(ctx);
  const list = audience(st.aud, st.sel);
  casts.delete(uid);
  let sent = 0;
  for (const c of list) {
    try {
      await bot.api.sendMessage(c.id, st.text);
      sent++;
    } catch {}
    await new Promise((r) => setTimeout(r, 60));
  }
  audit(ctx, 'broadcast', null, `${AUD_LABEL[st.aud]}: ${sent}/${list.length} delivered`);
  await ctx.reply(`📢 Delivered to ${sent} of ${list.length}.`);
  return adminHome(ctx);
}

// ---------- button router (everything that starts with "a:") ----------
export async function adminRoute(ctx, p) {
  const uid = String(ctx.from.id);
  if (!canAdmin(uid)) return;
  if (isLocked(uid)) {
    waiting.set(uid, { type: 'pin' });
    return show(ctx, '🔒 The admin panel is locked.\n\nSend your admin PIN (I will delete your message).', new InlineKeyboard().text('⬅️ Cancel', 'home'));
  }
  const a = p[1];
  if (OWNER_ONLY.has(a) && !isOwner(uid)) return denied(ctx);
  const c = db.customers[p[2]];

  switch (a) {
    case 'home':
      return adminHome(ctx);
    case 'list':
      view(uid).page = Number(p[2]) || 0;
      return listView(ctx, uid);
    case 'flt':
      if (FILTERS.some(([k]) => k === p[2])) Object.assign(view(uid), { f: p[2], page: 0 });
      return listView(ctx, uid);
    case 'clrq':
      Object.assign(view(uid), { q: '', page: 0 });
      return listView(ctx, uid);
    case 'search':
      waiting.set(uid, { type: 'search' });
      return show(ctx, '🔎 Send a name, @username, Telegram ID, WhatsApp number or plan name.', new InlineKeyboard().text('⬅️ Cancel', 'a:list:0'));
    case 'c':
      return customerView(ctx, p[2]);

    case 'ext': {
      if (!c) return listView(ctx, uid);
      if (!can(uid, 'extend')) return denied(ctx);
      const v = p[3];
      if (!v) return extendView(ctx, c, uid);
      if (v === 'custom') {
        waiting.set(uid, { type: 'extdays', id: c.id });
        return show(ctx, 'Type the number of days to add.', new InlineKeyboard().text('⬅️ Cancel', `a:ext:${c.id}`));
      }
      if (v === 'life') {
        if (!isOwner(uid)) return denied(ctx);
        c.expiresAt = LIFETIME;
        c.reminded = {};
        save();
        audit(ctx, 'set lifetime', c);
        tell(c, '🎉 Your subscription is now lifetime.');
        if (c.status === 'expired') await resume(c);
        return customerView(ctx, c.id);
      }
      return doExtend(ctx, c, Number(v));
    }
    case 'plan':
      return c ? planView(ctx, c) : listView(ctx, uid);
    case 'pl': {
      if (!c) return listView(ctx, uid);
      const key = p[3] === 'none' ? '' : p[3];
      if (key && !config.PLANS[key]) return;
      c.plan = key;
      save();
      audit(ctx, 'changed plan', c, planLabel(key));
      return customerView(ctx, c.id);
    }
    case 'trial': {
      if (!c) return listView(ctx, uid);
      const days = db.settings.trialDays || 3;
      c.plan = 'trial';
      c.trialUsed = true;
      c.expiresAt = Date.now() + days * DAY;
      c.reminded = {};
      save();
      audit(ctx, `gave ${days}-day trial`, c);
      tell(c, `🎁 You got a ${days}-day free trial.\nExpires: ${fmtExpiry(c)}`);
      if (c.status === 'expired') await resume(c);
      return customerView(ctx, c.id);
    }
    case 'lim':
      return c ? limitsView(ctx, c) : listView(ctx, uid);
    case 'lg':
    case 'lw': {
      if (!c) return listView(ctx, uid);
      const n = Number(p[3]);
      const opts = a === 'lg' ? [0, 1, 2, 3, 5, 10, 20, 50] : [0, 20, 50, 100, 200];
      if (!opts.includes(n)) return;
      c.limits[a === 'lg' ? 'maxGroups' : 'maxBadWords'] = n;
      save();
      audit(ctx, a === 'lg' ? 'set max groups' : 'set max bad words', c, n ? String(n) : 'default');
      return limitsView(ctx, c);
    }

    case 'susp':
      if (!c) return listView(ctx, uid);
      if (!can(uid, 'suspend')) return denied(ctx);
      return askReason(ctx, 'susp', c);
    case 'ban':
      return c ? askReason(ctx, 'ban', c) : listView(ctx, uid);
    case 'rs': {
      // a:rs:<susp|ban>:<id> = continue without a reason
      const cc = db.customers[p[3]];
      if (!cc) return listView(ctx, uid);
      if (p[2] === 'ban' && !isOwner(uid)) return denied(ctx);
      if (p[2] === 'susp' && !can(uid, 'suspend')) return denied(ctx);
      return applyReason(ctx, p[2] === 'ban' ? 'ban' : 'susp', cc, '');
    }
    case 'res': {
      if (!c) return listView(ctx, uid);
      if (!can(uid, 'suspend')) return denied(ctx);
      const wasSuspended = c.status === 'suspended';
      const ok = await resume(c);
      audit(ctx, 'resumed', c, ok ? '' : 'still expired');
      if (ok) tell(c, '▶️ Your service is active again.');
      else if (wasSuspended) tell(c, '▶️ Your pause was lifted, but your subscription has ended. Contact the admin to renew.');
      return customerView(ctx, c.id);
    }
    case 'unban':
      if (c) {
        c.status = 'disconnected';
        c.banReason = '';
        save();
        audit(ctx, 'unblocked', c);
        tell(c, '✅ Your access is back. Open the bot and tap Connect WhatsApp.');
      }
      return customerView(ctx, p[2]);
    case 'msg':
      if (!c) return listView(ctx, uid);
      if (!can(uid, 'message')) return denied(ctx);
      waiting.set(uid, { type: 'usermsg', id: c.id });
      return show(ctx, `💬 Type the message for ${nm(c)}. They will receive it in this bot.`, new InlineKeyboard().text('⬅️ Cancel', `a:c:${c.id}`));
    case 'use':
      return c ? show(ctx, usageText(c), back(`a:c:${c.id}`)) : listView(ctx, uid);
    case 'rst': {
      if (!c) return listView(ctx, uid);
      try {
        await restartSession(c.id);
        audit(ctx, 'restarted session', c);
      } catch (e) {
        await ctx.reply(`Could not restart: ${e.message}`);
      }
      return monitorView(ctx, uid);
    }
    case 'del': {
      if (p[2] === 'yes') {
        const gone = db.customers[p[3]];
        await stopSession(p[3], { wipe: true, logout: true });
        removeCustomer(p[3]);
        audit(ctx, 'removed customer', gone);
        return listView(ctx, uid);
      }
      return show(ctx, 'Remove this customer and unlink their WhatsApp? This cannot be undone.', new InlineKeyboard().text('🗑 Yes, remove', `a:del:yes:${p[2]}`).row().text('⬅️ No', `a:c:${p[2]}`));
    }

    case 'mon':
      if (!can(uid, 'view')) return denied(ctx);
      return monitorView(ctx, uid);
    case 'rstall':
      if (p[2] === 'yes') {
        await show(ctx, '♻️ Restarting all sessions, one by one…', new InlineKeyboard());
        await restartAll();
        audit(ctx, 'restarted all sessions');
        return monitorView(ctx, uid);
      }
      return show(ctx, 'Restart every WhatsApp session now? Each customer reconnects in a few seconds.', new InlineKeyboard().text('♻️ Yes, restart all', 'a:rstall:yes').row().text('⬅️ No', 'a:mon'));
    case 'boot':
      if (p[2] === 'yes') {
        audit(ctx, 'restarted the whole bot');
        await flush();
        await ctx.reply('⏻ Restarting. Back in about a minute…');
        setTimeout(() => process.exit(0), 500);
        return;
      }
      return show(ctx, 'Restart the whole bot?\n\nEvery session reconnects after it comes back. This only works on a host that restarts the app automatically (Render does).', new InlineKeyboard().text('⏻ Yes, restart', 'a:boot:yes').row().text('⬅️ No', 'a:mon'));
    case 'stats':
      return show(ctx, statsText(), new InlineKeyboard().text('🔄 Refresh', 'a:stats').row().text('⬅️ Back', 'a:home'));
    case 'log':
      return logView(ctx, p[2], Number(p[3]) || 0);

    case 'gs': {
      const what = p[2];
      if (what === 'maint') {
        if (db.settings.maintenance || p[3] === 'yes') {
          db.settings.maintenance = !db.settings.maintenance;
          save();
          audit(ctx, `maintenance ${db.settings.maintenance ? 'ON' : 'OFF'}`);
        } else {
          return show(ctx, 'Turn ON maintenance mode?\n\nCustomers will only see the maintenance message and cannot connect or change settings. Groups stay protected.', new InlineKeyboard().text('🚧 Yes, turn on', 'a:gs:maint:yes').row().text('⬅️ Cancel', 'a:gs'));
        }
      } else if (what === 'req') return toggleRequire(ctx, p[3]);
      else if (what === 'trial' && [0, 1, 3, 7, 14].includes(Number(p[3]))) {
        db.settings.trialDays = Number(p[3]);
        save();
        audit(ctx, 'trial days', null, String(p[3]));
      } else if (what === 'err') {
        db.settings.errorAlerts = !db.settings.errorAlerts;
        save();
      }
      return settingsView(ctx);
    }
    case 'limit': {
      if (p[2] === 'set') {
        db.settings.maxCustomers = Number(p[3]);
        save();
        audit(ctx, 'customer limit', null, p[3]);
        return adminHome(ctx);
      }
      if (p[2] === 'custom') {
        waiting.set(uid, { type: 'limit' });
        return show(ctx, 'Type the new customer limit (a number):', new InlineKeyboard().text('⬅️ Cancel', 'a:home'));
      }
      return limitView(ctx);
    }
    case 'msgs':
      return msgsView(ctx);
    case 'edit': {
      const key = p[2];
      if (!MSG_LABELS[key]) return;
      waiting.set(uid, { type: 'edit', key });
      return show(ctx, `Current ${MSG_LABELS[key]}:\n\n${msgs()[key]}\n\n— Send the new text now.`, new InlineKeyboard().text('↩️ Reset to default', `a:reset:${key}`).row().text('⬅️ Cancel', 'a:msgs'));
    }
    case 'reset':
      if (MSG_LABELS[p[2]]) {
        db.settings.messages[p[2]] = config.DEFAULT_MESSAGES[p[2]];
        save();
      }
      return msgsView(ctx);

    case 'staff': {
      if (p[2] === 'add') {
        waiting.set(uid, { type: 'staffadd' });
        return show(ctx, 'Send the Telegram numeric ID of the person (they can get it from @userinfobot). They must have started this bot once.', new InlineKeyboard().text('⬅️ Cancel', 'a:staff'));
      }
      if (p[2] === 'del') {
        db.settings.staff = db.settings.staff.filter((x) => x !== p[3]);
        save();
        audit(ctx, 'removed staff', null, p[3]);
        unlocked.delete(p[3]);
      }
      return staffView(ctx);
    }
    case 'lock':
      return lockView(ctx);
    case 'pin': {
      if (p[2] === 'set') {
        waiting.set(uid, { type: 'pinset' });
        return show(ctx, 'Send the new PIN: 4 to 8 digits. I will delete your message.', new InlineKeyboard().text('⬅️ Cancel', 'a:lock'));
      }
      if (p[2] === 'now') {
        unlocked.delete(uid);
        return show(ctx, '🔒 Locked.', new InlineKeyboard().text('⬅️ Home', 'home'));
      }
      if (p[2] === 'rm') {
        if (p[3] !== 'yes') return show(ctx, 'Remove the admin PIN? The panel will no longer ask for it.', new InlineKeyboard().text('🗑 Yes, remove', 'a:pin:rm:yes').row().text('⬅️ No', 'a:lock'));
        db.settings.pin = '';
        save();
        audit(ctx, 'removed admin PIN');
      }
      return lockView(ctx);
    }

    case 'cast':
      casts.delete(uid);
      return castAudienceView(ctx);
    case 'ca':
      if (!AUD_LABEL[p[2]] || p[2] === 'sel') return;
      casts.set(uid, { aud: p[2], sel: new Set(), text: '' });
      waiting.set(uid, { type: 'cast' });
      return show(ctx, `📢 To: ${AUD_LABEL[p[2]]} (${audience(p[2]).length})\n\nType the message to send.`, new InlineKeyboard().text('⬅️ Cancel', 'a:cast'));
    case 'cs':
      return castSelectView(ctx, uid, Number(p[2]) || 0);
    case 'ct': {
      const st = casts.get(uid);
      if (st && db.customers[p[2]]) st.sel.has(p[2]) ? st.sel.delete(p[2]) : st.sel.add(p[2]);
      return castSelectView(ctx, uid, Number(p[3]) || 0);
    }
    case 'cw':
      if (!casts.get(uid)?.sel.size) return castSelectView(ctx, uid, 0);
      waiting.set(uid, { type: 'cast' });
      return show(ctx, `📢 To: ${casts.get(uid).sel.size} selected customer(s)\n\nType the message to send.`, new InlineKeyboard().text('⬅️ Cancel', 'a:cast'));
    case 'cgo':
      return castSend(ctx, uid);
  }
}

// ---------- things the admin types (return true when handled) ----------
export async function adminText(ctx, st, text) {
  const uid = String(ctx.from.id);
  if (!st || !canAdmin(uid)) return false;

  if (st.type === 'pin') {
    ctx.deleteMessage().catch(() => {});
    const f = pinFails.get(uid) || { n: 0, until: 0 };
    if (Date.now() < f.until) {
      await ctx.reply(`Too many wrong tries. Try again in ${Math.ceil((f.until - Date.now()) / 60000)} minutes.`);
      return true;
    }
    if (checkPin(text, db.settings.pin)) {
      pinFails.delete(uid);
      unlocked.set(uid, Date.now() + UNLOCK_MIN * 60000);
      waiting.delete(uid);
      await adminHome(ctx);
      return true;
    }
    f.n++;
    if (f.n >= 5) {
      f.n = 0;
      f.until = Date.now() + 15 * 60000;
      addLog('event', `admin PIN: 5 wrong tries by ${uid}`, uid);
    }
    pinFails.set(uid, f);
    await ctx.reply('❌ Wrong PIN.');
    return true;
  }

  if (st.type === 'search') {
    Object.assign(view(uid), { q: text.slice(0, 40), f: 'all', page: 0 });
    waiting.delete(uid);
    await listView(ctx, uid);
    return true;
  }

  if (st.type === 'extdays') {
    const cc = db.customers[st.id];
    if (!cc || !can(uid, 'extend')) return true;
    const n = parseInt(text, 10);
    if (!Number.isInteger(n) || n < 1) {
      await ctx.reply('Send a whole number, for example 30.');
      return true;
    }
    if (!isOwner(uid) && n > STAFF_MAX_DAYS) {
      await ctx.reply(`Staff can add at most ${STAFF_MAX_DAYS} days at a time.`);
      return true;
    }
    waiting.delete(uid);
    await doExtend(ctx, cc, n);
    return true;
  }

  if (st.type === 'reason') {
    const cc = db.customers[st.id];
    waiting.delete(uid);
    if (!cc) return true;
    if (st.kind === 'ban' ? !isOwner(uid) : !can(uid, 'suspend')) return true;
    await applyReason(ctx, st.kind, cc, text);
    return true;
  }

  if (st.type === 'usermsg') {
    const cc = db.customers[st.id];
    waiting.delete(uid);
    if (!cc || !can(uid, 'message')) return true;
    try {
      await bot.api.sendMessage(cc.id, `📩 Message from the admin:\n\n${text.slice(0, 3500)}`);
      audit(ctx, 'messaged customer', cc);
      await ctx.reply('✅ Sent.');
    } catch {
      await ctx.reply('⚠️ Could not deliver (the customer may have blocked the bot).');
    }
    await customerView(ctx, cc.id);
    return true;
  }

  // everything below is owner only
  if (!isOwner(uid)) return false;

  if (st.type === 'pinset') {
    ctx.deleteMessage().catch(() => {});
    if (!/^\d{4,8}$/.test(text)) {
      await ctx.reply('The PIN must be 4 to 8 digits. Try again.');
      return true;
    }
    db.settings.pin = hashPin(text);
    unlocked.set(uid, Date.now() + UNLOCK_MIN * 60000);
    waiting.delete(uid);
    save();
    audit(ctx, 'set admin PIN');
    await lockView(ctx);
    return true;
  }

  if (st.type === 'staffadd') {
    const id = text.replace(/\D/g, '');
    if (id.length < 5 || id.length > 15) {
      await ctx.reply('That does not look like a Telegram ID. Send digits only.');
      return true;
    }
    waiting.delete(uid);
    if (!db.settings.staff.includes(id)) db.settings.staff.push(id);
    save();
    audit(ctx, 'added staff', null, id);
    bot.api.sendMessage(id, '👮 You were added as staff. Open the bot and tap Admin panel.').catch(() => {});
    await staffView(ctx);
    return true;
  }

  if (st.type === 'limit') {
    const n = parseInt(text, 10);
    if (!Number.isInteger(n) || n < 0 || n > 100000) {
      await ctx.reply('Send a whole number, for example 25.');
      return true;
    }
    db.settings.maxCustomers = n;
    waiting.delete(uid);
    save();
    audit(ctx, 'customer limit', null, String(n));
    await adminHome(ctx);
    return true;
  }

  if (st.type === 'edit') {
    if (text.length > 3500) {
      await ctx.reply('Too long. Keep it under 3500 characters.');
      return true;
    }
    db.settings.messages[st.key] = text;
    waiting.delete(uid);
    save();
    await ctx.reply('✅ Saved.');
    await msgsView(ctx);
    return true;
  }

  if (st.type === 'cast') {
    const c = casts.get(uid);
    waiting.delete(uid);
    if (!c) return true;
    if (text.length > 3500) {
      await ctx.reply('Too long. Keep it under 3500 characters.');
      waiting.set(uid, st);
      return true;
    }
    c.text = text;
    await castPreview(ctx, uid);
    return true;
  }
  return false;
}
