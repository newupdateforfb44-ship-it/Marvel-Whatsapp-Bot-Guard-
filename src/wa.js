// Helpers shared by the guard rules and the WhatsApp commands.
import { EventEmitter } from 'events';
import { db, save } from './store.js';
import { bump } from './stats.js';

// events: 'pairing-code'(cid, code) 'pairing-failed'(cid, why) 'open'(cid) 'logged-out'(cid) 'not-admin'(cid, groupName)
// 'disconnected'(cid, code) 'reconnected'(cid) 'group-limit'(cid, groupName, limit)
// 'expired'(cid) 'reminder'(cid, days) 'resumed'(cid)
export const events = new EventEmitter();

export const digits = (jid) => String(jid || '').split('@')[0].split(':')[0].replace(/\D/g, '');

/**
 * Unwraps nested messages including View Once containers.
 * Returns the innermost message object.
 */
export function unwrap(message) {
 let m = message;
 for (let i = 0; i < 5; i++) {
  const inner =
   m?.ephemeralMessage?.message ||
   m?.viewOnceMessage?.message ||
   m?.viewOnceMessageV2?.message ||
   m?.documentWithCaptionMessage?.message ||
   m?.editedMessage?.message;
  if (!inner) break;
  m = inner;
 }
 return m || {};
}

/**
 * Checks if a message is a View Once message.
 */
export function isViewOnce(msg) {
 return !!(msg.viewOnceMessage || msg.viewOnceMessageV2 || msg.viewOnceMessageV2Extension);
}

/**
 * Extracts the actual media payload from a View Once message.
 */
export function getMediaFromViewOnce(msg) {
 if (msg.viewOnceMessage) return msg.viewOnceMessage.message;
 if (msg.viewOnceMessageV2) return msg.viewOnceMessageV2.message;
 if (msg.viewOnceMessageV2Extension) return msg.viewOnceMessageV2Extension.message;
 return null;
}

/**
 * Downloads a View Once message and returns it as a Buffer.
 * @param {Object} sock - The Baileys socket instance.
 * @param {Object} msg - The original message object.
 * @returns {Promise<Buffer|null>}
 */
export async function downloadViewOnce(sock, msg) {
 try {
  // 1. Identify if it's view once and get the inner media object
  const mediaPayload = getMediaFromViewOnce(msg);
  if (!mediaPayload) return null;

  // 2. Determine media type based on what's inside the payload
  let mediaType;
  if (mediaPayload.imageMessage) mediaType = 'image';
  else if (mediaPayload.videoMessage) mediaType = 'video';
  else if (mediaPayload.audioMessage) mediaType = 'audio';
  else if (mediaPayload.stickerMessage) mediaType = 'sticker';
  else if (mediaPayload.documentMessage) mediaType = 'document';
  else if (mediaPayload.voiceMessage) mediaType = 'audio'; // Voice is often just audio
  else return null;

  // 3. Download the media using Baileys' built-in decryptor
  // We pass the original msg because downloadMediaMessage handles the decryption internally
  const buffer = await sock.downloadMediaMessage(msg, {
   stream: false,
   asData: true,
  });

  return buffer;
 } catch (e) {
  console.error('[WA] Error downloading View Once:', e);
  return null;
 }
}

/**
 * Sends a buffer as the appropriate media type.
 * @param {Object} sock - The Baileys socket instance.
 * @param {string} jid - The target JID.
 * @param {Buffer} buffer - The media buffer.
 * @param {Object} mediaMeta - Metadata like mimetype, caption, etc.
 * @param {Object} quotedMsg - Optional quoted message object.
 */
