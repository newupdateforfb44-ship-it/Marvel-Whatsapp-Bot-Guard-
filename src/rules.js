import { riskyLink } from './scanner.js';
// Pure detection rules (no WhatsApp or database calls), so they are easy to test.

export const INVITE_RE = /chat\.whatsapp\.com\/\S+/i;
export const LINK_RE =
  /(https?:\/\/|www\.)\S+|(?:^|\s)[a-z0-9-]{3,}\.(com|net|org|io|ly|link|xyz|info|site|shop|store|online|app|dev|tv|gg|cc|biz|click|top|vip|live|club)(\/\S*)?(?=\s|$)/i;

const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's' };

// Lowercase, strip accents/invisible characters, undo "leet" (a$$ -> ass), merge spaced letters (f u c k -> fuck).
export function tokensOf(text) {
  const base = String(text || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f\u200b-\u200f\u2060\ufeff]/g, '')
    .toLowerCase();
  const raw = base
    .split(/[^\p{L}\p{N}@$]+/u)
    .filter(Boolean)
    .map((t) => (/\p{L}/u.test(t) ? t.replace(/[013457@$]/g, (ch) => LEET[ch]) : t))
    .filter((t) => /\p{L}/u.test(t));

  const out = [];
  let run = [];
  const flush = () => {
    if (run.length >= 3) out.push(run.join(''));
    else out.push(...run);
    run = [];
  };
  for (const t of raw) {
    if ([...t].length === 1) run.push(t);
    else {
      flush();
      out.push(t);
    }
  }
  flush();
  return out;
}

const variants = (tok) => [
  tok,
  tok.replace(/(\p{L})\1{2,}/gu, '$1'),
  tok.replace(/(\p{L})\1{2,}/gu, '$1$1'),
];

export function buildBadWords(list) {
  const words = new Set();
  const phrases = [];
  for (const w of list || []) {
    const t = tokensOf(w).join(' ');
    if (!t) continue;
    if (t.includes(' ')) phrases.push(t);
    else words.add(t);
  }
  return { words, phrases };
}

export function findBadWord(text, bw) {
  if (!bw || (!bw.words.size && !bw.phrases.length)) return null;
  const toks = tokensOf(text);
  for (const tok of toks) for (const v of variants(tok)) if (bw.words.has(v)) return v;
  if (bw.phrases.length) {
    const joined = ` ${toks.join(' ')} `;
    for (const p of bw.phrases) if (joined.includes(` ${p} `)) return p;
  }
  return null;
}

export const emojiCount = (text) => (String(text || '').match(/\p{Extended_Pictographic}/gu) || []).length;

// Counts messages per sender inside a sliding window.
export class FloodTracker {
  constructor(windowMs = 10000) {
    this.windowMs = windowMs;
    this.map = new Map();
  }
  // true when this message pushes the sender over the limit
  hit(key, now, limit) {
    const arr = (this.map.get(key) || []).filter((t) => now - t < this.windowMs);
    arr.push(now);
    this.map.set(key, arr);
    if (this.map.size > 2000) {
      for (const [k, v] of this.map) if (now - v[v.length - 1] >= this.windowMs) this.map.delete(k);
    }
    return arr.length > limit;
  }
}

export function kindOf(c) {
  if (c.imageMessage) return 'image';
  if (c.videoMessage) return 'video';
  if (c.stickerMessage) return 'sticker';
  if (c.audioMessage) return 'audio';
  if (c.documentMessage) return 'document';
  if (c.contactMessage || c.contactsArrayMessage) return 'contact';
  return 'text';
}

export const MEDIA_REASON = {
  image: 'posting images',
  video: 'posting videos',
  sticker: 'sending stickers',
  audio: 'sending audio',
  document: 'sending documents',
  contact: 'sharing contacts',
};

// info: { text, mentionCount, isForwarded, statusMention, kind, flooding, badWords }
// returns { rule, reason } or null
export function detect(g, i) {
  if (i.statusMention) return g.blockStatusMention ? { rule: 'status', reason: 'tagging the group in statuses' } : null;
  const t = i.text || '';
  if (INVITE_RE.test(t) || (g.blockAllLinks && LINK_RE.test(t))) return { rule: 'link', reason: 'sending links' };
  if (g.scamScan) {
    const why = riskyLink(t);
    if (why) return { rule: 'scam', reason: `a suspicious link (${why})` };
  }
  if (g.maxMentions > 0 && i.mentionCount > g.maxMentions) return { rule: 'mentions', reason: 'tagging too many people' };
  if (g.badWordsOn && findBadWord(t, i.badWords)) return { rule: 'badword', reason: 'using banned words' };
  if (g.blockMedia?.[i.kind]) return { rule: 'media', reason: MEDIA_REASON[i.kind] };
  if (g.blockForwards && i.isForwarded) return { rule: 'forward', reason: 'forwarding messages' };
  if (g.floodLimit > 0 && i.flooding) return { rule: 'flood', reason: 'flooding the chat' };
  if (g.maxLength > 0 && t.length > g.maxLength) return { rule: 'long', reason: 'sending very long messages' };
  if (g.maxEmoji > 0 && emojiCount(t) > g.maxEmoji) return { rule: 'emoji', reason: 'emoji spam' };
  if (g.antiNumbers && i.phone) return { rule: 'phone', reason: 'sharing phone numbers' };
  if (g.slowMode > 0 && i.slowed) return { rule: 'slow', reason: 'posting too fast' };
  return null;
}
