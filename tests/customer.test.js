// Stage 2 customer-side screens: home for each status, connect gate, maintenance texts, settings still render.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.BOT_TOKEN = 'test-token';
process.env.ADMIN_IDS = '1';
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'cust-')));

const { initStore, db } = await import('../src/store.js');
await initStore();
const { _test, _ui } = await import('../src/bot.js');
const { waiting } = await import('../src/tg.js');
const { DAY } = await import('../src/plans.js');

function ctxFor(id, data) {
  const out = { last: null };
  return {
    out,
    from: { id, first_name: 'Cust', username: 'cust' },
    callbackQuery: data ? { data } : undefined,
    editMessageText: async (t, o) => (out.last = { t, kb: o?.reply_markup }),
    reply: async (t, o) => (out.last = { t, kb: o?.reply_markup }),
    answerCallbackQuery: async () => {},
  };
}
const go = async (id, data) => {
  const c = ctxFor(id, data);
  await _test.route(c, data);
  return c.out.last;
};
const btns = (o) => (o?.kb?.inline_keyboard || []).flat();

test('home screen for each status', async () => {
  const home = async (status, extra = {}) => {
    await go(500, 'home'); // creates the customer
    Object.assign(db.customers['500'], { status, number: '2348011122233', ...extra });
    return go(500, 'home');
  };
  let o = await home('suspended', { suspendReason: 'late payment' });
  assert.match(o.t, /paused/);
  assert.match(o.t, /late payment/);
  assert.ok(!btns(o).some((b) => b.callback_data === 'connect'));

  o = await home('expired', { plan: 'basic', expiresAt: Date.now() - 3 * DAY });
  assert.match(o.t, /subscription is not active/);
  assert.match(o.t, /expired 3 days ago/);

  o = await home('banned', { banReason: 'abuse' });
  assert.match(o.t, /blocked/);
  assert.match(o.t, /abuse/);

  o = await home('connected', { plan: 'pro', expiresAt: Date.now() + 9 * DAY });
  assert.match(o.t, /Plan: Pro/);
  assert.match(o.t, /9 days left/);
  assert.ok(btns(o).some((b) => b.callback_data === 'settings'));
  assert.ok(!btns(o).some((b) => b.callback_data === 'a:home'), 'customers do not see the admin panel');
});

test('owner and staff see the Admin panel button', async () => {
  let o = await go(1, 'home');
  assert.ok(btns(o).some((b) => b.callback_data === 'a:home'));
  db.settings.staff = ['600'];
  o = await go(600, 'home');
  assert.ok(btns(o).some((b) => b.callback_data === 'a:home'));
  db.settings.staff = [];
});

test('connect: blocked for paused/expired; subscription gate; trial allowed once', async () => {
  db.settings.requireSubscription = false;
  await go(501, 'home');
  let o = await go(501, 'connect');
  assert.match(o.t, /Send me the WhatsApp number/);

  db.settings.requireSubscription = true;
  db.settings.trialDays = 3;
  await go(502, 'home');
  o = await go(502, 'connect');
  assert.match(o.t, /Send me the WhatsApp number/, 'new customer gets the trial path');

  Object.assign(db.customers['502'], { everConnected: true, trialUsed: true, status: 'none', number: null });
  o = await go(502, 'connect');
  assert.match(o.t, /subscription is not active/);

  Object.assign(db.customers['502'], { expiresAt: Date.now() + 5 * DAY });
  o = await go(502, 'connect');
  assert.match(o.t, /Send me the WhatsApp number/, 'active subscription may connect');

  db.customers['503'] = { ...db.customers['502'], id: '503', status: 'suspended', number: '2348099999999' };
  o = await go(503, 'connect');
  assert.match(o.t, /paused/);
  db.settings.requireSubscription = false;
});

test('customer settings screens still render and respect the bad-word limit', async () => {
  await go(504, 'home');
  const c = db.customers['504'];
  Object.assign(c, { status: 'connected', number: '2348077766655', limits: { maxBadWords: 20 } });
  const seen = new Set();
  const queue = ['settings'];
  const skip = /^(disc|connect|home|how|noop|a:)/;
  let n = 0;
  while (queue.length && n < 120) {
    const d = queue.shift();
    if (seen.has(d) || skip.test(d)) continue;
    seen.add(d);
    const o = await go(504, d);
    assert.ok(o, `no screen for ${d}`);
    n++;
    for (const b of btns(o)) {
      if (b.callback_data) {
        assert.ok(Buffer.byteLength(b.callback_data) <= 64);
        queue.push(b.callback_data);
      }
    }
  }
  assert.ok(n >= 15, `only ${n} screens`);
  const w = _ui.wordsView(c);
  assert.match(w.text, /No words added yet/);
  c.guard.badWords = ['a1', 'b2'];
  assert.match(_ui.wordsView(c).text, /2\/20/);
  assert.match(_ui.settingsText(c), /Settings for/);
});
