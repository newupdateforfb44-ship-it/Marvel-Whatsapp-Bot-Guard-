// Stage 4: private chats, replies and sales, welcome and goodbye, scheduled posts, birthdays, summaries, polls, levels.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.BOT_TOKEN = 'test-token';
process.env.ADMIN_IDS = '1';
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'stage4-')));

const config = (await import('../config.js')).default;
const { initStore, db } = await import('../src/store.js');
const { handle, _test, sendToChat } = await import('../src/guard.js');
const { events } = await import('../src/wa.js');
const { SendQueue } = await import('../src/queue.js');
const { FloodTracker } = await import('../src/rules.js');
const social = await import('../src/social.js');
await initStore();

const BOT = '1000';
const ADMIN = '2000';
const MEMBER = '3000';
const GROUP = '999@g.us';
const at = (n) => `${n}@s.whatsapp.net`;
const PRIV = at('5551234567');
const flush = () => new Promise((r) => setTimeout(r, 20));

function setup({ guard = {}, cust = {} } = {}) {
  const sent = [];
  const sock = {
    user: { id: `${BOT}:1@s.whatsapp.net` },
    groupMetadata: async () => ({
      subject: 'Test group',
      participants: [
        { id: at(BOT), admin: 'admin' },
        { id: at(ADMIN), admin: 'admin' },
        { id: at(MEMBER), admin: null },
      ],
    }),
    sendMessage: async (jid, content, opts) => {
      sent.push({ jid, content, opts });
      return {};
    },
    groupParticipantsUpdate: async () => {},
    groupSettingUpdate: async () => {},
  };
  const s = { sock, state: 'open', stopped: false, meta: new Map(), notice: new Map(), q: new SendQueue({ min: 0, max: 0 }), flood: new FloodTracker(), lastWarn: new Map(), cool: new Map(), startedAt: Date.now(), bw: null };
  db.customers.c1 = {
    id: 'c1',
    name: 'Tester',
    number: BOT,
    status: 'connected',
    everConnected: true,
    plan: 'pro',
    expiresAt: Date.now() + 86400000 * 30,
    groups: { [GROUP]: { name: 'Test group', first: 0, last: 0, msgs: 0 } },
    groupList: {},
    joinLog: [],
    stats: { msgs: 0, deleted: 0, warned: 0, removed: 0, cmds: 0 },
    guard: { ...structuredClone(config.DEFAULT_GUARD), allowed: [], badWords: [], ...guard },
    ...cust,
  };
  db.greeted = {};
  db.birthdays = {};
  db.activity = {};
  return { s, sent, sock };
}
const pm = (from, t, extra = {}) => ({ key: { remoteJid: from, id: 'P' + Math.random().toString(36).slice(2), fromMe: false }, message: { conversation: t }, messageTimestamp: 1, ...extra });
const gm = (who, t, extra = {}) => ({ key: { remoteJid: GROUP, participant: at(who), id: 'G' + Math.random().toString(36).slice(2), fromMe: false }, message: { conversation: t }, messageTimestamp: 1, ...extra });
const texts = (sent) => sent.map((x) => x.content.text).filter(Boolean);

// ---------- pure helpers ----------
test('whole-word matching, replies and sales links', () => {
  assert.equal(social.hasWord('I want to buy numbers', 'buy'), true);
  assert.equal(social.hasWord('my buyer is late', 'buy'), false);
  assert.equal(social.hasWord('where can i get sms', 'where can i'), true);
  const g = { replies: [{ words: ['hours'], reply: 'We are open 9 to 5.' }], salesOn: true, salesLink: 'https://shop.test', salesTopics: [{ words: ['sms'], link: 'https://shop.test/sms' }] };
  assert.equal(social.matchReply(g, 'what are your hours?'), 'We are open 9 to 5.');
  assert.equal(social.salesReply(g, 'send me sms please'), '🛒 https://shop.test/sms');
  assert.equal(social.salesReply(g, 'how much is it'), '🛒 https://shop.test');
  assert.equal(social.salesReply({ ...g, salesOn: false }, 'how much'), null);
});

