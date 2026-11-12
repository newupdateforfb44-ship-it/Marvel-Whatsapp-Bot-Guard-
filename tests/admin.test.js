// Stage 2: plans, subscriptions, group limits, usage stats, admin panel, staff, PIN, broadcast, error alerts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.BOT_TOKEN = 'test-token';
process.env.ADMIN_IDS = '1';
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'admin-')));

const { initStore, db } = await import('../src/store.js');
await initStore();
const plans = await import('../src/plans.js');
const { subscriptionTick, resume, _setStartSessionForTest } = await import('../src/subs.js');
_setStartSessionForTest(async () => ({}));
const { handle } = await import('../src/guard.js');
const { SendQueue } = await import('../src/queue.js');
const { FloodTracker } = await import('../src/rules.js');
const { events } = await import('../src/wa.js');
const { reportError, setNotifier } = await import('../src/alerts.js');
const admin = await import('../src/admin.js');
const { bot, waiting } = await import('../src/tg.js');
const { ensureShape } = await import('../src/store.js');
const { DAY } = plans;

// capture Telegram messages instead of sending them
const tg = [];
bot.api.sendMessage = async (id, t) => (tg.push({ id: String(id), t }), {});
const toCustomer = (id) => tg.filter((m) => m.id === String(id)).map((m) => m.t);

function customer(id, over = {}) {
  db.customers[id] = ensureShape({
    id, name: `Cust ${id}`, username: `u${id}`, number: `2348000${id}`, status: 'connected', everConnected: true, createdAt: Date.now(),
    guard: { blockAllLinks: true, maxMentions: 5, warnLimit: 3, adminsAllowed: true, floodLimit: 0, maxLength: 0, maxEmoji: 0, blockForwards: false, blockStatusMention: false, blockMedia: {}, badWordsOn: false, commands: true, prefix: '.', allowed: [], badWords: [] },
    ...over,
  });
  return db.customers[id];
}

function ctxFor(id, data, text) {
  const out = { last: null, replies: [] };
  return {
    out,
    from: { id, first_name: 'Tester', username: 'tester' },
    callbackQuery: data ? { data } : undefined,
    message: text ? { text } : undefined,
    editMessageText: async (t, o) => (out.last = { t, kb: o?.reply_markup }),
    reply: async (t, o) => (out.replies.push(t), (out.last = { t, kb: o?.reply_markup })),
    answerCallbackQuery: async () => {},
    deleteMessage: async () => {},
  };
}
const click = async (id, data) => {
  const ctx = ctxFor(id, data);
  waiting.delete(String(id));
  await admin.adminRoute(ctx, data.split(':'));
  return ctx.out;
};
const type = async (id, text) => {
  const ctx = ctxFor(id, null, text);
  const handled = await admin.adminText(ctx, waiting.get(String(id)), text);
  return { handled, out: ctx.out };
};
const buttons = (out) => (out.last?.kb?.inline_keyboard || []).flat();

// ---------- plans ----------
test('plans: extend, limits, expiry text, owner never expires', () => {
  const c = customer('10');
  plans.extendDays(c, 30);
  assert.ok(Math.abs(c.expiresAt - (Date.now() + 30 * DAY)) < 2000);
  const first = c.expiresAt;
  plans.extendDays(c, 7); // stacks on top of the current expiry
  assert.equal(c.expiresAt, first + 7 * DAY);
  c.expiresAt = Date.now() - 2 * DAY;
  plans.extendDays(c, 5); // already expired: counts from today
  assert.ok(Math.abs(c.expiresAt - (Date.now() + 5 * DAY)) < 2000);
  assert.match(plans.fmtExpiry(c), /5 days left/);
  c.expiresAt = plans.LIFETIME;
  assert.equal(plans.fmtExpiry(c), 'lifetime');
  c.plan = 'basic';
  assert.equal(plans.maxGroups(c), 5);
  c.limits.maxGroups = 2;
  assert.equal(plans.maxGroups(c), 2);
  c.plan = 'vip';
  c.limits.maxGroups = 0;
  assert.equal(plans.maxGroups(c), 0);
  assert.equal(plans.subActive({ id: '1', expiresAt: null }), true); // owner
  assert.equal(plans.subActive({ id: '77', expiresAt: null }), false);
});

// ---------- subscriptions ----------
test('subscriptions: nothing happens while "require subscription" is off', async () => {
  db.settings.requireSubscription = false;
  const c = customer('11', { plan: '', expiresAt: null });
  await subscriptionTick();
  assert.equal(c.status, 'connected');
});

