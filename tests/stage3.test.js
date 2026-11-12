// Stage 3: group control. Runs the real guard and commands against a fake WhatsApp socket.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.BOT_TOKEN = 'test-token';
process.env.ADMIN_IDS = '1';
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'stage3-')));

const config = (await import('../config.js')).default;
const { initStore, db } = await import('../src/store.js');
const { handle, _test, joinByLink } = await import('../src/guard.js');
const { events, say } = await import('../src/wa.js');
const { SendQueue } = await import('../src/queue.js');
const { FloodTracker } = await import('../src/rules.js');
const { hasPhoneNumber, countryBlocked, SlowTracker, WindowCounter, inNight, hourIn, groupScore, accountHealth } = await import('../src/checks.js');
const { setLockdownSettings, runLockdown, LOCK_RULES } = await import('../src/lockdown.js');
await initStore();

const BOT = '1000';
const ADMIN = '2000';
const MEMBER = '3000';
const MEMBER2 = '4000';
const GROUP = '999@g.us';
const GROUP2 = '888@g.us';
const at = (n) => `${n}@s.whatsapp.net`;

function setup({ guard = {}, cust = {}, groups = [GROUP], groupList = null } = {}) {
  const sent = [];
  const calls = [];
  const sock = {
    failing: false,
    user: { id: `${BOT}:1@s.whatsapp.net` },
    groupMetadata: async (jid) => ({
      subject: jid === GROUP2 ? 'Second group' : 'Test group',
      participants: [
        { id: at(BOT), admin: 'admin' },
        { id: at(ADMIN), admin: 'admin' },
        { id: at(MEMBER), admin: null },
        { id: at(MEMBER2), admin: null },
      ],
    }),
    sendMessage: async (jid, content, opts) => {
      if (sock.failing) throw new Error('locked group');
      sent.push({ jid, content, opts });
      return {};
    },
    groupParticipantsUpdate: async (...a) => calls.push(['participants', ...a]),
    groupSettingUpdate: async (...a) => calls.push(['setting', ...a]),
    groupUpdateSubject: async (...a) => calls.push(['subject', ...a]),
    groupUpdateDescription: async (...a) => calls.push(['desc', ...a]),
    groupInviteCode: async () => 'CODE123',
    groupAcceptInvite: async () => '777@g.us',
  };
  const s = { sock, state: 'open', stopped: false, meta: new Map(), notice: new Map(), q: new SendQueue({ min: 0, max: 0 }), startedAt: Date.now(), bw: null };
  const groupsSeen = {};
  for (const g of groups) groupsSeen[g] = { name: '', first: Date.now(), last: Date.now(), msgs: 0 };
  db.customers.c1 = {
    id: 'c1',
    name: 'Tester',
    number: BOT,
    status: 'connected',
    everConnected: true,
    plan: 'pro',
    expiresAt: Date.now() + 86400000 * 30,
    groups: groupsSeen,
    groupList: groupList || {},
    joinLog: [],
    stats: { msgs: 0, deleted: 0, warned: 0, removed: 0, cmds: 0 },
    guard: {
      ...structuredClone(config.DEFAULT_GUARD),
      allowed: [],
      badWords: [],
      blockAllLinks: true,
      maxMentions: 5,
      warnLimit: 3,
      adminsAllowed: true,
      ...guard,
    },
    ...cust,
  };
  db.warnings = {};
  db.mutes = {};
  db.activity = {};
  return { s, sent, calls, sock };
}
const msg = (who, message, jid = GROUP, extra = {}) => ({
  key: { remoteJid: jid, participant: at(who), id: 'M' + Math.random().toString(36).slice(2), fromMe: false },
  message,
  messageTimestamp: Math.floor(Date.now() / 1000),
  ...extra,
});
const text = (t) => ({ conversation: t });
const quoted = (t, stanza, who = MEMBER) => ({
  extendedTextMessage: { text: t, contextInfo: { stanzaId: stanza, participant: at(who), quotedMessage: { conversation: 'quoted text' } } },
});
const tagged = (t, who) => ({ extendedTextMessage: { text: t, contextInfo: { mentionedJid: [at(who)] } } });
const deleted = (sent) => sent.filter((x) => x.content?.delete);
const flush = () => new Promise((r) => setTimeout(r, 20));

