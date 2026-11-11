// Runs the real guard + commands against a fake WhatsApp socket.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'guard-')));
const { initStore, db } = await import('../src/store.js');
const { handle } = await import('../src/guard.js');
const { SendQueue } = await import('../src/queue.js');
const { FloodTracker } = await import('../src/rules.js');
const { events, strike } = await import('../src/wa.js');
await initStore();

const BOT = '1000';
const ADMIN = '2000';
const MEMBER = '3000';
const GROUP = '999@g.us';

function setup({ botAdmin = true, guard = {} } = {}) {
  const sent = [];
  const calls = [];
  const sock = {
    user: { id: `${BOT}:1@s.whatsapp.net` },
    groupMetadata: async () => ({
      subject: 'Test group',
      participants: [
        { id: `${BOT}@s.whatsapp.net`, admin: botAdmin ? 'admin' : null },
        { id: `${ADMIN}@s.whatsapp.net`, admin: 'admin' },
        { id: `${MEMBER}@s.whatsapp.net`, admin: null },
      ],
    }),
    sendMessage: async (jid, content) => (sent.push(content), {}),
    groupParticipantsUpdate: async (...a) => calls.push(['participants', ...a]),
    groupSettingUpdate: async (...a) => calls.push(['setting', ...a]),
    groupInviteCode: async () => 'CODE123',
  };
  const s = { sock, meta: new Map(), notice: new Map(), q: new SendQueue({ min: 0, max: 0 }), flood: new FloodTracker(), lastWarn: new Map(), cool: new Map(), startedAt: Date.now(), bw: null };
  db.customers.c1 = { id: 'c1', number: BOT, status: 'connected', guard: { blockAllLinks: true, maxMentions: 5, warnLimit: 3, adminsAllowed: true, floodLimit: 0, maxLength: 0, maxEmoji: 0, blockForwards: false, blockStatusMention: false, blockMedia: {}, badWordsOn: false, commands: true, prefix: '.', allowed: [], badWords: [], ...guard } };
  db.warnings = {};
  return { s, sent, calls };
}
const msg = (who, message, extra = {}) => ({ key: { remoteJid: GROUP, participant: `${who}@s.whatsapp.net`, id: 'M' + Math.random(), fromMe: false }, message, messageTimestamp: Math.floor(Date.now() / 1000), ...extra });
const text = (t) => ({ conversation: t });
const deleted = (sent) => sent.filter((x) => x.delete);

test('link from member: deleted + warned; admin exempt', async () => {
  const { s, sent } = setup();
  await handle('c1', s, msg(ADMIN, text('see https://example.com')));
  assert.equal(sent.length, 0);
  await handle('c1', s, msg(MEMBER, text('see https://example.com')));
  assert.equal(deleted(sent).length, 1);
  assert.match(sent.at(-1).text, /Warning 1\/3/);
});

test('three strikes removes the member', async () => {
  const { s, calls } = setup();
  for (let i = 0; i < 3; i++) {
    await handle('c1', s, msg(MEMBER, text('x https://example.com')));
    s.lastWarn.clear(); // skip the 8s burst guard
  }
  assert.ok(calls.some((c) => c[0] === 'participants' && c[3] === 'remove'));
});

test('burst counts as one warning', async () => {
  const { s, sent } = setup();
  for (let i = 0; i < 5; i++) await handle('c1', s, msg(MEMBER, text('x https://example.com')));
  assert.equal(deleted(sent).length, 5);
  assert.equal(db.warnings[`c1|${GROUP}|${MEMBER}`], 1);
});

test('bot not admin: nothing posted in the group, Telegram notice event instead', async () => {
  const { s, sent } = setup({ botAdmin: false });
  const got = [];
  events.once('not-admin', (cid, name) => got.push([cid, name]));
  await handle('c1', s, msg(MEMBER, text('https://example.com')));
  assert.equal(sent.length, 0);
  assert.deepEqual(got, [['c1', 'Test group']]);
});

test('new rules are off by default (existing behaviour unchanged)', async () => {
  const { s, sent } = setup();
  await handle('c1', s, msg(MEMBER, text('😀'.repeat(50) + ' ' + 'a'.repeat(5000))));
  assert.equal(sent.length, 0);
});

test('flood, bad word, media, status mention', async () => {
  let { s, sent } = setup({ guard: { floodLimit: 3 } });
  for (let i = 0; i < 5; i++) await handle('c1', s, msg(MEMBER, text('hi ' + i)));
  assert.equal(deleted(sent).length, 2);

  ({ s, sent } = setup({ guard: { badWordsOn: true, badWords: ['fuck'] } }));
  await handle('c1', s, msg(MEMBER, text('f.u.c.k')));
  assert.equal(deleted(sent).length, 1);

  ({ s, sent } = setup({ guard: { blockMedia: { sticker: true } } }));
  await handle('c1', s, msg(MEMBER, { stickerMessage: {} }));
  assert.equal(deleted(sent).length, 1);

  ({ s, sent } = setup({ guard: { blockStatusMention: true } }));
  await handle('c1', s, msg(MEMBER, { groupStatusMentionMessage: { message: {} } }));
  assert.equal(deleted(sent).length, 1);
});

