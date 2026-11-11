// Stage 6: automation (auto-react, always online, auto-read, auto-bio) and reply rules with pictures.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.BOT_TOKEN = 'test-token';
process.env.ADMIN_IDS = '1';
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'stage6-')));

const social = await import('../src/social.js');
const auto = await import('../src/automation.js');

const wordsOf = (w) =>
  String(w || '')
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter((x) => x.length >= 2);

// a fake session: the queue runs jobs at once, and every outgoing call is recorded
function fakeSession() {
  const log = { sent: [], reads: [], presence: [], bio: [] };
  const s = {
    q: { add: (fn) => fn() },
    sock: {
      sendMessage: async (jid, content) => log.sent.push({ jid, content }),
      readMessages: async (keys) => log.reads.push(keys),
      sendPresenceUpdate: async (p) => log.presence.push(p),
      updateProfileStatus: async (t) => log.bio.push(t),
    },
  };
  return { s, log };
}

const msgFrom = (chat, id) => ({ key: { remoteJid: chat, id, fromMe: false } });

test('reply rules: the picture is optional and comes last', () => {
  const r = social.parseReplyRule('price, cost | Our prices are here | https://cdn.test/p.jpg', wordsOf);
  assert.deepEqual(r, { words: ['price', 'cost'], reply: 'Our prices are here', image: 'https://cdn.test/p.jpg' });
  assert.equal(social.parseReplyRule('price | Our prices', wordsOf).image, '');
  assert.equal(social.parseReplyRule('price | https://cdn.test/p.jpg', wordsOf), null, 'a reply is required');
  assert.equal(social.parseReplyRule('price | Read this | http://insecure.test/p.jpg', wordsOf).image, '', 'only https pictures');
  assert.equal(social.parseReplyRule('price | Pipe | inside text', wordsOf).reply, 'Pipe | inside text');
});

test('matchReply still returns the text; replyRule returns the picture too', () => {
  const g = { replies: [{ words: ['price'], reply: 'Prices', image: 'https://x.test/p.jpg' }] };
  assert.equal(social.matchReply(g, 'what price?'), 'Prices');
  assert.equal(social.replyRule(g, 'what price?').image, 'https://x.test/p.jpg');
  assert.equal(social.matchReply(g, 'hello'), null);
});

test('auto-react: off by default, once a minute per chat, emoji from the set', async () => {
  const { s, log } = fakeSession();
  const chat = '111@s.whatsapp.net';
  assert.equal(await auto.autoReact('c6a', s, msgFrom(chat, 'a'), { autoReact: false }), false);
  assert.equal(log.sent.length, 0);

  const on = { autoReact: true };
  assert.equal(await auto.autoReact('c6a', s, msgFrom(chat, 'b'), on, () => 0), true);
  assert.equal(log.sent.length, 1);
  assert.deepEqual(log.sent[0].content.react.text, auto.REACT_SET[0]);
  assert.equal(await auto.autoReact('c6a', s, msgFrom(chat, 'c'), on, () => 0), false, 'cooled down for a minute');
  assert.equal(await auto.autoReact('c6a', s, msgFrom('222@g.us', 'd'), on), true, 'another chat is not cooled');
});

test('auto-react never reacts to the number’s own messages', async () => {
  const { s, log } = fakeSession();
  const own = { key: { remoteJid: '333@g.us', id: 'x', fromMe: true } };
  assert.equal(await auto.autoReact('c6b', s, own, { autoReact: true }), false);
  assert.equal(log.sent.length, 0);
});

test('auto-read marks incoming messages as read only when switched on', async () => {
  const { s, log } = fakeSession();
  const m = msgFrom('444@g.us', 'e');
  assert.equal(await auto.autoRead(s, m, { autoRead: false }), false);
  assert.equal(await auto.autoRead(s, m, { autoRead: true }), true);
  assert.deepEqual(log.reads[0], [m.key]);
});

test('presence and bio: always online sends presence; bio is trimmed to 139 and sent once', async () => {
  const { s, log } = fakeSession();
  await auto.presenceAndBio(s, { alwaysOnline: false, bio: '' });
  assert.equal(log.presence.length, 0);
  assert.equal(log.bio.length, 0);

  await auto.presenceAndBio(s, { alwaysOnline: true, bio: 'x'.repeat(200) });
  assert.deepEqual(log.presence, ['available']);
  assert.equal(log.bio.length, 1);
  assert.equal(log.bio[0].length, 139);

  await auto.presenceAndBio(s, { alwaysOnline: true, bio: 'x'.repeat(200) });
  assert.equal(log.bio.length, 1, 'same bio is not sent again');
  assert.equal(log.presence.length, 2, 'presence is sent every minute');

  await auto.presenceAndBio(s, { bio: 'Open 9 to 5' });
  assert.equal(log.bio.at(-1), 'Open 9 to 5');
});

test('a failed bio update is retried on the next minute', async () => {
  const { s } = fakeSession();
  let tries = 0;
  s.sock.updateProfileStatus = async () => {
    tries++;
    if (tries === 1) throw new Error('offline');
  };
  await auto.presenceAndBio(s, { bio: 'hello' });
  await auto.presenceAndBio(s, { bio: 'hello' });
  assert.equal(tries, 2);
  assert.equal(s.bioSet, 'hello');
});

test('pickEmoji stays inside the set', () => {
  for (const r of [0, 0.3, 0.99]) assert.ok(auto.REACT_SET.includes(auto.pickEmoji(() => r)));
});
