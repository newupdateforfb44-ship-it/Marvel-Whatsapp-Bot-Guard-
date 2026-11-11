// WhatsApp commands (group admins and the bot's own number). Prefix is set per customer.
import { db, save } from './store.js';
import { events, digits, getContext, getText, unwrap, getMeta, isAdminOf, findParticipant, say, react, notifyNotAdmin, strike } from './wa.js';
import { runLockdown } from './lockdown.js';
import { parsePoll, levelOf } from './social.js';
import { contentFor, mediaOf } from './content.js';
import { parseDelay } from './automation.js';
import { addSite, removeSite, sitesOf, uptimePct } from './uptime.js';
import { speedLabel } from './publicstats.js';
import { askAi, summarize, transcribe, aiAllowed, aiReady, withSignature } from './ai.js';
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { calc, convert, timeIn, joke, quote, qrUrl, useLookup, weather, define, wiki, translate, movie, news, youtube, lyricsLink, createShort, shortUrl, checkSite, siteLine, addNote, notesOf, addTodo, todosOf, toggleTodo, delTodo } from './utility.js';

const reply = (c, text, mentions) => say(c.s, c.jid, mentions ? { text, mentions } : { text }, { quoted: c.msg });

const tsMs = (msg) => {
  const t = msg.messageTimestamp;
  const n = typeof t === 'object' && t ? t.toNumber?.() ?? Number(t) : Number(t);
  return n * 1000;
};

