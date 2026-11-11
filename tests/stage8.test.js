// Stage 8: scam and link scanner, AI assistant and transcripts (fake service), signature, panel.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.BOT_TOKEN = 'test-token';
process.env.ADMIN_IDS = '1';
process.env.AI_API_KEY = 'test-ai-key';
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'stage8-')));

const { initStore } = await import('../src/store.js');
await initStore();
const scanner = await import('../src/scanner.js');
const { detect } = await import('../src/rules.js');
const ai = await import('../src/ai.js');
const { withSignature } = ai;
const { _ui } = await import('../src/bot.js');

// ---------- scanner ----------
test('scanner: ordinary links pass; risky ones are named', () => {
  assert.equal(scanner.riskyLink('see https://example.com/page'), null);
  assert.equal(scanner.riskyLink('no link here'), null);
  assert.match(scanner.riskyLink('go to http://192.168.1.10/login'), /IP address/);
  assert.match(scanner.riskyLink('https://bit.ly/abc123'), /short link/);
  assert.match(scanner.riskyLink('https://pаypal.xn--com-9o0a.test'), /look-alike/);
  assert.match(scanner.riskyLink('https://paypal.com@evil.test/x'), /login hidden/);
  assert.match(scanner.riskyLink('https://claim.it.zip'), /risky domain/);
  assert.match(scanner.riskyLink('https://a.b.c.d.example.com/'), /subdomains/);
  assert.match(scanner.riskyLink('free nitro, claim now: https://example.com'), /scam wording/);
  assert.equal(scanner.riskyLink('free nitro with no link'), null, 'wording alone is not enough');
});

test('scanner in the rules: only when the owner switches it on', () => {
  const base = { blockAllLinks: false };
  assert.equal(detect({ ...base, scamScan: false }, { text: 'https://bit.ly/x' }), null);
  const hit = detect({ ...base, scamScan: true }, { text: 'https://bit.ly/x' });
  assert.equal(hit.rule, 'scam');
  assert.match(hit.reason, /suspicious link/);
});

// ---------- AI ----------
function fakeFetch(handler) {
  const calls = [];
  ai._setFetch(async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  });
  return calls;
}
const okJson = (body) => ({ ok: true, json: async () => body });

test('ask: sends the question with the key, returns the answer; errors are short messages', async () => {
  const calls = fakeFetch(() => okJson({ choices: [{ message: { content: ' Hello there ' } }] }));
  const r = await ai.askAi('hi?', 'fun');
  assert.equal(r.text, 'Hello there');
  assert.match(calls[0].url, /\/chat\/completions$/);
  assert.equal(calls[0].init.headers.authorization, 'Bearer test-ai-key');
  const body = JSON.parse(calls[0].init.body);
  assert.match(body.messages[0].content, /playful/);
  assert.match(body.messages[0].content, /same language/);

  fakeFetch(() => ({ ok: false, status: 500 }));
  assert.match((await ai.askAi('hi')).error, /did not answer/);
  fakeFetch(() => {
    throw new Error('network down');
  });
  assert.match((await ai.askAi('hi')).error, /did not answer/);
});

test('transcribe: sends the audio as a file and returns the text', async () => {
  const calls = fakeFetch(() => okJson({ text: 'Meeting at nine' }));
  const r = await ai.transcribe(Buffer.from('ogg-bytes'), 'audio/ogg');
  assert.equal(r.text, 'Meeting at nine');
  assert.match(calls[0].url, /audio\/transcriptions$/);
  assert.ok(calls[0].init.body instanceof FormData);
  assert.equal(calls[0].init.body.get('model'), 'whisper-1');
  fakeFetch(() => okJson({}));
  assert.match((await ai.transcribe(Buffer.from('x'))).error, /Could not transcribe/);
});

test('daily AI limit counts every call; 0 means no limit', () => {
  const cust = {};
  const now = Date.parse('2026-11-11T12:00:00Z');
  assert.equal(ai.aiAllowed(cust, 2, now), true);
  assert.equal(ai.aiAllowed(cust, 2, now), true);
  assert.equal(ai.aiAllowed(cust, 2, now), false);
  assert.equal(ai.aiAllowed(cust, 2, now + 86400000), true, 'a new day starts again');
  assert.equal(ai.aiAllowed(cust, 0, now), true);
});

test('signature: added when set, nothing when empty', () => {
  assert.equal(withSignature({ signature: 'Powered by Marvel' }, 'Hi'), 'Hi\n\n— Powered by Marvel');
  assert.equal(withSignature({ signature: '' }, 'Hi'), 'Hi');
  assert.ok(ai.PERSONALITY_KEYS.includes('friendly'));
});

// ---------- panel ----------
test('AI & safety screen: switches, limit and personality buttons with short callbacks', () => {
  const c = { guard: { aiPersonality: 'friendly', aiDailyLimit: 20 } };
  const cbs = _ui.screenView(c, 'ai').kb.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(cbs.includes('t:ai:aiOn'));
  assert.ok(cbs.includes('t:ai:scamScan'));
  assert.ok(cbs.includes('n:ai:aiDailyLimit:50'));
  for (const k of ai.PERSONALITY_KEYS) assert.ok(cbs.includes(`aip:${k}`));
  for (const cb of cbs) assert.ok(Buffer.byteLength(cb) <= 64, cb);
  const settings = _ui.settingsKb().inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(settings.includes('sc:ai'));
});
