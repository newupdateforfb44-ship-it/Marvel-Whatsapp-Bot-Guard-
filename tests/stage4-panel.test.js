// Stage 4 customer panel: replies and sales screens render and their buttons work.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.BOT_TOKEN = 'test-token';
process.env.ADMIN_IDS = '1';
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'panel4-')));

const config = (await import('../config.js')).default;
const { initStore, db } = await import('../src/store.js');
await initStore();
const { _test } = await import('../src/bot.js');
const { waiting } = await import('../src/tg.js');

const UID = 700;
function ctxFor(data) {
  const out = { last: null };
  return {
    out,
    from: { id: UID, first_name: 'Cust', username: 'cust' },
    callbackQuery: data ? { data } : undefined,
    editMessageText: async (t, o) => (out.last = { t, kb: o?.reply_markup }),
    reply: async (t, o) => (out.last = { t, kb: o?.reply_markup }),
    answerCallbackQuery: async () => {},
  };
}
const go = async (data) => {
  const c = ctxFor(data);
  await _test.route(c, data);
  return c.out.last;
};
const datas = (o) => (o?.kb?.inline_keyboard || []).flat().map((b) => b.callback_data).filter(Boolean);

function connected() {
  db.customers[String(UID)] = {
    id: String(UID), name: 'Cust', number: '2348011122233', status: 'connected', everConnected: true,
    groups: {}, groupList: {}, joinLog: [], stats: { msgs: 0, deleted: 0, warned: 0, removed: 0, cmds: 0 },
    guard: { ...structuredClone(config.DEFAULT_GUARD), allowed: [], badWords: [] },
  };
  return db.customers[String(UID)];
}

test('replies & sales screen and its switches', async () => {
  const c = connected();
  const social = await go('sc:social');
  assert.match(social.t, /Replies & sales/);
  assert.ok(datas(social).includes('texts'));
  assert.ok(datas(social).includes('it:view:replies'));
  await go('t:social:privateChats');
  assert.equal(c.guard.privateChats, true);
  await go('t:social:salesOn');
  assert.equal(c.guard.salesOn, true);
});

test('messages & links screen shows the current values', async () => {
  const c = connected();
  c.guard.salesLink = 'https://shop.test';
  const texts = await go('texts');
  assert.match(texts.t, /Shop link: https:\/\/shop\.test/);
  assert.match(texts.t, /Welcome message: not set/);
  const edit = await go('fld:salesLink');
  assert.match(edit.t, /must start|starting with https/i);
});

test('lists: toggle and delete scheduled posts and auto-replies', async () => {
  const c = connected();
  c.guard.schedules = [{ time: '18:00', text: 'Promo', on: true, lastRun: '' }];
  c.guard.replies = [{ words: ['hours'], reply: 'Open 9 to 5' }];
  const sched = await go('it:view:sched');
  assert.match(sched.t, /1 saved/);
  await go('it:tog:sched:0');
  assert.equal(c.guard.schedules[0].on, false);
  await go('it:del:replies:0');
  assert.equal(c.guard.replies.length, 0);
});

test('every new button fits the 64-byte limit', async () => {
  const c = connected();
  c.guard.schedules = [{ time: '18:00', text: 'Promo', on: true, lastRun: '' }];
  let n = 0;
  for (const s of ['sc:social', 'texts', 'it:view:sched', 'it:view:replies', 'it:view:topics']) {
    for (const d of datas(await go(s))) {
      n++;
      assert.ok(Buffer.byteLength(d) <= 64, d);
    }
  }
  assert.ok(n > 10);
});
