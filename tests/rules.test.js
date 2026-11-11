import test from 'node:test';
import assert from 'node:assert/strict';
import { tokensOf, buildBadWords, findBadWord, emojiCount, FloodTracker, detect, kindOf, LINK_RE, INVITE_RE } from '../src/rules.js';
import { SendQueue } from '../src/queue.js';

const bw = (...w) => buildBadWords(w);

test('bad words: plain, leet, spaced, stretched, accents', () => {
  const b = bw('fuck', 'ass', 'son of a bitch');
  assert.ok(findBadWord('what the fuck', b));
  assert.ok(findBadWord('f.u.c.k you', b));
  assert.ok(findBadWord('f u c k', b));
  assert.ok(findBadWord('fuuuuck', b));
  assert.ok(findBadWord('you a$$', b));
  assert.ok(findBadWord('FÜCK', bw('fuck')));
  assert.ok(findBadWord('hey SON of a BITCH!', b));
});

test('bad words: no false positives', () => {
  const b = bw('ass', 'fuck');
  assert.equal(findBadWord('please pass the class', b), null);
  assert.equal(findBadWord('assume the best', b), null);
  assert.equal(findBadWord('I have 5 apples', b), null);
  assert.equal(findBadWord('', b), null);
});

test('tokens ignore number-only text', () => {
  assert.deepEqual(tokensOf('100 200'), []);
});

test('links and invites', () => {
  assert.ok(INVITE_RE.test('join chat.whatsapp.com/AbC123'));
  assert.ok(LINK_RE.test('visit https://example.com now'));
  assert.ok(LINK_RE.test('see example.com'));
  assert.ok(!LINK_RE.test('hello everyone'));
});

test('emoji count', () => {
  assert.equal(emojiCount('hi 😀😀🔥 123'), 3);
  assert.equal(emojiCount('plain text 12345'), 0);
});

test('flood tracker', () => {
  const f = new FloodTracker(10000);
  const r = [1, 2, 3, 4, 5].map((i) => f.hit('a', 1000 + i, 4));
  assert.deepEqual(r, [false, false, false, false, true]);
  assert.equal(f.hit('a', 20000, 4), false); // window passed
  assert.equal(f.hit('b', 1000, 4), false);
});

test('detect: everything off by default does nothing', () => {
  const g = { blockAllLinks: false, maxMentions: 0, blockMedia: {} };
  assert.equal(detect(g, { text: 'hello', kind: 'text', mentionCount: 50 }), null);
  assert.equal(detect(g, { statusMention: true }), null);
});

test('detect: each rule', () => {
  const base = { blockAllLinks: true, maxMentions: 5, blockMedia: { image: true }, badWordsOn: true, blockForwards: true, floodLimit: 4, maxLength: 10, maxEmoji: 2, blockStatusMention: true };
  const d = (i) => detect(base, { text: '', kind: 'text', mentionCount: 0, ...i })?.rule;
  assert.equal(d({ statusMention: true }), 'status');
  assert.equal(d({ text: 'x chat.whatsapp.com/abc' }), 'link');
  assert.equal(d({ mentionCount: 6 }), 'mentions');
  assert.equal(d({ text: 'fuck', badWords: bw('fuck') }), 'badword');
  assert.equal(d({ kind: 'image' }), 'media');
  assert.equal(d({ isForwarded: true }), 'forward');
  assert.equal(d({ flooding: true }), 'flood');
  assert.equal(d({ text: 'a'.repeat(11) }), 'long');
  assert.equal(d({ text: '😀😀😀' }), 'emoji');
  assert.equal(d({ text: 'hi' }), undefined);
});

test('kindOf', () => {
  assert.equal(kindOf({ stickerMessage: {} }), 'sticker');
  assert.equal(kindOf({ conversation: 'x' }), 'text');
});

test('send queue keeps order and survives errors', async () => {
  const q = new SendQueue({ min: 0, max: 0 });
  const out = [];
  await Promise.all([q.add(async () => out.push(1)), q.add(async () => { throw new Error('x'); }), q.add(async () => out.push(3))]);
  assert.deepEqual(out, [1, 3]);
});