test('allowed numbers are exempt', async () => {
  const { s, sent } = setup({ guard: { allowed: [MEMBER] } });
  await handle('c1', s, msg(MEMBER, text('https://example.com')));
  assert.equal(sent.length, 0);
});

test('commands: member menu works, admin commands ignored for members', async () => {
  const { s, sent, calls } = setup();
  await handle('c1', s, msg(MEMBER, text('.menu')));
  assert.match(sent[0].text, /Group Guard/);
  await handle('c1', s, msg(MEMBER, text('.close')));
  assert.equal(calls.length, 0);
});

test('commands: admin close / link / tagall / kick', async () => {
  const { s, sent, calls } = setup();
  await handle('c1', s, msg(ADMIN, text('.close')));
  assert.deepEqual(calls[0], ['setting', GROUP, 'announcement']);
  await handle('c1', s, msg(ADMIN, text('.link')));
  assert.match(sent.at(-1).text, /chat\.whatsapp\.com\/CODE123/);
  await handle('c1', s, msg(ADMIN, text('.tagall hello')));
  assert.equal(sent.at(-1).mentions.length, 3);
  await handle('c1', s, msg(ADMIN, { extendedTextMessage: { text: '.kick @3000', contextInfo: { mentionedJid: [`${MEMBER}@s.whatsapp.net`] } } }));
  assert.deepEqual(calls.at(-1), ['participants', GROUP, [`${MEMBER}@s.whatsapp.net`], 'remove']);
});

test('commands: cannot kick an admin; owner (fromMe) can run commands', async () => {
  const { s, sent, calls } = setup();
  await handle('c1', s, msg(ADMIN, { extendedTextMessage: { text: '.kick @2000', contextInfo: { mentionedJid: [`${ADMIN}@s.whatsapp.net`] } } }));
  assert.equal(calls.length, 0);
  assert.match(sent.at(-1).text, /can't remove an admin/);
  const own = msg(BOT, text('.alive'));
  own.key.fromMe = true;
  await handle('c1', s, own);
  assert.match(sent.at(-1).text, /online/);
});

test('commands: admin command with bot not admin reacts and notifies', async () => {
  const { s, sent, calls } = setup({ botAdmin: false });
  await handle('c1', s, msg(ADMIN, text('.close')));
  assert.equal(calls.length, 0);
  assert.equal(sent[0].react?.text, '⚠️');
});

test('commands can be turned off; custom prefix', async () => {
  let { s, sent } = setup({ guard: { commands: false } });
  await handle('c1', s, msg(MEMBER, text('.menu')));
  assert.equal(sent.length, 0);
  ({ s, sent } = setup({ guard: { prefix: '!' } }));
  await handle('c1', s, msg(MEMBER, text('.menu')));
  assert.equal(sent.length, 0);
  await handle('c1', s, msg(MEMBER, text('!ping')));
  assert.match(sent[0].text, /Pong/);
});

test('warn / warnings / resetwarn', async () => {
  const { s, sent } = setup();
  const tag = (t) => msg(ADMIN, { extendedTextMessage: { text: t, contextInfo: { mentionedJid: [`${MEMBER}@s.whatsapp.net`] } } });
  await handle('c1', s, tag('.warn @3000 spamming'));
  assert.match(sent.at(-1).text, /spamming is not allowed here\. Warning 1\/3/);
  await handle('c1', s, tag('.warnings @3000'));
  assert.match(sent.at(-1).text, /1\/3/);
  await handle('c1', s, tag('.resetwarn @3000'));
  assert.equal(db.warnings[`c1|${GROUP}|${MEMBER}`], undefined);
});

test('view-once messages are not unwrapped, copied, or forwarded', async () => {
  const { s, sent, calls } = setup({ guard: { blockMedia: { image: true } } });
  await handle('c1', s, msg(MEMBER, { viewOnceMessage: { message: { imageMessage: { caption: 'private' } } } }));
  assert.equal(sent.length, 0);
  assert.equal(calls.length, 0);
});

test('a failed removal preserves the warning count for a later retry', async () => {
  const { s } = setup({ guard: { warnLimit: 1 } });
  s.sock.groupParticipantsUpdate = async () => { throw new Error('not an admin'); };
  await assert.rejects(
    strike('c1', s, GROUP, `${MEMBER}@s.whatsapp.net`, 'breaking a rule', db.customers.c1.guard),
    /not an admin/
  );
  assert.equal(db.warnings[`c1|${GROUP}|${MEMBER}`], 1);
});