test('subscriptions: expired customer is disconnected, renewed customer resumes, reminders sent once', async () => {
  db.settings.requireSubscription = true;
  tg.length = 0;
  const expiredEvents = [];
  const reminders = [];
  events.on('expired', (cid) => expiredEvents.push(cid));
  events.on('reminder', (cid, d) => reminders.push([cid, d]));

  const gone = customer('12', { expiresAt: Date.now() - 1000 });
  const soon = customer('13', { expiresAt: Date.now() + 2 * DAY });
  const fine = customer('14', { expiresAt: Date.now() + 40 * DAY });
  await subscriptionTick();
  await subscriptionTick(); // second run must not repeat anything
  assert.equal(gone.status, 'expired');
  assert.deepEqual(expiredEvents.filter((x) => x === '12'), ['12']);
  assert.equal(soon.status, 'connected');
  assert.equal(fine.status, 'connected');
  assert.deepEqual(reminders.filter((r) => r[0] === '13'), [['13', 2]]);
  assert.equal(reminders.filter((r) => r[0] === '14').length, 0);

  // renewal brings the customer back (session start fails in tests: no real WhatsApp, that is reported not thrown)
  plans.extendDays(gone, 30);
  assert.equal(await resume(gone), true);
  assert.equal(gone.status, 'connected');
  db.settings.requireSubscription = false;
});

test('subscriptions: free trial only for brand-new customers', () => {
  db.settings.requireSubscription = true;
  db.settings.trialDays = 3;
  assert.equal(plans.canStartTrial({ id: '90', everConnected: false, trialUsed: false, expiresAt: null }), true);
  assert.equal(plans.canStartTrial({ id: '90', everConnected: true, trialUsed: false, expiresAt: null }), false);
  assert.equal(plans.canStartTrial({ id: '90', everConnected: false, trialUsed: true, expiresAt: null }), false);
  db.settings.trialDays = 0;
  assert.equal(plans.canStartTrial({ id: '90', everConnected: false, trialUsed: false, expiresAt: null }), false);
  db.settings.requireSubscription = false;
  db.settings.trialDays = 3;
});

// ---------- group limit + usage stats ----------
function groupSetup(cid, who) {
  const sent = [];
  const sock = {
    user: { id: '1000:1@s.whatsapp.net' },
    groupMetadata: async (jid) => ({ subject: `Group ${jid.slice(0, 3)}`, participants: [{ id: '1000@s.whatsapp.net', admin: 'admin' }, { id: '2000@s.whatsapp.net', admin: null }] }),
    sendMessage: async (jid, content) => (sent.push(content), {}),
    groupParticipantsUpdate: async () => {},
  };
  const s = { sock, meta: new Map(), notice: new Map(), q: new SendQueue({ min: 0, max: 0 }), flood: new FloodTracker(), lastWarn: new Map(), cool: new Map(), startedAt: Date.now(), bw: null };
  return { s, sent };
}
const gmsg = (jid, text) => ({ key: { remoteJid: jid, participant: '2000@s.whatsapp.net', id: 'M' + Math.random(), fromMe: false }, message: { conversation: text } });

test('group limit: only the first N groups are guarded, one Telegram notice', async () => {
  db.warnings = {};
  const c = customer('20', { plan: 'basic', limits: { maxGroups: 1 } });
  const { s, sent } = groupSetup('20');
  const limitEvents = [];
  events.on('group-limit', (cid, name, limit) => limitEvents.push([cid, name, limit]));
  await handle('20', s, gmsg('111@g.us', 'hello'));
  await handle('20', s, gmsg('222@g.us', 'see https://example.com'));
  await handle('20', s, gmsg('222@g.us', 'see https://example.com'));
  assert.equal(sent.filter((x) => x.delete).length, 0, 'second group is not guarded');
  await handle('20', s, gmsg('111@g.us', 'see https://example.com'));
  assert.equal(sent.filter((x) => x.delete).length, 1, 'first group is guarded');
  assert.deepEqual(limitEvents.filter((e) => e[0] === '20'), [['20', 'Group 222', 1]]);
  assert.equal(Object.keys(c.groups).length, 2);
});

