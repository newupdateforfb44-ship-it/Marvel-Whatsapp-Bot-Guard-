// Stage 6: automation on the customer's own number: auto-react, always online, auto-read, auto-bio,
// typing indicator, status view and react, status posts, and reminders. All off until switched on in the panel.
import { react, say, getMeta, digits } from './wa.js';
import { protectedGroups } from './plans.js';
import { save } from './store.js';

// true while the key is still cooling down; otherwise this call takes the slot
const last = new Map();
export function coolingDown(key, ms) {
  const t = last.get(key) || 0;
  if (Date.now() - t < ms) return true;
  if (last.size > 5000) last.clear();
  last.set(key, Date.now());
  return false;
}

export const STATUS_JID = 'status@broadcast';
export const REACT_SET = ['👍', '❤️', '🔥', '😂', '🙏'];
export const pickEmoji = (rnd = Math.random) => REACT_SET[Math.floor(rnd() * REACT_SET.length)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One reaction per chat per minute, so the bot does not react to every single message.
export async function autoReact(cid, s, msg, g, rnd) {
  if (!g.autoReact || msg.key.fromMe) return false;
  const jid = msg.key.remoteJid;
  if (coolingDown(`${cid}|${jid}|react`, 60000)) return false;
  await react(s, jid, msg.key, pickEmoji(rnd));
  return true;
}

// Marks incoming messages as read (the customer chooses this in the panel)
export async function autoRead(s, msg, g) {
  if (!g.autoRead || msg.key.fromMe) return false;
  await s.sock.readMessages([msg.key]).catch(() => {});
  return true;
}

// Runs once a minute for each connected number: presence and the WhatsApp "About" text.
export async function presenceAndBio(s, g) {
  if (g.alwaysOnline) await s.sock.sendPresenceUpdate('available').catch(() => {});
  const bio = String(g.bio || '').trim().slice(0, 139);
  if (bio && s.bioSet !== bio) {
    await s.sock.updateProfileStatus(bio).then(() => (s.bioSet = bio)).catch(() => {});
  }
}

// Typing indicator before a private reply: "typing…" for a moment that grows with the length of the text
export async function typeThen(s, jid, g, text) {
  if (!g.autoTyping) return;
  await s.sock.sendPresenceUpdate('composing', jid).catch(() => {});
  await sleep(Math.min(3000, 600 + String(text || '').length * 25));
  await s.sock.sendPresenceUpdate('paused', jid).catch(() => {});
}

// Statuses that the bot sees: mark as seen, and react with an emoji (at most one every 20 seconds)
export async function handleStatus(cid, s, msg, g) {
  if (msg.key.fromMe || !msg.message) return false;
  if (g.statusView) await s.sock.readMessages([msg.key]).catch(() => {});
  const who = msg.key.participant;
  if (g.statusLike && who && !coolingDown(`${cid}|status|like`, 20000)) {
    await s.q
      .add(() => s.sock.sendMessage(STATUS_JID, { react: { text: pickEmoji(), key: msg.key } }, { statusJidList: [who] }))
      .catch(() => {});
  }
  return true;
}

// Posts to the bot's status. The audience is the members of the protected groups (up to 300).
export async function statusAudience(s, cust) {
  const ids = new Set();
  for (const jid of protectedGroups(cust)) {
    const meta = await getMeta(s, jid).catch(() => null);
    for (const p of meta?.participants || []) if (p.id) ids.add(p.id);
  }
  return [...ids].slice(0, 300);
}
// Tagging inside a status is capped at 50 people, and only people who are
// members of the customer's protected groups (the status audience). Anyone else is skipped.
export const MAX_STATUS_TAGS = 50;
export function pickStatusTags(wanted, audience) {
  const byDigits = new Map(audience.map((j) => [digits(j), j]));
  const out = [];
  for (const n of wanted || []) {
    const d = String(n).replace(/\D/g, '');
    const jid = byDigits.get(d);
    if (jid && !out.some((o) => o.d === d)) out.push({ d, jid });
    if (out.length >= MAX_STATUS_TAGS) break;
  }
  return out;
}
// Group tags in a status are kept even smaller: at most 50 groups, and only groups the customer protects.
export const MAX_STATUS_GROUPS = 50;
export async function postStatus(s, audience, content, tags = [], groups = []) {
  if (!audience.length) return false;
  let c = content;
  const chosen = pickStatusTags(tags, audience);
  const grp = (groups || []).filter((g) => g?.jid).slice(0, MAX_STATUS_GROUPS);
  if (chosen.length || grp.length) {
    const base = c.text ?? c.caption ?? '';
    const extra = [
      ...chosen.filter((t) => !base.includes(`@${t.d}`)).map((t) => `@${t.d}`),
      ...grp.map((g) => `@${g.subject || 'group'}`),
    ].join(' ');
    const text = extra ? `${base}\n${extra}`.trim() : base;
    const add = {};
    if (chosen.length) add.mentions = chosen.map((t) => t.jid);
    if (grp.length) {
      add.contextInfo = { ...(c.contextInfo || {}), groupMentions: grp.map((g) => ({ groupJid: g.jid, groupSubject: g.subject || '' })) };
    }
    if (c.text !== undefined) c = { ...c, text, ...add };
    else if (c.caption !== undefined || c.image || c.video) c = { ...c, caption: text, ...add };
  }
  await s.q.add(() => s.sock.sendMessage(STATUS_JID, c, { statusJidList: audience })).catch(() => {});
  return true;
}

// "10m", "2h", "1d" -> milliseconds (null if not a delay)
export function parseDelay(t) {
  const m = String(t || '').match(/^(\d{1,4})([mhd])$/i);
  if (!m || Number(m[1]) === 0) return null;
  return Number(m[1]) * { m: 60000, h: 3600000, d: 86400000 }[m[2].toLowerCase()];
}

// Reminders set with .remind: posted to their group when they are due
export async function runReminders(cid, s, cust, now = Date.now()) {
  const list = cust.reminders || [];
  const due = list.filter((r) => r.at <= now);
  if (!due.length) return;
  const groups = protectedGroups(cust);
  cust.reminders = list.filter((r) => r.at > now);
  save();
  for (const r of due) {
    if (groups.includes(r.jid)) await say(s, r.jid, { text: `⏰ Reminder: ${r.text}` }).catch(() => {});
  }
}
