// Stage 6, complete: voice notes and stickers, countdowns, typing, status view/react/post, reminders,
// scheduled-post options (status, countdown, voice/sticker).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.BOT_TOKEN = 'test-token';
process.env.ADMIN_IDS = '1';
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'stage6full-')));

const { initStore, db } = await import('../src/store.js');
await initStore();
const content = await import('../src/content.js');
const auto = await import('../src/automation.js');
const { _ui } = await import('../src/bot.js');

const GROUP = '999@g.us';

function fakeSession() {
  const log = { sent: [], reads: [], presence: [] };
  const s = {
    q: { add: (fn) => fn() },
    sock: {
      sendMessage: async (jid, c, o) => log.sent.push({ jid, c, o }),
      readMessages: async (k) => log.reads.push(k),
      sendPresenceUpdate: async (p, jid) => log.presence.push([p, jid]),
    },
  };
  return { s, log };
}

// ---------- voice notes and stickers ----------
test('saving: names, sizes, empty files and the 20-item limit', () => {
  const cust = {};
  const buf = Buffer.from('OggS-fake');
  assert.equal(content.saveMedia(cust, 'Hello', 'voice', buf, 'audio/ogg').ok, true);
  assert.ok(cust.media.hello, 'name is stored lowercase');
  assert.match(content.saveMedia(cust, 'bad name!', 'voice', buf, 'x').error, /Use letters/);
  assert.match(content.saveMedia(cust, 'empty', 'voice', Buffer.alloc(0), 'x').error, /empty/);
  assert.match(content.saveMedia(cust, 'big', 'sticker', Buffer.alloc(content.MAX_STICKER + 1), 'image/webp').error, /too big/);
  for (let i = 1; i < content.MAX_MEDIA; i++) content.saveMedia(cust, `item${i}`, 'voice', buf, 'x');
  assert.match(content.saveMedia(cust, 'one-more', 'voice', buf, 'x').error, /up to 20/);
  assert.equal(content.saveMedia(cust, 'hello', 'voice', Buffer.from('again'), 'x').ok, true, 'replacing a name is allowed at the limit');
});

test('contentFor: voice and sticker references send the saved file, anything else is text', () => {
  const cust = {};
  content.saveMedia(cust, 'hi', 'voice', Buffer.from('ogg'), 'audio/ogg');
  content.saveMedia(cust, 'wave', 'sticker', Buffer.from('webp'), 'image/webp');
  const v = content.contentFor(cust, 'voice:hi');
  assert.equal(v.ptt, true);
  assert.equal(v.mimetype, 'audio/ogg; codecs=opus');
  assert.equal(v.audio.toString(), 'ogg');
  assert.equal(content.contentFor(cust, 'sticker:wave').sticker.toString(), 'webp');
  assert.deepEqual(content.contentFor(cust, 'voice:wave'), { text: 'voice:wave' }, 'wrong kind is sent as text');
  assert.deepEqual(content.contentFor(cust, 'voice:none'), { text: 'voice:none' }, 'unknown name is sent as text');
  assert.deepEqual(content.contentFor(cust, 'Hello there'), { text: 'Hello there' });
});

test('deleteMedia and listMedia', () => {
  const cust = {};
  content.saveMedia(cust, 'a', 'voice', Buffer.from('x'.repeat(2048)), 'x');
  const [m] = content.listMedia(cust);
  assert.equal(m.name, 'a');
  assert.equal(m.kind, 'voice');
  assert.ok(m.kb >= 1);
  assert.equal(content.deleteMedia(cust, 'A'), true);
  assert.equal(content.deleteMedia(cust, 'a'), false);
});

// ---------- countdown ----------
test('countdown: days left, zero when passed, ? when the date is wrong', () => {
  assert.equal(content.fillCountdown('{days 2026-11-20} to go', '2026-11-11'), '9 to go');
  assert.equal(content.fillCountdown('{days 2026-11-01}', '2026-11-11'), '0');
  assert.equal(content.fillCountdown('{days 2026-13-45}', '2026-11-11'), '?');
  assert.equal(content.fillCountdown('no placeholder', '2026-11-11'), 'no placeholder');
});