test('usage stats count messages, deletions and warnings (per customer, per group, per day)', async () => {
  db.warnings = {};
  const c = customer('21');
  const { s } = groupSetup('21');
  await handle('21', s, gmsg('333@g.us', 'hi'));
  await handle('21', s, gmsg('333@g.us', 'x https://example.com'));
  assert.equal(c.stats.msgs, 2);
  assert.equal(c.stats.deleted, 1);
  assert.equal(c.stats.warned, 1);
  assert.equal(c.groups['333@g.us'].deleted, 1);
  assert.equal(c.groups['333@g.us'].name, 'Group 333');
  const today = new Date().toISOString().slice(0, 10);
  assert.ok(db.daily[today].deleted >= 1);
});

test('paused / expired customers get no protection', async () => {
  const c = customer('22', { status: 'suspended' });
  const { s, sent } = groupSetup('22');
  await handle('22', s, gmsg('444@g.us', 'x https://example.com'));
  assert.equal(sent.length, 0);
  c.status = 'connected';
});

// ---------- error alerts ----------
test('error alerts: logged, deduplicated and rate limited', () => {
  const got = [];
  setNotifier((t) => got.push(t));
  db.settings.errorAlerts = true;
  const before = db.errors.length;
  for (let i = 0; i < 5; i++) reportError('test', new Error('same problem'));
  assert.equal(got.length, 1, 'same error alerts once');
  assert.equal(db.errors.length, before + 1);
  assert.equal(db.errors.at(-1).n, 5);
  for (let i = 0; i < 30; i++) reportError('test', new Error('different ' + i));
  assert.ok(got.length <= 10, 'never more than 10 alerts per hour');
  db.settings.errorAlerts = false;
  const n = got.length;
  reportError('test', new Error('quiet one'));
  assert.equal(got.length, n);
  db.settings.errorAlerts = true;
});

// ---------- PIN ----------
test('admin PIN: hash verifies, wrong PIN fails, panel locks and unlocks', async () => {
  const h = admin.hashPin('4821');
  assert.ok(!h.includes('4821'));
  assert.equal(admin.checkPin('4821', h), true);
  assert.equal(admin.checkPin('4822', h), false);
  assert.equal(admin.checkPin('4821', ''), false);

  db.settings.pin = h;
  let out = await click(1, 'a:home');
  assert.match(out.last.t, /locked/);
  assert.equal(waiting.get('1').type, 'pin');
  let r = await type(1, '0000');
  assert.match(r.out.last.t, /Wrong PIN/);
  r = await type(1, '4821');
  assert.match(r.out.last.t, /Admin panel/);
  out = await click(1, 'a:home');
  assert.match(out.last.t, /Admin panel/, 'stays unlocked');
  db.settings.pin = '';
});

test('admin PIN: 5 wrong tries lock for 15 minutes', async () => {
  db.settings.pin = admin.hashPin('1357');
  await click(2, 'a:home').catch(() => {});
  db.settings.staff = ['2'];
  await click(2, 'a:home');
  for (let i = 0; i < 5; i++) await type(2, '0000');
  const r = await type(2, '1357');
  assert.match(r.out.replies.join(' '), /Too many wrong tries/);
  db.settings.pin = '';
  db.settings.staff = [];
});

// ---------- permissions ----------
test('staff: can extend up to 30 days and pause, cannot block, change plan, broadcast or restart', async () => {
  db.settings.staff = ['2'];
  const c = customer('30', { expiresAt: Date.now() + 10 * DAY });
  const exp0 = c.expiresAt;
  for (const d of ['a:ban:30', 'a:plan:30', 'a:pl:30:pro', 'a:trial:30', 'a:lim:30', 'a:del:yes:30', 'a:cast', 'a:cgo', 'a:gs', 'a:rstall:yes', 'a:boot:yes', 'a:staff', 'a:lock', 'a:rst:30', 'a:limit:set:99']) {
    const out = await click(2, d);
    assert.match(out.last.t, /Only the owner/, `${d} must be owner only`);
  }
  assert.ok(db.customers['30'], 'not removed');
  assert.equal(c.plan, '');

  await click(2, 'a:ext:30:30');
  assert.ok(c.expiresAt >= exp0 + 30 * DAY - 10);
  const exp1 = c.expiresAt;
  const o = await click(2, 'a:ext:30:90');
  assert.equal(c.expiresAt, exp1, 'staff cannot add 90 days');
  assert.match(o.replies.join(' '), /at most 30/);

  await click(2, 'a:rs:susp:30');
  assert.equal(c.status, 'suspended');
  await click(2, 'a:res:30');
  assert.equal(c.status, 'connected');

  assert.ok(db.log.some((l) => l.kind === 'audit' && /staff/.test(l.text) && /extended 30 days/.test(l.text)), 'staff actions are in the history');
  db.settings.staff = [];
  const out = await click(5, 'a:home'); // a stranger gets nothing
  assert.equal(out.last, null);
});

