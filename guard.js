// WhatsApp side: one Baileys session per customer. The guard rules use the customer's own settings.
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import fs from 'fs';
import { EventEmitter } from 'events';
import { db, save } from './store.js';

// events: 'pairing-code'(cid, code) 'pairing-failed'(cid, why) 'open'(cid) 'logged-out'(cid)
export const events = new EventEmitter();
const sessions = new Map();
const authDir = (cid) => `./auth/${cid}`;

// ---------- helpers ----------
const digits = (jid) => String(jid || '').split('@')[0].split(':')[0].replace(/\D/g, '');

const INVITE_RE = /chat\.whatsapp\.com\/\S+/i;
const LINK_RE =
  /(https?:\/\/|www\.)\S+|(?:^|\s)[a-z0-9-]{3,}\.(com|net|org|io|ly|link|xyz|info|site|shop|store|online|app|dev|tv|gg|cc|biz|click|top|vip|live|club)(\/\S*)?(?=\s|$)/i;

function unwrap(message) {
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

const getText = (c) =>
  c.conversation ||
  c.extendedTextMessage?.text ||
  c.imageMessage?.caption ||
  c.videoMessage?.caption ||
  c.documentMessage?.caption ||
  '';

function getContext(c) {
  for (const v of Object.values(c)) if (v && typeof v === 'object' && v.contextInfo) return v.contextInfo;
  return null;
}

const participantDigits = (p) => [p.id, p.lid, p.phoneNumber, p.jid].filter(Boolean).map(digits);

function isAdminOf(meta, idList) {
  const wanted = new Set(idList.filter(Boolean).map(digits));
  return meta.participants.some(
    (p) => (p.admin === 'admin' || p.admin === 'superadmin') && participantDigits(p).some((d) => wanted.has(d))
  );
}

async function getMeta(s, jid) {
  const c = s.meta.get(jid);
  if (c && Date.now() - c.t < 5 * 60 * 1000) return c.m;
  const m = await s.sock.groupMetadata(jid);
  s.meta.set(jid, { m, t: Date.now() });
  return m;
}

// ---------- guard rules ----------
async function handle(cid, s, msg) {
  const sock = s.sock;
  const cust = db.customers[cid];
  if (!cust) return;
  const g = cust.guard;

  const jid = msg.key.remoteJid;
  if (!jid || !jid.endsWith('@g.us') || msg.key.fromMe || !msg.message) return;

  let content = unwrap(msg.message);
  let targetKey = msg.key;

  // Someone edited a message: check the new text and delete the original
  const proto = content.protocolMessage;
  if (proto) {
    if (proto.editedMessage && proto.key?.id) {
      content = unwrap(proto.editedMessage);
      targetKey = { remoteJid: jid, id: proto.key.id, fromMe: false, participant: msg.key.participant };
    } else return;
  }

  const text = getText(content);
  const ctx = getContext(content);
  const mentionCount = ctx?.mentionedJid?.length || 0;

  const hasInvite = INVITE_RE.test(text);
  const hasLink = g.blockAllLinks && LINK_RE.test(text);
  const tooManyMentions = g.maxMentions > 0 && mentionCount > g.maxMentions;
  if (!hasInvite && !hasLink && !tooManyMentions) return;

  const senderIds = [msg.key.participant, msg.key.participantAlt, msg.participant].filter(Boolean);
  if (!senderIds.length) return;
  const senderJid = senderIds[0];

  const allowed = new Set((g.allowed || []).map(String));
  if (senderIds.some((id) => allowed.has(digits(id)))) return;

  const meta = await getMeta(s, jid);

  if (!isAdminOf(meta, [sock.user?.id, sock.user?.lid])) {
    const last = s.notice.get(jid) || 0;
    if (Date.now() - last > 60 * 60 * 1000) {
      s.notice.set(jid, Date.now());
      await sock.sendMessage(jid, { text: '⚠️ Please make me a group admin so I can delete links.' });
    }
    return;
  }

  if (g.adminsAllowed && isAdminOf(meta, senderIds)) return;

  // 1) delete (if the delete fails, do not warn)
  try {
    await sock.sendMessage(jid, { delete: targetKey });
  } catch (e) {
    console.error(`[${cid}] delete failed:`, e.message);
    return;
  }

  // 2) warn, remove after the limit
  const who = digits(senderJid);
  const key = `${cid}|${jid}|${who}`;
  db.warnings[key] = (db.warnings[key] || 0) + 1;
  const count = db.warnings[key];
  const reason = tooManyMentions && !hasInvite && !hasLink ? 'tagging too many people' : 'sending links';

  if (g.warnLimit > 0 && count >= g.warnLimit) {
    delete db.warnings[key];
    save();
    await sock.sendMessage(jid, {
      text: `🚫 @${who} was removed for ${reason} (${g.warnLimit}/${g.warnLimit} warnings).`,
      mentions: [senderJid],
    });
    await sock.groupParticipantsUpdate(jid, [senderJid], 'remove');
  } else {
    save();
    const limitText = g.warnLimit > 0 ? `${count}/${g.warnLimit}` : `${count}`;
    await sock.sendMessage(jid, {
      text: `⚠️ @${who}, ${reason} is not allowed here. Warning ${limitText}.`,
      mentions: [senderJid],
    });
  }
}

// ---------- connection ----------
async function connect(cid, s) {
  const { state, saveCreds } = await useMultiFileAuthState(authDir(cid));
  const { version } = await fetchLatestBaileysVersion();
  if (s.stopped) return;

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['Ubuntu', 'Chrome', '120.0.0'],
    markOnlineOnConnect: false,
  });
  s.sock = sock;
  sock.ev.on('creds.update', saveCreds);

  if (!state.creds.registered && s.pairNumber && !s.pairRequested) {
    s.pairRequested = true;
    setTimeout(async () => {
      if (s.stopped) return;
      try {
        const code = await sock.requestPairingCode(s.pairNumber);
        events.emit('pairing-code', cid, code);
        s.pairTimer = setTimeout(() => {
          if (!s.stopped && !sock.authState.creds.registered) {
            stopSession(cid, { wipe: true });
            events.emit('pairing-failed', cid, 'expired');
          }
        }, 3 * 60 * 1000);
      } catch (e) {
        stopSession(cid, { wipe: true });
        events.emit('pairing-failed', cid, e.message);
      }
    }, 3000);
  }

  sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (s.stopped || s.sock !== sock) return;
    if (connection === 'open') {
      clearTimeout(s.pairTimer);
      s.pairNumber = null;
      events.emit('open', cid);
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        stopSession(cid, { wipe: true });
        events.emit('logged-out', cid);
        return;
      }
      // still waiting for the customer to enter the code: the pairing timer handles failure
      if (!sock.authState.creds.registered) return;
      setTimeout(() => {
        if (!s.stopped && s.sock === sock) connect(cid, s).catch((e) => console.error(`[${cid}] reconnect:`, e.message));
      }, 3000);
    }
  });

  sock.ev.on('group-participants.update', ({ id }) => s.meta.delete(id));
  sock.ev.on('groups.update', (u) => u.forEach((x) => x.id && s.meta.delete(x.id)));

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      try {
        await handle(cid, s, msg);
      } catch (e) {
        console.error(`[${cid}] error:`, e.message);
      }
    }
  });
}

