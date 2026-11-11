// WhatsApp side: one Baileys session per customer. The guard rules use the customer's own settings.
import makeWASocket, { DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import pino from 'pino';
import { db, save, ensureShape, addLog, markDirty } from './store.js';
import { bump } from './stats.js';
import { reportError } from './alerts.js';
import { maxGroups, mayUse, protectedGroups, DAY } from './plans.js';
import { getAuth, wipeAuth } from './auth.js';
import { events, digits, unwrap, getText, getContext, isAdminOf, getMeta, notifyNotAdmin, strike, say } from './wa.js';
import { detect, kindOf, buildBadWords, FloodTracker } from './rules.js';
import { hasPhoneNumber, countryBlocked, inNight, accountHealth, WindowCounter, SlowTracker } from './checks.js';
import { SendQueue } from './queue.js';
import { tryCommand } from './commands.js';
import { runLockdown } from './lockdown.js';
import { handlePrivate, isPrivateJid, onMembers, runSchedules, runDaily, runSummaries } from './social.js';
import { autoReact, autoRead, presenceAndBio, handleStatus, runReminders, STATUS_JID } from './automation.js';

export { events };
const sessions = new Map();
const RAID_JOINS = 10; // joins inside one minute that count as a raid
const THREAT_DELETES = 20; // deletes inside ten minutes that alert the customer

// The sessions and trackers are created in startSession. Tests build their own, so fill in whatever is missing.
function initSession(s) {
  s.meta ??= new Map();
  s.notice ??= new Map();
  s.q ??= new SendQueue();
  s.flood ??= new FloodTracker();
  s.lastWarn ??= new Map();
  s.cool ??= new Map();
  s.slow ??= new SlowTracker();
  s.spikes ??= new WindowCounter(10 * 60 * 1000);
  s.raids ??= new WindowCounter(60 * 1000);
  s.recent ??= new Map();
  s.nightState ??= new Map();
  s.failTimes ??= [];
  s.drops ??= [];
  s.retry ??= [];
}

// WhatsApp tells the group when someone tags it in their status: it arrives as one of these
const isStatusMention = (c) =>
  Boolean(c.groupStatusMentionMessage || c.statusMentionMessage) ||
  c.protocolMessage?.type === 25 ||
  c.protocolMessage?.type === 'STATUS_MENTION_MESSAGE';

function isViewOnce(message) {
  let content = message;
  for (let i = 0; i < 5 && content; i++) {
    if (content.viewOnceMessage || content.viewOnceMessageV2 || content.viewOnceMessageV2Extension) return true;
    content = content.ephemeralMessage?.message || content.documentWithCaptionMessage?.message || content.editedMessage?.message;
  }
  return false;
}

const botIds = (s) => [s.sock?.user?.id, s.sock?.user?.lid];

const groupName = (cust, s, jid) => cust.groupList?.[jid]?.name || cust.groups?.[jid]?.name || s?.meta?.get(jid)?.m?.subject || jid;

// ---------- group tracking + plan limit ----------
// 'allowed' mode: only groups the customer added with an invite link (and not paused).
// 'all' mode: groups are remembered in the order they were first seen. A plan that allows N groups protects the first N.
async function groupAllowed(cid, cust, s, jid) {
  ensureShape(cust);
  if (cust.groupList[jid]?.paused) return false;
  if (cust.guard.groupMode === 'allowed') return Boolean(cust.groupList[jid]);

  let grp = cust.groups[jid];
  if (!grp) {
    grp = cust.groups[jid] = { name: '', first: Date.now(), last: Date.now(), msgs: 0 };
    try {
      grp.name = (await getMeta(s, jid)).subject || '';
    } catch {}
    save();
  } else if (!grp.name) {
    const m = s.meta?.get(jid)?.m;
    if (m?.subject) grp.name = m.subject;
  }
  const limit = maxGroups(cust);
  if (limit > 0 && Object.keys(cust.groups).indexOf(jid) >= limit) {
    const k = `limit|${jid}`;
    if (Date.now() - (s.notice.get(k) || 0) > 6 * 60 * 60 * 1000) {
      s.notice.set(k, Date.now());
      events.emit('group-limit', cid, grp.name || jid, limit);
    }
    return false;
  }
  return true;
}

// ---------- evidence, activity, removals ----------
function logEvidence(cid, jid, who, reason, text) {
  db.evidence.push({ t: Date.now(), cid, jid, who, reason, text: String(text || '').slice(0, 120) });
  if (db.evidence.length > 300) db.evidence.splice(0, db.evidence.length - 300);
  markDirty();
}

// Who talks how much (for .inactive and .topmembers), and the last messages (for .purge).
function noteActivity(cid, s, jid, msg) {
  const who = digits(msg.key.participant || msg.key.participantAlt || '');
  if (!who) return;
  const act = (db.activity[`${cid}|${jid}`] ||= {});
  const e = (act[who] ||= { n: 0, t: 0 });
  e.n++;
  e.t = Date.now();
  markDirty();
  const arr = s.recent.get(jid) || [];
  arr.push({ key: msg.key, who });
  if (arr.length > 60) arr.shift();
  s.recent.set(jid, arr);
}

// Delete a message and record it. Returns false if the delete failed (then nothing else is done).
async function deleteMsg(cid, s, jid, key, senderJid, reason, text) {
  try {
    await s.sock.sendMessage(jid, { delete: key });
  } catch (e) {
    console.error(`[${cid}] delete failed:`, e.message);
    return false;
  }
  bump(cid, 'deleted', jid);
  logEvidence(cid, jid, digits(senderJid), reason, text);
  return true;
}

async function removeMember(cid, s, jid, senderJid, why) {
  await s.sock.groupParticipantsUpdate(jid, [senderJid], 'remove');
  bump(cid, 'removed', jid);
  logEvidence(cid, jid, digits(senderJid), `removed for ${why}`, '');
  await say(s, jid, { text: `🚫 @${digits(senderJid)} was removed for ${why}.`, mentions: [senderJid] });
}

// Many deletes in a short time: tell the customer once per burst.
function noteDelete(cid, s, jid) {
  const n = s.spikes.add(jid);
  if (n === THREAT_DELETES) events.emit('threat', cid, groupName(db.customers[cid], s, jid), n);
}

export async function handle(cid, s, msg) {
  initSession(s);

  // Respect view-once: do not unwrap, persist, or forward restricted media.
  if (isViewOnce(msg?.message)) return;

  const cust = db.customers[cid];
  if (!cust) return;
  ensureShape(cust);
  const g = cust.guard;

  const jid = msg.key.remoteJid;
  if (jid === STATUS_JID) {
    if (mayUse(cust)) await handleStatus(cid, s, msg, g).catch(() => {});
    return;
  }
  if (isPrivateJid(jid)) {
    if (!msg.message || msg.key.fromMe) return;
    if (mayUse(cust)) {
      await autoRead(s, msg, g).catch(() => {});
      await autoReact(cid, s, msg, g).catch(() => {});
    }
    return handlePrivate(cid, s, msg);
  }
  if (!jid || !jid.endsWith('@g.us') || !msg.message) return;

  // paused, expired or blocked customers get no protection (their session is normally stopped already)
  if (cust.status === 'suspended' || cust.status === 'expired' || cust.status === 'banned' || !mayUse(cust)) return;

  s.lastMsgAt = Date.now();
  if (!(await groupAllowed(cid, cust, s, jid))) return;
  if (!msg.key.fromMe) bump(cid, 'msgs', jid);
  noteActivity(cid, s, jid, msg);
  await autoRead(s, msg, g).catch(() => {});
  await autoReact(cid, s, msg, g).catch(() => {});

  let content = unwrap(msg.message);

  // 1) commands (group admins and the bot's own number)
  if (g.commands && (await tryCommand(cid, s, msg, content, getText(content), g))) {
    bump(cid, 'cmds', jid);
    return;
  }
  if (msg.key.fromMe) return;

  // 2) guard rules
  let targetKey = msg.key;
  let statusMention = isStatusMention(content);
  const pm = content.protocolMessage;
  if (pm && !statusMention) {
    // someone edited a message: check the new text and delete the original
    if (pm.editedMessage && pm.key?.id) {
      content = unwrap(pm.editedMessage);
      targetKey = { remoteJid: jid, id: pm.key.id, fromMe: false, participant: msg.key.participant };
    } else return;
  }

  const senderIds = [msg.key.participant, msg.key.participantAlt, msg.participant].filter(Boolean);
  if (!senderIds.length) return;
  const senderJid = senderIds[0];
  const who = digits(senderJid);

  // 3) blacklist and mute come first (admins are exempt)
  const blacklisted = senderIds.some((id) => (g.blacklist || []).includes(digits(id)));
  const muted = (db.mutes[`${cid}|${jid}|${who}`] || 0) > Date.now();
  if (blacklisted || muted) {
    const meta = await getMeta(s, jid);
    if (!isAdminOf(meta, senderIds)) {
      if (!isAdminOf(meta, botIds(s))) return notifyNotAdmin(cid, s, jid, meta);
      const reason = blacklisted ? 'blacklisted number' : 'muted member';
      if (!(await deleteMsg(cid, s, jid, targetKey, senderJid, reason, ''))) return;
      noteDelete(cid, s, jid);
      if (blacklisted) await removeMember(cid, s, jid, senderJid, 'being on the blacklist');
      return;
    }
  }

  if (!s.bw || s.bw.key !== (g.badWords || []).join('|')) s.bw = { key: (g.badWords || []).join('|'), list: buildBadWords(g.badWords) };

  const ctx = getContext(content);
  const text = getText(content);
  const found = detect(g, {
    text,
    mentionCount: ctx?.mentionedJid?.length || 0,
    isForwarded: Boolean(ctx?.isForwarded),
    statusMention,
    kind: kindOf(content),
    flooding: g.floodLimit > 0 && s.flood.hit(`${jid}|${who}`, Date.now(), g.floodLimit),
    badWords: s.bw.list,
    phone: Boolean(g.antiNumbers) && hasPhoneNumber(text),
    slowed: g.slowMode > 0 && s.slow.hit(`${jid}|${who}`, Date.now(), g.slowMode),
  });
  if (!found) return;

  if (senderIds.some((id) => (g.allowed || []).map(String).includes(digits(id)))) return;

  const meta = await getMeta(s, jid);
  if (!isAdminOf(meta, botIds(s))) {
    notifyNotAdmin(cid, s, jid, meta); // tells the customer on Telegram, nothing is posted in the group
    return;
  }
  if (g.adminsAllowed && isAdminOf(meta, senderIds)) return;

  // delete first (if the delete fails, do not warn), then warn / mute / remove
  if (!(await deleteMsg(cid, s, jid, targetKey, senderJid, found.reason, text))) return;
  noteDelete(cid, s, jid);
  await strike(cid, s, jid, senderJid, found.reason, g);
}

// ---------- joins: blacklist, blocked countries, anti-raid ----------
async function onJoin(cid, s, jid, participants) {
  initSession(s);
  const cust = db.customers[cid];
  if (!cust || !mayUse(cust) || !protectedGroups(cust).includes(jid)) return;
  const g = cust.guard;
  const meta = await getMeta(s, jid);
  if (!isAdminOf(meta, botIds(s))) return;

  for (const p of participants) {
    const who = digits(p);
    const listed = (g.blacklist || []).includes(who);
    // only real phone numbers have a country code (WhatsApp internal ids do not)
    const blocked = String(p).endsWith('@s.whatsapp.net') && countryBlocked(who, g.blockCountries);
    if (!listed && !blocked) continue;
    if (isAdminOf(meta, [p])) continue;
    await s.q.add(() => s.sock.groupParticipantsUpdate(jid, [p], 'remove'));
    bump(cid, 'removed', jid);
    logEvidence(cid, jid, who, listed ? 'blacklisted number joined' : 'blocked country code joined', '');
  }

  if (g.antiRaid) {
    let n = 0;
    for (let i = 0; i < participants.length; i++) n = s.raids.add(jid);
    // the batch that crosses the limit closes the group once
    if (n >= RAID_JOINS && n - participants.length < RAID_JOINS) {
      await s.q.add(() => s.sock.groupSettingUpdate(jid, 'announcement'));
      s.nightState.set(jid, 'announcement');
      await say(s, jid, { text: '🚨 Many people joined at once, so the group is closed. Admins can reopen it with .open' });
      events.emit('raid', cid, groupName(cust, s, jid), n);
    }
  }
}

// ---------- night mode and timers ----------
async function runNight(cid, s, cust, now) {
  initSession(s);
  const g = cust.guard;
  if (!g.nightOn || g.lockdown || !mayUse(cust)) return;
  const want = inNight(g, now) ? 'announcement' : 'not_announcement';
  for (const jid of protectedGroups(cust)) {
    if (s.nightState.get(jid) === want) continue;
    const meta = await getMeta(s, jid).catch(() => null);
    if (!meta || !isAdminOf(meta, botIds(s))) continue;
    const updated = await s.q.add(() => s.sock.groupSettingUpdate(jid, want));
    if (updated === null) continue;
    s.nightState.set(jid, want);
    addLog('action', `night mode: ${want === 'announcement' ? 'closed' : 'opened'} ${meta.subject || jid}`, cid);
  }
}

// Failed posts are retried every few minutes. After five tries the customer is told.
async function runRetries(cid, s, now) {
  initSession(s);
  if (!s.retry.length) return;
  const due = s.retry.filter((i) => i.due <= now);
  s.retry = s.retry.filter((i) => i.due > now);
  for (const it of due) {
    const ok = await s.q.add(async () => {
      try {
        await s.sock.sendMessage(it.jid, it.content, it.opts);
        return true;
      } catch {
        return false;
      }
    });
    if (ok) continue;
    it.tries++;
    if (it.tries >= 5) {
      const meta = await getMeta(s, it.jid).catch(() => null);
      events.emit('post-failed', cid, meta?.subject || groupName(db.customers[cid], s, it.jid));
      continue;
    }
    it.due = now + it.tries * 2 * 60 * 1000;
    s.retry.push(it);
  }
}

// Customers get a short weekly summary of what the guard did (once every 7 days from their first action).
function weeklyTick(now) {
  for (const c of Object.values(db.customers)) {
    const w = c.weekly;
    if (!w || now - w.since < 7 * DAY) continue;
    const summary = { msgs: w.msgs, deleted: w.deleted, warned: w.warned, removed: w.removed };
    c.weekly = { since: now, msgs: 0, deleted: 0, warned: 0, removed: 0 };
    save();
    if (c.status === 'connected' && summary.deleted + summary.warned + summary.removed > 0) events.emit('weekly', c.id, summary);
  }
}

async function tick() {
  const now = Date.now();
  for (const [cid, s] of [...sessions]) {
    // auto-recovery: a session stuck connecting for 10 minutes is restarted (pairing has its own timer, so it is skipped)
    if (s.state === 'connecting' && !s.pairNumber) {
      s.connectingSince ??= now;
      if (now - s.connectingSince > 10 * 60 * 1000) {
        s.connectingSince = null;
        restartSession(cid).catch((e) => reportError(`watchdog ${cid}`, e));
        continue;
      }
    } else s.connectingSince = null;
    if (s.stopped || s.state !== 'open') continue;
    const cust = db.customers[cid];
    if (!cust) continue;
    try {
      await presenceAndBio(s, cust.guard);
      await runRetries(cid, s, now);
      await runNight(cid, s, cust, now);
      await runSchedules(cid, s, cust, now);
      await runReminders(cid, s, cust, now);
      await runDaily(cid, s, cust, now);
    } catch (e) {
      reportError(`timer ${cid}`, e);
    }
  }
  weeklyTick(now);
  runSummaries(now);
}
const timer = setInterval(() => tick().catch((e) => reportError('timer', e)), 60 * 1000);
timer.unref?.();

// ---------- connection ----------
// If the connection stays down for 2 minutes, tell the customer (and the owner) once.
function watchDown(cid, s, code) {
  if (s.downTimer) return;
  s.downTimer = setTimeout(() => {
    s.downTimer = null;
    if (!s.stopped && s.state !== 'open' && !s.alertedDown) {
      s.alertedDown = true;
      events.emit('disconnected', cid, code);
    }
  }, 2 * 60 * 1000);
}

async function connect(cid, s) {
  const { state, saveCreds } = await getAuth(cid);
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
    if (connection === 'connecting') s.state = 'connecting';
    if (connection === 'open') {
      s.state = 'open';
      s.openedAt = Date.now();
      clearTimeout(s.pairTimer);
      clearTimeout(s.downTimer);
      s.downTimer = null;
      s.pairNumber = null;
      if (s.alertedDown) {
        s.alertedDown = false;
        events.emit('reconnected', cid);
      }
      events.emit('open', cid);
    }
    if (connection === 'close') {
      s.state = 'closed';
      s.reconnects = (s.reconnects || 0) + 1;
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        stopSession(cid, { wipe: true });
        events.emit('logged-out', cid);
        return;
      }
      // the same login was opened somewhere else (for example during a redeploy): stop this copy
      if (code === DisconnectReason.connectionReplaced) {
        console.log(`[${cid}] session opened elsewhere, stopping this copy`);
        stopSession(cid);
        return;
      }
      // still waiting for the customer to enter the code: the pairing timer handles failure
      if (!sock.authState.creds.registered) return;
      s.drops = [...(s.drops || []), Date.now()].slice(-100);
      watchDown(cid, s, code);
      setTimeout(() => {
        if (!s.stopped && s.sock === sock) connect(cid, s).catch((e) => console.error(`[${cid}] reconnect:`, e.message));
      }, 3000);
    }
  });

  sock.ev.on('group-participants.update', (u) => {
    s.meta.delete(u.id);
    if (u.action === 'add') onJoin(cid, s, u.id, u.participants || []).catch((e) => reportError(`join ${cid}`, e));
    if (u.action === 'add' || u.action === 'remove') {
      onMembers(cid, s, u.id, u.participants || [], u.action).catch((e) => reportError(`welcome ${cid}`, e));
    }
  });
  sock.ev.on('groups.update', (u) => u.forEach((x) => x.id && s.meta.delete(x.id)));

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      try {
        await handle(cid, s, msg);
      } catch (e) {
        reportError(`customer ${cid}`, e);
      }
    }
  });
}