// ---------- owner actions ----------
test('owner: plan, trial, limits, pause with reason, block with reason, resume', async () => {
  tg.length = 0;
  const c = customer('31');
  await click(1, 'a:pl:31:pro');
  assert.equal(c.plan, 'pro');
  await click(1, 'a:lg:31:3');
  assert.equal(plans.maxGroups(c), 3);
  await click(1, 'a:lw:31:20');
  assert.equal(plans.maxBadWords(c), 20);
  await click(1, 'a:trial:31');
  assert.equal(c.plan, 'trial');
  assert.ok(c.trialUsed && c.expiresAt > Date.now());

  await click(1, 'a:susp:31');
  assert.equal(waiting.get('1').type, 'reason');
  await type(1, 'payment dispute');
  assert.equal(c.status, 'suspended');
  assert.equal(c.suspendReason, 'payment dispute');
  assert.ok(toCustomer('31').some((t) => /payment dispute/.test(t)));
  await click(1, 'a:res:31');
  assert.equal(c.status, 'connected');

  await click(1, 'a:ban:31');
  await type(1, 'spamming');
  assert.equal(c.status, 'banned');
  assert.equal(c.banReason, 'spamming');
  await click(1, 'a:unban:31');
  assert.equal(c.status, 'disconnected');
  const acts = db.log.filter((l) => l.kind === 'audit').map((l) => l.text).join('\n');
  for (const word of ['changed plan', 'set max groups', 'gave', 'paused', 'resumed', 'blocked', 'unblocked']) assert.match(acts, new RegExp(word));
});

test('owner: extend with typed days, lifetime, and message a customer', async () => {
  tg.length = 0;
  const c = customer('32', { status: 'expired', expiresAt: Date.now() - DAY });
  db.settings.requireSubscription = true;
  await click(1, 'a:ext:32:custom');
  await type(1, '45');
  assert.equal(c.status, 'connected', 'expired customer is resumed by renewal');
  assert.ok(c.expiresAt > Date.now() + 44 * DAY);
  await click(1, 'a:ext:32:life');
  assert.equal(plans.fmtExpiry(c), 'lifetime');
  await click(1, 'a:msg:32');
  await type(1, 'Thanks for renewing');
  assert.ok(toCustomer('32').some((t) => /Thanks for renewing/.test(t)));
  db.settings.requireSubscription = false;
});

test('turning subscriptions ON offers a grace period so live customers are not cut off', async () => {
  db.settings.requireSubscription = false;
  for (const c of Object.values(db.customers)) if (c.status === 'connected') c.expiresAt = null;
  const lacking = Object.values(db.customers).filter((c) => c.status === 'connected' && !plans.subActive(c)).length;
  assert.ok(lacking > 0);
  const screen = await click(1, 'a:gs:req');
  assert.match(screen.last.t, /no active subscription/);
  assert.ok(buttons(screen).some((b) => /grace/.test(b.text)));
  await click(1, 'a:gs:req:grace');
  assert.equal(db.settings.requireSubscription, true);
  assert.equal(Object.values(db.customers).filter((c) => c.status === 'connected' && !plans.subActive(c)).length, 0, 'nobody disconnected');
  await click(1, 'a:gs:req:yes'); // turn off again
  assert.equal(db.settings.requireSubscription, false);
});

test('maintenance mode toggles with a confirmation', async () => {
  let out = await click(1, 'a:gs:maint');
  assert.equal(db.settings.maintenance, false);
  assert.match(out.last.t, /Turn ON maintenance/);
  await click(1, 'a:gs:maint:yes');
  assert.equal(db.settings.maintenance, true);
  await click(1, 'a:gs:maint');
  assert.equal(db.settings.maintenance, false);
});

