// Stage 4: private chats (greeting, auto-replies, sales, away, support tickets), welcome and goodbye,
// scheduled posts, birthdays, the daily summary, polls, giveaways and levels.
import { db, save, markDirty } from './store.js';
import { digits, events, getText, unwrap, say, getMeta } from './wa.js';
import { protectedGroups, mayUse } from './plans.js';
import { contentFor, fillCountdown } from './content.js';
import { typeThen, postStatus, statusAudience } from './automation.js';
import { withSignature } from './ai.js';

const HOUR = 3600000;
export const BUY_WORDS = ['buy', 'price', 'prices', 'order', 'shop', 'how much', 'where can i', 'cost'];

// Telegram message id -> the WhatsApp chat a ticket came from. Key: 'customerId:messageId'.
export const ticketRoutes = new Map();
const ticketKey = (cid, mid) => `${cid}:${mid}`;
export const rememberTicket = (cid, mid, jid) => {
  ticketRoutes.set(ticketKey(cid, mid), { cid: String(cid), jid });
  if (ticketRoutes.size > 500) ticketRoutes.delete(ticketRoutes.keys().next().value);
};
export const ticketFor = (cid, mid) => ticketRoutes.get(ticketKey(cid, mid)) || null;

export const isPrivateJid = (jid) => /@(s\.whatsapp\.net|lid)$/.test(String(jid || ''));

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// whole-word match, so "buy" does not match "buyer"
export function hasWord(text, word) {
  const w = String(word || '').trim().toLowerCase();
  if (w.length < 2) return false;
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(w)}([^\\p{L}\\p{N}]|$)`, 'iu').test(String(text || ''));
}

// The first reply rule whose words appear in the text ({ words, reply, image })
export function replyRule(g, text) {
  for (const r of g.replies || []) if ((r.words || []).some((w) => hasWord(text, w))) return r;
  return null;
}
export function matchReply(g, text) {
  return replyRule(g, text)?.reply ?? null;
}

// Stage 6: "words | reply" or "words | reply | https://.../picture.jpg" (the picture is optional, and last)
export const IMAGE_URL = /^https:\/\/\S+\.(jpe?g|png|webp|gif)(\?\S*)?$/i;
export function parseReplyRule(t, wordsOf) {
  let body = String(t || '');
  let image = '';
  const i = body.lastIndexOf('|');
  if (i >= 0 && IMAGE_URL.test(body.slice(i + 1).trim())) {
    image = body.slice(i + 1).trim();
    body = body.slice(0, i);
  }
  const [w, r] = splitBar(body);
  const words = wordsOf(w);
  return words.length && r ? { words, reply: r.slice(0, 500), image } : null;
}

export function salesReply(g, text) {
  if (!g.salesOn) return null;
  for (const t of g.salesTopics || []) if (t.link && (t.words || []).some((w) => hasWord(text, w))) return `🛒 ${t.link}`;
  if (g.salesLink && BUY_WORDS.some((w) => hasWord(text, w))) return `🛒 ${g.salesLink}`;
  return null;
}

// Local date and time in a time zone (falls back to UTC)
export function localParts(tz, now = Date.now()) {
  const opts = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
  let f;
  try {
    f = new Intl.DateTimeFormat('en-GB', { timeZone: tz || 'UTC', ...opts });
  } catch {
    f = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', ...opts });
  }
  const p = Object.fromEntries(f.formatToParts(now).map((x) => [x.type, x.value]));
  const hour = Number(p.hour) % 24;
  return { date: `${p.year}-${p.month}-${p.day}`, hour, minute: Number(p.minute), mins: hour * 60 + Number(p.minute) };
}

// "9:05" or "18:00" -> "09:05" / "18:00" (null if not a time)
export function normTime(v) {
  const m = String(v || '').trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
}
const minutesOf = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

// "a, b | reply" -> the part before and after the bar
export const splitBar = (t) => {
  const i = String(t || '').indexOf('|');
  return i < 0 ? [String(t || '').trim(), ''] : [t.slice(0, i).trim(), t.slice(i + 1).trim()];
};

// rate limits per key (true = still cooling down; otherwise this call takes the slot)
const last = new Map();
export function cooled(key, ms) {
  const t = last.get(key) || 0;
  if (Date.now() - t < ms) return true;
  if (last.size > 5000) last.clear();
  last.set(key, Date.now());
  return false;
}

const PRIVATE_MENU = (g) =>
  withSignature(g, `🤖 Hi! I am an automatic helper.\n\n${g.prefix}shop: our link\n${g.prefix}menu: this help\n\nSend your question and the team will answer as soon as they can.`);

// ---------- private chats ----------
export async function handlePrivate(cid, s, msg) {
  const cust = db.customers[cid];
  if (!cust || !mayUse(cust)) return;
  const g = cust.guard;
  if (!g.privateChats) return;
  const jid = msg.key.remoteJid;
  if (!isPrivateJid(jid) || msg.key.fromMe) return;
  const who = digits(jid);
  const text = getText(unwrap(msg.message || {})).trim();

  if (g.greetFirst && g.greeting && !db.greeted[`${cid}|${who}`]) {
    db.greeted[`${cid}|${who}`] = Date.now();
    markDirty();
    await say(s, jid, { text: withSignature(g, g.greeting) });
  }

  const prefix = g.prefix || '.';
  if (text.startsWith(prefix)) {
    const word = text.slice(prefix.length).trim().split(/\s+/)[0].toLowerCase();
    if (word === 'menu' || word === 'ping') return say(s, jid, { text: PRIVATE_MENU(g) });
    if (word === 'shop' || word === 'buy') {
      if (g.salesOn && g.salesLink) return say(s, jid, { text: `🛒 ${g.salesLink}` });
      return say(s, jid, { text: 'No shop link is set yet.' });
    }
  }

  const rule = replyRule(g, text);
  if (rule) {
    if (!cooled(`${cid}|${who}|reply`, 2 * 60000)) {
      await typeThen(s, jid, g, rule.reply);
      await say(s, jid, rule.image ? { image: { url: rule.image }, caption: rule.reply } : contentFor(cust, rule.reply));
    }
    return;
  }
  const sales = salesReply(g, text);
  if (sales) {
    if (!cooled(`${cid}|${who}|sales`, 6 * HOUR)) {
      await typeThen(s, jid, g, sales);
      await say(s, jid, { text: sales });
    }
    return;
  }
  if (g.awayOn && g.away && !cooled(`${cid}|${who}|away`, 6 * HOUR)) await say(s, jid, { text: g.away });
  if (g.support) {
    const n = ++db.ticketSeq;
    markDirty();
    events.emit('ticket', cid, jid, n, text.slice(0, 500) || '(no text: a photo, sticker or voice note)', who);
  }
}

// ---------- groups: welcome and goodbye ----------
export async function onMembers(cid, s, jid, participants, action) {
  const cust = db.customers[cid];
  if (!cust || !mayUse(cust) || !protectedGroups(cust).includes(jid)) return;
  const g = cust.guard;
  const tpl = action === 'add' ? g.welcome : g.goodbye;
  if (!tpl) return;
  const meta = await getMeta(s, jid).catch(() => null);
  for (const p of participants.slice(0, 5)) {
    const who = digits(p);
    if (action === 'add' && (g.blacklist || []).includes(who)) continue;
    const text = tpl.replace(/\{name\}/g, `@${who}`).replace(/\{group\}/g, meta?.subject || '');
    const content = contentFor(cust, text);
    await say(s, jid, content.text !== undefined ? { ...content, mentions: [p] } : content);
  }
}

// ---------- daily jobs ----------
// Scheduled posts: each one goes to every protected group once a day, at or after its time (your time zone).
export async function runSchedules(cid, s, cust, now = Date.now()) {
  const g = cust.guard;
  if (!g.schedules?.length || !mayUse(cust)) return;
  const p = localParts(g.nightTz, now);
  for (const sc of g.schedules) {
    if (!sc.on || sc.lastRun === p.date) continue;
    if (p.mins < minutesOf(sc.time)) continue;
    sc.lastRun = p.date;
    markDirty();
    save();
    // "{days YYYY-MM-DD}" is filled in, and "voice:name" / "sticker:name" send the saved item
    const content = contentFor(cust, fillCountdown(sc.text, p.date));
    if (sc.status) {
      // group numbers (g1, g2) are the position in the protected-groups list
      const pg = protectedGroups(cust);
      const groups = [];
      for (const n of (sc.groups || []).slice(0, 50)) {
        const jid = pg[n - 1];
        if (!jid) continue;
        const meta = await getMeta(s, jid).catch(() => null);
        groups.push({ jid, subject: meta?.subject || '' });
      }
      await postStatus(s, await statusAudience(s, cust), content, sc.tags, groups);
    }
    else for (const jid of protectedGroups(cust)) await say(s, jid, content);
  }
}

// Birthdays at 9 am and the daily summary at 9 pm (your time zone), once a day each.
export async function runDaily(cid, s, cust, now = Date.now()) {
  if (!mayUse(cust)) return;
  const g = cust.guard;
  const p = localParts(g.nightTz, now);
  cust.daily ??= { birthday: '', summary: '' };
  if (p.hour >= 9 && cust.daily.birthday !== p.date) {
    cust.daily.birthday = p.date;
    save();
    const mmdd = p.date.slice(5);
    const prefix = `${cid}|`;
    for (const [k, v] of Object.entries(db.birthdays)) {
      if (!k.startsWith(prefix) || v !== mmdd) continue;
      const [, jid, who] = k.split('|');
      if (!protectedGroups(cust).includes(jid)) continue;
      await say(s, jid, { text: `🎂 Happy birthday @${who}!`, mentions: [`${who}@s.whatsapp.net`] });
    }
  }
}

// The daily summary is sent to the customer, not to the groups. Runs for every connected customer.
export function runSummaries(now = Date.now()) {
  for (const c of Object.values(db.customers)) {
    if (c.status !== 'connected' || !c.guard?.dailySummary) continue;
    const p = localParts(c.guard.nightTz, now);
    c.daily ??= { birthday: '', summary: '' };
    if (p.hour < 21 || c.daily.summary === p.date) continue;
    c.daily.summary = p.date;
    const d = c.day || { msgs: 0, deleted: 0, warned: 0, removed: 0 };
    c.day = { msgs: 0, deleted: 0, warned: 0, removed: 0 };
    save();
    events.emit('summary', c.id, d);
  }
}

// ---------- levels (points = messages) ----------
export const levelOf = (points) => Math.floor(Math.sqrt(points / 10));

// ---------- polls and giveaways ----------
export function parsePoll(text) {
  const parts = String(text || '').split('|').map((x) => x.trim()).filter(Boolean);
  if (parts.length < 3) return null;
  const [name, ...values] = parts;
  if (values.length > 12 || values.some((v) => v.length > 100) || name.length > 255) return null;
  return { name, values };
}
