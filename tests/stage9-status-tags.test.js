import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.BOT_TOKEN = 'test-token';
process.env.ADMIN_IDS = '1';
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'statustags-')));

const { initStore } = await import('../src/store.js');
await initStore();
const auto = await import('../src/automation.js');

const aud = ['255700000001@s.whatsapp.net', '255700000002@s.whatsapp.net', '255700000003@s.whatsapp.net',
  '255700000004@s.whatsapp.net', '255700000005@s.whatsapp.net', '255700000006@s.whatsapp.net', '255700000007@s.whatsapp.net'];

test('tags are capped at 5', () => {
  const t = auto.pickStatusTags(aud.map((a) => a.split('@')[0]), aud);
  assert.equal(t.length, 5);
});

test('non-members are skipped and duplicates removed', () => {
  const t = auto.pickStatusTags(['255700000001', '255700000001', '255799999999'], aud);
  assert.equal(t.length, 1);
});

test('postStatus adds mentions and keeps the audience', async () => {
  const sent = [];
  const s = { q: { add: (f) => f() }, sock: { sendMessage: async (j, c, o) => sent.push({ j, c, o }) } };
  await auto.postStatus(s, aud, { text: 'Offer today' }, ['255700000002']);
  assert.equal(sent[0].j, 'status@broadcast');
  assert.deepEqual(sent[0].c.mentions, ['255700000002@s.whatsapp.net']);
  assert.match(sent[0].c.text, /@255700000002/);
  assert.equal(sent[0].o.statusJidList.length, 7);
});

test('no tags: content unchanged', async () => {
  const sent = [];
  const s = { q: { add: (f) => f() }, sock: { sendMessage: async (j, c) => sent.push(c) } };
  await auto.postStatus(s, aud, { text: 'Hello' });
  assert.deepEqual(sent[0], { text: 'Hello' });
});

test('group tag adds groupMentions, max 2 groups', async () => {
  const sent = [];
  const s = { q: { add: (f) => f() }, sock: { sendMessage: async (j, c) => sent.push(c) } };
  await auto.postStatus(s, aud, { text: 'Hi' }, [], [
    { jid: '1@g.us', subject: 'A' }, { jid: '2@g.us', subject: 'B' }, { jid: '3@g.us', subject: 'C' },
  ]);
  assert.equal(sent[0].contextInfo.groupMentions.length, 2);
  assert.equal(sent[0].contextInfo.groupMentions[0].groupJid, '1@g.us');
});