// ---------- pure checks ----------
test('phone numbers: real numbers are caught, dates and prices are not', () => {
  assert.equal(hasPhoneNumber('call +234 801 234 5678'), true);
  assert.equal(hasPhoneNumber('my number 08012345678'), true);
  assert.equal(hasPhoneNumber('see you 2026-11-10 at 5'), false);
  assert.equal(hasPhoneNumber('price 2500 naira'), false);
});

test('slow mode, window counter and country codes', () => {
  const slow = new SlowTracker();
  assert.equal(slow.hit('a', 1000, 10), false);
  assert.equal(slow.hit('a', 5000, 10), true); // too soon
  assert.equal(slow.hit('a', 12000, 10), false); // timer was not restarted by the blocked message
  const win = new WindowCounter(60000);
  win.add('g', 0);
  win.add('g', 1000);
  assert.equal(win.add('g', 70000), 1);
  assert.equal(countryBlocked('2348012345678', ['234']), true);
  assert.equal(countryBlocked('447700900000', ['234']), false);
  assert.equal(countryBlocked('', ['1']), false);
});

test('night window, including across midnight', () => {
  const utc = (d, h) => Date.UTC(2026, 0, d, h, 30);
  const night = { nightStart: 23, nightEnd: 7, nightTz: 'UTC' };
  assert.equal(inNight(night, utc(1, 23)), true);
  assert.equal(inNight(night, utc(2, 6)), true);
  assert.equal(inNight(night, utc(2, 7)), false);
  assert.equal(inNight(night, utc(1, 12)), false);
  assert.equal(inNight({ nightStart: 9, nightEnd: 17, nightTz: 'UTC' }, utc(1, 12)), true);
  assert.equal(typeof hourIn('America/New_York'), 'number');
});

test('security score and account health', () => {
  assert.equal(groupScore(structuredClone(config.DEFAULT_GUARD)), 25); // links 10 + tags 10 + warnings 5
  const all = {
    ...structuredClone(config.DEFAULT_GUARD),
    floodLimit: 4,
    badWordsOn: true,
    blockMedia: { image: true, video: false, sticker: false, audio: false, document: false, contact: false },
    maxLength: 500,
    maxEmoji: 10,
    blockForwards: true,
    blockStatusMention: true,
    muteAt: 2,
    antiNumbers: true,
    slowMode: 5,
    antiRaid: true,
    blockCountries: ['1'],
  };
  assert.equal(groupScore(all), 100);
  assert.equal(accountHealth({}).score, 100);
  assert.equal(accountHealth({ failures24: 4, drops24: 2 }).score, 60);
  assert.equal(accountHealth({ failures24: 99, drops24: 99, queue: 99 }).score, 5);
});

// ---------- group control: which groups are protected ----------
test('allowed-groups mode: only groups added by link are protected, pause stops protection', async () => {
  const { s, sent } = setup({ guard: { groupMode: 'allowed' }, groups: [GROUP, GROUP2] });
  await handle('c1', s, msg(MEMBER, text('https://example.com')));
  assert.equal(deleted(sent).length, 0, 'an unlisted group is ignored');
  db.customers.c1.groupList[GROUP] = { name: 'Mine', paused: false, added: Date.now() };
  await handle('c1', s, msg(MEMBER, text('https://example.com')));
  assert.equal(deleted(sent).length, 1);
  db.customers.c1.groupList[GROUP].paused = true;
  await handle('c1', s, msg(MEMBER, text('https://example.com')));
  assert.equal(deleted(sent).length, 1, 'a paused group is ignored');
});

