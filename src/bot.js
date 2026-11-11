// Telegram side: customer menu + admin panel, all driven by buttons.
import { InlineKeyboard, Keyboard } from 'grammy';
import config from '../config.js';
import { db, save, usedSlots, ensureCustomer, addLog } from './store.js';
import { startSession, stopSession, events, joinByLink, lockdownFromPanel, sessionHealth, sendToChat } from './guard.js';
import { groupScore, hourIn } from './checks.js';
import { ticketFor, rememberTicket, splitBar, normTime, localParts, parseReplyRule } from './social.js';
import { linksOf, shortUrl } from './utility.js';
import { listMedia, saveMedia, deleteMedia, validName, MAX_VOICE, MAX_STICKER } from './content.js';
import { newHookToken } from './webhook.js';
import { sendBackup, restoreBackup } from './backup.js';
import { PERSONALITY_KEYS } from './ai.js';
import { refLinkOf, applyReferral, referralStats, refCodeOf, REWARD_DAYS, MAX_REWARDS } from './referrals.js';
import { newDashToken } from './dashboard.js';
import { bot, show, waiting, esc, isOwner, canAdmin, msgs, cancelKb, contactBtn, notifyOwners } from './tg.js';
import { adminRoute, adminText } from './admin.js';
import { setNotifier, reportError } from './alerts.js';
import { DAY, subRequired, subActive, canStartTrial, fmtExpiry, planLabel, maxBadWords } from './plans.js';

export { bot };
setNotifier(notifyOwners);

// ---------- customer: home ----------
async function showHome(ctx) {
  const c = ensureCustomer(ctx.from);
  const kb = new InlineKeyboard();
  let text = msgs().welcome;

  if (c.status === 'banned') {
    text = `🚫 Your access has been blocked.${c.banReason ? `\n\nReason: ${c.banReason}` : ''}\n\nPlease contact the admin.`;
    contactBtn(kb);
  } else if (c.status === 'suspended') {
    text = `⏸ Your service is paused by the admin.${c.suspendReason ? `\n\nReason: ${c.suspendReason}` : ''}\n\nPlease contact the admin.`;
    contactBtn(kb);
  } else if (c.status === 'expired') {
    text = `${msgs().expired}\n\nExpired: ${fmtExpiry(c)}`;
    contactBtn(kb);
  } else {
    if (c.status === 'connected') {
      text += `\n\n✅ Connected: +${c.number}`;
      if (c.plan || c.expiresAt) text += `\n📦 Plan: ${planLabel(c.plan)} · ${fmtExpiry(c)}`;
      kb.text('⚙️ Settings', 'settings').row().text('🔌 Disconnect', 'disc').row();
    } else {
      kb.text('➕ Connect WhatsApp', 'connect').row();
    }
    kb.text('📘 How it works', 'how').row();
    contactBtn(kb);
  }
  if (canAdmin(ctx.from.id)) kb.text('🛠 Admin panel', 'a:home').row();
  await show(ctx, text, kb);
}

// ---------- customer: connect ----------
async function onConnect(ctx) {
  const c = ensureCustomer(ctx.from);
  if (['banned', 'connected', 'suspended', 'expired'].includes(c.status)) return showHome(ctx);

  // subscriptions: needs an active plan, or an unused free trial (starts on first connect)
  if (subRequired() && !isOwner(ctx.from.id) && !subActive(c) && !canStartTrial(c)) {
    return show(ctx, msgs().expired, contactBtn(new InlineKeyboard()).text('⬅️ Back', 'home'));
  }

  const hasSlot = c.number || isOwner(ctx.from.id) || usedSlots() < db.settings.maxCustomers;
  if (!hasSlot) return show(ctx, msgs().limitReached, contactBtn(new InlineKeyboard()).text('⬅️ Back', 'home'));

  waiting.set(String(ctx.from.id), { type: 'number' });
  await show(
    ctx,
    '📱 Send me the WhatsApp number the guard will use.\n\nInclude the country code, digits only. Example: 2348012345678\n\nUse a SEPARATE number, not your personal one.',
    cancelKb()
  );
}

async function onNumber(ctx, text) {
  const c = ensureCustomer(ctx.from);
  const num = text.replace(/\D/g, '');
  if (num.length < 8 || num.length > 15) {
    return ctx.reply('That does not look like a valid number. Send it with the country code, digits only.', {
      reply_markup: cancelKb(),
    });
  }
  if (Object.values(db.customers).some((x) => x.id !== c.id && x.number === num)) {
    return ctx.reply('That number is already in use by another account. Send a different number.', {
      reply_markup: cancelKb(),
    });
  }
  waiting.delete(String(ctx.from.id));
  await stopSession(c.id, { wipe: true });
  c.number = num;
  c.status = 'pairing';
  save();
  await ctx.reply('⏳ Generating your pairing code, one moment...');
  try {
    await startSession(c.id, { pairNumber: num });
  } catch (e) {
    console.error('startSession failed:', e.message);
    c.status = c.everConnected ? 'disconnected' : 'none';
    if (!c.everConnected) c.number = null;
    save();
    await ctx.reply('⚠️ Could not start the connection. Please try again.', {
      reply_markup: new InlineKeyboard().text('➕ Try again', 'connect'),
    });
  }
}

// ---------- customer: settings ----------
const yn = (v) => (v ? 'Yes' : 'No');
const getPath = (o, path) => path.split('.').reduce((x, k) => x?.[k], o);
const setPath = (o, path, v) => {
  const ks = path.split('.');
  const last = ks.pop();
  ks.reduce((x, k) => x[k], o)[last] = v;
};

const hourLabel = (h) => `${String(h).padStart(2, '0')}:00`;
const minLabel = (m) => (m >= 60 ? `${m / 60} h` : `${m} min`);

