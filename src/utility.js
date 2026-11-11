// Stage 5: utility commands (calculator, time, units, jokes, QR, lookups, short links, site checker, notes, to-dos).
// Lookups call public web services. Each one fails quietly when the service is down or no key is set.
import crypto from 'crypto';
import dns from 'dns/promises';
import net from 'net';
import tls from 'tls';
import config from '../config.js';
import { db, markDirty } from './store.js';

// ---------- calculator (no eval: a small parser) ----------
export function calc(expr) {
  const src = String(expr || '').replace(/\s+/g, '').toLowerCase();
  if (!src || src.length > 100 || !/^[0-9a-z.+\-*/%^()]+$/.test(src)) return null;
  let i = 0;
  const peek = () => src[i];
  const fnRe = /sqrt|abs|round/y;
  const FN = { sqrt: Math.sqrt, abs: Math.abs, round: Math.round };
  const primary = () => {
    if (peek() === '(') {
      i++;
      const v = expr1();
      if (peek() !== ')') throw new Error('missing )');
      i++;
      return v;
    }
    fnRe.lastIndex = i;
    const f = fnRe.exec(src);
    if (f && src[i + f[0].length] === '(') {
      i += f[0].length + 1;
      const v = expr1();
      if (peek() !== ')') throw new Error('missing )');
      i++;
      return FN[f[0]](v);
    }
    const m = /\d+(\.\d+)?/y;
    m.lastIndex = i;
    const n = m.exec(src);
    if (!n) throw new Error('bad token');
    i += n[0].length;
    return Number(n[0]);
  };
  const unary = () => {
    if (peek() === '-') return (i++, -unary());
    if (peek() === '+') return (i++, unary());
    return primary();
  };
  const power = () => {
    const b = unary();
    if (peek() === '^') return (i++, b ** power());
    return b;
  };
  const term = () => {
    let v = power();
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = src[i++];
      const r = power();
      v = op === '*' ? v * r : op === '/' ? v / r : v % r;
    }
    return v;
  };
  const expr1 = () => {
    let v = term();
    while (peek() === '+' || peek() === '-') {
      const op = src[i++];
      const r = term();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  };
  try {
    const v = expr1();
    if (i !== src.length || !Number.isFinite(v)) return null;
    return Number(v.toFixed(10));
  } catch {
    return null;
  }
}

// ---------- units ----------
const LINEAR = {
  km: ['m', 1000], mi: ['m', 1609.344], m: ['m', 1], ft: ['m', 0.3048], cm: ['m', 0.01], in: ['m', 0.0254],
  kg: ['g', 1000], g: ['g', 1], lb: ['g', 453.592], oz: ['g', 28.3495],
  l: ['ml', 1000], ml: ['ml', 1], gal: ['ml', 3785.41],
};
export function convert(value, from, to) {
  const a = String(from).toLowerCase();
  const b = String(to).toLowerCase();
  const v = Number(value);
  if (!Number.isFinite(v)) return null;
  if ((a === 'c' || a === 'f') && (b === 'c' || b === 'f')) {
    const r = a === b ? v : a === 'c' ? (v * 9) / 5 + 32 : ((v - 32) * 5) / 9;
    return Math.round(r * 10000) / 10000;
  }
  const x = LINEAR[a];
  const y = LINEAR[b];
  if (!x || !y || x[0] !== y[0]) return null;
  return Math.round(((v * x[1]) / y[1]) * 10000) / 10000;
}

// ---------- time ----------
const ZONES = { utc: 'UTC', ny: 'America/New_York', london: 'Europe/London', lagos: 'Africa/Lagos', dubai: 'Asia/Dubai', delhi: 'Asia/Kolkata', tokyo: 'Asia/Tokyo', sydney: 'Australia/Sydney' };
export function timeIn(zone, now = Date.now()) {
  const name = ZONES[String(zone || 'utc').toLowerCase()] || zone || 'UTC';
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: name, dateStyle: 'medium', timeStyle: 'short' }).format(now) + ` (${name})`;
  } catch {
    return null;
  }
}