test('all-groups mode: a paused group is not protected either', async () => {
  const { s, sent } = setup({ groupList: { [GROUP]: { name: '', paused: true, added: 0 } } });
  await handle('c1', s, msg(MEMBER, text('https://example.com')));
  assert.equal(deleted(sent).length, 0);
});

test('joining by invite link: adds the group, refuses duplicates, honours the hourly limit', async () => {
  const { s } = setup({ guard: { groupMode: 'allowed', joinsPerHour: 2 }, groups: [] });
  const ids = ['700@g.us', '700@g.us', '701@g.us', '702@g.us'];
  s.sock.groupAcceptInvite = async () => ids.shift();
  _test.sessions.set('c1', s);
  try {
    const first = await joinByLink('c1', 'CODE');
    assert.equal(first.jid, '700@g.us');
    assert.ok(db.customers.c1.groupList['700@g.us']);
    assert.match((await joinByLink('c1', 'CODE')).error, /already/);
    assert.equal((await joinByLink('c1', 'CODE')).jid, '701@g.us');
    assert.match((await joinByLink('c1', 'CODE')).error, /up to 2 groups per hour/);
  } finally {
    _test.sessions.delete('c1');
  }
});

// ---------- guard rules ----------
test('blacklisted number: message deleted and the member removed', async () => {
  const { s, sent, calls } = setup({ guard: { blacklist: [MEMBER] } });
  await handle('c1', s, msg(MEMBER, text('hello')));
  assert.equal(deleted(sent).length, 1);
  assert.deepEqual(calls.at(-1), ['participants', GROUP, [at(MEMBER)], 'remove']);
});

test('muted member: messages deleted silently until the mute ends', async () => {
  const { s, sent } = setup();
  db.mutes[`c1|${GROUP}|${MEMBER}`] = Date.now() + 60000;
  await handle('c1', s, msg(MEMBER, text('hello')));
  assert.equal(deleted(sent).length, 1);
  assert.equal(sent.length, 1, 'no warning text for a muted member');
  db.mutes[`c1|${GROUP}|${MEMBER}`] = Date.now() - 1;
  await handle('c1', s, msg(MEMBER, text('hello')));
  assert.equal(deleted(sent).length, 1);
});

test('strike ladder: warn, mute at the second warning, remove at the third', async () => {
  const { s, sent, calls } = setup({ guard: { muteAt: 2, muteMinutes: 60 } });
  for (let i = 0; i < 2; i++) {
    await handle('c1', s, msg(MEMBER, text('https://example.com')));
    s.lastWarn.clear();
  }
  assert.match(sent.at(-1).content.text, /Warning 2\/3[\s\S]*Muted for 1 hour/);
  assert.ok(db.mutes[`c1|${GROUP}|${MEMBER}`] > Date.now());
  await handle('c1', s, msg(MEMBER, text('https://example.com'))); // muted: deleted, not counted
  assert.equal(calls.length, 0, 'not removed while muted');
  delete db.mutes[`c1|${GROUP}|${MEMBER}`]; // the mute has ended
  await handle('c1', s, msg(MEMBER, text('https://example.com')));
  assert.ok(calls.some((c) => c[0] === 'participants' && c[3] === 'remove'));
});

test('slow mode: a second message inside the window is deleted', async () => {
  const { s, sent } = setup({ guard: { slowMode: 10 } });
  await handle('c1', s, msg(MEMBER, text('one')));
  await handle('c1', s, msg(MEMBER, text('two')));
  assert.equal(deleted(sent).length, 1);
});

test('anti-number-sharing deletes phone numbers only', async () => {
  const { s, sent } = setup({ guard: { antiNumbers: true } });
  await handle('c1', s, msg(MEMBER, text('call +234 801 234 5678')));
  await handle('c1', s, msg(MEMBER2, text('see you 2026-11-10')));
  assert.equal(deleted(sent).length, 1);
});