// Every setting screen is described here: bool = on/off switch, num = pick one of the options
const SCREENS = {
  links: {
    title: '🔗 Links & tags',
    rows: [
      { bool: 'blockAllLinks', label: 'Delete ALL links (off = invite links only)' },
      { num: 'maxMentions', label: '🏷 Max tags per message', opts: [0, 3, 5, 10] },
    ],
  },
  spam: {
    title: '🛡 Spam control',
    rows: [
      { num: 'floodLimit', label: '💬 Flood: max messages per 10 sec', opts: [0, 4, 6, 8] },
      { num: 'maxLength', label: '📏 Max message length', opts: [0, 500, 1000, 2000, 4000] },
      { num: 'maxEmoji', label: '😀 Max emojis per message', opts: [0, 10, 20, 30] },
      { bool: 'blockForwards', label: 'Delete forwarded messages' },
      { bool: 'blockStatusMention', label: 'Delete status-mention tags' },
    ],
  },
  media: {
    title: '🚫 Media filter',
    hint: 'Switched-on types are deleted when a member posts them.',
    rows: [
      { bool: 'blockMedia.image', label: '🖼 Images' },
      { bool: 'blockMedia.video', label: '🎬 Videos' },
      { bool: 'blockMedia.sticker', label: '😊 Stickers' },
      { bool: 'blockMedia.audio', label: '🎙 Voice / audio' },
      { bool: 'blockMedia.document', label: '📄 Documents' },
      { bool: 'blockMedia.contact', label: '👤 Contact cards' },
    ],
  },
  strikes: {
    title: '⚠️ Warnings & admins',
    rows: [
      { num: 'warnLimit', label: 'Warnings before removal', opts: [0, 2, 3, 5], zero: 'Never' },
      { num: 'muteAt', label: '🔇 Mute after this many warnings', opts: [0, 2, 3], zero: 'Off' },
      { num: 'muteMinutes', label: '🔇 Mute length', opts: [15, 60, 1440], fmt: minLabel },
      { bool: 'adminsAllowed', label: 'Group admins are exempt from all rules' },
    ],
  },
  social: {
    title: '💬 Replies & sales',
    hint: 'Private chats are answered only when "Reply to private chats" is on. Groups are not changed by these switches.',
    rows: [
      { bool: 'privateChats', label: '💬 Reply to private chats' },
      { bool: 'greetFirst', label: '🙋 Greet each new private chat once' },
      { bool: 'awayOn', label: '🌙 Away reply' },
      { bool: 'support', label: '🎫 Send private messages to me as tickets' },
      { bool: 'salesOn', label: '🛒 Sales assistant' },
      { bool: 'dailySummary', label: '📈 Daily summary at 9 pm' },
    ],
  },
  anti: {
    title: '🛡 Anti-abuse',
    hint: 'New checks. Each one is off until you switch it on.',
    rows: [
      { bool: 'antiNumbers', label: '📵 Delete messages that share phone numbers' },
      { num: 'slowMode', label: '⏱ Slow mode: seconds between messages', opts: [0, 5, 10, 30], fmt: (v) => (v ? `${v} s` : 'Off') },
      { bool: 'antiRaid', label: '🚨 Anti-raid: close the group on mass joins' },
    ],
  },
  night: {
    title: '🌙 Night mode',
    hint: 'Protected groups close at the start hour and open at the end hour. Lockdown overrides this.',
    rows: [
      { bool: 'nightOn', label: 'Night mode on' },
      { num: 'nightStart', label: 'Close at', opts: [21, 22, 23, 0], fmt: hourLabel },
      { num: 'nightEnd', label: 'Open at', opts: [5, 6, 7, 8], fmt: hourLabel },
    ],
  },
  auto: {
    title: '🤖 Automation',
    hint: 'Off until you switch it on. Always online and mark-as-read change how your number looks to others, so use them knowingly.',
    rows: [
      { bool: 'autoReact', label: '👍 React to messages (once a minute per chat)' },
      { bool: 'alwaysOnline', label: '🟢 Always online' },
      { bool: 'autoRead', label: '👀 Mark incoming messages as read' },
      { bool: 'autoTyping', label: '✍️ Typing indicator before automatic private replies' },
      { bool: 'statusView', label: "👀 Mark members' statuses as seen" },
      { bool: 'statusLike', label: '❤️ React to members\' statuses (one every 20 seconds)' },
    ],
  },
  ai: {
    title: '🤖 AI & safety',
    hint: 'The AI needs an AI key from the owner. The scam scanner deletes messages with suspicious links (short links, look-alike letters, scam wording). Pick a personality below.',
    rows: [
      { bool: 'aiOn', label: '🤖 AI answers (.ai) and transcripts (.transcribe)' },
      { bool: 'scamScan', label: '🛡 Delete suspicious links (scam scanner)' },
      { num: 'aiDailyLimit', label: '📊 AI calls per day', opts: [0, 10, 20, 50], zero: 'No limit' },
    ],
  },
  util: {
    title: '🧰 Tools & lookups',
    hint: 'Weather, dictionary, wiki, translate and the calculator need no setup. Movies, news and YouTube need a key from the owner. This limit counts lookups per member per day.',
    rows: [{ num: 'utilityDailyLimit', label: '🔎 Lookups per member per day', opts: [0, 10, 25, 50], zero: 'No limit' }],
  },
  cmd: {
    title: '⌨️ Commands',
    hint: 'Members and admins can type commands like menu, tagall, kick in the group. Admin commands only work for group admins.',
    rows: [{ bool: 'commands', label: 'Commands enabled' }],
  },
};

const FIELDS = new Map([['badWordsOn', { bool: true }]]);
for (const sc of Object.values(SCREENS))
  for (const r of sc.rows) FIELDS.set(r.bool || r.num, r.bool ? { bool: true } : { opts: r.opts });
const PREFIXES = ['.', '!', '/', '#', '$'];

function screenView(c, name) {
  const sc = SCREENS[name];
  const g = c.guard;
  const kb = new InlineKeyboard();
  for (const r of sc.rows) {
    if (r.bool) kb.text(`${getPath(g, r.bool) ? '✅' : '⬜'} ${r.label}`, `t:${name}:${r.bool}`).row();
    else {
      const cur = getPath(g, r.num);
      const show = (v) => (r.fmt ? r.fmt(v) : v === 0 ? r.zero || 'Off' : v);
      kb.text(`${r.label}: ${show(cur)}`, 'noop').row();
      r.opts.forEach((v) => kb.text((v === cur ? '✅ ' : '') + show(v), `n:${name}:${r.num}:${v}`));
      kb.row();
    }
  }
  if (name === 'cmd') {
    kb.text(`Prefix: ${g.prefix}`, 'noop').row();
    PREFIXES.forEach((p) => kb.text((p === g.prefix ? '✅ ' : '') + p, `pre:${p}`));
    kb.row();
  }
  if (name === 'anti') {
    kb.text(`🌍 Blocked country codes (${(g.blockCountries || []).length})`, 'lst:view:countries').row();
    kb.text(`⛔ Blacklist (${(g.blacklist || []).length})`, 'lst:view:blacklist').row();
  }
  if (name === 'social') {
    kb.text('✏️ Messages & links', 'texts').row();
    kb.text(`🤖 Auto-replies (${(g.replies || []).length})`, 'it:view:replies').row();
    kb.text(`🛒 Sales topics (${(g.salesTopics || []).length})`, 'it:view:topics').row();
    kb.text(`⏰ Scheduled posts (${(g.schedules || []).length})`, 'it:view:sched').row();
  }
  if (name === 'util') kb.text('🔗 My short links', 'shl').row();
  if (name === 'ai') {
    PERSONALITY_KEYS.forEach((k) => kb.text((k === g.aiPersonality ? '✅ ' : '') + k, `aip:${k}`));
    kb.row();
  }
  if (name === 'auto') {
    kb.text('✏️ Bot bio and messages', 'texts').row();
    kb.text('🎤 Voice notes & stickers', 'med:view').row();
    kb.text('🛒 Order webhook', 'hook').row();
    kb.text(`🤖 Auto-replies (${(g.replies || []).length})`, 'it:view:replies').row();
  }
  if (name === 'night') {
    kb.text(`Time zone: ${g.nightTz}`, 'noop').row();
    config.TIME_ZONES.forEach((z, i) => {
      kb.text((z === g.nightTz ? '✅ ' : '') + z, `tz:${i}`);
      if (i % 2 === 1) kb.row();
    });
    kb.row();
  }
  kb.text('⬅️ Back', 'settings');
  let hint = sc.hint || '';
  if (name === 'night') hint += `\n\nNow in ${g.nightTz}: ${hourLabel(hourIn(g.nightTz))}`;
  return { text: `${sc.title}${hint ? `\n\n${hint}` : ''}`, kb };
}

function wordsView(c) {
  const g = c.guard;
  const kb = new InlineKeyboard().text(`${g.badWordsOn ? '✅' : '⬜'} Bad-word filter`, 't:words:badWordsOn').row();
  g.badWords.slice(0, 30).forEach((w, i) => {
    kb.text(`❌ ${w}`, `w:del:${i}`);
    if (i % 2) kb.row();
  });
  kb.row().text('➕ Add words', 'w:add');
  if (g.badWords.length) kb.text('🗑 Clear all', 'w:clear');
  kb.row().text('⬅️ Back', 'settings');
  const n = g.badWords.length;
  return {
    text:
      `🤬 Bad words\n\nMessages containing these words are deleted and the sender gets a warning. It also catches disguised spellings like f.u.c.k, f u c k, fuuuck and leet-style letters.\n\n` +
      (n ? `${n}/${maxBadWords(c)} word${n === 1 ? '' : 's'} saved${n > 30 ? ' (showing the first 30)' : ''}. Tap one to remove it.` : 'No words added yet.'),
    kb,
  };
}

async function showScreen(ctx, name) {
  const c = ensureCustomer(ctx.from);
  if (c.status !== 'connected') return showHome(ctx);
  const v = name === 'words' ? wordsView(c) : SCREENS[name] ? screenView(c, name) : null;
  if (!v) return showSettings(ctx);
  await show(ctx, v.text, v.kb);
}