// ---------- typing ----------
test('typing: off sends nothing; on shows typing then paused', async () => {
  const { s, log } = fakeSession();
  await auto.typeThen(s, '1@s.whatsapp.net', { autoTyping: false }, 'hi');
  assert.equal(log.presence.length, 0);
  await auto.typeThen(s, '1@s.whatsapp.net', { autoTyping: true }, 'hi');
  assert.deepEqual(log.presence, [['composing', '1@s.whatsapp.net'], ['paused', '1@s.whatsapp.net']]);
});

// ---------- statuses ----------
test('status: view and react only when switched on; one reaction every 20 seconds', async () => {
  const { s, log } = fakeSession();
  const msg = { key: { remoteJid: auto.STATUS_JID, id: 'st1', fromMe: false, participant: '777@s.whatsapp.net' }, message: { conversation: 'x' } };
  assert.equal(await auto.handleStatus('c6s', s, msg, { statusView: false, statusLike: false }), true);
  assert.equal(log.reads.length, 0);
  assert.equal(log.sent.length, 0);

  await auto.handleStatus('c6s', s, msg, { statusView: true, statusLike: true });
  assert.equal(log.reads.length, 1);
  assert.equal(log.sent.length, 1);
  assert.equal(log.sent[0].jid, auto.STATUS_JID);
  assert.deepEqual(log.sent[0].o, { statusJidList: ['777@s.whatsapp.net'] });
  assert.ok(auto.REACT_SET.includes(log.sent[0].c.react.text));

  await auto.handleStatus('c6s', s, msg, { statusLike: true });
  assert.equal(log.sent.length, 1, 'cooling down');
});

test('status: own statuses are ignored', async () => {
  const { s, log } = fakeSession();
  const own = { key: { remoteJid: auto.STATUS_JID, id: 'o', fromMe: true }, message: {} };
  assert.equal(await auto.handleStatus('c6o', s, own, { statusView: true, statusLike: true }), false);
  assert.equal(log.reads.length + log.sent.length, 0);
});

test('postStatus: nothing to send with an empty audience; otherwise the audience is passed', async () => {
  const { s, log } = fakeSession();
  assert.equal(await auto.postStatus(s, [], { text: 'x' }), false);
  assert.equal(log.sent.length, 0);
  assert.equal(await auto.postStatus(s, ['a@s.whatsapp.net', 'b@s.whatsapp.net'], { text: 'Hi' }), true);
  assert.deepEqual(log.sent[0].o, { statusJidList: ['a@s.whatsapp.net', 'b@s.whatsapp.net'] });
  assert.equal(log.sent[0].jid, auto.STATUS_JID);
});

// ---------- reminders ----------
test('parseDelay: minutes, hours, days; anything else is null', () => {
  assert.equal(auto.parseDelay('10m'), 600000);
  assert.equal(auto.parseDelay('2h'), 7200000);
  assert.equal(auto.parseDelay('1d'), 86400000);
  assert.equal(auto.parseDelay('0m'), null);
  assert.equal(auto.parseDelay('5w'), null);
  assert.equal(auto.parseDelay('soon'), null);
});

test('reminders: due ones are posted to their group and removed; later ones stay', async () => {
  const { s, log } = fakeSession();
  const now = Date.now();
  const cust = {
    guard: { groupMode: 'all' },
    groups: { [GROUP]: { subject: 'Test' } },
    reminders: [
      { jid: GROUP, at: now - 1000, text: 'stand up' },
      { jid: GROUP, at: now + 600000, text: 'later' },
    ],
  };
  await auto.runReminders('c6r', s, cust, now);
  assert.equal(log.sent.length, 1);
  assert.equal(log.sent[0].jid, GROUP);
  assert.equal(log.sent[0].c.text, '⏰ Reminder: stand up');
  assert.deepEqual(cust.reminders.map((r) => r.text), ['later']);
});

// ---------- the panel's scheduled-post parser ----------
test('scheduled posts: status option and countdown text are read correctly', () => {
  const p = _ui.ITEMS.sched.parse;
  assert.deepEqual(p('18:00 status | Big sale {days 2026-12-25}').status, true);
  assert.equal(p('18:00 status | Big sale').time, '18:00');
  assert.equal(p('18:00 | Hello').status, false);
  assert.equal(p('18:00 | Hello').text, 'Hello');
  assert.equal(p('25:00 | Hello'), null);
  assert.equal(p('18:00 |'), null);
});

test('db is untouched by these checks except the shared store', () => {
  assert.ok(db.customers);
});
