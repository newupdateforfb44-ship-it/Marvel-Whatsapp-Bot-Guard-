// Stage 7: encryption at rest, website uptime, storage cleanup, backup and restore, order webhook.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';

process.env.BOT_TOKEN = 'test-token';
process.env.ADMIN_IDS = '1';
process.env.DATA_KEY = 'test-data-key-123';
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'stage7-')));

const { initStore, db } = await import('../src/store.js');
await initStore();
const { sealText, openText, encryptionOn } = await import('../src/crypto.js');
const uptime = await import('../src/uptime.js');
const { pruneStorage } = await import('../src/cleanup.js');
const { makeBackup, restoreBackup } = await import('../src/backup.js');
const { handleHook, newHookToken } = await import('../src/webhook.js');
const { events } = await import('../src/wa.js');

const DAY = 86400000;
const MIN = 60000;

// ---------- encryption ----------
test('encryption: sealed values open with the same key and not with a changed one', () => {
  assert.equal(encryptionOn(), true);
  const sealed = sealText('{"secret":1}');
  assert.ok(sealed.startsWith('enc1:'));
  assert.ok(!sealed.includes('secret'));
  assert.equal(openText(sealed), '{"secret":1}');
  const tampered = sealed.slice(0, -4) + 'AAAA';
  assert.equal(openText(tampered), null, 'tampered data is refused');
  assert.equal(openText('plain value'), 'plain value', 'values stored before encryption still read');
});

// ---------- uptime ----------
test('sites: addresses are normalised, duplicates and the limit are refused', () => {
  assert.equal(uptime.normSite('example.com'), 'https://example.com/');
  assert.equal(uptime.normSite('http://a.test/x'), 'http://a.test/x');
  assert.equal(uptime.normSite('localhost'), null, 'a name without a dot is refused');
  const cust = {};
  assert.equal(uptime.addSite(cust, 'one.test').ok, true);
  assert.match(uptime.addSite(cust, 'one.test').error, /already/);
  for (const h of ['two', 'three', 'four', 'five']) uptime.addSite(cust, `${h}.test`);
  assert.match(uptime.addSite(cust, 'six.test').error, /up to 5/);
  assert.equal(uptime.removeSite(cust, 2), true);
  assert.equal(uptime.removeSite(cust, 99), false);
  assert.equal(uptime.sitesOf(cust).length, 4);
});

test('uptime: alerts only on changes, and the percentage counts real checks', async () => {
  const cust = { id: 'u1', sites: [] };
  uptime.addSite(cust, 'watch.test');
  const heard = [];
  const on = (cid, e) => heard.push([cid, e.up]);
  events.on('site', on);
  let mode = 'up';
  const check = async () => (mode === 'up' ? { status: 200, ms: 40 } : { error: 'did not answer' });
  const t0 = Date.now();
  await uptime.runSites(cust, t0, check);
  assert.equal(heard.length, 0, 'the first check does not alert');
  await uptime.runSites(cust, t0 + MIN, check);
  assert.equal(heard.length, 0, 'not due yet');
  mode = 'down';
  await uptime.runSites(cust, t0 + 20 * MIN, check);
  assert.deepEqual(heard, [['u1', false]]);
  mode = 'up';
  await uptime.runSites(cust, t0 + 40 * MIN, check);
  assert.deepEqual(heard, [['u1', false], ['u1', true]]);
  assert.equal(uptime.uptimePct(cust.sites[0]), 67, '2 of the 3 checks were up');
  events.off('site', on);
});

test('uptime: a 500 answer counts as down, a 404 as up', async () => {
  const cust = { id: 'u2', sites: [] };
  uptime.addSite(cust, 'codes.test');
  await uptime.runSites(cust, Date.now(), async () => ({ status: 500, ms: 1 }));
  assert.equal(cust.sites[0].up, false);
  const c2 = { id: 'u3', sites: [] };
  uptime.addSite(c2, 'codes2.test');
  await uptime.runSites(c2, Date.now(), async () => ({ status: 404, ms: 1 }));
  assert.equal(c2.sites[0].up, true);
});

