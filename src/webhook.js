// Stage 7: order notifications. Your website sends a POST with JSON {"text": "New order #123"} to your
// private link, and you get it on Telegram. The link is random and can be replaced at any time.
import crypto from 'crypto';
import { db, markDirty } from './store.js';
import { events } from './wa.js';

const MAX_BODY = 4096;
const TEXT_MAX = 300;
const hits = new Map(); // token -> recent request times (30 per minute)

export const newHookToken = (cust) => {
  cust.hookToken = crypto.randomBytes(20).toString('hex');
  markDirty();
  return cust.hookToken;
};

function allowHit(token, now = Date.now()) {
  const arr = (hits.get(token) || []).filter((t) => now - t < 60000);
  const ok = arr.length < 30;
  if (ok) arr.push(now);
  hits.set(token, arr);
  if (hits.size > 1000) hits.clear();
  return ok;
}

export function handleHook(req, res) {
  const m = String(req.url || '').match(/^\/hook\/([0-9a-f]{40})$/);
  let done = false;
  const finish = (code, msg) => {
    if (done) return true;
    done = true;
    res.writeHead(code, { 'Content-Type': 'text/plain' });
    res.end(msg);
    return true;
  };
  if (!m) return finish(404, 'Not found');
  if (req.method !== 'POST') return finish(405, 'POST only');
  const cust = Object.values(db.customers).find((c) => c.hookToken && c.hookToken === m[1]);
  if (!cust) return finish(404, 'Not found');
  if (!allowHit(m[1])) return finish(429, 'Too many requests');

  let size = 0;
  const chunks = [];
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY) finish(413, 'Too large');
    else chunks.push(c);
  });
  req.on('error', () => finish(400, 'Bad request'));
  req.on('end', () => {
    if (done) return;
    let data;
    try {
      data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return finish(400, 'Send JSON');
    }
    const text = String(data?.text ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, TEXT_MAX);
    if (!text) return finish(400, 'Missing text');
    events.emit('order', cust.id, text);
    finish(200, 'ok');
  });
  return true;
}