export async function sendMediaBuffer(sock, jid, buffer, mediaMeta, quotedMsg = null) {
 if (!buffer || !Buffer.isBuffer(buffer)) return;

 const sendObj = {};

 if (mediaMeta.type === 'image') {
  sendObj.imageMessage = {
   image: buffer,
   caption: mediaMeta.caption || '',
   mimetype: mediaMeta.mimetype || 'image/jpeg',
  };
 } else if (mediaMeta.type === 'video') {
  sendObj.videoMessage = {
   video: buffer,
   caption: mediaMeta.caption || '',
   mimetype: mediaMeta.mimetype || 'video/mp4',
  };
 } else if (mediaMeta.type === 'audio') {
  sendObj.audioMessage = {
   audio: buffer,
   mimetype: mediaMeta.mimetype || 'audio/ogg; codecs=opus',
   ptt: mediaMeta.ptt || false, // If it was a voice note (PTT)
  };
 } else if (mediaMeta.type === 'sticker') {
  sendObj.stickerMessage = {
   sticker: buffer,
   mimetype: mediaMeta.mimetype || 'image/webp',
  };
 } else if (mediaMeta.type === 'document') {
  sendObj.documentMessage = {
   document: buffer,
   fileName: mediaMeta.fileName || 'file',
   mimetype: mediaMeta.mimetype || 'application/octet-stream',
   caption: mediaMeta.caption || '',
  };
 }

 // Add context info if provided (e.g., to preserve quotes/replies)
 if (quotedMsg && quotedMsg.contextInfo) {
  sendObj[Object.keys(sendObj)[0]].contextInfo = quotedMsg.contextInfo;
 }

 await sock.sendMessage(jid, sendObj, {
  quoted: quotedMsg,
 });
}

export const getText = (c) =>
 c.conversation || c.extendedTextMessage?.text || c.imageMessage?.caption || c.videoMessage?.caption || c.documentMessage?.caption || '';

export function getContext(c) {
 for (const v of Object.values(c)) if (v && typeof v === 'object' && v.contextInfo) return v.contextInfo;
 return null;
}

export const participantDigits = (p) => [p.id, p.lid, p.phoneNumber, p.jid].filter(Boolean).map(digits);

export function isAdminOf(meta, idList) {
 const wanted = new Set(idList.filter(Boolean).map(digits));
 return meta.participants.some(
  (p) => (p.admin === 'admin' || p.admin === 'superadmin') && participantDigits(p).some((d) => wanted.has(d))
 );
}

export function findParticipant(meta, ref) {
 const want = digits(ref);
 if (!want) return null;
 return meta.participants.find((p) => participantDigits(p).includes(want)) || null;
}

export async function getMeta(s, jid) {
 const c = s.meta.get(jid);
 if (c && Date.now() - c.t < 5 * 60 * 1000) return c.m;
 const m = await s.sock.groupMetadata(jid);
 s.meta.set(jid, { m, t: Date.now() });
 return m;
}

export const say = (s, jid, content, opts) => s.q.add(() => postOrQueue(s, jid, content, opts));

async function postOrQueue(s, jid, content, opts) {
 try {
  return await s.sock.sendMessage(jid, content, opts);
 } catch (e) {
  s.failTimes ??= [];
  s.failTimes.push(Date.now());
  if (s.failTimes.length > 200) s.failTimes.splice(0, s.failTimes.length - 200);
  s.retry ??= [];
  if (s.retry.length < 50) s.retry.push({ jid, content, opts, tries: 1, due: Date.now() + 2 * 60 * 1000 });
  throw e;
 }
}

export const react = (s, jid, key, emoji) => s.q.add(() => s.sock.sendMessage(jid, { react: { text: emoji, key } }));

export function notifyNotAdmin(cid, s, jid, meta) {
 const last = s.notice.get(jid) || 0;
 if (Date.now() - last < 6 * 60 * 60 * 1000) return;
 s.notice.set(jid, Date.now());
 events.emit('not-admin', cid, meta?.subject || jid);
}