test('anti-raid: 10 joins in a minute close the group once and tell the customer', async () => {
  const { s, calls, sent } = setup({ guard: { antiRaid: true } });
  await handle('c1', s, msg(ADMIN, text('hi'))); // registers the group as protected
  let got = null;
  events.once('raid', (cid, name, n) => (got = [cid, name, n]));
  const joiners = Array.from({ length: 10 }, (_, i) => at(5000 + i));
  await _test.onJoin('c1', s, GROUP, joiners);
  assert.deepEqual(calls.filter((c) => c[0] === 'setting'), [['setting', GROUP, 'announcement']]);
  assert.deepEqual(got, ['c1', 'Test group', 10]);
  assert.match(sent.at(-1).content.text, /Many people joined/);
  await _test.onJoin('c1', s, GROUP, [at(6000)]);
  assert.equal(calls.filter((c) => c[0] === 'setting').length, 1, 'does not close again');
});

test('joins: blacklisted numbers and blocked country codes are removed, lookalike ids are not', async () => {
  const { s, calls } = setup({ guard: { blockCountries: ['234'], blacklist: ['5555'] } });
  await handle('c1', s, msg(ADMIN, text('hi')));
  await _test.onJoin('c1', s, GROUP, [at('2348012345678'), at('5555'), at('447700900000'), '2349000000000@lid']);
  const removed = calls.filter((c) => c[0] === 'participants').map((c) => c[2][0]);
  assert.deepEqual(removed, [at('2348012345678'), at('5555')]);
});

test('night mode: closes once at night, opens once in the morning', async () => {
  const { s, calls } = setup({ groups: [GROUP] });
  const h = hourIn('UTC');
  const cust = db.customers.c1;
  cust.groups[GROUP] = { name: 'Test group', first: 0, last: 0, msgs: 0 };
  cust.guard.nightOn = true;
  cust.guard.nightTz = 'UTC';
  cust.guard.nightStart = h;
  cust.guard.nightEnd = (h + 1) % 24;
  await _test.runNight('c1', s, cust, Date.now());
  await _test.runNight('c1', s, cust, Date.now());
  assert.deepEqual(calls.filter((c) => c[0] === 'setting'), [['setting', GROUP, 'announcement']]);
  cust.guard.nightStart = (h + 5) % 24;
  cust.guard.nightEnd = (h + 6) % 24;
  await _test.runNight('c1', s, cust, Date.now());
  assert.equal(calls.at(-1)[2], 'not_announcement');
});

test('night mode retries when WhatsApp rejects a group-setting update', async () => {
  const { s, calls, sock } = setup({ groups: [GROUP] });
  const h = hourIn('UTC');
  const cust = db.customers.c1;
  cust.guard.nightOn = true;
  cust.guard.nightTz = 'UTC';
  cust.guard.nightStart = h;
  cust.guard.nightEnd = (h + 1) % 24;
  sock.groupSettingUpdate = async () => { throw new Error('temporary failure'); };

  await _test.runNight('c1', s, cust, Date.now());
  assert.equal(s.nightState.get(GROUP), undefined);

  sock.groupSettingUpdate = async (...args) => calls.push(['setting', ...args]);
  await _test.runNight('c1', s, cust, Date.now());
  assert.equal(s.nightState.get(GROUP), 'announcement');
  assert.deepEqual(calls.filter((c) => c[0] === 'setting'), [['setting', GROUP, 'announcement']]);
});