export async function startSession(cid, { pairNumber } = {}) {
  cid = String(cid);
  if (sessions.has(cid)) await stopSession(cid);
  const s = { stopped: false, sock: null, meta: new Map(), notice: new Map(), pairNumber, pairRequested: false, pairTimer: null };
  sessions.set(cid, s);
  await connect(cid, s);
}

export async function stopSession(cid, { wipe = false, logout = false } = {}) {
  cid = String(cid);
  const s = sessions.get(cid);
  if (s) {
    s.stopped = true;
    clearTimeout(s.pairTimer);
    if (logout) {
      try {
        await s.sock?.logout();
      } catch {}
    }
    try {
      s.sock?.end(undefined);
    } catch {}
    sessions.delete(cid);
  }
  if (wipe) fs.rmSync(authDir(cid), { recursive: true, force: true });
}

export const isRunning = (cid) => sessions.has(String(cid));

// start every customer that was connected before a restart
export async function startAll() {
  for (const c of Object.values(db.customers)) {
    if (c.status === 'pairing') {
      c.status = c.everConnected ? 'disconnected' : 'none';
      if (!c.everConnected) c.number = null;
      save();
    }
    if (c.status === 'connected') {
      try {
        await startSession(c.id);
      } catch (e) {
        console.error(`[${c.id}] could not start:`, e.message);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}