function settingsText(c) {
  const g = c.guard;
  const off = (n, unit = '') => (n > 0 ? `${n}${unit}` : 'off');
  const media = Object.entries(g.blockMedia).filter(([, v]) => v).map(([k]) => k);
  return (
    `⚙️ Settings for +${c.number}${c.plan || c.expiresAt ? ` · ${planLabel(c.plan)}` : ''}\n\n` +
    `🔗 Links: ${g.blockAllLinks ? 'all deleted' : 'invite links only'} · 🏷 Tags: max ${off(g.maxMentions)}\n` +
    `🛡 Flood: ${off(g.floodLimit, '/10s')} · Length: ${off(g.maxLength)} · Emoji: ${off(g.maxEmoji)}\n` +
    `↪️ Forwards: ${g.blockForwards ? 'deleted' : 'allowed'} · Status tags: ${g.blockStatusMention ? 'deleted' : 'allowed'}\n` +
    `🚫 Media blocked: ${media.length ? media.join(', ') : 'none'}\n` +
    `🤬 Bad words: ${g.badWordsOn ? `on (${g.badWords.length})` : 'off'}\n` +
    `⚠️ Warnings before removal: ${g.warnLimit > 0 ? g.warnLimit : 'never'} · 👮 Admins exempt: ${yn(g.adminsAllowed)}\n` +
    `⌨️ Commands: ${g.commands ? `on (prefix ${g.prefix})` : 'off'} · ✅ Allowed numbers: ${g.allowed.length}\n` +
    `👥 Groups: ${g.groupMode === 'allowed' ? `only ${Object.keys(c.groupList || {}).length} added by link` : 'all (plan limit)'}\n` +
    `🛡 Anti: numbers ${yn(g.antiNumbers)} · slow ${g.slowMode ? `${g.slowMode} s` : 'off'} · raid ${yn(g.antiRaid)} · countries ${(g.blockCountries || []).length} · blacklist ${(g.blacklist || []).length}\n` +
    `🌙 Night: ${g.nightOn ? `${hourLabel(g.nightStart)} to ${hourLabel(g.nightEnd)} (${g.nightTz})` : 'off'}\n` +
    `🚨 Lockdown: ${g.lockdown ? 'ON' : 'off'} · 🛡 Score: ${groupScore(g)}/100\n` +
    `💬 Private chats ${yn(g.privateChats)} · sales ${yn(g.salesOn)} · tickets ${yn(g.support)} · scheduled posts ${(g.schedules || []).length}`
  );
}

function settingsKb() {
  return new InlineKeyboard()
    .text('🔗 Links & tags', 'sc:links')
    .text('🛡 Spam control', 'sc:spam')
    .row()
    .text('🚫 Media filter', 'sc:media')
    .text('🤬 Bad words', 'sc:words')
    .row()
    .text('⚠️ Warnings', 'sc:strikes')
    .text('⌨️ Commands', 'sc:cmd')
    .row()
    .text('✅ Allowed numbers', 'allowed')
    .row()
    .text('👥 Groups', 'groups')
    .text('🛡 Anti-abuse', 'sc:anti')
    .row()
    .text('🌙 Night mode', 'night')
    .text('🚨 Safety', 'safety')
    .row()
    .text('💬 Replies & sales', 'sc:social')
    .text('🧰 Tools & lookups', 'sc:util')
    .text('🤖 Automation', 'sc:auto')
    .text('🤖 AI & safety', 'sc:ai')
    .text('🎁 Invite friends', 'ref')
    .text('📊 My dashboard', 'dash')
    .row()
    .text('⬅️ Back', 'home');
}

async function showSettings(ctx) {
  const c = ensureCustomer(ctx.from);
  if (c.status !== 'connected') return showHome(ctx);
  await show(ctx, settingsText(c), settingsKb());
}

async function showAllowed(ctx) {
  const c = ensureCustomer(ctx.from);
  const kb = new InlineKeyboard();
  c.guard.allowed.forEach((n) => kb.text(`❌ +${n}`, `allow:del:${n}`).row());
  kb.text('➕ Add numbers', 'allow:add').row().text('⬅️ Back', 'settings');
  await show(
    ctx,
    '✅ Allowed numbers are exempt from every rule (links, tags, spam, bad words and so on).\n\n' +
      (c.guard.allowed.length ? 'Tap a number to remove it.' : 'No numbers added yet.'),
    kb
  );
}

// ---------- Stage 3: groups, lists, safety ----------
async function showGroups(ctx) {
  const c = ensureCustomer(ctx.from);
  if (c.status !== 'connected') return showHome(ctx);
  const g = c.guard;
  const allowed = g.groupMode === 'allowed';
  const items = allowed
    ? Object.entries(c.groupList || {}).map(([jid, e]) => ({ jid, name: e.name, paused: Boolean(e.paused) }))
    : Object.keys(c.groups || {})
        .slice(0, 40)
        .map((jid) => ({ jid, name: c.groups[jid]?.name, paused: Boolean(c.groupList?.[jid]?.paused) }));
  const kb = new InlineKeyboard().text(allowed ? '🔀 Mode: only groups I add by link' : '🔀 Mode: all groups (plan limit)', 'grp:mode').row();
  for (const it of items) {
    kb.text(`${it.paused ? '⏸' : '▶️'} ${(it.name || it.jid.split('@')[0]).slice(0, 28)}`, `grp:p:${it.jid}`);
    if (allowed) kb.text('❌', `grp:rm:${it.jid}`);
    kb.row();
  }
  kb.text('➕ Add group by invite link', 'grp:add').row().text('⬅️ Back', 'settings');
  const text =
    '👥 Groups\n\n' +
    (allowed
      ? 'Only the groups you add here are protected. Every other group is ignored, even if I am in it.'
      : 'The first groups I see are protected, up to your plan limit.') +
    '\n\n▶️ protected · ⏸ paused' +
    (allowed ? ' · ❌ stop protecting' : '') +
    (items.length ? '' : '\n\nNo groups yet.') +
    `\n\n🛡 Security score: ${groupScore(g)}/100`;
  await show(ctx, text, kb);
}

// Lists of numbers and country codes, edited with buttons and typed input
const LISTS = {
  countries: {
    title: '🌍 Blocked country codes',
    field: 'blockCountries',
    hint: 'Members who JOIN with a number that starts with one of these codes are removed. Digits only, e.g. 234 or 92.',
    ask: 'country codes, digits only (for example 234 92). Several at once is fine, separated by spaces or commas.',
    max: 50,
  },
  blacklist: {
    title: '⛔ Blacklist',
    field: 'blacklist',
    hint: 'These numbers are removed when they join, and their messages are deleted. You can also type .ban in the group.',
    ask: 'numbers with the country code, digits only. Several at once is fine, separated by spaces or commas.',
    max: 300,
  },
};

async function showList(ctx, key) {
  const c = ensureCustomer(ctx.from);
  const L = LISTS[key];
  const arr = c.guard[L.field] || [];
  const kb = new InlineKeyboard();
  arr.slice(0, 40).forEach((x, i) => {
    kb.text(`❌ ${x}`, `lst:del:${key}:${i}`);
    if (i % 3 === 2) kb.row();
  });
  kb.row().text('➕ Add', `lst:add:${key}`);
  if (arr.length) kb.text('🗑 Clear all', `lst:clear:${key}`);
  kb.row().text('⬅️ Back', 'sc:anti');
  const count = arr.length ? `${arr.length} saved. Tap one to remove it.${arr.length > 40 ? ' (showing the first 40)' : ''}` : 'Nothing added yet.';
  await show(ctx, `${L.title}\n\n${L.hint}\n\n${count}`, kb);
}

async function showSafety(ctx, note = '') {
  const c = ensureCustomer(ctx.from);
  if (c.status !== 'connected') return showHome(ctx);
  const g = c.guard;
  const h = sessionHealth(c.id);
  const kb = new InlineKeyboard()
    .text(g.lockdown ? '🔓 End lockdown' : '🚨 Lockdown now', g.lockdown ? 'lock:off' : 'lock:on')
    .row()
    .text('🧾 Evidence (last 10)', 'ev')
    .text('📊 This week', 'wk')
    .row()
    .text('⬅️ Back', 'settings');
  const text =
    `🚨 Safety${note ? `\n\n${note}` : ''}\n\n` +
    'Lockdown turns on the strictest rules and closes your groups to members. Admins can still post. Ending it restores your old rules and reopens the groups.\n\n' +
    `Status: ${g.lockdown ? '🚨 LOCKDOWN ON' : '✅ normal'}\n` +
    `🛡 Security score: ${groupScore(g)}/100\n` +
    `📶 Account health: ${h.score}/100 ${h.label}`;
  await show(ctx, text, kb);
}