export async function startSession(cid, { pairNumber } = {}) {
  cid = String(cid);
  if (sessions.has(cid)) await stopSession(cid);
  const s = {
    stopped: false,
    sock: null,
    meta: new Map(),
    notice: new Map(),
    pairNumber,
    pairRequested: false,
    pairTimer: null,
    startedAt: Date.now(),
    state: 'connecting',
    openedAt: 0,
    reconnects: 0,
    lastMsgAt: 0,
    downTimer: null,
    alertedDown: false,
    q: new SendQueue(),
    flood: new FloodTracker(),
    lastWarn: new Map(),
    cool: new Map(),
    bw: null,
  };
  initSession(s);
  sessions.set(cid, s);
  await connect(cid, s);
}

export async function stopSession(cid, { wipe = false, logout = false } = {}) {
  cid = String(cid);
  const s = sessions.get(cid);
  if (s) {
    s.stopped = true;
    s.q.clear();
    clearTimeout(s.pairTimer);
    clearTimeout(s.downTimer);
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
  if (wipe) await wipeAuth(cid);
}

export const isRunning = (cid) => sessions.has(String(cid));
export const runningCount = () => sessions.size;

// Live numbers for the owner's monitor screen
export function sessionInfo(cid) {
  const s = sessions.get(String(cid));
  if (!s) return null;
  return {
    state: s.state,
    since: s.openedAt || s.startedAt,
    reconnects: s.reconnects || 0,
    queue: s.q.items.length,
    lastMsgAt: s.lastMsgAt || 0,
  };
}

// Account health for the customer (failed posts and drops in the last day)
export function sessionHealth(cid) {
  const s = sessions.get(String(cid));
  const now = Date.now();
  const recent = (arr) => (arr || []).filter((t) => now - t < DAY).length;
  return accountHealth({ failures24: recent(s?.failTimes), drops24: recent(s?.drops), queue: s?.q?.items.length || 0 });
}

export async function restartSession(cid) {
  cid = String(cid);
  await stopSession(cid);
  await startSession(cid);
}

export async function restartAll() {
  for (const id of [...sessions.keys()]) {
    try {
      await restartSession(id);
    } catch (e) {
      reportError(`restart ${id}`, e);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

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
        reportError(`start ${c.id}`, e);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

// ---------- Stage 3 actions used by the Telegram panel ----------
// Join a group with an invite link. The bot joins as a normal member: the customer must make it an admin.
export async function joinByLink(cid, code) {
  cid = String(cid);
  const cust = db.customers[cid];
  const s = sessions.get(cid);
  if (!cust) return { error: 'Account not found.' };
  if (!s || s.state !== 'open') return { error: 'Your WhatsApp is not connected right now. Check the phone, then try again.' };
  ensureShape(cust);

  const now = Date.now();
  cust.joinLog = cust.joinLog.filter((t) => now - t < 60 * 60 * 1000);
  const limit = cust.guard.joinsPerHour > 0 ? cust.guard.joinsPerHour : 5;
  if (cust.joinLog.length >= limit) return { error: `You can add up to ${limit} groups per hour. Try again later.` };

  let gid;
  try {
    gid = await s.sock.groupAcceptInvite(code);
  } catch {
    return { error: 'Could not join with that link. It may be expired or revoked.' };
  }
  if (gid && typeof gid === 'object') gid = gid.id;
  if (!gid) return { error: 'Could not join with that link.' };
  if (cust.groupList[gid]) return { error: 'That group is already in your list.' };

  cust.joinLog.push(now);
  cust.groupList[gid] = { name: '', paused: false, added: now };
  try {
    cust.groupList[gid].name = (await getMeta(s, gid)).subject || '';
  } catch {}
  save();
  addLog('action', `group added by link: ${cust.groupList[gid].name || gid}`, cid);
  return { jid: gid, name: cust.groupList[gid].name };
}

// A reply typed in Telegram goes to the WhatsApp chat of a support ticket
export async function sendToChat(cid, jid, text) {
  const s = sessions.get(String(cid));
  if (!s || s.state !== 'open') return false;
  const ok = await s.q.add(async () => {
    await s.sock.sendMessage(jid, { text });
    return true;
  });
  return Boolean(ok);
}

// Lockdown from the Telegram panel (same as the .lockdown command)
export const lockdownFromPanel = (cid, on) => runLockdown(String(cid), sessions.get(String(cid)) || null, on);

export const groupNameOf = (cid, jid) => groupName(db.customers[cid], sessions.get(String(cid)), jid);

// exposed for tests only
export const _test = { onJoin, runNight, runRetries, weeklyTick, tick, groupAllowed, noteActivity, sessions };
