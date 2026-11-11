// Stage 6: voice notes and stickers that the customer uploads from Telegram. They are used by name
// (voice:name or sticker:name, as the whole message) in replies, welcome and goodbye texts, scheduled
// posts and the .voice command. Stored on the customer, small files only.
export const MAX_VOICE = 1024 * 1024; // 1 MB
export const MAX_STICKER = 512 * 1024; // 512 KB
export const MAX_MEDIA = 20;
const NAME = /^[a-z0-9_-]{1,20}$/;
const REF = /^(voice|sticker):([a-z0-9_-]{1,20})$/i;

export const validName = (n) => NAME.test(String(n || '').trim().toLowerCase());
export const mediaOf = (cust) => (cust.media ??= {});

export function saveMedia(cust, rawName, kind, buf, mime) {
  if (!validName(rawName)) return { error: 'Use letters, numbers, - or _ (up to 20 characters).' };
  const name = String(rawName).trim().toLowerCase();
  const max = kind === 'voice' ? MAX_VOICE : MAX_STICKER;
  if (!buf || !buf.length) return { error: 'The file was empty.' };
  if (buf.length > max) return { error: `That file is too big. The limit is ${Math.round(max / 1024)} KB.` };
  const m = mediaOf(cust);
  if (!m[name] && Object.keys(m).length >= MAX_MEDIA) return { error: `You can save up to ${MAX_MEDIA} voice notes and stickers. Delete one first.` };
  m[name] = { kind, mime, b64: buf.toString('base64'), t: Date.now() };
  return { ok: true, name };
}

export function deleteMedia(cust, name) {
  const m = mediaOf(cust);
  const k = String(name || '').toLowerCase();
  if (!m[k]) return false;
  delete m[k];
  return true;
}

export function listMedia(cust) {
  return Object.entries(mediaOf(cust)).map(([name, e]) => ({
    name,
    kind: e.kind,
    kb: Math.max(1, Math.round((e.b64.length * 0.75) / 1024)),
  }));
}

// The Baileys content for a message. "voice:name" and "sticker:name" send the saved item;
// anything else (or an unknown name) is sent as plain text.
export function contentFor(cust, text) {
  const t = String(text ?? '').trim();
  const m = t.match(REF);
  const e = m && mediaOf(cust)[m[2].toLowerCase()];
  if (e && m[1].toLowerCase() === e.kind) {
    const buf = Buffer.from(e.b64, 'base64');
    return e.kind === 'voice' ? { audio: buf, mimetype: 'audio/ogg; codecs=opus', ptt: true } : { sticker: buf };
  }
  return { text: String(text ?? '') };
}

// Countdown: "{days 2026-12-25}" becomes the number of days left from `today` (YYYY-MM-DD in the customer's time zone)
export function daysBetween(fromDate, toDate) {
  const d = Math.round((Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / 86400000);
  return Number.isFinite(d) ? Math.max(0, d) : null;
}
export function fillCountdown(text, today) {
  return String(text ?? '').replace(/\{days (\d{4}-\d{2}-\d{2})\}/g, (_, d) => {
    const n = daysBetween(today, d);
    return n === null ? '?' : String(n);
  });
}