test('lockdown: strict rules and closed groups, then the old rules come back', async () => {
  const { s, calls } = setup({ guard: { slowMode: 0, blockAllLinks: false } });
  db.customers.c1.groups[GROUP] = { name: '', first: 0, last: 0, msgs: 0 };
  const r = await runLockdown('c1', s, true);
  assert.equal(r.closed, 1);
  const g = db.customers.c1.guard;
  assert.equal(g.lockdown, true);
  assert.equal(g.slowMode, LOCK_RULES.slowMode);
  assert.equal(g.blockAllLinks, true);
  assert.equal(calls.at(-1)[2], 'announcement');
  await runLockdown('c1', s, false);
  assert.equal(g.lockdown, false);
  assert.equal(g.slowMode, 0);
  assert.equal(g.blockAllLinks, false);
  assert.equal(calls.at(-1)[2], 'not_announcement');
  // turning it on twice does not overwrite the saved rules
  setLockdownSettings(db.customers.c1, true);
  setLockdownSettings(db.customers.c1, true);
  setLockdownSettings(db.customers.c1, false);
  assert.equal(g.slowMode, 0);
});

test('lockdown preserves a group that was already closed before lockdown', async () => {
  const { s, calls } = setup();
  db.customers.c1.groups[GROUP] = { name: '', first: 0, last: 0, msgs: 0 };
  s.meta.set(GROUP, { m: { announce: true, participants: [{ id: at(BOT), admin: 'admin' }] }, t: Date.now() });
  await runLockdown('c1', s, true);
  await runLockdown('c1', s, false);
  assert.deepEqual(calls.filter((c) => c[0] === 'setting').map((c) => c[2]), ['announcement', 'announcement']);
  assert.equal(db.customers.c1.guard.lockdownGroupModes[GROUP], undefined, 'the snapshot is cleared after successful restore');
});

test('unlock does not open a group when no prior setting was captured', async () => {
  const { s, calls } = setup();
  db.customers.c1.groups[GROUP] = { name: '', first: 0, last: 0, msgs: 0 };
  db.customers.c1.guard.lockdown = true;
  db.customers.c1.guard.lockdownGroupModes = {};
  await runLockdown('c1', s, false);
  assert.equal(calls.some((c) => c[0] === 'setting'), false);
});

test('a failed post is queued, retried, and the customer is told after five tries', async () => {
  const { s, sock } = setup();
  sock.failing = true;
  await say(s, GROUP, { text: 'warning' });
  assert.equal(s.retry.length, 1);
  assert.equal(s.failTimes.length, 1);
  sock.failing = false;
  await _test.runRetries('c1', s, Date.now() + 3 * 60 * 1000);
  assert.equal(s.retry.length, 0, 'retry succeeded');

  sock.failing = true;
  await say(s, GROUP, { text: 'warning 2' });
  let failedEvent = null;
  events.once('post-failed', (cid, name) => (failedEvent = [cid, name]));
  for (let i = 0; i < 10 && s.retry.length; i++) await _test.runRetries('c1', s, Date.now() + 86400000 * (i + 1));
  assert.deepEqual(failedEvent, ['c1', 'Test group']);
});

test('evidence is recorded for each deleted message', async () => {
  const { s } = setup();
  const before = db.evidence.length;
  await handle('c1', s, msg(MEMBER, text('https://example.com')));
  const last = db.evidence.at(-1);
  assert.equal(db.evidence.length, before + 1);
  assert.equal(last.cid, 'c1');
  assert.equal(last.reason, 'sending links');
});

test('weekly report is sent to a connected customer once per week', async () => {
  const { s } = setup();
  await handle('c1', s, msg(MEMBER, text('https://example.com')));
  let got = null;
  events.once('weekly', (cid, w) => (got = [cid, w.deleted]));
  _test.weeklyTick(Date.now() + 8 * 86400000);
  assert.deepEqual(got, ['c1', 1]);
});

// ---------- commands ----------
test('.pin replies to a message and pins it for 7 days', async () => {
  const { s, sent } = setup();
  await handle('c1', s, msg(ADMIN, quoted('.pin', 'STANZA1')));
  const pin = sent.find((x) => x.content.pin);
  assert.equal(pin.content.type, 1);
  assert.equal(pin.content.pin.id, 'STANZA1');
  assert.equal(pin.content.time, 7 * 86400);
  await handle('c1', s, msg(ADMIN, quoted('.unpin', 'STANZA1')));
  assert.equal(sent.findLast((x) => x.content.pin).content.type, 2);
});

