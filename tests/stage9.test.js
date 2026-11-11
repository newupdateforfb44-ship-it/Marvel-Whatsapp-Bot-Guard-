// Stage 9: referrals, customer dashboard, public stats and badge, speed label, and the panel buttons.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.BOT_TOKEN = 'test-token';
process.env.ADMIN_IDS = '1';
process.env.PUBLIC_STATS = 'true';
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'stage9-')));

const { initStore, db } = await import('../src/store.js');
await initStore();
const refs = await import('../src/referrals.js');
const dash = await import('../src/dashboard.js');
const pub = await import('../src/publicstats.js');
const { _ui } = await import('../src/bot.js');

const DAY = 86400000;

// ---------- speed label ----------
test('speed label: thresholds', () => {
  assert.match(pub.speedLabel(120), /Lightning/);
  assert.match(pub.speedLabel(800), /Fast/);
  assert.match(pub.speedLabel(2000), /Slow/);
  assert.match(pub.speedLabel(9000), /Very slow/);
});

// ---------- referrals ----------
test('referrals: a new customer who came through a link gives the referrer free days', () => {
  const referrer = { id: 'r1', status: 'connected', expiresAt: Date.now() + 2 * DAY };
  db.customers.r1 = referrer;
  const code = refs.refCodeOf(referrer);
  assert.match(code, /^[0-9a-f]{8}$/);
  assert.equal(refs.refCodeOf(referrer), code, 'the code stays the same');

  const newbie = { id: 'n1' };
  db.customers.n1 = newbie;
  const before = referrer.expiresAt;
  const r = refs.applyReferral(newbie, `ref_${code}`);
  assert.deepEqual(r, { referrerId: 'r1', days: refs.REWARD_DAYS });
  assert.equal(newbie.referredBy, 'r1');
  assert.equal(referrer.expiresAt, before + refs.REWARD_DAYS * DAY);
  assert.equal(referrer.refRewards, 1);
  assert.equal(refs.referralStats(referrer).invited, 1);
});

test('referrals: self-referral, bad codes and a second use are refused', () => {
  const me = { id: 'm1' };
  db.customers.m1 = me;
  const code = refs.refCodeOf(me);
  assert.equal(refs.applyReferral({ id: 'm1' }, `ref_${code}`), null, 'no reward for your own link');
  assert.equal(refs.applyReferral({ id: 'x' }, 'ref_zzzz'), null);
  assert.equal(refs.applyReferral({ id: 'x' }, ''), null);
  const other = { id: 'o1' };
  db.customers.o1 = other;
  const c2 = refs.refCodeOf(other);
  const once = { id: 'x2' };
  assert.ok(refs.applyReferral(once, `ref_${c2}`));
  assert.equal(refs.applyReferral(once, `ref_${c2}`), null, 'a customer can only be referred once');
});

test('referrals: a referrer gets at most MAX_REWARDS rewards', () => {
  const r = { id: 'cap', status: 'connected' };
  db.customers.cap = r;
  const code = refs.refCodeOf(r);
  for (let i = 0; i < refs.MAX_REWARDS; i++) assert.ok(refs.applyReferral({ id: `cap-${i}` }, `ref_${code}`));
  assert.equal(refs.applyReferral({ id: 'cap-extra' }, `ref_${code}`), null);
});

// ---------- dashboard ----------
test('dashboard: shows the customer numbers and escapes the name', () => {
  const cust = {
    id: 'd1',
    name: '<img src=x onerror=alert(1)>',
    status: 'connected',
    plan: 'pro',
    groups: { 'g1@g.us': {}, 'g2@g.us': {} },
    day: { msgs: 12, deleted: 3, warned: 1, removed: 0 },
    weekly: { msgs: 90, deleted: 9, warned: 4, removed: 1 },
    sites: [{ url: 'https://x.test/', up: true, checks: 2, okChecks: 2 }],
  };
  const html = dash.dashboardHtml(cust);
  assert.ok(!html.includes('<img src=x'), 'the name is escaped');
  assert.ok(html.includes('&lt;img'));
  assert.match(html, /Messages checked<\/th><td>12/);
  assert.match(html, /x\.test/);
  assert.ok(!html.includes('@g.us'), 'group ids are not shown');
});

test('dashboard route: unknown token 404, the owner token opens the page', () => {
  const cust = { id: 'd2', name: 'Two' };
  const token = dash.newDashToken(cust);
  const customers = { d2: cust };
  const make = () => {
    const out = { status: 0, type: '', body: '' };
    return {
      out,
      res: {
        writeHead(s, h) {
          out.status = s;
          out.type = h?.['Content-Type'] || '';
        },
        end(b) {
          out.body = b;
        },
      },
    };
  };
  const bad = make();
  dash.handleDash({ url: `/dash/${'a'.repeat(40)}` }, bad.res, customers);
  assert.equal(bad.out.status, 404);
  const ok = make();
  dash.handleDash({ url: `/dash/${token}` }, ok.res, customers);
  assert.equal(ok.out.status, 200);
  assert.match(ok.out.type, /text\/html/);
  assert.match(ok.out.body, /Two/);
});

// ---------- public stats ----------
test('public stats: totals only, and the badge and page are generated', () => {
  db.customers.s1 = { id: 's1', status: 'connected', groupList: {}, groups: { 'a@g.us': {} }, guard: {} };
  db.customers.s2 = { id: 's2', status: 'expired', groupList: {}, groups: {}, guard: {} };
  const now = Date.now();
  db.daily = {
    [new Date(now).toISOString().slice(0, 10)]: { msgs: 40 },
    '2020-01-01': { msgs: 999 },
  };
  const snap = pub.statsSnapshot(now);
  assert.equal(snap.connected, Object.values(db.customers).filter((c) => c.status === 'connected').length);
  assert.equal(snap.weekMsgs, 40, 'days older than a week are not counted');
  const html = pub.renderStatsHtml(snap);
  assert.ok(!html.includes('s1') && !html.includes('@g.us'), 'no ids or groups in the page');
  assert.match(pub.badgeSvg('group guard', 'online 1d'), /<svg/);
  assert.match(pub.badgeSvg('a<b', 'x'), /a&lt;b/, 'labels are escaped');
});

test('public stats route: off by default setting is a 404, on serves the page and badge', () => {
  const run = (url, enabled) => {
    const out = { status: 0, body: '', type: '' };
    const handled = pub.handlePublicRoute(
      { url },
      { writeHead(s, h) { out.status = s; out.type = h?.['Content-Type'] || ''; }, end(b) { out.body = b; } },
      enabled
    );
    return { handled, out };
  };
  assert.equal(run('/stats', false).out.status, 404);
  const page = run('/stats', true);
  assert.equal(page.out.status, 200);
  assert.match(page.out.type, /text\/html/);
  assert.match(run('/badge.svg', true).out.type, /svg/);
  assert.equal(run('/other', true).handled, false, 'other URLs are left for the rest of the server');
});

// ---------- panel ----------
test('settings has the invite and dashboard buttons', () => {
  const cbs = _ui.settingsKb().inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(cbs.includes('ref'));
  assert.ok(cbs.includes('dash'));
});