// ---------- jokes, quotes ----------
const JOKES = [
  'Why do programmers prefer dark mode? Because light attracts bugs.',
  'I told my computer I needed a break. Now it will not stop sending me Kit-Kat ads.',
  'Why did the scarecrow win an award? He was outstanding in his field.',
  'What do you call a fake noodle? An impasta.',
  'Why don\'t skeletons fight each other? They don\'t have the guts.',
];
const QUOTES = [
  'The best time to plant a tree was 20 years ago. The second best time is now. (Chinese proverb)',
  'Well done is better than well said. (Benjamin Franklin)',
  'Small steps every day add up. (Anonymous)',
  'It always seems impossible until it is done. (Nelson Mandela)',
];
export const pick = (list, rnd = Math.random) => list[Math.floor(rnd() * list.length)];
export const joke = (rnd) => pick(JOKES, rnd);
export const quote = (rnd) => pick(QUOTES, rnd);

// ---------- QR ----------
export const qrUrl = (text) => `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(String(text).slice(0, 500))}`;

// ---------- network: the only outbound calls. Injectable for tests ----------
let http = (...a) => fetch(...a);
export const _setFetch = (fn) => {
  http = fn || ((...a) => fetch(...a));
};
async function getJson(url, timeoutMs = 8000) {
  try {
    const r = await http(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'GroupGuardBot/2.5' } });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