test('.purge deletes recent member messages and keeps admin messages', async () => {
  const { s, sent } = setup();
  await handle('c1', s, msg(MEMBER, text('member one')));
  await handle('c1', s, msg(ADMIN, text('admin note')));
  const keep = sent.length;
  await handle('c1', s, msg(MEMBER2, text('member two')));
  await handle('c1', s, msg(ADMIN, text('.purge 5')));
  await flush();
  const gone = deleted(sent.slice(keep)).map((x) => x.content.delete.participant);
  assert.deepEqual(gone.sort(), [at(MEMBER), at(MEMBER2)].sort());
  assert.ok(!gone.includes(at(ADMIN)));
});

test('.setname and .lockname use the group settings', async () => {
  const { s, calls } = setup();
  await handle('c1', s, msg(ADMIN, text('.setname Cool group')));
  assert.deepEqual(calls.at(-1), ['subject', GROUP, 'Cool group']);
  await handle('c1', s, msg(ADMIN, text('.lockname on')));
  assert.deepEqual(calls.at(-1), ['setting', GROUP, 'locked']);
});

test('.report sends the reported text to the customer', async () => {
  const { s } = setup();
  let got = null;
  events.once('report', (cid, name, who, q) => (got = [cid, name, who, q]));
  await handle('c1', s, msg(MEMBER2, quoted('.report', 'STANZA2', MEMBER)));
  assert.deepEqual(got, ['c1', 'Test group', MEMBER2, 'quoted text']);
});

test('.ban blacklists the member and removes them, .mute uses minutes', async () => {
  const { s, calls } = setup();
  await handle('c1', s, msg(ADMIN, tagged('.ban @3000', MEMBER)));
  assert.ok(db.customers.c1.guard.blacklist.includes(MEMBER));
  assert.deepEqual(calls.at(-1), ['participants', GROUP, [at(MEMBER)], 'remove']);
  await handle('c1', s, msg(ADMIN, tagged('.mute @4000 30', MEMBER2)));
  const until = db.mutes[`c1|${GROUP}|${MEMBER2}`];
  assert.ok(until > Date.now() + 29 * 60000 && until < Date.now() + 31 * 60000);
});

test('.topmembers and .inactive count messages seen by the bot', async () => {
  const { s, sent } = setup();
  for (let i = 0; i < 3; i++) await handle('c1', s, msg(MEMBER, text('hi ' + i)));
  await handle('c1', s, msg(MEMBER2, text('hey')));
  await handle('c1', s, msg(ADMIN, text('.topmembers')));
  assert.match(sent.at(-1).content.text, /1\. \+3000 · 3 messages/);
  await handle('c1', s, msg(ADMIN, text('.inactive 1')));
  assert.match(sent.at(-1).content.text, /Everyone has posted/);
});

test('.lockdown and .unlockdown from the group', async () => {
  const { s, calls } = setup();
  await handle('c1', s, msg(ADMIN, text('.lockdown')));
  assert.equal(db.customers.c1.guard.lockdown, true);
  assert.equal(calls.at(-1)[2], 'announcement');
  await handle('c1', s, msg(ADMIN, text('.unlockdown')));
  assert.equal(db.customers.c1.guard.lockdown, false);
  assert.equal(calls.at(-1)[2], 'not_announcement');
});

test('members cannot use admin commands (mute, ban, lockdown)', async () => {
  const { s, calls } = setup();
  await handle('c1', s, msg(MEMBER, text('.lockdown')));
  await handle('c1', s, msg(MEMBER2, tagged('.ban @3000', MEMBER)));
  assert.equal(calls.length, 0);
  assert.equal(db.customers.c1.guard.lockdown, false);
});