const uptimeText = (ms) => {
  const m = Math.floor(ms / 60000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m % 60}m` : `${m}m`;
};

// the member being targeted: a tag, a replied-to message, or a typed number
function pickTarget(c) {
  const ctx = getContext(c.content);
  const ref = ctx?.mentionedJid?.[0] || ctx?.participant || c.args.find((a) => a.replace(/\D/g, '').length >= 8);
  const p = ref ? findParticipant(c.meta, ref) : null;
  return p;
}
const isBot = (c, p) => [c.sock.user?.id, c.sock.user?.lid].filter(Boolean).map(digits).some((d) => d === digits(p.id) || (p.phoneNumber && d === digits(p.phoneNumber)));
// all the ids a member can be known by (blacklist and mute use the digits of these)
const idsOf = (p) => [p.id, p.phoneNumber, p.lid].filter(Boolean).map(digits).filter(Boolean);
// "30" in the arguments = minutes (up to a week). Long numbers are phone numbers, so they are ignored.
const minutesIn = (args) => {
  const a = args.find((x) => /^\d{1,5}$/.test(x) && Number(x) > 0 && Number(x) <= 10080);
  return a ? Number(a) : null;
};
// the message the command was typed as a reply to
const quotedKey = (c) => {
  const ctx = getContext(c.content);
  if (!ctx?.stanzaId) return null;
  return { remoteJid: c.jid, id: ctx.stanzaId, fromMe: false, participant: ctx.participant };
};
const lockInfo = async (c, name) => {
  const v = (c.args[0] || '').toLowerCase();
  if (v !== 'on' && v !== 'off') return reply(c, `🔐 Usage: ${c.prefix}${name} on  or  ${c.prefix}${name} off`);
  await c.sock.groupSettingUpdate(c.jid, v === 'on' ? 'locked' : 'unlocked');
  return reply(c, `🔐 ${v === 'on' ? 'Only admins' : 'Everyone'} can change the group name and description now. (WhatsApp uses one switch for both.)`);
};
// Lookups that call outside services: respect the customer's daily limit per member
const lookup = (fn, usage) => ({
  run: async (c) => {
    const who = digits(c.msg.key.participant || c.jid);
    if (!useLookup(c.cid, who, c.g.utilityDailyLimit)) return reply(c, '🔎 Daily lookup limit reached. Try again tomorrow.');
    const out = await fn(c);
    if (out === null || out === undefined || out === '') return reply(c, usage ? `🔎 ${usage}` : '🔎 Nothing found. Try different words.');
    return reply(c, out);
  },
});

const needTarget = (c, name) => reply(c, `👤 Tag the member or reply to their message.\nExample: ${c.prefix}${name} @user`);
const reasonOf = (c) => c.args.filter((a) => !/^@?\d{6,}$/.test(a)).join(' ').trim();

const COMMANDS = {
  menu: {
    run: (c) =>
      reply(
        c,
        `🤖 Group Guard (WhatsApp bot)\nPrefix: ${c.prefix}\n\n` +
          `👥 Everyone\n${c.prefix}menu · ${c.prefix}ping · ${c.prefix}alive · ${c.prefix}groupinfo · ${c.prefix}admins\n${c.prefix}rules · ${c.prefix}level · ${c.prefix}leaderboard · ${c.prefix}shop\n${c.prefix}report (reply to a message)\n` +
          `🧰 ${c.prefix}calc · ${c.prefix}time · ${c.prefix}convert · ${c.prefix}joke · ${c.prefix}quote · ${c.prefix}qr\n` +
          `🔎 ${c.prefix}weather · ${c.prefix}define · ${c.prefix}wiki · ${c.prefix}translate · ${c.prefix}movie · ${c.prefix}news · ${c.prefix}yts · ${c.prefix}lyrics · ${c.prefix}site\n` +
          `📝 ${c.prefix}note · ${c.prefix}todo add|done|del\n` +
          `🤖 ${c.prefix}ai question · ${c.prefix}transcribe (reply to a voice note, admins)\n` +
          `🎤 ${c.prefix}voice name · ⏰ ${c.prefix}remind 30m text (admins)\n\n` +
          `👮 Admins\n${c.prefix}tagall · ${c.prefix}hidetag · ${c.prefix}tagadmins · ${c.prefix}announce\n` +
          `${c.prefix}kick · ${c.prefix}promote · ${c.prefix}demote\n` +
          `${c.prefix}mute [min] · ${c.prefix}unmute · ${c.prefix}ban · ${c.prefix}unban\n` +
          `${c.prefix}open · ${c.prefix}close · ${c.prefix}link · ${c.prefix}revoke\n` +
          `${c.prefix}pin · ${c.prefix}unpin · ${c.prefix}purge [n]\n` +
          `${c.prefix}setname · ${c.prefix}setdesc · ${c.prefix}lockname on/off · ${c.prefix}lockdesc on/off\n` +
          `${c.prefix}inactive [days] · ${c.prefix}topmembers · ${c.prefix}birthday DD-MM\n` +
          `${c.prefix}lockdown · ${c.prefix}unlockdown · ${c.prefix}poll · ${c.prefix}giveaway\n` +
          `${c.prefix}warn · ${c.prefix}warnings · ${c.prefix}resetwarn`
      ),
  },
  ping: {
    run: (c) => {
      const ms = Math.max(0, Date.now() - tsMs(c.msg)) || 0;
      return reply(c, `🏓 Pong! ${ms} ms · ${speedLabel(ms)}`);
    },
  },
  alive: { run: (c) => reply(c, `✅ I'm online. 🤖 WhatsApp group bot\n⏱ Uptime: ${uptimeText(Date.now() - c.s.startedAt)}`) },
  groupinfo: {
    run: (c) => {
      const ps = c.meta.participants;
      const admins = ps.filter((p) => p.admin).length;
      const made = c.meta.creation ? new Date(c.meta.creation * 1000).toISOString().slice(0, 10) : '-';
      const desc = c.meta.desc ? `\n📝 ${String(c.meta.desc).slice(0, 200)}` : '';
      return reply(c, `👥 ${c.meta.subject}\nMembers: ${ps.length} · Admins: ${admins}\nCreated: ${made}${desc}`);
    },
  },
  admins: {
    run: (c) => {
      const ids = c.meta.participants.filter((p) => p.admin).map((p) => p.id);
      return reply(c, `👮 Admins\n${ids.map((i) => '@' + digits(i)).join('\n')}`, ids);
    },
  },

  tagall: {
    admin: true,
    run: (c) => {
      const ids = c.meta.participants.map((p) => p.id);
      const body = c.args.join(' ') || '📢 Attention everyone!';
      return say(c.s, c.jid, { text: `${body}\n\n${ids.map((i) => '@' + digits(i)).join(' ')}`, mentions: ids });
    },
  },
  hidetag: {
    admin: true,
    run: (c) => {
      const ctx = getContext(c.content);
      const quoted = ctx?.quotedMessage ? getText(unwrap(ctx.quotedMessage)) : '';
      const text = c.args.join(' ') || quoted || '📢';
      return say(c.s, c.jid, { text, mentions: c.meta.participants.map((p) => p.id) });
    },
  },
  tagadmins: {
    admin: true,
    run: (c) => {
      const ids = c.meta.participants.filter((p) => p.admin).map((p) => p.id);
      const body = c.args.join(' ') || '🚨 Admins, please check this.';
      return say(c.s, c.jid, { text: `${body}\n\n${ids.map((i) => '@' + digits(i)).join(' ')}`, mentions: ids });
    },
  },

  kick: {
    admin: true,
    needBot: true,
    run: async (c) => {
      const p = pickTarget(c);
      if (!p) return needTarget(c, 'kick');
      if (isBot(c, p)) return;
      if (p.admin) return reply(c, "⚠️ I can't remove an admin.");
      await c.sock.groupParticipantsUpdate(c.jid, [p.id], 'remove');
      return reply(c, `✅ @${digits(p.id)} was removed.`, [p.id]);
    },
  },
  promote: {
    admin: true,
    needBot: true,
    run: async (c) => {
      const p = pickTarget(c);
      if (!p) return needTarget(c, 'promote');
      if (p.admin) return reply(c, 'ℹ️ That member is already an admin.');
      await c.sock.groupParticipantsUpdate(c.jid, [p.id], 'promote');
      return reply(c, `⭐ @${digits(p.id)} is now an admin.`, [p.id]);
    },
  },
  demote: {
    admin: true,
    needBot: true,
    run: async (c) => {
      const p = pickTarget(c);
      if (!p) return needTarget(c, 'demote');
      if (!p.admin) return reply(c, 'ℹ️ That member is not an admin.');
      await c.sock.groupParticipantsUpdate(c.jid, [p.id], 'demote');
      return reply(c, `⬇️ @${digits(p.id)} is no longer an admin.`, [p.id]);
    },
  },

  open: {
    admin: true,
    needBot: true,
    run: async (c) => {
      await c.sock.groupSettingUpdate(c.jid, 'not_announcement');
      return reply(c, '🔓 Group opened. Everyone can send messages.');
    },
  },
  close: {
    admin: true,
    needBot: true,
    run: async (c) => {
      await c.sock.groupSettingUpdate(c.jid, 'announcement');
      return reply(c, '🔒 Group closed. Only admins can send messages.');
    },
  },
  link: {
    admin: true,
    needBot: true,
    run: async (c) => reply(c, `🔗 https://chat.whatsapp.com/${await c.sock.groupInviteCode(c.jid)}`),
  },
  revoke: {
    admin: true,
    needBot: true,
    run: async (c) => {
      const code = await c.sock.groupRevokeInvite(c.jid);
      return reply(c, `♻️ Old link cancelled.\n🔗 https://chat.whatsapp.com/${code}`);
    },
  },

  warn: {
    admin: true,
    needBot: true,
    run: async (c) => {
      const p = pickTarget(c);
      if (!p) return needTarget(c, 'warn');
      if (isBot(c, p)) return;
      if (p.admin) return reply(c, "⚠️ I can't warn an admin.");
      await strike(c.cid, c.s, c.jid, p.id, reasonOf(c) || 'breaking the group rules', c.g, { force: true });
    },
  },
  warnings: {
    admin: true,
    run: (c) => {
      const p = pickTarget(c);
      if (!p) return needTarget(c, 'warnings');
      const n = db.warnings[`${c.cid}|${c.jid}|${digits(p.id)}`] || 0;
      return reply(c, `📋 @${digits(p.id)} has ${n}${c.g.warnLimit > 0 ? `/${c.g.warnLimit}` : ''} warnings.`, [p.id]);
    },
  },
  resetwarn: {
    admin: true,
    run: (c) => {
      const p = pickTarget(c);
      if (!p) return needTarget(c, 'resetwarn');
      delete db.warnings[`${c.cid}|${c.jid}|${digits(p.id)}`];
      save();
      return reply(c, `✅ Warnings cleared for @${digits(p.id)}.`, [p.id]);
    },
  },
  mute: {
    admin: true,
    needBot: true,
    run: (c) => {
      const p = pickTarget(c);
      if (!p) return needTarget(c, 'mute');
      if (isBot(c, p)) return;
      if (p.admin) return reply(c, "⚠️ I can't mute an admin.");
      const mins = minutesIn(c.args) || 60;
      db.mutes[`${c.cid}|${c.jid}|${digits(p.id)}`] = Date.now() + mins * 60000;
      save();
      return reply(c, `🔇 @${digits(p.id)} is muted for ${mins} min. Their messages are deleted.`, [p.id]);
    },
  },
  unmute: {
    admin: true,
    run: (c) => {
      const p = pickTarget(c);
      if (!p) return needTarget(c, 'unmute');
      delete db.mutes[`${c.cid}|${c.jid}|${digits(p.id)}`];
      save();
      return reply(c, `🔊 @${digits(p.id)} can post again.`, [p.id]);
    },
  },
  ban: {
    admin: true,
    needBot: true,
    run: async (c) => {
      const p = pickTarget(c);
      if (!p) return needTarget(c, 'ban');
      if (isBot(c, p)) return;
      if (p.admin) return reply(c, "⚠️ I can't ban an admin. Demote them first.");
      c.g.blacklist = [...new Set([...(c.g.blacklist || []), ...idsOf(p)])];
      save();
      await c.sock.groupParticipantsUpdate(c.jid, [p.id], 'remove');
      return reply(c, `⛔ @${digits(p.id)} is on the blacklist and was removed. They are removed again if they rejoin.`, [p.id]);
    },
  },
  unban: {
    admin: true,
    run: (c) => {
      const p = pickTarget(c);
      if (!p) return needTarget(c, 'unban');
      const ids = idsOf(p);
      const before = (c.g.blacklist || []).length;
      c.g.blacklist = (c.g.blacklist || []).filter((x) => !ids.includes(x));
      save();
      return reply(c, before !== c.g.blacklist.length ? `✅ @${digits(p.id)} is off the blacklist.` : 'ℹ️ That member is not on the blacklist.', [p.id]);
    },
  },

  pin: {
    admin: true,
    needBot: true,
    run: async (c) => {
      const key = quotedKey(c);
      if (!key) return reply(c, `📌 Reply to the message you want to pin, then type ${c.prefix}pin.`);
      await c.sock.sendMessage(c.jid, { pin: key, type: 1, time: 7 * 86400 });
      return reply(c, '📌 Pinned for 7 days.');
    },
  },
  unpin: {
    admin: true,
    needBot: true,
    run: async (c) => {
      const key = quotedKey(c);
      if (!key) return reply(c, `📌 Reply to the pinned message, then type ${c.prefix}unpin.`);
      await c.sock.sendMessage(c.jid, { pin: key, type: 2 });
      return reply(c, '📌 Unpinned.');
    },
  },
  purge: {
    admin: true,
    needBot: true,
    run: (c) => {
      const n = Math.min(30, Math.max(1, Number(c.args[0]) || 10));
      const list = c.s.recent?.get(c.jid) || [];
      const picked = [];
      for (let i = list.length - 1; i >= 0 && picked.length < n; i--) {
        if (!isAdminOf(c.meta, [list[i].who])) picked.push(list[i]);
      }
      if (!picked.length) return reply(c, 'ℹ️ Nothing to purge. I can only purge messages I have seen since I last restarted.');
      const gone = new Set(picked.map((e) => e.key.id));
      c.s.recent.set(c.jid, list.filter((e) => !gone.has(e.key.id)));
      for (const e of picked) c.s.q.add(() => c.sock.sendMessage(c.jid, { delete: e.key }));
      return reply(c, `🧹 Deleting ${picked.length} recent message${picked.length === 1 ? '' : 's'} from members. Admin messages are kept.`);
    },
  },

  setname: {
    admin: true,
    needBot: true,
    run: async (c) => {
      const name = c.args.join(' ').trim().slice(0, 25);
      if (!name) return reply(c, `✏️ Usage: ${c.prefix}setname New group name`);
      await c.sock.groupUpdateSubject(c.jid, name);
      return reply(c, `✅ Group name changed to "${name}".`);
    },
  },
  setdesc: {
    admin: true,
    needBot: true,
    run: async (c) => {
      const desc = c.args.join(' ').trim().slice(0, 512);
      if (!desc) return reply(c, `📝 Usage: ${c.prefix}setdesc Your group description`);
      await c.sock.groupUpdateDescription(c.jid, desc);
      return reply(c, '✅ Group description updated.');
    },
  },
  lockname: {
    admin: true,
    needBot: true,
    run: (c) => lockInfo(c, 'lockname'),
  },
  lockdesc: {
    admin: true,
    needBot: true,
    run: (c) => lockInfo(c, 'lockdesc'),
  },
  inactive: {
    admin: true,
    run: (c) => {
      const days = Math.min(365, Math.max(1, Number(c.args[0]) || 7));
      const act = db.activity[`${c.cid}|${c.jid}`] || {};
      const cutoff = Date.now() - days * 86400000;
      const members = c.meta.participants.filter((p) => !p.admin && !isBot(c, p));
      const quiet = members.filter((p) => (act[digits(p.id)]?.t || 0) < cutoff);
      if (!quiet.length) return reply(c, `✅ Everyone has posted in the last ${days} day${days === 1 ? '' : 's'}.`);
      const shown = quiet.slice(0, 15).map((p) => `+${digits(p.id)}`).join('\n');
      return reply(
        c,
        `💤 ${quiet.length} member${quiet.length === 1 ? ' has' : 's have'} not posted in ${days} day${days === 1 ? '' : 's'}.\n${shown}${quiet.length > 15 ? `\n…and ${quiet.length - 15} more` : ''}\n\n(Counted since I started watching this group.)`
      );
    },
  },
  topmembers: {
    admin: true,
    run: (c) => {
      const act = db.activity[`${c.cid}|${c.jid}`] || {};
      const top = Object.entries(act)
        .sort((a, b) => b[1].n - a[1].n)
        .slice(0, 5);
      if (!top.length) return reply(c, '📊 No messages counted yet.');
      return reply(c, `🏆 Top members (since I started watching)\n${top.map(([w, e], i) => `${i + 1}. +${w} · ${e.n} messages`).join('\n')}`);
    },
  },
  report: {
    run: (c) => {
      const ctx = getContext(c.content);
      if (!ctx?.stanzaId) return reply(c, `🚩 Reply to the message you want to report, then type ${c.prefix}report.`);
      const quoted = ctx.quotedMessage ? getText(unwrap(ctx.quotedMessage)) : '';
      events.emit('report', c.cid, c.meta.subject || c.jid, digits(c.msg.key.participant), String(quoted).slice(0, 200));
      return reply(c, '🚩 Thanks. The admins were notified.');
    },
  },
  announce: {
    admin: true,
    run: (c) => {
      const text = c.args.join(' ').trim();
      if (!text) return reply(c, `📢 Usage: ${c.prefix}announce Your message`);
      const ids = c.meta.participants.map((p) => p.id);
      return say(c.s, c.jid, { text: `📢 ANNOUNCEMENT\n\n${text}\n\n${ids.map((i) => '@' + digits(i)).join(' ')}`, mentions: ids });
    },
  },
  lockdown: {
    admin: true,
    run: async (c) => {
      const r = await runLockdown(c.cid, c.s, true);
      return reply(c, `🚨 Lockdown ON. Strict rules are on and ${r.closed} group${r.closed === 1 ? '' : 's'} closed. Type ${c.prefix}unlockdown to end it.`);
    },
  },
  unlockdown: {
    admin: true,
    run: async (c) => {
      const r = await runLockdown(c.cid, c.s, false);
      return reply(c, `✅ Lockdown OFF. Your rules are back and ${r.closed} group${r.closed === 1 ? '' : 's'} reopened.`);
    },
  },
  rules: {
    run: (c) => reply(c, c.g.rules ? `📜 Group rules\n\n${c.g.rules}` : 'No rules have been set yet.'),
  },
  birthday: {
    run: (c) => {
      const m = (c.args[0] || '').match(/^(\d{1,2})[-/.](\d{1,2})$/);
      if (!m) return reply(c, `🎂 Send your birthday as DD-MM, for example ${c.prefix}birthday 14-02`);
      const dd = Number(m[1]);
      const mm = Number(m[2]);
      if (dd < 1 || dd > 31 || mm < 1 || mm > 12) return reply(c, '🎂 That date does not look right. Use DD-MM.');
      db.birthdays[`${c.cid}|${c.jid}|${digits(c.msg.key.participant)}`] = `${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
      save();
      return reply(c, '🎂 Saved! I will wish you on your day.');
    },
  },
  poll: {
    admin: true,
    run: (c) => {
      const p = parsePoll(c.args.join(' '));
      if (!p) return reply(c, `📊 Usage: ${c.prefix}poll Question | Option 1 | Option 2 (2 to 12 options)`);
      return c.sock.sendMessage(c.jid, { poll: { name: p.name, values: p.values, selectableCount: 1 } });
    },
  },
  giveaway: {
    admin: true,
    run: (c) => {
      const n = Math.min(10, Math.max(1, Number(c.args[0]) || 1));
      const cutoff = Date.now() - 7 * 86400000;
      const act = db.activity[`${c.cid}|${c.jid}`] || {};
      const pool = c.meta.participants.filter((p) => !p.admin && !isBot(c, p) && (act[digits(p.id)]?.t || 0) >= cutoff).map((p) => p.id);
      if (!pool.length) return reply(c, 'Nobody has posted in the last 7 days, so there is no one to draw.');
      const winners = [];
      while (winners.length < n && pool.length) winners.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
      return say(c.s, c.jid, {
        text: `🎉 Giveaway! ${winners.length > 1 ? 'Winners' : 'Winner'}: ${winners.map((w) => '@' + digits(w)).join(' ')}`,
        mentions: winners,
      });
    },
  },
  level: {
    run: (c) => {
      const act = db.activity[`${c.cid}|${c.jid}`] || {};
      const me = act[digits(c.msg.key.participant)]?.n || 0;
      const rank = 1 + Object.values(act).filter((e) => e.n > me).length;
      return reply(c, `⭐ Level ${levelOf(me)} · ${me} points (1 per message) · rank ${rank}`);
    },
  },
  leaderboard: {
    run: (c) => {
      const act = db.activity[`${c.cid}|${c.jid}`] || {};
      const top = Object.entries(act)
        .sort((a, b) => b[1].n - a[1].n)
        .slice(0, 10);
      if (!top.length) return reply(c, '🏆 No points yet.');
      return reply(c, `🏆 Leaderboard\n${top.map(([w, e], i) => `${i + 1}. +${w} · level ${levelOf(e.n)} · ${e.n} points`).join('\n')}`);
    },
  },
  buy: { run: (c) => COMMANDS.shop.run(c) },
  shop: {
    run: (c) => (c.g.salesOn && c.g.salesLink ? reply(c, `🛒 ${c.g.salesLink}`) : reply(c, 'No shop link is set yet.')),
  },
  calc: {
    run: (c) => {
      const v = calc(c.args.join(' '));
      return reply(c, v === null ? `🧮 I could not calculate that. Example: ${c.prefix}calc (2+3)*4` : `🧮 ${v}`);
    },
  },
  time: {
    run: (c) => {
      const t = timeIn(c.args[0] || 'utc');
      return reply(c, t ? `🕒 ${t}` : '🕒 Unknown zone. Try ny, london, lagos, dubai, delhi, tokyo, sydney, or a name like Europe/Paris.');
    },
  },
  convert: {
    run: (c) => {
      const [v, a, b] = c.args;
      const r = v && a && b ? convert(v, a, b) : null;
      return reply(c, r === null ? `📏 Usage: ${c.prefix}convert 10 km mi (km mi m ft cm in kg g lb oz l ml gal c f)` : `📏 ${v} ${a} = ${r} ${b}`);
    },
  },
  joke: { run: (c) => reply(c, `😄 ${joke()}`) },
  quote: { run: (c) => reply(c, `💬 ${quote()}`) },
  qr: {
    run: (c) => {
      const t = c.args.join(' ').trim();
      if (!t) return reply(c, `🔳 Usage: ${c.prefix}qr text or link`);
      return say(c.s, c.jid, { image: { url: qrUrl(t) }, caption: `🔳 ${t.slice(0, 100)}` }, { quoted: c.msg });
    },
  },
  weather: lookup((c) => (c.args.length ? weather(c.args.join(' ')) : null), 'Usage: .weather city'),
  define: lookup((c) => (c.args[0] ? define(c.args[0]) : null), 'Usage: .define word'),
  wiki: lookup((c) => (c.args.length ? wiki(c.args.join(' ')) : null), 'Usage: .wiki topic'),
  translate: lookup((c) => (c.args[1] ? translate(c.args[0], c.args.slice(1).join(' ')) : null), 'Usage: .translate fr hello there (language code first)'),
  movie: lookup((c) => (c.args.length ? movie(c.args.join(' ')) : null), 'Usage: .movie title'),
  news: lookup(() => news(), null),
  yts: lookup((c) => (c.args.length ? youtube(c.args.join(' ')) : null), 'Usage: .yts search words'),
  site: lookup(async (c) => (c.args[0] ? siteLine(await checkSite(c.args[0])) : null), 'Usage: .site example.com'),
  lyrics: {
    run: (c) => (c.args.length ? reply(c, lyricsLink(c.args.join(' '))) : reply(c, `🎵 Usage: ${c.prefix}lyrics song name`)),
  },
  short: {
    admin: true,
    run: (c) => {
      const code = c.args[0] ? createShort(c.cid, c.args[0]) : null;
      if (!code) return reply(c, `🔗 Usage: ${c.prefix}short https://example.com`);
      const url = shortUrl(code);
      return reply(c, url ? `🔗 ${url}` : '🔗 The owner has not set PUBLIC_URL yet, so short links are off.');
    },
  },
  note: {
    run: (c) => {
      const t = c.args.join(' ').trim();
      if (!t) {
        const list = notesOf(c.cid, c.jid).slice(-10);
        return reply(c, list.length ? `📝 Notes\n${list.map((n, i) => `${i + 1}. ${n}`).join('\n')}` : `📝 No notes yet. Add one with ${c.prefix}note text`);
      }
      addNote(c.cid, c.jid, t);
      return reply(c, '📝 Note saved.');
    },
  },
  todo: {
    run: (c) => {
      const [sub, ...rest] = c.args;
      const n = Number(rest[0]);
      const senderIds = [c.msg.key.participant, c.msg.key.participantAlt].filter(Boolean);
      const isAdmin = Boolean(c.msg.key.fromMe) || isAdminOf(c.meta, senderIds);
      if (sub === 'add' && rest.length) {
        addTodo(c.cid, c.jid, rest.join(' '));
        return reply(c, '✅ Added to the to-do list.');
      }
      if (sub === 'done' && n > 0) {
        const t = toggleTodo(c.cid, c.jid, n);
        return reply(c, t ? `${t.done ? '✅ Done' : '↩️ Reopened'}: ${t.text}` : 'ℹ️ No to-do with that number.');
      }
      if (sub === 'del' && n > 0) {
        if (!isAdmin) return reply(c, 'Only admins can delete to-dos.');
        return reply(c, delTodo(c.cid, c.jid, n) ? '🗑 Deleted.' : 'ℹ️ No to-do with that number.');
      }
      const list = todosOf(c.cid, c.jid);
      if (!list.length) return reply(c, `📋 To-do list is empty. Add with ${c.prefix}todo add text`);
      return reply(c, `📋 To-do\n${list.map((t, i) => `${i + 1}. ${t.done ? '✅' : '⬜'} ${t.text}`).join('\n')}`);
    },
  },
  voice: {
    run: (c) => {
      const cust = db.customers[c.cid];
      const name = (c.args[0] || '').toLowerCase();
      const e = name && mediaOf(cust)[name];
      if (!e || e.kind !== 'voice') return reply(c, `🎤 Usage: ${c.prefix}voice name. Voice notes are added in the panel (Settings > Automation > Voice notes & stickers).`);
      return say(c.s, c.jid, contentFor(cust, `voice:${name}`), { quoted: c.msg });
    },
  },
  remind: {
    admin: true,
    run: (c) => {
      const cust = db.customers[c.cid];
      cust.reminders ??= [];
      const [t, ...rest] = c.args;
      const ms = parseDelay(t);
      const text = rest.join(' ').trim().slice(0, 300);
      if (!ms || !text) return reply(c, `⏰ Usage: ${c.prefix}remind 30m text (m = minutes, h = hours, d = days)`);
      if (ms > 7 * 86400000) return reply(c, '⏰ The longest reminder is 7 days.');
      if (cust.reminders.length >= 20) return reply(c, '⏰ You can have up to 20 reminders. Wait for some to go off.');
      cust.reminders.push({ jid: c.jid, at: Date.now() + ms, text });
      save();
      return reply(c, '⏰ Reminder set.');
    },
  },
  addsite: {
    admin: true,
    run: (c) => {
      if (!c.args[0]) return reply(c, `🌐 Usage: ${c.prefix}addsite example.com`);
      const r = addSite(db.customers[c.cid], c.args[0]);
      return reply(c, r.error ? `🌐 ${r.error}` : `🌐 Watching ${r.url}. I will tell you if it goes down.`);
    },
  },
  removesite: {
    admin: true,
    run: (c) => {
      const n = Number(c.args[0]);
      return reply(c, removeSite(db.customers[c.cid], n) ? '🌐 Removed.' : `🌐 Usage: ${c.prefix}removesite 1 (see ${c.prefix}sites)`);
    },
  },
  sites: {
    run: (c) => {
      const list = sitesOf(db.customers[c.cid]);
      if (!list.length) return reply(c, `🌐 No sites yet. Admins add one with ${c.prefix}addsite example.com`);
      const lines = list.map((s, i) => `${i + 1}. ${s.url} · ${s.up === null ? 'checking' : s.up ? '🟢 up' : '🔴 down'} · ${uptimePct(s) ?? '-'}% · ${s.ms} ms`);
      return reply(c, `🌐 Sites\n${lines.join('\n')}`);
    },
  },
  ai: {
    run: async (c) => {
      const q = c.args.join(' ').trim();
      if (!q) return reply(c, `🤖 Usage: ${c.prefix}ai your question`);
      if (!c.g.aiOn) return reply(c, '🤖 The assistant is off. The owner can switch it on in the panel.');
      if (!aiReady()) return reply(c, '🤖 The owner has not set up the AI key yet.');
      if (!aiAllowed(db.customers[c.cid], c.g.aiDailyLimit)) return reply(c, '🤖 Daily AI limit reached. Try again tomorrow.');
      const r = await askAi(q, c.g.aiPersonality);
      return reply(c, r.error ? `🤖 ${r.error}` : withSignature(c.g, `🤖 ${r.text}`));
    },
  },
  transcribe: {
    admin: true,
    run: async (c) => {
      const ctx = getContext(c.content);
      const quoted = ctx?.quotedMessage ? unwrap(ctx.quotedMessage) : null;
      if (!quoted?.audioMessage) return reply(c, `🎙 Reply to a voice note with ${c.prefix}transcribe.`);
      if (!c.g.aiOn) return reply(c, '🎙 The assistant is off. The owner can switch it on in the panel.');
      if (!aiReady()) return reply(c, '🎙 The owner has not set up the AI key yet.');
      const cust = db.customers[c.cid];
      if (!aiAllowed(cust, c.g.aiDailyLimit)) return reply(c, '🎙 Daily AI limit reached. Try again tomorrow.');
      const msg = { key: { remoteJid: c.jid, id: ctx.stanzaId, fromMe: false, participant: ctx.participant }, message: quoted };
      let buf;
      try {
        buf = await downloadMediaMessage(msg, 'buffer', {}, { reuploadRequest: c.sock.updateMediaMessage });
      } catch {
        return reply(c, '🎙 Could not download that voice note.');
      }
      const t = await transcribe(buf, quoted.audioMessage.mimetype || 'audio/ogg');
      if (t.error) return reply(c, `🎙 ${t.error}`);
      const sum = aiAllowed(cust, c.g.aiDailyLimit) ? await summarize(t.text) : { error: 'Daily AI limit reached, so no summary.' };
      const summary = sum.text ? `\n\n📝 Summary\n${sum.text}` : '';
      return reply(c, withSignature(c.g, `🎙 Transcript\n${t.text}${summary}`));
    },
  },
};