test('time helpers and poll parsing', () => {
  assert.equal(social.normTime('9:05'), '09:05');
  assert.equal(social.normTime('25:00'), null);
  const p = social.localParts('UTC', Date.UTC(2026, 10, 11, 21, 30));
  assert.equal(p.date, '2026-11-11');
  assert.equal(p.mins, 21 * 60 + 30);
  assert.deepEqual(social.parsePoll('Lunch? | Pizza | Rice'), { name: 'Lunch?', values: ['Pizza', 'Rice'] });
  assert.equal(social.parsePoll('Only one | option'), null);
});

// ---------- private chats ----------
test('private chats are ignored until switched on', async () => {
  const { s, sent } = setup();
  await handle('c1', s, pm(PRIV, 'what are your hours?'));
  assert.equal(sent.length, 0);
});

test('private: greeting once, auto-reply, cooldown, sales, away, then ticket', async () => {
  const { s, sent } = setup({
    guard: {
      privateChats: true, greetFirst: true, greeting: 'Hi, welcome!', replies: [{ words: ['hours'], reply: 'Open 9 to 5.' }],
      salesOn: true, salesLink: 'https://shop.test', awayOn: true, away: 'Away right now.', support: true,
    },
  });
  let ticket = null;
  events.once('ticket', (cid, jid, n, text) => (ticket = [cid, jid, n, text]));
  await handle('c1', s, pm(PRIV, 'what are your hours?'));
  assert.deepEqual(texts(sent), ['Hi, welcome!', 'Open 9 to 5.']);
  await handle('c1', s, pm(PRIV, 'hours again?'));
  assert.equal(texts(sent).length, 2, 'auto-reply has a 2 minute cooldown');
  await handle('c1', s, pm(PRIV, 'how much is a number?'));
  assert.equal(texts(sent).at(-1), '🛒 https://shop.test');
  await handle('c1', s, pm(PRIV, 'hello there'));
  assert.equal(texts(sent).at(-1), 'Away right now.');
  assert.deepEqual(ticket, ['c1', PRIV, 1, 'hello there']);
  await handle('c1', s, pm(PRIV, 'hello again'));
  assert.equal(texts(sent).filter((t) => t === 'Hi, welcome!').length, 1, 'greeting only once');
});

test('private: .menu and .shop answer; media without text still becomes a ticket', async () => {
  const { s, sent } = setup({ guard: { privateChats: true, support: true, salesOn: true, salesLink: 'https://shop.test' } });
  await handle('c1', s, pm(PRIV, '.shop'));
  assert.equal(texts(sent).at(-1), '🛒 https://shop.test');
  await handle('c1', s, pm(PRIV, '.menu'));
  assert.match(texts(sent).at(-1), /automatic helper/);
  let t = null;
  events.once('ticket', (c, j, n, text) => (t = text));
  await handle('c1', s, pm(PRIV, '', { message: { imageMessage: {} } }));
  assert.match(t, /no text/);
});

test('ticket replies from Telegram go back to the same chat', async () => {
  const { s, sent } = setup();
  _test.sessions.set('c1', s);
  try {
    assert.equal(await sendToChat('c1', PRIV, 'Thanks, we are on it.'), true);
    assert.equal(sent.at(-1).jid, PRIV);
    assert.equal(sent.at(-1).content.text, 'Thanks, we are on it.');
    social.rememberTicket('c1', 77, PRIV);
    assert.deepEqual(social.ticketFor('c1', 77), { cid: 'c1', jid: PRIV });
    assert.equal(social.ticketFor('c1', 78), null);
  } finally {
    _test.sessions.delete('c1');
  }
});

// ---------- groups ----------
test('welcome and goodbye messages mention the member', async () => {
  const { s, sent } = setup({ guard: { welcome: 'Hi {name}, welcome to {group}!', goodbye: 'Bye {name}.' } });
  await social.onMembers('c1', s, GROUP, [at(MEMBER)], 'add');
  assert.equal(sent.at(-1).content.text, 'Hi @3000, welcome to Test group!');
  assert.deepEqual(sent.at(-1).content.mentions, [at(MEMBER)]);
  await social.onMembers('c1', s, GROUP, [at(MEMBER)], 'remove');
  assert.equal(sent.at(-1).content.text, 'Bye @3000.');
});

