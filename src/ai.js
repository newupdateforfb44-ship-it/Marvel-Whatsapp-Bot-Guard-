// Stage 8: AI assistant and voice-note transcripts. Works with any OpenAI-compatible service the owner
// sets up in the host environment: AI_API_KEY, AI_BASE_URL, AI_MODEL, AI_STT_MODEL. Off without a key.
import config from '../config.js';
import { markDirty } from './store.js';

const PERSONALITIES = {
  friendly: 'You are a friendly, helpful assistant.',
  formal: 'You are a formal, precise assistant.',
  fun: 'You are a playful assistant who uses light humour.',
  teacher: 'You are a patient teacher who explains step by step.',
};
export const PERSONALITY_KEYS = Object.keys(PERSONALITIES);
export const aiReady = () => Boolean(config.AI_API_KEY);

let http = (...a) => fetch(...a);
export const _setFetch = (fn) => {
  http = fn || ((...a) => fetch(...a));
};
const base = () => (config.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
const KEY_MISSING = 'The owner has not set AI_API_KEY, so the assistant is off.';

async function call(url, init) {
  try {
    const r = await http(url, { ...init, signal: AbortSignal.timeout(30000) });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

// One answer from the model. The personality sets the tone; the answer follows the language of the question.
export async function complete(system, user, personality = 'friendly') {
  if (!aiReady()) return { error: KEY_MISSING };
  const body = {
    model: config.AI_MODEL || 'gpt-4o-mini',
    max_tokens: 300,
    messages: [
      { role: 'system', content: `${PERSONALITIES[personality] || PERSONALITIES.friendly} ${system} Answer in the same language as the question.` },
      { role: 'user', content: String(user).slice(0, 2000) },
    ],
  };
  const r = await call(`${base()}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.AI_API_KEY}` },
    body: JSON.stringify(body),
  });
  const text = r?.choices?.[0]?.message?.content;
  if (!text) return { error: 'The assistant did not answer. Try again later.' };
  return { text: String(text).trim().slice(0, 900) };
}

export const askAi = (question, personality) =>
  complete('Keep the answer short (under 800 characters).', question, personality);
export const summarize = (text) => complete('Summarise the text in three short bullet points.', text);

export async function transcribe(buf, mime = 'audio/ogg') {
  if (!aiReady()) return { error: KEY_MISSING };
  const form = new FormData();
  form.append('model', config.AI_STT_MODEL || 'whisper-1');
  form.append('file', new Blob([buf], { type: mime }), 'voice.ogg');
  const r = await call(`${base()}/audio/transcriptions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.AI_API_KEY}` },
    body: form,
  });
  return r?.text ? { text: String(r.text).trim().slice(0, 2000) } : { error: 'Could not transcribe that voice note.' };
}

// Daily limit per customer: every AI call (questions and transcripts) counts. 0 = no limit.
export function aiAllowed(cust, limit, now = Date.now()) {
  if (!(limit > 0)) return true;
  const day = new Date(now).toISOString().slice(0, 10);
  const u = cust.aiUse?.day === day ? cust.aiUse : { day, n: 0 };
  cust.aiUse = u;
  if (u.n >= limit) return false;
  u.n++;
  markDirty();
  return true;
}

// The signature line ("Powered by ...") added to the menu, greeting and AI answers
export const withSignature = (g, text) => (g.signature ? `${text}\n\n— ${g.signature}` : text);