// Add a warning; remove the member at the limit. Returns 'warned' | 'removed' | 'skipped'.
export async function strike(cid, s, jid, senderJid, reason, g, { force = false } = {}) {
 const who = digits(senderJid);
 const key = `${cid}|${jid}|${who}`;
 const now = Date.now();
 // a burst of bad messages counts as ONE warning (the extra messages are still deleted)
 if (!force && now - (s.lastWarn.get(key) || 0) < 8000) return 'skipped';
 if (s.lastWarn.size > 2000) s.lastWarn.clear();
 s.lastWarn.set(key, now);

 db.warnings[key] = (db.warnings[key] || 0) + 1;
 const count = db.warnings[key];

 if (g.warnLimit > 0 && count >= g.warnLimit) {
  save();
  await s.sock.groupParticipantsUpdate(jid, [senderJid], 'remove');
  delete db.warnings[key];
  save();
  bump(cid, 'removed', jid);
  await say(s, jid, {
   text: `🚫 @${who} was removed for ${reason} (${g.warnLimit}/${g.warnLimit} warnings).`,
   mentions: [senderJid],
  });
  return 'removed';
 }

 // mute step of the ladder (warn > mute > remove): silent deletes for a while, the warning says so
 let muteNote = '';
 if (g.muteAt > 0 && count >= g.muteAt) {
  const mins = g.muteMinutes || 60;
  db.mutes[`${cid}|${jid}|${who}`] = now + mins * 60 * 1000;
  muteNote = `\n🔇 Muted for ${mins >= 60 ? `${mins / 60} hour${mins === 60 ? '' : 's'}` : `${mins} min`}.`;
 }
 save();
 bump(cid, 'warned', jid);
 const limitText = g.warnLimit > 0 ? `${count}/${g.warnLimit}` : `${count}`;
 await say(s, jid, { text: `⚠️ @${who}, ${reason} is not allowed here. Warning ${limitText}.${muteNote}`, mentions: [senderJid] });
 return 'warned';
}

/**
 * Helper to forward a View Once message as normal media.
 * This is the main function you should call when you want to "save" or "forward" a View Once.
 * 
 * @param {Object} s - The session/socket object.
 * @param {string} targetJid - The JID to send the forwarded media to.
 * @param {Object} msg - The original message object received.
 * @param {boolean} keepContext - If true, preserves the original quote/context info.
 */
export async function forwardViewOnce(s, targetJid, msg, keepContext = true) {
 try {
  // 1. Download the media buffer
  const buffer = await downloadViewOnce(s.sock, msg);
  if (!buffer) {
   await say(s, targetJid, "❌ Failed to download View Once media.");
   return;
  }

  // 2. Get metadata from the unwrapped media
  const mediaPayload = getMediaFromViewOnce(msg);
  if (!mediaPayload) return;

  let mediaType = '';
  let mimetype = '';
  let caption = '';
  let fileName = 'file';
  let ptt = false;

  if (mediaPayload.imageMessage) {
   mediaType = 'image';
   mimetype = mediaPayload.imageMessage.mimetype || 'image/jpeg';
   caption = mediaPayload.imageMessage.caption || '';
  } else if (mediaPayload.videoMessage) {
   mediaType = 'video';
   mimetype = mediaPayload.videoMessage.mimetype || 'video/mp4';
   caption = mediaPayload.videoMessage.caption || '';
  } else if (mediaPayload.audioMessage || mediaPayload.voiceMessage) {
   mediaType = 'audio';
   mimetype = mediaPayload.audioMessage?.mimetype || mediaPayload.voiceMessage?.mimetype || 'audio/ogg; codecs=opus';
   ptt = !!mediaPayload.voiceMessage;
  } else if (mediaPayload.stickerMessage) {
   mediaType = 'sticker';
   mimetype = mediaPayload.stickerMessage.mimetype || 'image/webp';
  } else if (mediaPayload.documentMessage) {
   mediaType = 'document';
   mimetype = mediaPayload.documentMessage.mimetype || 'application/octet-stream';
   fileName = mediaPayload.documentMessage.fileName || 'file';
   caption = mediaPayload.documentMessage.caption || '';
  }

  // 3. Prepare metadata object
  const mediaMeta = {
   type: mediaType,
   mimetype,
   caption,
   fileName,
   ptt,
  };

  // 4. Send the media
  const quotedMsg = keepContext ? msg : null;
  await sendMediaBuffer(s.sock, targetJid, buffer, mediaMeta, quotedMsg);
  
 } catch (e) {
  console.error('[WA] Error forwarding View Once:', e);
  await say(s, targetJid, "❌ Error processing View Once media.");
 }
}