export const weather = async (place) => {
  const j = await getJson(`https://wttr.in/${encodeURIComponent(place)}?format=j1`);
  const c = j?.current_condition?.[0];
  if (!c) return null;
  return `🌤 ${place}: ${c.temp_C}°C (feels ${c.FeelsLikeC}°C), ${c.weatherDesc?.[0]?.value || ''}, humidity ${c.humidity}%`;
};
export const define = async (word) => {
  const j = await getJson(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
  const d = j?.[0]?.meanings?.[0];
  if (!d) return null;
  return `📖 ${j[0].word} (${d.partOfSpeech}): ${d.definitions[0].definition}`;
};
export const wiki = async (topic) => {
  const j = await getJson(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(topic.replace(/ /g, '_'))}`);
  if (!j?.extract) return null;
  return `📚 ${j.title}: ${j.extract.slice(0, 500)}\n${j.content_urls?.desktop?.page || ''}`;
};
export const translate = async (lang, text) => {
  const j = await getJson(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|${encodeURIComponent(lang)}`);
  const t = j?.responseData?.translatedText;
  return t ? `🌍 ${t}` : null;
};
export const movie = async (title) => {
  if (!config.OMDB_KEY) return 'The owner has not set OMDB_KEY, so movie info is off.';
  const j = await getJson(`https://www.omdbapi.com/?t=${encodeURIComponent(title)}&apikey=${encodeURIComponent(config.OMDB_KEY)}`);
  if (!j || j.Response === 'False') return null;
  return `🎬 ${j.Title} (${j.Year}) · IMDb ${j.imdbRating}\n${String(j.Plot || '').slice(0, 300)}`;
};
export const news = async () => {
  if (!config.NEWS_KEY) return 'The owner has not set NEWS_KEY, so news is off.';
  const j = await getJson(`https://newsapi.org/v2/top-headlines?country=us&pageSize=3&apiKey=${encodeURIComponent(config.NEWS_KEY)}`);
  const a = j?.articles || [];
  if (!a.length) return null;
  return `📰 Top headlines\n${a.map((x, i) => `${i + 1}. ${x.title}`).join('\n')}`;
};
export const youtube = async (q) => {
  if (!config.YOUTUBE_KEY) return 'The owner has not set YOUTUBE_KEY, so search is off.';
  const j = await getJson(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=3&q=${encodeURIComponent(q)}&key=${encodeURIComponent(config.YOUTUBE_KEY)}`);
  const items = j?.items || [];
  if (!items.length) return null;
  return `▶️ Results\n${items.map((x) => `• ${x.snippet.title}\n  https://youtu.be/${x.id.videoId}`).join('\n')}`;
};
// Lyrics: we only point to where they can be found. The lyrics text is not sent.
export const lyricsLink = (song) => `🎵 Find the lyrics here: https://www.google.com/search?q=${encodeURIComponent(`${song} lyrics`)}`;

// ---------- daily limit for lookups (0 = off) ----------
export function useLookup(cid, who, limit) {
  if (!(limit > 0)) return true;
  const day = new Date().toISOString().slice(0, 10);
  if (db.utilDay !== day) {
    db.utilDay = day;
    db.utilUse = {};
  }
  const k = `${cid}|${who}`;
  const n = (db.utilUse[k] || 0) + 1;
  db.utilUse[k] = n;
  markDirty();
  return n <= limit;
}

// ---------- short links with click counts (created by admins only) ----------
export const shortUrl = (code) => (config.PUBLIC_URL ? `${config.PUBLIC_URL.replace(/\/$/, '')}/r/${code}` : null);
export function createShort(cid, target) {
  if (!/^https?:\/\/\S+$/i.test(target) || target.length > 2000) return null;
  let code;
  do code = crypto.randomBytes(4).toString('hex');
  while (db.shorts[code]);
  db.shorts[code] = { cid: String(cid), url: target, clicks: 0, t: Date.now() };
  markDirty();
  return code;
}
// the redirect route: /r/<code> counts a click and sends the visitor on
export function handleRedirect(req, res) {
  const m = String(req.url || '').match(/^\/r\/([0-9a-f]{8})$/);
  const e = m && db.shorts[m[1]];
  if (!e) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }
  e.clicks++;
  markDirty();
  res.writeHead(302, { Location: e.url });
  res.end();
  return true;
}
export const linksOf = (cid) => Object.entries(db.shorts).filter(([, e]) => e.cid === String(cid));

// ---------- site checker (public websites only: blocks private and local addresses) ----------
export function isPrivateIp(ip) {
  if (net.isIPv6(ip)) return ip === '::1' || ip === '::' || /^f[cd]/i.test(ip) || /^fe80/i.test(ip);
  const p = ip.split('.').map(Number);
  return p[0] === 10 || p[0] === 127 || p[0] === 0 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) || (p[0] === 169 && p[1] === 254) || p[0] >= 224;
}
export async function isPublicHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h || h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return false;
  if (net.isIP(h)) return !isPrivateIp(h);
  try {
    const addrs = await dns.lookup(h, { all: true });
    return addrs.length > 0 && addrs.every((a) => !isPrivateIp(a.address));
  } catch {
    return false;
  }
}
async function certDaysLeft(host) {
  return new Promise((resolve) => {
    const sock = tls.connect({ host, port: 443, servername: host, rejectUnauthorized: false }, () => {
      const c = sock.getPeerCertificate();
      sock.end();
      resolve(c?.valid_to ? Math.floor((new Date(c.valid_to) - Date.now()) / 86400000) : null);
    });
    sock.setTimeout(6000, () => {
      sock.destroy();
      resolve(null);
    });
    sock.on('error', () => resolve(null));
  });
}
export async function checkSite(input, { allowPrivate = false } = {}) {
  let u;
  try {
    u = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    return { error: 'That does not look like a web address.' };
  }
  if (!allowPrivate && !(await isPublicHost(u.hostname))) return { error: 'I can only check public websites.' };
  const t0 = Date.now();
  let status;
  try {
    const r = await http(u.href, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
    status = r.status;
  } catch {
    return { error: `${u.hostname} did not answer.` };
  }
  const ms = Date.now() - t0;
  const ssl = u.protocol === 'https:' ? await certDaysLeft(u.hostname) : null;
  return { host: u.hostname, status, ms, ssl };
}
export const siteLine = (r) =>
  r.error
    ? `⚠️ ${r.error}`
    : `🌐 ${r.host}: ${r.status < 400 ? '✅ up' : '❌ error'} (HTTP ${r.status}) · ${r.ms} ms${r.ssl == null ? '' : ` · SSL valid ${r.ssl} days`}`;

// ---------- notes and to-dos (per group) ----------
const bucket = (cid, jid) => (db.notes[`${cid}|${jid}`] ||= { notes: [], todos: [] });
export const notesOf = (cid, jid) => bucket(cid, jid).notes;
export const todosOf = (cid, jid) => bucket(cid, jid).todos;
export function addNote(cid, jid, text) {
  const n = notesOf(cid, jid);
  n.push(String(text).slice(0, 300));
  if (n.length > 50) n.shift();
  markDirty();
}
export function addTodo(cid, jid, text) {
  const t = todosOf(cid, jid);
  t.push({ text: String(text).slice(0, 200), done: false });
  if (t.length > 50) t.shift();
  markDirty();
}
// returns the changed to-do or null (number is 1-based, as shown in the list)
export function toggleTodo(cid, jid, n) {
  const t = todosOf(cid, jid)[n - 1];
  if (!t) return null;
  t.done = !t.done;
  markDirty();
  return t;
}
export function delTodo(cid, jid, n) {
  const list = todosOf(cid, jid);
  if (!list[n - 1]) return false;
  list.splice(n - 1, 1);
  markDirty();
  return true;
}