async function showEvidence(ctx) {
  const c = ensureCustomer(ctx.from);
  const rows = db.evidence.filter((e) => e.cid === c.id).slice(-10).reverse();
  const lines = rows.map(
    (e) => `${new Date(e.t).toISOString().slice(5, 16).replace('T', ' ')} UTC · +${e.who} · ${e.reason}${e.text ? `\n   "${e.text}"` : ''}`
  );
  await show(ctx, `🧾 Evidence (last 10)\n\n${lines.length ? lines.join('\n') : 'Nothing removed yet.'}`, new InlineKeyboard().text('⬅️ Back', 'safety'));
}

async function showMedia(ctx) {
  const c = ensureCustomer(ctx.from);
  const list = listMedia(c);
  const kb = new InlineKeyboard().text('🎤 Add voice note', 'med:add:voice').text('🖼 Add sticker', 'med:add:sticker').row();
  for (const m of list) kb.text(`🗑 ${m.kind === 'voice' ? '🎤' : '🖼'} ${m.name} (${m.kb} KB)`, `med:del:${m.name}`).row();
  kb.text('⬅️ Back', 'sc:auto');
  const body = list.length ? list.map((m) => `• ${m.kind}:${m.name} (${m.kb} KB)`).join('\n') : 'None yet.';
  await show(
    ctx,
    `🎤 Voice notes & stickers\n\nUse one as the whole message: voice:name or sticker:name, in a reply, welcome or goodbye text, or a scheduled post. Members can play a voice note with .voice name.\n\nYour items (tap one to delete it):\n${body}`,
    kb
  );
}

async function showShortLinks(ctx) {
  const c = ensureCustomer(ctx.from);
  const rows = linksOf(c.id).slice(-15).reverse();
  const lines = rows.map(([code, e]) => `${shortUrl(code) || `/r/${code}`} · ${e.clicks} click${e.clicks === 1 ? '' : 's'}\n   → ${e.url}`);
  await show(
    ctx,
    `🔗 My short links (last 15)\n\n${lines.length ? lines.join('\n') : 'No short links yet. Admins make them in the group with .short https://...'}`,
    new InlineKeyboard().text('⬅️ Back', 'sc:util')
  );
}

async function showWeekly(ctx) {
  const c = ensureCustomer(ctx.from);
  const w = c.weekly || { msgs: 0, deleted: 0, warned: 0, removed: 0 };
  await show(
    ctx,
    `📊 This week so far\n\nMessages checked: ${w.msgs}\nDeleted: ${w.deleted}\nWarnings: ${w.warned}\nRemoved: ${w.removed}\n\nI also send you this summary every 7 days.`,
    new InlineKeyboard().text('⬅️ Back', 'safety')
  );
}

// ---------- Stage 4: messages, auto-replies, sales topics, scheduled posts ----------
const wordsOf = (w) =>
  String(w || '')
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter((x) => x.length >= 2 && x.length <= 40)
    .slice(0, 10);

const TEXTS = {
  welcome: { label: '👋 Welcome message', hint: 'Posted when someone joins a protected group. {name} = the new member, {group} = the group name.' },
  goodbye: { label: '👋 Goodbye message', hint: 'Posted when someone leaves or is removed. {name} and {group} work here too.' },
  rules: { label: '📜 Group rules (.rules)', hint: 'Shown when a member types .rules.' },
  greeting: { label: '🙋 First-contact greeting', hint: 'Sent once to each person who messages you privately (needs "Greet each new private chat" on).' },
  away: { label: '🌙 Away reply', hint: 'Sent to each person at most once every 6 hours (needs "Away reply" on).' },
  signature: { label: '✍️ Signature (Powered by…)', hint: 'Added at the end of the menu, the first greeting and AI answers. Leave it empty for none.' },
  bio: { label: '📝 Bot bio (About)', hint: 'The About text of the bot number, shown on its profile. Up to 139 characters. It is applied to the number within a minute of saving.' },
  salesLink: { label: '🛒 Shop link', hint: 'Sent for .shop, .buy and buy questions (needs the sales assistant on). Must start with https://', url: true },
};

async function showTexts(ctx) {
  const c = ensureCustomer(ctx.from);
  const kb = new InlineKeyboard();
  for (const [k, T] of Object.entries(TEXTS)) kb.text(T.label, `fld:${k}`).row();
  kb.text('⬅️ Back', 'sc:social');
  const lines = Object.entries(TEXTS).map(([k, T]) => `${T.label}: ${c.guard[k] ? c.guard[k].slice(0, 40).replace(/\n/g, ' ') : 'not set'}`);
  await show(ctx, `✏️ Messages & links\n\n${lines.join('\n')}`, kb);
}

const ITEMS = {
  replies: {
    title: '🤖 Auto-replies',
    field: 'replies',
    max: 30,
    hint: 'In private chats, when a message contains one of the words, I send the reply. Words are separated by commas. Optional: add a picture link (https://…jpg) as a third part, after a second bar, and it is sent with the reply.',
    ask: 'rule as: words | reply text\nExample: price, cost | Our prices are on the shop page.',
    parse: (t) => parseReplyRule(t, wordsOf),
    label: (x) => `${x.words.join(', ')} → ${x.reply}${x.image ? ' 🖼' : ''}`,
  },
  topics: {
    title: '🛒 Sales topics',
    field: 'salesTopics',
    max: 10,
    hint: 'When a private message contains one of the words, I send that link (needs the sales assistant on).',
    ask: 'rule as: words | link\nExample: sms, numbers | https://example.com/sms',
    parse: (t) => {
      const [w, r] = splitBar(t);
      const words = wordsOf(w);
      return words.length && /^https:\/\/\S+$/i.test(r) ? { words, link: r } : null;
    },
    label: (x) => `${x.words.join(', ')} → ${x.link}`,
  },
  sched: {
    title: '⏰ Scheduled posts',
    field: 'schedules',
    max: 50,
    toggle: true,
    hint: 'Posted to every protected group once a day, at this time in your time zone (Night mode sets it). Write the word status after the time to post to your status instead. To tag up to 50 people in that status, add their numbers with @ after the word status (they must be members of your protected groups). To tag a group too, add g1 or g2 or gr3 (its number in your protected-groups list, max 50 groups). {days 2026-12-25} shows the days left. voice:name and sticker:name send a saved voice note or sticker.',
    ask: "post as: HH:MM | text\nExample: 18:00 | Today's offer is live: https://example.com\nStatus with tags (max 50): 18:00 status @255700000001 @255700000002 g1 | Offer today",
    parse: (t) => {
      const [tm, txt] = splitBar(t);
      const [hh, ...flags] = tm.split(/\s+/);
      const hhmm = normTime(hh);
      const tags = [...new Set(flags.filter((f) => /^@\d{7,15}$/.test(f)).map((f) => f.slice(1)))].slice(0, 50);
      const groups = [...new Set(flags.filter((f) => /^g[1-9]\d?$/i.test(f)).map((f) => Number(f.slice(1))))].slice(0, 50);
      return hhmm && txt ? { time: hhmm, text: txt.slice(0, 1000), on: true, lastRun: '', status: flags.includes('status'), tags: flags.includes('status') ? tags : [], groups: flags.includes('status') ? groups : [] } : null;
    },
    label: (x) => `${x.on ? '' : '(paused) '}${x.status ? `(status${x.tags?.length ? ` +${x.tags.length} tagged` : ''}${x.groups?.length ? ` +${x.groups.length} group` : ''}) ` : ''}${x.time} ${x.text}`,
  },
};

async function showItems(ctx, key) {
  const c = ensureCustomer(ctx.from);
  const I = ITEMS[key];
  const arr = c.guard[I.field] || [];
  const kb = new InlineKeyboard();
  arr.slice(0, 50).forEach((x, i) => {
    kb.text(`${i + 1}. ${I.label(x)}`.slice(0, 50), 'noop');
    if (I.toggle) kb.text(x.on ? '⏸' : '▶️', `it:tog:${key}:${i}`);
    kb.text('❌', `it:del:${key}:${i}`).row();
  });
  kb.text('➕ Add', `it:add:${key}`).row().text('⬅️ Back', 'sc:social');
  await show(ctx, `${I.title}\n\n${I.hint}\n\n${arr.length ? `${arr.length} saved.` : 'Nothing added yet.'}`, kb);
}

