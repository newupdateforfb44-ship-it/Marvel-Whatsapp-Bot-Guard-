// Stage 3 customer panel: the new screens render, their buttons work and fit Telegram's 64-byte callback limit.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.BOT_TOKEN = 'test-token';
process.env.ADMIN_IDS = '1';
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'panel3-')));

const config = (await import('../config.js')).default;
const { initStore, db } = await import('../src/store.js');
await initStore();
const { _test, _ui } = await import('../src/bot.js');
const { waiting } = await import('../src/tg.js');

const UID = 600;
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
const buttons = (o) => (o?.kb?.inline_keyboard || []).flat();
const datas = (o) => buttons(o).map((b) => b.callback_data).filter(Boolean);

function connectedCustomer() {
  db.customers[String(UID)] = {
    id: String(UID),
    name: 'Cust',
    number: '2348011122233',
    status: 'connected',
    everConnected: true,
    plan: 'pro',
    expiresAt: Date.now() + 86400000 * 30,
    groups: { '111@g.us': { name: 'Family', first: 0, last: 0, msgs: 0 } },
    groupList: {},
    joinLog: [],
    stats: { msgs: 0, deleted: 0, warned: 0, removed: 0, cmds: 0 },
    guard: { ...structuredClone(config.DEFAULT_GUARD), allowed: [], badWords: [] },
  };
  return db.customers[String(UID)];
}

test('new screens render and show their current state', async () => {
  connectedCustomer();
  const settings = await go('settings');
  assert.match(settings.t, /Groups: all/);
  assert.match(settings.t, /Lockdown: off/);
  assert.ok(datas(settings).includes('groups'));
  assert.ok(datas(settings).includes('night'));
  assert.ok(datas(settings).includes('safety'));

  const anti = await go('sc:anti');
  assert.match(anti.t, /Anti-abuse/);
  assert.ok(datas(anti).includes('lst:view:blacklist'));
  assert.ok(datas(anti).includes('lst:view:countries'));

  const strikes = await go('sc:strikes');
  assert.ok(datas(strikes).includes('n:strikes:muteAt:2'));
  assert.ok(datas(strikes).includes('n:strikes:muteMinutes:1440'));

  const night = await go('sc:night');
  assert.match(night.t, /Now in UTC: \d\d:00/);
  assert.ok(datas(night).includes('tz:2'));
});

test('groups: mode switch, pause and remove', async () => {
  const c = connectedCustomer();
  const groups = await go('groups');
  assert.ok(datas(groups).includes('grp:p:111@g.us'));
  await go('grp:mode');
  assert.equal(c.guard.groupMode, 'allowed');
  c.groupList['111@g.us'] = { name: 'Family', paused: false, added: 0 };
  await go('grp:p:111@g.us');
  assert.equal(c.groupList['111@g.us'].paused, true);
  const after = await go('grp:rm:111@g.us');
  assert.equal(c.groupList['111@g.us'], undefined);
  assert.match(after.t, /No groups yet/);
  const addPrompt = await go('grp:add');
  assert.equal(waiting.get(String(UID)).type, 'grouplink');
  assert.ok(datas(addPrompt).includes('groups'));
});

test('blacklist: add numbers by typing, remove by tapping', async () => {
  const c = connectedCustomer();
  await go('lst:add:blacklist');
  assert.equal(waiting.get(String(UID)).key, 'blacklist');
  // what the typed-input handler does for a list
  c.guard.blacklist = ['2348000000001', '2348000000002'];
  const view = await go('lst:view:blacklist');
  assert.match(view.t, /2 saved/);
  await go('lst:del:blacklist:0');
  assert.deepEqual(c.guard.blacklist, ['2348000000002']);
  await go('lst:clear:blacklist');
  const confirm = await go('lst:clear:blacklist');
  assert.ok(datas(confirm).includes('lst:clear:blacklist:yes'));
  await go('lst:clear:blacklist:yes');
  assert.deepEqual(c.guard.blacklist, []);
});

test('night mode: hours and time zone', async () => {
  const c = connectedCustomer();
  await go('night');
  await go('tz:2');
  assert.equal(c.guard.nightTz, config.TIME_ZONES[2]);
  await go('n:night:nightStart:0');
  assert.equal(c.guard.nightStart, 0);
  await go('t:night:nightOn');
  assert.equal(c.guard.nightOn, true);
});

test('safety: lockdown asks first, then turns on and off', async () => {
  const c = connectedCustomer();
  const ask = await go('lock:on');
  assert.match(ask.t, /Turn on LOCKDOWN now/);
  assert.equal(c.guard.lockdown, false, 'nothing changes before the confirmation');
  const done = await go('lock:on:yes');
  assert.equal(c.guard.lockdown, true);
  assert.match(done.t, /Status: 🚨 LOCKDOWN ON/);
  assert.match(done.t, /Account health: 100\/100/);
  await go('lock:off:yes');
  assert.equal(c.guard.lockdown, false);
});

test('evidence and weekly report screens', async () => {
  connectedCustomer();
  const ev = await go('ev');
  assert.match(ev.t, /Nothing removed yet/);
  const wk = await go('wk');
  assert.match(wk.t, /Messages checked: 0/);
});

test('every new button fits the 64-byte callback limit', async () => {
  connectedCustomer();
  const starts = ['settings', 'groups', 'night', 'safety', 'sc:anti', 'sc:strikes', 'lst:view:countries', 'lst:view:blacklist'];
  const seen = new Set();
  for (const s of starts) {
    const o = await go(s);
    for (const d of datas(o)) {
      seen.add(d);
      assert.ok(Buffer.byteLength(d) <= 64, `too long: ${d}`);
    }
  }
  assert.ok(seen.size > 20);
});