// ---------- storage cleanup ----------
test('cleanup: old logs and activity go, current data stays', () => {
  const now = Date.now();
  db.log = Array.from({ length: 2300 }, (_, i) => ({ i }));
  db.greeted = { old: now - 200 * DAY, fresh: now - DAY };
  db.activity = { 'c|g': { oldMember: { n: 3, t: now - 40 * DAY }, newMember: { n: 9, t: now } } };
  db.daily = { '2020-01-01': {}, [new Date(now).toISOString().slice(0, 10)]: { msgs: 1 } };
  pruneStorage(now);
  assert.equal(db.log.length, 2000);
  assert.equal(db.log[0].i, 300, 'the oldest entries are dropped');
  assert.deepEqual(Object.keys(db.greeted), ['fresh']);
  assert.deepEqual(Object.keys(db.activity['c|g']), ['newMember']);
  assert.equal(Object.keys(db.daily).length, 1);
});

// ---------- backup and restore ----------
test('backup: encrypted, and restoring brings the data back', async () => {
  db.customers.keep = { id: 'keep', name: 'Keeper', sites: [] };
  const b = makeBackup();
  assert.ok(b.buf, 'a backup is made when DATA_KEY is set');
  assert.match(b.name, /^groupguard-\d{4}-\d{2}-\d{2}\.bak$/);
  assert.ok(b.buf.toString('utf8').startsWith('enc1:'));
  assert.ok(!b.buf.toString('utf8').includes('Keeper'), 'the backup does not show data in plain text');

  delete db.customers.keep;
  const r = restoreBackup(b.buf.toString('utf8'));
  assert.equal(r.ok, true);
  assert.equal(db.customers.keep.name, 'Keeper');
  assert.match(restoreBackup('not a backup').error, /cannot be opened|not a backup/);
  assert.match(restoreBackup(sealText('{"x":1}')).error, /not a backup/);
});

// ---------- order webhook ----------
function fakeReq(method, url) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  return req;
}
function fakeRes() {
  return {
    status: 0,
    body: '',
    writeHead(s) {
      this.status = s;
    },
    end(b) {
      this.body = b;
    },
  };
}
function postJson(url, payload) {
  const req = fakeReq('POST', url);
  const res = fakeRes();
  handleHook(req, res);
  const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
  req.emit('data', Buffer.from(raw));
  req.emit('end');
  return res;
}

test('order webhook: valid JSON reaches the customer; bad requests are refused', () => {
  const cust = { id: '4242', sites: [] };
  db.customers['4242'] = cust;
  const token = newHookToken(cust);
  const url = `/hook/${token}`;
  const got = [];
  const on = (cid, t) => got.push([cid, t]);
  events.on('order', on);

  assert.equal(handleHook(fakeReq('POST', '/hook/' + '0'.repeat(40)), fakeRes()) && 'handled', 'handled');
  const unknown = fakeRes();
  handleHook(fakeReq('POST', '/hook/' + '0'.repeat(40)), unknown);
  assert.equal(unknown.status, 404);

  const getRes = fakeRes();
  handleHook(fakeReq('GET', url), getRes);
  assert.equal(getRes.status, 405);

  const ok = postJson(url, { text: 'New order #123\u0000 for 2 items' });
  assert.equal(ok.status, 200);
  assert.deepEqual(got, [['4242', 'New order #123  for 2 items']], 'control characters become spaces');

  assert.equal(postJson(url, { other: 1 }).status, 400);
  assert.equal(postJson(url, 'not json').status, 400);
  assert.equal(postJson(url, { text: 'x'.repeat(3000) }).status, 200, 'long text is cut, not refused');
  assert.equal(got[1][1].length, 300);
  events.off('order', on);
});

test('order webhook: a body over 4 KB is refused', () => {
  const cust = db.customers['4242'];
  const url = `/hook/${cust.hookToken}`;
  const req = fakeReq('POST', url);
  const res = fakeRes();
  handleHook(req, res);
  req.emit('data', Buffer.alloc(5000, 97));
  req.emit('end');
  assert.equal(res.status, 413);
});