// ---------- button router ----------
async function route(ctx, data) {
  const uid = String(ctx.from.id);
  const p = data.split(':');
  if (data !== 'noop') waiting.delete(uid);

  if (p[0] === 'a') return adminRoute(ctx, p);

  switch (p[0]) {
    case 'home':
      return showHome(ctx);
    case 'noop':
      return;
    case 'how':
      return show(ctx, msgs().howItWorks, new InlineKeyboard().text('⬅️ Back', 'home'));
    case 'connect':
      return onConnect(ctx);
    case 'settings':
      return showSettings(ctx);
    case 'disc': {
      const c = ensureCustomer(ctx.from);
      if (p[1] === 'yes') {
        await stopSession(c.id, { wipe: true, logout: true });
        c.status = 'none';
        c.number = null;
        save();
        return show(ctx, '🔌 Disconnected. Your WhatsApp number was unlinked.', new InlineKeyboard().text('⬅️ Home', 'home'));
      }
      return show(
        ctx,
        'Disconnect your WhatsApp number? The guard will stop working in your groups.',
        new InlineKeyboard().text('🔌 Yes, disconnect', 'disc:yes').row().text('⬅️ No', 'home')
      );
    }
    case 'sc':
      return showScreen(ctx, p[1]);
    case 't': {
      // t:<screen>:<setting> toggles an on/off setting
      const c = ensureCustomer(ctx.from);
      if (c.status !== 'connected') return showHome(ctx);
      if (FIELDS.get(p[2])?.bool) {
        setPath(c.guard, p[2], !getPath(c.guard, p[2]));
        save();
      }
      return showScreen(ctx, p[1]);
    }
    case 'n': {
      // n:<screen>:<setting>:<value> picks one of the allowed values
      const c = ensureCustomer(ctx.from);
      if (c.status !== 'connected') return showHome(ctx);
      const v = Number(p[3]);
      if (FIELDS.get(p[2])?.opts?.includes(v)) {
        setPath(c.guard, p[2], v);
        save();
      }
      return showScreen(ctx, p[1]);
    }
    case 'pre': {
      const c = ensureCustomer(ctx.from);
      if (c.status === 'connected' && PREFIXES.includes(p[1])) {
        c.guard.prefix = p[1];
        save();
      }
      return showScreen(ctx, 'cmd');
    }
    case 'w': {
      const c = ensureCustomer(ctx.from);
      if (c.status !== 'connected') return showHome(ctx);
      if (p[1] === 'del') {
        c.guard.badWords.splice(Number(p[2]), 1);
        save();
      } else if (p[1] === 'add') {
        waiting.set(uid, { type: 'words' });
        return show(
          ctx,
          'Send the words to block. Several at once is fine: separate them with commas or new lines. A short phrase works too.',
          new InlineKeyboard().text('⬅️ Cancel', 'sc:words')
        );
      } else if (p[1] === 'clear') {
        if (p[2] !== 'yes')
          return show(
            ctx,
            'Remove ALL bad words?',
            new InlineKeyboard().text('🗑 Yes, clear', 'w:clear:yes').row().text('⬅️ No', 'sc:words')
          );
        c.guard.badWords = [];
        save();
      }
      return showScreen(ctx, 'words');
    }
    case 'set': {
      // old buttons still sitting in earlier chats
      return showSettings(ctx);
    }
    case 'groups':
      return showGroups(ctx);
    case 'texts':
      return showTexts(ctx);
    case 'fld': {
      const c = ensureCustomer(ctx.from);
      const T = TEXTS[p[1]];
      if (c.status !== 'connected' || !T) return showTexts(ctx);
      waiting.set(uid, { type: 'field', key: p[1] });
      return show(ctx, `${T.label}\n\n${T.hint}\n\nSend the new text, or "off" to clear it.`, new InlineKeyboard().text('⬅️ Cancel', 'texts'));
    }
    case 'it': {
      const c = ensureCustomer(ctx.from);
      if (c.status !== 'connected') return showHome(ctx);
      const key = p[2];
      const I = ITEMS[key];
      if (!I) return showSettings(ctx);
      const arr = c.guard[I.field];
      if (p[1] === 'del') {
        arr.splice(Number(p[3]), 1);
        save();
      } else if (p[1] === 'tog' && I.toggle && arr[Number(p[3])]) {
        arr[Number(p[3])].on = !arr[Number(p[3])].on;
        save();
      } else if (p[1] === 'add') {
        waiting.set(uid, { type: 'item', key });
        return show(ctx, `Send the ${I.ask}`, new InlineKeyboard().text('⬅️ Cancel', `it:view:${key}`));
      }
      return showItems(ctx, key);
    }
    case 'night':
      return showScreen(ctx, 'night');
    case 'safety':
      return showSafety(ctx);
    case 'med': {
      const c = ensureCustomer(ctx.from);
      if (c.status !== 'connected') return showHome(ctx);
      if (p[1] === 'del') {
        deleteMedia(c, p[2]);
        save();
        return showMedia(ctx);
      }
      if (p[1] === 'add' && (p[2] === 'voice' || p[2] === 'sticker')) {
        waiting.set(String(ctx.from.id), { type: 'medname', kind: p[2] });
        return show(
          ctx,
          `Send a short name for this ${p[2] === 'voice' ? 'voice note' : 'sticker'} (letters, numbers, - or _, up to 20). Example: hello`,
          new InlineKeyboard().text('⬅️ Cancel', 'med:view')
        );
      }
      return showMedia(ctx);
    }
    case 'hook': {
      const c = ensureCustomer(ctx.from);
      if (c.status !== 'connected') return showHome(ctx);
      if (p[1] === 'new' || !c.hookToken) newHookToken(c);
      save();
      const url = config.PUBLIC_URL ? `${config.PUBLIC_URL.replace(/\/$/, '')}/hook/${c.hookToken}` : null;
      return show(
        ctx,
        `🛒 Order webhook\n\n${url ? `Your website sends a POST with JSON {"text": "New order #123"} to:\n${url}` : 'The owner has not set PUBLIC_URL yet, so the link cannot be shown.'}\n\nAnyone with this link can send you messages, so keep it private. Make a new one if it leaks.`,
        new InlineKeyboard().text('🔄 New link', 'hook:new').row().text('⬅️ Back', 'sc:auto')
      );
    }
    case 'bak': {
      if (!isOwner(ctx.from.id)) return;
      const ok = await sendBackup(ctx.api);
      return ctx.reply(ok ? '💾 Backup sent to the owners.' : '⚠️ No backup made. Set DATA_KEY first.');
    }
    case 'rst': {
      if (!isOwner(ctx.from.id)) return;
      const uid = String(ctx.from.id);
      if (p[1] === 'yes') {
        const st = waiting.get(uid);
        if (!st || st.type !== 'restoreconfirm') return showHome(ctx);
        waiting.delete(uid);
        const r = restoreBackup(st.text);
        return ctx.reply(r.error ? `⚠️ ${r.error}` : `✅ Restored ${r.customers} customers. Restart the bot so their WhatsApp sessions start again.`);
      }
      waiting.set(uid, { type: 'restore' });
      return show(
        ctx,
        '♻️ Restore\n\nSend the backup file (.bak) here as a document. It replaces the current data, so only do this when you need to.',
        new InlineKeyboard().text('⬅️ Cancel', 'home')
      );
    }
    case 'aip': {
      const c = ensureCustomer(ctx.from);
      if (c.status !== 'connected') return showHome(ctx);
      if (PERSONALITY_KEYS.includes(p[1])) {
        c.guard.aiPersonality = p[1];
        save();
      }
      return showScreen(ctx, 'ai');
    }
    case 'ref': {
      const c = ensureCustomer(ctx.from);
      refCodeOf(c);
      save();
      let name = '';
      try {
        name = bot.botInfo.username || '';
      } catch {}
      const st = referralStats(c);
      return show(
        ctx,
        `🎁 Invite friends\n\nShare this link. When someone new starts the bot with it, you get ${REWARD_DAYS} free days (up to ${MAX_REWARDS} times).\n\n${name ? refLinkOf(name, c) : 'The bot name is not ready yet. Try again in a moment.'}\n\nInvited: ${st.invited} · Rewards: ${st.rewards}`,
        new InlineKeyboard().text('⬅️ Back', 'settings')
      );
    }
    case 'dash': {
      const c = ensureCustomer(ctx.from);
      if (c.status !== 'connected') return showHome(ctx);
      if (p[1] === 'new' || !c.dashToken) newDashToken(c);
      save();
      const url = config.PUBLIC_URL ? `${config.PUBLIC_URL.replace(/\/$/, '')}/dash/${c.dashToken}` : null;
      return show(
        ctx,
        `📊 My dashboard\n\n${url ? `Open it in a browser: ${url}` : 'The owner has not set PUBLIC_URL yet, so the link cannot be shown.'}\n\nThe page is read-only. Anyone with the link can see your numbers, so keep it private.`,
        new InlineKeyboard().text('🔄 New link', 'dash:new').row().text('⬅️ Back', 'settings')
      );
    }
    case 'shl':
      return showShortLinks(ctx);
    case 'ev':
      return showEvidence(ctx);
    case 'wk':
      return showWeekly(ctx);
    case 'lock': {
      const c = ensureCustomer(ctx.from);
      if (c.status !== 'connected') return showHome(ctx);
      const on = p[1] === 'on';
      if (p[2] !== 'yes') {
        return show(
          ctx,
          on
            ? 'Turn on LOCKDOWN now?\n\nStrict rules go on and your groups close to members.'
            : 'End lockdown?\n\nYour old rules come back and the groups reopen.',
          new InlineKeyboard().text(on ? '🚨 Yes, lock down' : '🔓 Yes, end it', `lock:${on ? 'on' : 'off'}:yes`).row().text('⬅️ No', 'safety')
        );
      }
      const r = await lockdownFromPanel(c.id, on);
      return showSafety(ctx, `Done. ${r.closed} group${r.closed === 1 ? '' : 's'} changed.`);
    }
    case 'tz': {
      const c = ensureCustomer(ctx.from);
      const z = config.TIME_ZONES[Number(p[1])];
      if (c.status === 'connected' && z) {
        c.guard.nightTz = z;
        save();
      }
      return showScreen(ctx, 'night');
    }
    case 'grp': {
      const c = ensureCustomer(ctx.from);
      if (c.status !== 'connected') return showHome(ctx);
      const jid = p[2];
      if (p[1] === 'mode') {
        c.guard.groupMode = c.guard.groupMode === 'allowed' ? 'all' : 'allowed';
        save();
        return showGroups(ctx);
      }
      if (p[1] === 'add') {
        waiting.set(uid, { type: 'grouplink' });
        return show(
          ctx,
          'Send the group invite link, for example https://chat.whatsapp.com/XXXXXXXX\n\nI join as a normal member. Then make the guard number a group ADMIN.',
          new InlineKeyboard().text('⬅️ Cancel', 'groups')
        );
      }
      if (p[1] === 'p' && jid) {
        const e = (c.groupList[jid] ||= { name: c.groups?.[jid]?.name || '', paused: false, added: Date.now() });
        e.paused = !e.paused;
        save();
      }
      if (p[1] === 'rm' && jid) {
        delete c.groupList[jid];
        save();
      }
      return showGroups(ctx);
    }
    case 'lst': {
      const c = ensureCustomer(ctx.from);
      if (c.status !== 'connected') return showHome(ctx);
      const key = p[2];
      if (!LISTS[key]) return showSettings(ctx);
      if (p[1] === 'del') {
        c.guard[LISTS[key].field].splice(Number(p[3]), 1);
        save();
      } else if (p[1] === 'add') {
        waiting.set(uid, { type: 'list', key });
        return show(ctx, `Send the ${LISTS[key].ask}`, new InlineKeyboard().text('⬅️ Cancel', `lst:view:${key}`));
      } else if (p[1] === 'clear') {
        if (p[3] !== 'yes')
          return show(
            ctx,
            `Remove everything from the ${LISTS[key].title.replace(/^\S+\s/, '').toLowerCase()}?`,
            new InlineKeyboard().text('🗑 Yes, clear', `lst:clear:${key}:yes`).row().text('⬅️ No', `lst:view:${key}`)
          );
        c.guard[LISTS[key].field] = [];
        save();
      }
      return showList(ctx, key);
    }
    case 'allowed':
      return showAllowed(ctx);
    case 'allow': {
      const c = ensureCustomer(ctx.from);
      if (p[1] === 'del') {
        c.guard.allowed = c.guard.allowed.filter((n) => n !== p[2]);
        save();
        return showAllowed(ctx);
      }
      if (p[1] === 'add') {
        waiting.set(uid, { type: 'allow' });
        return show(
          ctx,
          'Send the numbers to allow, with country code, digits only. You can send several separated by spaces or commas.',
          new InlineKeyboard().text('⬅️ Cancel', 'allowed')
        );
      }
    }
  }
}