// Returns true if the message was a command (so the guard rules are skipped for it).
export async function tryCommand(cid, s, msg, content, text, g) {
  const prefix = g.prefix || '.';
  if (!text.startsWith(prefix)) return false;
  const [word, ...args] = text.slice(prefix.length).trim().split(/\s+/);
  const name = (word || '').toLowerCase();
  const cmd = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : null;
  if (!cmd) return false;

  const sock = s.sock;
  const jid = msg.key.remoteJid;
  const meta = await getMeta(s, jid);
  const senderIds = [msg.key.participant, msg.key.participantAlt, msg.participant].filter(Boolean);
  const isMe = Boolean(msg.key.fromMe);
  const isAdmin = isMe || isAdminOf(meta, senderIds);

  if (cmd.admin && !isAdmin) return true; // members get no reply (no spam)
  if (!isAdmin) {
    const ck = `${digits(senderIds[0])}|${name}`;
    if (Date.now() - (s.cool.get(ck) || 0) < 4000) return true;
    if (s.cool.size > 2000) s.cool.clear();
    s.cool.set(ck, Date.now());
  }

  if (cmd.needBot && !isAdminOf(meta, [sock.user?.id, sock.user?.lid])) {
    await react(s, jid, msg.key, '⚠️');
    notifyNotAdmin(cid, s, jid, meta);
    return true;
  }

  const c = { cid, s, sock, msg, jid, g, args, prefix, content, meta };
  try {
    await cmd.run(c);
  } catch (e) {
    console.error(`[${cid}] command ${name} failed:`, e.message);
    await react(s, jid, msg.key, '❌');
  }
  return true;
}