test('group commands: rules, birthday, poll, leaderboard, level, buy', async () => {
  const { s, sent } = setup({ guard: { rules: 'Be kind.', salesOn: true, salesLink: 'https://shop.test' } });
  s.cool.clear(); await handle('c1', s, gm(MEMBER, '.rules'));
  assert.match(texts(sent).at(-1), /Be kind\./);
  s.cool.clear(); await handle('c1', s, gm(MEMBER, '.birthday 14-02'));
  assert.equal(db.birthdays[`c1|${GROUP}|${MEMBER}`], '02-14');
  s.cool.clear(); await handle('c1', s, gm(MEMBER, '.birthday 40-02'));
  assert.match(texts(sent).at(-1), /does not look right/);
  s.cool.clear(); await handle('c1', s, gm(MEMBER, 'hi'));
  s.cool.clear(); await handle('c1', s, gm(MEMBER, 'hi again'));
  await handle('c1', s, gm(ADMIN, '.leaderboard'));
  assert.match(texts(sent).at(-1), /1\. \+3000/);
  s.cool.clear(); await handle('c1', s, gm(MEMBER, '.level'));
  assert.match(texts(sent).at(-1), /rank 1/);
  s.cool.clear(); await handle('c1', s, gm(MEMBER, '.buy'));
  assert.equal(texts(sent).at(-1), '🛒 https://shop.test');
  await handle('c1', s, gm(ADMIN, '.poll Lunch? | Pizza | Rice'));
  const poll = sent.find((x) => x.content.poll);
  assert.deepEqual(poll.content.poll, { name: 'Lunch?', values: ['Pizza', 'Rice'], selectableCount: 1 });
});

test('giveaway draws from members who posted recently, never admins', async () => {
  const { s, sent } = setup();
  await handle('c1', s, gm(MEMBER, 'hello'));
  await handle('c1', s, gm(ADMIN, '.giveaway'));
  const win = sent.at(-1);
  assert.match(win.content.text, /Winner: @3000/);
  assert.deepEqual(win.content.mentions, [at(MEMBER)]);
});

// ---------- daily jobs ----------
test('scheduled posts go out once a day after their time', async () => {
  const { s, sent } = setup({ guard: { nightTz: 'UTC', schedules: [{ time: '18:00', text: 'Offer today!', on: true, lastRun: '' }] } });
  const cust = db.customers.c1;
  await _test.runNight('c1', s, cust, Date.UTC(2026, 10, 11, 9)); // makes sure the session is ready
  await social.runSchedules('c1', s, cust, Date.UTC(2026, 10, 11, 17, 59));
  assert.equal(texts(sent).length, 0, 'not before 18:00');
  await social.runSchedules('c1', s, cust, Date.UTC(2026, 10, 11, 18, 5));
  assert.equal(texts(sent).filter((t) => t === 'Offer today!').length, 1);
  await social.runSchedules('c1', s, cust, Date.UTC(2026, 10, 11, 20));
  assert.equal(texts(sent).filter((t) => t === 'Offer today!').length, 1, 'once per day');
});

test('birthdays are wished at 9 am, once', async () => {
  const { s, sent } = setup({ guard: { nightTz: 'UTC' } });
  db.birthdays[`c1|${GROUP}|${MEMBER}`] = '11-11';
  const cust = db.customers.c1;
  await social.runDaily('c1', s, cust, Date.UTC(2026, 10, 11, 8));
  assert.equal(sent.length, 0, 'not yet 9 am');
  await social.runDaily('c1', s, cust, Date.UTC(2026, 10, 11, 10));
  assert.equal(texts(sent).at(-1), '🎂 Happy birthday @3000!');
  const n = sent.length;
  await social.runDaily('c1', s, cust, Date.UTC(2026, 10, 11, 11));
  assert.equal(sent.length, n);
});

test('daily summary goes to the customer at 9 pm with the day so far', async () => {
  setup({ guard: { nightTz: 'UTC', dailySummary: true } });
  db.customers.c1.day = { msgs: 12, deleted: 3, warned: 1, removed: 0 };
  let got = null;
  events.once('summary', (cid, d) => (got = [cid, d.msgs, d.deleted]));
  social.runSummaries(Date.UTC(2026, 10, 11, 21, 5));
  assert.deepEqual(got, ['c1', 12, 3]);
  assert.deepEqual(db.customers.c1.day, { msgs: 0, deleted: 0, warned: 0, removed: 0 });
});