// ---------- events from the WhatsApp side ----------
export function wireEvents() {
  // Stage 7: website uptime and order notifications
  events.on('site', (cid, e) => {
    bot.api
      .sendMessage(cid, e.up ? `✅ ${e.url} is back up.` : `🔴 ${e.url} is down (${e.reason}). I will tell you when it is back.`)
      .catch(() => {});
  });
  events.on('order', (cid, text) => {
    bot.api.sendMessage(cid, `🛒 New order\n\n${text}`).catch(() => {});
  });
  events.on('pairing-code', (cid, code) => {
    const c = db.customers[cid];
    bot.api
      .sendMessage(
        cid,
        `🔑 <b>Your pairing code</b>\n\n<code>${esc(code)}</code>\n\nOn the phone with +${esc(c?.number || '')}:\nWhatsApp > Linked devices > Link a device > <b>Link with phone number instead</b>, then enter the code.\n\nThe code expires in about 3 minutes.`,
        { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('⬅️ Home', 'home') }
      )
      .catch(() => {});
  });

  events.on('pairing-failed', (cid, why) => {
    const c = db.customers[cid];
    if (c) {
      c.status = c.everConnected ? 'disconnected' : 'none';
      if (!c.everConnected) c.number = null;
      save();
    }
    console.error(`[${cid}] pairing failed:`, why);
    bot.api
      .sendMessage(cid, '⚠️ The pairing code expired or failed. Tap the button to try again.', {
        reply_markup: new InlineKeyboard().text('➕ Connect WhatsApp', 'connect'),
      })
      .catch(() => {});
  });

  events.on('open', (cid) => {
    const c = db.customers[cid];
    if (!c || c.status === 'connected') return;
    const first = !c.everConnected;
    let extra = '';
    if (canStartTrial(c)) {
      const days = db.settings.trialDays;
      c.plan = 'trial';
      c.trialUsed = true;
      c.expiresAt = Date.now() + days * DAY;
      c.reminded = {};
      extra = `\n\n🎁 Your free ${days}-day trial has started.`;
    }
    c.status = 'connected';
    c.everConnected = true;
    save();
    addLog('event', `connected: ${c.name || c.id} (+${c.number})`, c.id);
    if (first && db.settings.errorAlerts) notifyOwners(`🆕 New customer connected: ${c.name || c.username || c.id} (+${c.number})`);
    bot.api
      .sendMessage(
        cid,
        `✅ Connected! +${c.number} is linked.\n\nNow add that number to your WhatsApp group and make it a group ADMIN. Then adjust what gets blocked in Settings.${extra}`,
        { reply_markup: new InlineKeyboard().text('⚙️ Settings', 'settings').row().text('⬅️ Home', 'home') }
      )
      .catch(() => {});
  });

  events.on('not-admin', (cid, groupName) => {
    const c = db.customers[cid];
    bot.api
      .sendMessage(
        cid,
        `⚠️ I'm not an admin in "${groupName}" yet, so I can't delete messages or run admin commands there.\n\nOpen the group and make +${c?.number || 'the guard number'} a group admin.`
      )
      .catch(() => {});
  });

  events.on('logged-out', (cid) => {
    const c = db.customers[cid];
    if (!c || c.status === 'none') return;
    c.status = 'disconnected';
    save();
    addLog('event', `logged out from WhatsApp: ${c.name || c.id} (+${c.number})`, cid);
    if (db.settings.errorAlerts) notifyOwners(`🔌 ${c.name || c.username || c.id} (+${c.number}) was unlinked from WhatsApp.`);
    bot.api
      .sendMessage(cid, '⚠️ Your WhatsApp number was unlinked. Tap the button to connect it again.', {
        reply_markup: new InlineKeyboard().text('➕ Connect WhatsApp', 'connect'),
      })
      .catch(() => {});
  });

  // the connection has been down for 2 minutes
  events.on('disconnected', (cid) => {
    const c = db.customers[cid];
    if (!c) return;
    addLog('event', `connection down: ${c.name || c.id} (+${c.number})`, cid);
    if (db.settings.errorAlerts) notifyOwners(`⚠️ Connection down for ${c.name || c.username || c.id} (+${c.number}). Still trying to reconnect.`);
    bot.api.sendMessage(cid, '⚠️ Your WhatsApp connection dropped. I keep trying to reconnect. If it does not come back soon, check that the phone is online.').catch(() => {});
  });

  events.on('reconnected', (cid) => {
    const c = db.customers[cid];
    if (!c) return;
    addLog('event', `connection back: ${c.name || c.id}`, cid);
    if (db.settings.errorAlerts) notifyOwners(`✅ ${c.name || c.username || c.id} (+${c.number}) is back online.`);
    bot.api.sendMessage(cid, '✅ Your WhatsApp connection is back.').catch(() => {});
  });

  // a group is over the customer's plan limit
  events.on('group-limit', (cid, groupName, limit) => {
    bot.api
      .sendMessage(cid, `ℹ️ "${groupName}" is not protected: your plan allows ${limit} group${limit === 1 ? '' : 's'}. Contact the admin to upgrade.`)
      .catch(() => {});
  });

  events.on('expired', (cid) => {
    const c = db.customers[cid];
    if (!c) return;
    if (db.settings.errorAlerts) notifyOwners(`⏰ Subscription ended: ${c.name || c.username || c.id} (+${c.number}). Disconnected.`);
    bot.api
      .sendMessage(cid, `${msgs().expired}\n\nYour guard is paused. Renew and it reconnects automatically.`, { reply_markup: contactBtn(new InlineKeyboard()) })
      .catch(() => {});
  });

  events.on('reminder', (cid, days) => {
    bot.api.sendMessage(cid, `⏳ Your subscription ends in ${days} day${days === 1 ? '' : 's'}. Contact the admin to renew.`, { reply_markup: contactBtn(new InlineKeyboard()) }).catch(() => {});
  });

  events.on('raid', (cid, groupName, n) => {
    addLog('event', `anti-raid: ${groupName} (${n} joins)`, cid);
    bot.api
      .sendMessage(cid, `🚨 Anti-raid: ${n} people joined "${groupName}" within a minute. I closed the group. Admins can reopen it with .open when it is safe.`)
      .catch(() => {});
  });

  events.on('threat', (cid, groupName, n) => {
    addLog('event', `threat: ${n} deletes in 10 min in ${groupName}`, cid);
    bot.api
      .sendMessage(cid, `⚠️ Lots of unwanted messages in "${groupName}": ${n} removed in 10 minutes. Details: Settings > Safety > Evidence.`)
      .catch(() => {});
  });

  events.on('post-failed', (cid, groupName) => {
    addLog('event', `could not post in ${groupName} after 5 tries`, cid);
    bot.api
      .sendMessage(cid, `⚠️ I could not post in "${groupName}" after several tries. Check that the guard number is still a group ADMIN and that the group is not locked.`)
      .catch(() => {});
  });

  events.on('report', (cid, groupName, who, quoted) => {
    bot.api
      .sendMessage(cid, `🚩 Report in "${groupName}" from +${who}:\n${quoted ? `"${quoted}"` : '(no text)'}\n\nPlease check the group.`)
      .catch(() => {});
  });

  events.on('ticket', (cid, jid, n, text, who) => {
    bot.api
      .sendMessage(cid, `🎫 Ticket #${n} from +${who}:\n${text}\n\nReply to this message to answer on WhatsApp.`)
      .then((m) => rememberTicket(cid, m.message_id, jid))
      .catch(() => {});
  });

  events.on('summary', (cid, d) => {
    bot.api
      .sendMessage(cid, `📈 Today\n\nMessages checked: ${d.msgs}\nDeleted: ${d.deleted}\nWarnings: ${d.warned}\nRemoved: ${d.removed}`)
      .catch(() => {});
  });

  events.on('weekly', (cid, w) => {
    bot.api
      .sendMessage(cid, `📊 Your weekly report\n\nMessages checked: ${w.msgs}\nDeleted: ${w.deleted}\nWarnings: ${w.warned}\nRemoved: ${w.removed}`)
      .catch(() => {});
  });

  events.on('resumed', (cid) => {
    addLog('event', `service resumed: ${db.customers[cid]?.name || cid}`, cid);
  });
}