// ---------- list, search, filters ----------
test('customer list: search and filters', () => {
  db.customers = {};
  customer('40', { name: 'Amaka Obi', username: 'amaka', plan: 'basic', expiresAt: Date.now() + 2 * DAY });
  customer('41', { name: 'Bola', plan: 'pro', status: 'expired', expiresAt: Date.now() - DAY });
  customer('42', { name: 'Chidi', status: 'suspended' });
  customer('43', { name: 'Visitor', number: null, status: 'none' });
  const f = (v) => admin.filterCustomers({ f: 'all', q: '', page: 0, ...v }).map((c) => c.id).sort();
  assert.deepEqual(f({}), ['40', '41', '42']);
  assert.deepEqual(f({ q: 'amaka' }), ['40']);
  assert.deepEqual(f({ q: 'visitor' }), ['43'], 'search also finds people with no number');
  assert.deepEqual(f({ q: 'pro' }), ['41']);
  assert.deepEqual(f({ f: 'expiring' }), ['40', '41']);
  assert.deepEqual(f({ f: 'expired' }), ['41']);
  assert.deepEqual(f({ f: 'suspended' }), ['42']);
  assert.deepEqual(f({ f: 'new' }), ['43']);
  assert.deepEqual(f({ f: 'connected' }), ['40']);
});

// ---------- broadcast ----------
test('broadcast audiences + sending to selected customers', async () => {
  const aud = (a, sel) => admin.audience(a, sel).map((c) => c.id).sort();
  db.customers['44'] = ensureShape({ id: '44', name: 'Banned', number: '1', status: 'banned', createdAt: 1, guard: db.customers['40'].guard });
  assert.deepEqual(aud('act'), ['40']);
  assert.deepEqual(aud('exp'), ['41']);
  assert.deepEqual(aud('soon'), ['40']);
  assert.ok(!aud('all').includes('44'), 'blocked users are not in broadcasts');
  assert.deepEqual(aud('sel', new Set(['41', '42'])), ['41', '42']);

  tg.length = 0;
  await click(1, 'a:cs:0');
  await click(1, 'a:ct:41:0');
  await click(1, 'a:ct:42:0');
  await click(1, 'a:cw');
  const prev = await type(1, 'Maintenance tonight at 10pm');
  assert.match(prev.out.last.t, /Selected customers \(2\)/);
  await click(1, 'a:cgo');
  assert.deepEqual(tg.filter((m) => /Maintenance tonight/.test(m.t)).map((m) => m.id).sort(), ['41', '42']);
  assert.ok(db.log.some((l) => /broadcast/.test(l.text) && /2\/2/.test(l.text)));
});

// ---------- staff management ----------
test('owner adds and removes staff; staff get the admin panel', async () => {
  tg.length = 0;
  db.settings.staff = [];
  await click(1, 'a:staff:add');
  await type(1, '555123');
  assert.deepEqual(db.settings.staff, ['555123']);
  assert.ok(toCustomer('555123').some((t) => /added as staff/.test(t)));
  const out = await click(555123, 'a:home');
  assert.match(out.last.t, /\(staff\)/);
  assert.ok(!buttons(out).some((b) => /Broadcast|Global settings|Staff/.test(b.text)), 'staff do not see owner buttons');
  await click(1, 'a:staff:del:555123');
  assert.deepEqual(db.settings.staff, []);
});

// ---------- screens ----------
test('every admin screen renders; every button is valid (BFS through the panel)', async () => {
  const owner = 1;
  const seen = new Set();
  const queue = ['a:home'];
  const skip = /^a:(rst|rstall|boot|cgo)\b|:yes$|:grace$|^a:del:/;
  let screens = 0;
  while (queue.length && screens < 400) {
    const data = queue.shift();
    if (seen.has(data) || skip.test(data)) continue;
    seen.add(data);
    const out = await click(owner, data);
    assert.ok(out.last, `no screen for ${data}`);
    assert.ok(out.last.t.length < 4000, `${data}: text too long`);
    screens++;
    for (const row of out.last.kb.inline_keyboard.slice(0, -1)) assert.ok(row.length > 0, `${data}: empty row in the middle`);
    for (const b of buttons(out)) {
      if (b.callback_data) {
        assert.ok(Buffer.byteLength(b.callback_data) <= 64, `callback too long: ${b.callback_data}`);
        if (b.callback_data.startsWith('a:')) queue.push(b.callback_data);
      }
    }
  }
  assert.ok(screens > 40, `only ${screens} screens reached`);
});

test('stats text works on empty and filled data', () => {
  assert.match(admin.statsText(), /Stats/);
  assert.match(admin.statsText(), /Last 7 days/);
});

test('settings are upgraded for old data (no plan/limits/groups fields)', () => {
  const old = { id: '99', guard: {}, status: 'connected' };
  ensureShape(old);
  assert.deepEqual(old.limits, {});
  assert.equal(old.plan, '');
  assert.equal(old.expiresAt, null);
  assert.equal(old.stats.msgs, 0);
});
