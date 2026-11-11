// Stage 5 customer panel: the tools screen, its limit buttons, the short-links button, and the settings entry.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.BOT_TOKEN = 'test-token';
process.env.ADMIN_IDS = '1';
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'panel5-')));

const config = (await import('../config.js')).default;
const { initStore } = await import('../src/store.js');
await initStore();
const { _ui } = await import('../src/bot.js');

const buttons = (kb) => kb.inline_keyboard.flat();

test('tools screen shows the daily limit row with its options', () => {
  const c = { guard: structuredClone(config.DEFAULT_GUARD) };
  const v = _ui.screenView(c, 'util');
  const cbs = buttons(v.kb).map((b) => b.callback_data);
  for (const n of [0, 10, 25, 50]) assert.ok(cbs.includes(`n:util:utilityDailyLimit:${n}`), `missing option ${n}`);
  assert.ok(cbs.includes('shl'), 'short links button');
  assert.ok(cbs.includes('settings'), 'back button');
  assert.match(v.text, /Tools & lookups/);
});

test('every callback on the tools screen fits Telegram limit (64 bytes)', () => {
  const c = { guard: structuredClone(config.DEFAULT_GUARD) };
  for (const b of buttons(_ui.screenView(c, 'util').kb)) {
    if (b.callback_data) assert.ok(Buffer.byteLength(b.callback_data) <= 64, b.callback_data);
  }
});

test('the selected limit is marked on the tools screen', () => {
  const c = { guard: { ...structuredClone(config.DEFAULT_GUARD), utilityDailyLimit: 25 } };
  const row = buttons(_ui.screenView(c, 'util').kb).find((b) => b.callback_data === 'n:util:utilityDailyLimit:25');
  assert.match(row.text, /✅/);
});

test('settings has an entry to the tools screen', () => {
  const cbs = buttons(_ui.settingsKb()).map((b) => b.callback_data);
  assert.ok(cbs.includes('sc:util'));
});