// ---------- telegram handlers ----------
bot.use(async (ctx, next) => {
  if (ctx.chat?.type && ctx.chat.type !== 'private') return; // only work in private chat
  // maintenance mode: customers only see the maintenance message (admins and staff still get in)
  if (db.settings.maintenance && ctx.from && !canAdmin(ctx.from.id)) {
    if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => {});
    return show(ctx, msgs().maintenance, contactBtn(new InlineKeyboard()));
  }
  await next();
});

bot.on('callback_query:data', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  await route(ctx, ctx.callbackQuery.data);
});

const MENU_LABEL = '📋 Menu';

// /start: first a small message that pins the "Menu" button at the bottom, then the welcome with all buttons
bot.command('start', async (ctx) => {
  const uid = String(ctx.from.id);
  const isNew = !db.customers[uid];
  waiting.delete(uid);
  // Stage 9: a new customer who came through a referral link gives the referrer free days
  const cust = ensureCustomer(ctx.from);
  if (isNew) {
    const r = applyReferral(cust, ctx.match);
    if (r) bot.api.sendMessage(r.referrerId, `🎁 A friend joined with your link. You got ${r.days} free days.`).catch(() => {});
  }
  save();
  await ctx.reply('👇 Tap "Menu" below anytime to see all the buttons.', {
    reply_markup: new Keyboard().text(MENU_LABEL).resized().persistent(),
  });
  await showHome(ctx);
});

// /menu (also listed in Telegram's Menu button): show all the buttons again
bot.command('menu', async (ctx) => {
  waiting.delete(String(ctx.from.id));
  await showHome(ctx);
});

// ---------- Stage 6: voice notes and stickers from Telegram ----------
async function downloadTelegramFile(ctx, fileId, max) {
  const f = await ctx.api.getFile(fileId);
  if (f.file_size && f.file_size > max) throw new Error('too big');
  const r = await fetch(`https://api.telegram.org/file/bot${config.BOT_TOKEN}/${f.file_path}`);
  if (!r.ok) throw new Error('download failed');
  return Buffer.from(await r.arrayBuffer());
}
async function saveUploaded(ctx, c, uid, st, fileId, max, mime) {
  let buf;
  try {
    buf = await downloadTelegramFile(ctx, fileId, max);
  } catch {
    return ctx.reply('Could not download that file. It may be too big.', { reply_markup: new InlineKeyboard().text('⬅️ Back', 'med:view') });
  }
  const r = saveMedia(c, st.name, st.kind, buf, mime);
  if (r.error) return ctx.reply(`⚠️ ${r.error}`, { reply_markup: new InlineKeyboard().text('⬅️ Back', 'med:view') });
  waiting.delete(uid);
  save();
  return ctx.reply(`✅ Saved as ${st.kind}:${r.name}. Use that as the whole message in a reply, welcome text or scheduled post.`, {
    reply_markup: new InlineKeyboard().text('⬅️ Back', 'med:view'),
  });
}
bot.on('message:voice', async (ctx) => {
  const uid = String(ctx.from.id);
  const st = waiting.get(uid);
  if (!st || st.type !== 'medfile' || st.kind !== 'voice') return;
  const c = ensureCustomer(ctx.from);
  if (c.status !== 'connected') return showHome(ctx);
  await saveUploaded(ctx, c, uid, st, ctx.message.voice.file_id, MAX_VOICE, 'audio/ogg; codecs=opus');
});
bot.on('message:sticker', async (ctx) => {
  const uid = String(ctx.from.id);
  const st = waiting.get(uid);
  if (!st || st.type !== 'medfile' || st.kind !== 'sticker') return;
  const c = ensureCustomer(ctx.from);
  if (c.status !== 'connected') return showHome(ctx);
  const sk = ctx.message.sticker;
  if (sk.is_animated || sk.is_video) return ctx.reply('Animated and video stickers are not supported. Send a normal sticker.');
  await saveUploaded(ctx, c, uid, st, sk.file_id, MAX_STICKER, 'image/webp');
});

