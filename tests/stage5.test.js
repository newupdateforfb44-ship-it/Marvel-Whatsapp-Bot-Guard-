// Stage 5: calculator, converter, time zones, jokes, lookups (fake network), short links, site checker, notes and to-dos.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';

process.env.BOT_TOKEN = 'test-token';
process.env.ADMIN_IDS = '1';
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'stage5-')));

const config = (await import('../config.js')).default;
const { initStore, db } = await import('../src/store.js');
const u = await import('../src/utility.js');
await initStore();

const CID = 'c1';
const JID = '555@g.us';

test('calc: arithmetic, precedence, powers, functions, bad input', () => {
  assert.equal(u.calc('2+3*4'), 14);
  assert.equal(u.calc('(2+3)*4'), 20);
  assert.equal(u.calc('2^3^2'), 512);
  assert.equal(u.calc('-3+5'), 2);
  assert.equal(u.calc('10/0'), null);
  assert.equal(u.calc('abc'), null);
  assert.equal(u.calc('sqrt(81)'), 9);
});

test('convert: units and temperatures', () => {
  assert.ok(Math.abs(Number(u.convert(10, 'km', 'mi')) - 6.2137) < 0.001);
  assert.equal(Number(u.convert(100, 'c', 'f')), 212);
  assert.equal(Number(u.convert(32, 'f', 'c')), 0);
  assert.equal(u.convert(1, 'km', 'kg'), null);
});

test('timeIn: known zones and aliases, bad zone is null', () => {
  assert.ok(u.timeIn('UTC'));
  assert.ok(u.timeIn('ny'));
  assert.equal(u.timeIn('nonsense/zone'), null);
});

test('joke, quote, lyrics link and qr link', () => {
  assert.ok(typeof u.joke() === 'string' && u.joke().length > 0);
  assert.ok(typeof u.quote() === 'string' && u.quote().length > 0);
  assert.match(u.lyricsLink('hey jude'), /google\.com\/search\?q=/);
  assert.match(u.qrUrl('hi there'), /data=hi%20there/);
});

test('lookups with a fake network: results, and null when the service fails', async () => {
  u._setFetch(async (url) => {
    if (url.includes('wttr.in'))
      return { ok: true, json: async () => ({ current_condition: [{ temp_C: '21', FeelsLikeC: '20', weatherDesc: [{ value: 'Sunny' }], humidity: '40' }] }) };
    if (url.includes('dictionaryapi'))
      return { ok: true, json: async () => [{ word: 'hi', meanings: [{ partOfSpeech: 'noun', definitions: [{ definition: 'a greeting' }] }] }] };
    if (url.includes('wikipedia'))
      return { ok: true, json: async () => ({ title: 'Lagos', extract: 'City in Nigeria.', content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Lagos' } } }) };
    throw new Error('unexpected url ' + url);
  });
  assert.match(await u.weather('Lagos'), /21°C/);
  assert.match(await u.define('hi'), /a greeting/);
  assert.match(await u.wiki('Lagos'), /City in Nigeria/);

  u._setFetch(async () => {
    throw new Error('service down');
  });
  assert.equal(await u.weather('Lagos'), null);
  assert.equal(await u.define('hi'), null);
  u._setFetch(null);
});

test('movie and news say they are off when the owner has no key', async () => {
  assert.equal(config.OMDB_KEY, '');
  assert.match(await u.movie('Heat'), /OMDB_KEY/);
  assert.match(await u.news(), /NEWS_KEY/);
});

test('useLookup: limit 0 is unlimited; a limit of 2 blocks the third lookup for one member', () => {
  for (let i = 0; i < 5; i++) assert.equal(u.useLookup(CID, 'a', 0), true);
  assert.equal(u.useLookup('c2', 'x', 2), true);
  assert.equal(u.useLookup('c2', 'x', 2), true);
  assert.equal(u.useLookup('c2', 'x', 2), false);
  assert.equal(u.useLookup('c2', 'y', 2), true);
});

test('isPrivateIp and checkSite refuse private addresses', async () => {
  assert.equal(u.isPrivateIp('127.0.0.1'), true);
  assert.equal(u.isPrivateIp('10.1.2.3'), true);
  assert.equal(u.isPrivateIp('192.168.1.1'), true);
  assert.equal(u.isPrivateIp('8.8.8.8'), false);
  const r = await u.checkSite('127.0.0.1');
  assert.ok(r.error);
});

test('checkSite with allowPrivate reads a local server (status and timing)', async () => {
  const srv = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('ok');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    const r = await u.checkSite(`http://127.0.0.1:${port}/`, { allowPrivate: true });
    assert.equal(r.status, 200);
    assert.equal(r.host, '127.0.0.1');
    assert.equal(r.ssl, null);
    assert.match(u.siteLine(r), /200/);
  } finally {
    srv.close();
  }
});

test('short links: create, redirect with a click count, 404 for unknown codes', () => {
  const code = u.createShort(CID, 'https://example.com/page');
  assert.match(code, /^[0-9a-f]{8}$/);
  assert.equal(u.createShort(CID, 'javascript:alert(1)'), null);
  assert.equal(u.createShort(CID, 'not a url'), null);

  const res = {
    status: 0,
    headers: {},
    writeHead(s, h) {
      this.status = s;
      this.headers = h || {};
    },
    end() {},
  };
  assert.equal(u.handleRedirect({ url: `/r/${code}` }, res), true);
  assert.equal(res.status, 302);
  assert.equal(res.headers.Location, 'https://example.com/page');
  assert.equal(db.shorts[code].clicks, 1);

  const miss = { status: 0, writeHead(s) { this.status = s; }, end() {} };
  u.handleRedirect({ url: '/r/ffffffff' }, miss);
  assert.equal(miss.status, 404);

  const mine = u.linksOf(CID).map(([c]) => c);
  assert.ok(mine.includes(code));
});

test('shortUrl needs PUBLIC_URL; the test runs without it', () => {
  assert.equal(u.shortUrl('abcdef12'), null);
});

test('notes and to-dos per chat', () => {
  u.addNote(CID, JID, 'buy milk');
  assert.ok(u.notesOf(CID, JID).includes('buy milk'));
  u.addTodo(CID, JID, 'book the room');
  u.addTodo(CID, JID, 'send invoices');
  let list = u.todosOf(CID, JID);
  assert.equal(list.length, 2);
  const t = u.toggleTodo(CID, JID, 1);
  assert.equal(t.done, true);
  assert.equal(u.toggleTodo(CID, JID, 9), null);
  assert.equal(u.delTodo(CID, JID, 2), true);
  list = u.todosOf(CID, JID);
  assert.equal(list.length, 1);
  assert.equal(list[0].text, 'book the room');
  assert.equal(u.todosOf(CID, 'other-chat').length, 0);
});