bot.on('message:document', async (ctx) => {
  const uid = String(ctx.from.id);
  const st = waiting.get(uid);
  if (!st || st.type !== 'restore' || !isOwner(ctx.from.id)) return;
  let buf;
  try {
    buf = await downloadTelegramFile(ctx, ctx.message.document.file_id, 20 * 1024 * 1024);
  } catch {
    return ctx.reply('Could not download that file.');
  }
  waiting.set(uid, { type: 'restoreconfirm', text: buf.toString('utf8') });
  return ctx.reply('Restore this backup now? The current data will be replaced.', {
    reply_markup: new InlineKeyboard().text('♻️ Yes, restore', 'rst:yes').row().text('⬅️ No', 'home'),
  });
});

bot.on('message:text', async (ctx) => {
  const uid = String(ctx.from.id);
  const st = waiting.get(uid);
  const text = ctx.message.text.trim();

  // replying to a support ticket sends your answer to that WhatsApp chat
  const replied = ctx.message.reply_to_message;
  if (replied && !text.startsWith('/')) {
    const t = ticketFor(ctx.chat.id, replied.message_id);
    if (t) {
      const ok = await sendToChat(t.cid, t.jid, text);
      return ctx.reply(ok ? '✅ Sent to the WhatsApp chat.' : '⚠️ Could not send. Check that the guard number is connected.');
    }
  }

  if (text === MENU_LABEL) {
    waiting.delete(uid);
    return showHome(ctx);
  }

  if (!st || text.startsWith('/')) {
    waiting.delete(uid);
    return showHome(ctx); // any message shows the menu with buttons
  }

  if (st.type === 'medname') {
    if (!validName(text)) return ctx.reply('Use letters, numbers, - or _ (up to 20 characters). Try again.', { reply_markup: new InlineKeyboard().text('⬅️ Cancel', 'med:view') });
    waiting.set(uid, { type: 'medfile', kind: st.kind, name: text.toLowerCase() });
    return ctx.reply(`Now send the ${st.kind === 'voice' ? 'voice note' : 'sticker'}.`, { reply_markup: new InlineKeyboard().text('⬅️ Cancel', 'med:view') });
  }
  if (st.type === 'medfile') return ctx.reply(`Send the ${st.kind === 'voice' ? 'voice note' : 'sticker'} itself, not text.`, { reply_markup: new InlineKeyboard().text('⬅️ Cancel', 'med:view') });
  if (st.type === 'number') return onNumber(ctx, text);

  if (st.type === 'words') {
    const c = ensureCustomer(ctx.from);
    const add = text.split(/[,\n;]+/).map((w) => w.trim().toLowerCase()).filter((w) => w.length >= 2 && w.length <= 40);
    if (!add.length) return ctx.reply('No valid words found. Try again.', { reply_markup: new InlineKeyboard().text('⬅️ Cancel', 'sc:words') });
    c.guard.badWords = [...new Set([...c.guard.badWords, ...add])].slice(0, maxBadWords(c));
    waiting.delete(uid);
    save();
    return showScreen(ctx, 'words');
  }

  if (st.type === 'allow') {
    const c = ensureCustomer(ctx.from);
    const nums = text.split(/[\s,;]+/).map((n) => n.replace(/\D/g, '')).filter((n) => n.length >= 8 && n.length <= 15);
    if (!nums.length) return ctx.reply('No valid numbers found. Try again.', { reply_markup: new InlineKeyboard().text('⬅️ Cancel', 'allowed') });
    c.guard.allowed = [...new Set([...c.guard.allowed, ...nums])];
    waiting.delete(uid);
    save();
    return showAllowed(ctx);
  }

  if (st.type === 'field') {
    const c = ensureCustomer(ctx.from);
    const T = TEXTS[st.key];
    const v = text.toLowerCase() === 'off' ? '' : text;
    if (v && T.url && !/^https:\/\/\S+$/i.test(v)) return ctx.reply('That does not look like a link starting with https://. Try again.', { reply_markup: new InlineKeyboard().text('⬅️ Cancel', 'texts') });
    if (v.length > (T.url ? 200 : 500)) return ctx.reply('That is too long. Keep it under 500 characters.', { reply_markup: new InlineKeyboard().text('⬅️ Cancel', 'texts') });
    c.guard[st.key] = v;
    waiting.delete(uid);
    save();
    return showTexts(ctx);
  }

  if (st.type === 'item') {
    const c = ensureCustomer(ctx.from);
    const I = ITEMS[st.key];
    const item = I.parse(text);
    if (!item) return ctx.reply(`That did not work. Use this format:\n${I.ask}`, { reply_markup: new InlineKeyboard().text('⬅️ Cancel', `it:view:${st.key}`) });
    const arr = c.guard[I.field] || (c.guard[I.field] = []);
    if (arr.length >= I.max) return ctx.reply(`You can save up to ${I.max}. Delete one first.`, { reply_markup: new InlineKeyboard().text('⬅️ Cancel', `it:view:${st.key}`) });
    if (st.key === 'sched') {
      // a time that has already passed today waits for tomorrow
      const p = localParts(c.guard.nightTz);
      const [hh, mm] = item.time.split(':').map(Number);
      if (p.mins >= hh * 60 + mm) item.lastRun = p.date;
    }
    arr.push(item);
    waiting.delete(uid);
    save();
    return showItems(ctx, st.key);
  }

  if (st.type === 'list') {
    const c = ensureCustomer(ctx.from);
    const L = LISTS[st.key];
    const parts = text.split(/[\s,;]+/).map((x) => x.replace(/\D/g, ''));
    const add = parts.filter((x) => (st.key === 'countries' ? x.length >= 1 && x.length <= 4 : x.length >= 8 && x.length <= 15));
    if (!add.length) return ctx.reply('No valid entries found. Try again.', { reply_markup: new InlineKeyboard().text('⬅️ Cancel', `lst:view:${st.key}`) });
    c.guard[L.field] = [...new Set([...(c.guard[L.field] || []), ...add])].slice(0, L.max);
    waiting.delete(uid);
    save();
    return showList(ctx, st.key);
  }

  if (st.type === 'grouplink') {
    const m = text.match(/chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/);
    if (!m) return ctx.reply('That is not a WhatsApp group invite link. It looks like https://chat.whatsapp.com/XXXXXXXX. Try again.', { reply_markup: new InlineKeyboard().text('⬅️ Cancel', 'groups') });
    waiting.delete(uid);
    const c = ensureCustomer(ctx.from);
    const r = await joinByLink(c.id, m[1]);
    if (r.error) return ctx.reply(`⚠️ ${r.error}`, { reply_markup: new InlineKeyboard().text('👥 Groups', 'groups') });
    await ctx.reply(`✅ Joined "${r.name || 'the group'}". Now make +${c.number} a group ADMIN so I can protect it.`);
    return showGroups(ctx);
  }

  if (await adminText(ctx, st, text)) return;
});

// Telegram's own "Menu" button next to the text box
export async function setupMenu() {
  try {
    await bot.api.setMyCommands([
      { command: 'start', description: 'Start the bot' },
      { command: 'menu', description: 'Show all buttons' },
    ]);
    await bot.api.setChatMenuButton({ menu_button: { type: 'commands' } });
  } catch (e) {
    console.error('Could not set menu:', e.message);
  }
}

bot.catch((err) => reportError('telegram', err.error || err));

// exposed for tests only
export const _ui = { screenView, wordsView, settingsText, settingsKb, SCREENS, ITEMS };
export const _test = { route, showHome };
