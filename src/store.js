// Database: customers, settings, warnings, stats, logs. MySQL when MYSQL_URL is set, otherwise a local file.
import fs from 'fs';
import config from '../config.js';
import { sqlEnabled, getPool } from './mysql.js';

const DATA_DIR = './data';
const FILE = `${DATA_DIR}/db.json`;

export const db = {
  settings: {
    ...config.DEFAULT_GLOBAL,
    maxCustomers: config.DEFAULT_MAX_CUSTOMERS,
    messages: { ...config.DEFAULT_MESSAGES },
    staff: [],
    pin: '',
  },
  customers: {},
  warnings: {},
  daily: {}, // 'YYYY-MM-DD' -> { msgs, deleted, warned, removed, cmds }
  log: [], // admin actions + important events (newest last, capped)
  errors: [], // recent errors (capped)
  mutes: {}, // 'cid|group|number' -> time the mute ends (Stage 3)
  evidence: [], // what was deleted and why, newest last, capped (Stage 3)
  activity: {}, // 'cid|group' -> { number: { n: messages, t: last time } } (Stage 3)
  greeted: {}, // 'cid|number' -> time of the first-contact greeting (Stage 4)
  birthdays: {}, // 'cid|group|number' -> 'MM-DD' (Stage 4)
  ticketSeq: 0, // support ticket numbers (Stage 4)
  shorts: {}, // short code -> { cid, url, clicks, t } (Stage 5)
  notes: {}, // 'cid|group' -> { notes: [], todos: [] } (Stage 5)
  utilDay: '', // day the lookup counters belong to (Stage 5)
  utilUse: {}, // 'cid|number' -> lookups today (Stage 5)
  lastBackupDay: '', // last UTC day a backup was successfully delivered
};

// Older customers get the newer settings filled in with their defaults.
function migrateGuard(c) {
  const d = structuredClone(config.DEFAULT_GUARD);
  const g = c.guard || {};
  c.guard = { ...d, ...g, blockMedia: { ...d.blockMedia, ...(g.blockMedia || {}) }, allowed: g.allowed || [], badWords: g.badWords || [] };
}

// Stage 2 fields (plan, expiry, limits, usage). Cheap, safe to call often.
export function ensureShape(c) {
  c.plan ??= '';
  c.expiresAt ??= null;
  c.trialUsed ??= false;
  c.reminded ??= {};
  c.limits ??= {};
  c.groups ??= {};
  c.stats ??= { msgs: 0, deleted: 0, warned: 0, removed: 0, cmds: 0 };
  c.suspendReason ??= '';
  c.banReason ??= '';
  c.groupList ??= {}; // Stage 3: groups added with an invite link ('allowed' mode) and their pause state
  c.joinLog ??= []; // times of invite-link joins (for the per-hour limit)
  c.day ??= { msgs: 0, deleted: 0, warned: 0, removed: 0 }; // counted today, sent in the 9 pm summary (Stage 4)
  c.daily ??= { birthday: '', summary: '' }; // which day the daily jobs last ran (Stage 4)
  return c;
}

export async function initStore() {
  let raw = {};
  if (sqlEnabled) {
    const [rows] = await (await getPool()).query("SELECT v FROM kv WHERE k = 'db'");
    raw = rows.length ? JSON.parse(rows[0].v) : {};
  } else {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    try {
      raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Persisted database has an invalid top-level JSON value; refusing to initialize empty data.');
  }
  const s = raw.settings || {};
  db.settings = {
    ...config.DEFAULT_GLOBAL,
    ...s,
    maxCustomers: s.maxCustomers ?? config.DEFAULT_MAX_CUSTOMERS,
    messages: { ...config.DEFAULT_MESSAGES, ...(s.messages || {}) },
    staff: Array.isArray(s.staff) ? s.staff.map(String) : [],
    pin: typeof s.pin === 'string' ? s.pin : '',
  };
  db.customers = raw.customers || {};
  for (const c of Object.values(db.customers)) {
    migrateGuard(c);
    ensureShape(c);
  }
  db.warnings = raw.warnings || {};
  db.daily = raw.daily || {};
  db.log = Array.isArray(raw.log) ? raw.log : [];
  db.errors = Array.isArray(raw.errors) ? raw.errors : [];
  db.mutes = raw.mutes && typeof raw.mutes === 'object' ? raw.mutes : {};
  db.evidence = Array.isArray(raw.evidence) ? raw.evidence : [];
  db.activity = raw.activity && typeof raw.activity === 'object' ? raw.activity : {};
  db.greeted = raw.greeted && typeof raw.greeted === 'object' ? raw.greeted : {};
  db.birthdays = raw.birthdays && typeof raw.birthdays === 'object' ? raw.birthdays : {};
  db.ticketSeq = Number(raw.ticketSeq) || 0;
  db.shorts = raw.shorts && typeof raw.shorts === 'object' ? raw.shorts : {};
  db.notes = raw.notes && typeof raw.notes === 'object' ? raw.notes : {};
  db.utilDay = typeof raw.utilDay === 'string' ? raw.utilDay : '';
  db.utilUse = raw.utilUse && typeof raw.utilUse === 'object' ? raw.utilUse : {};
  db.lastBackupDay = typeof raw.lastBackupDay === 'string' ? raw.lastBackupDay : '';
  console.log(`Storage: ${sqlEnabled ? 'MySQL' : 'local files'}`);
}

let timer = null;
let dirty = false;
let generation = 0;
let chain = Promise.resolve();
async function write(snapshot) {
  if (sqlEnabled) {
    await (await getPool()).query(
      "INSERT INTO kv (k, v) VALUES ('db', ?) ON DUPLICATE KEY UPDATE v = VALUES(v)",
      [snapshot]
    );
  } else {
    fs.writeFileSync(`${FILE}.tmp`, snapshot);
    fs.renameSync(`${FILE}.tmp`, FILE);
  }
}
export function flush() {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!dirty) return chain;
  const savedGeneration = generation;
  const snapshot = JSON.stringify(db);
  const task = chain.catch(() => {}).then(() => write(snapshot));
  chain = task.then(
    () => {
      if (generation === savedGeneration) dirty = false;
    },
    (e) => {
      dirty = true;
      console.error('Could not save data:', e.message);
      throw e;
    }
  );
  return chain;
}
export function save() {
  markDirty();
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { void flush().catch(() => {}); }, 300);
}

// Counters change on every message: do not write the whole database each time. They are saved
// by the autosave below (every 2 minutes, only if something changed) and when the bot stops.
export const markDirty = () => {
  dirty = true;
  generation++;
};
export function startAutosave() {
  setInterval(() => {
    if (dirty) void flush().catch(() => {});
  }, 2 * 60 * 1000).unref();
}

// Admin actions and important events (shown in Admin panel > Logs).
export function addLog(kind, text, cid = '') {
  db.log.push({ t: Date.now(), kind, text: String(text).slice(0, 300), cid: String(cid || '') });
  if (db.log.length > 500) db.log.splice(0, db.log.length - 500);
  save();
}

export const usedSlots = () =>
  Object.values(db.customers).filter((c) => c.number && c.status !== 'banned').length;

export function ensureCustomer(u) {
  const id = String(u.id);
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ');
  let c = db.customers[id];
  if (!c) {
    c = db.customers[id] = ensureShape({
      id,
      name,
      username: u.username || '',
      number: null,
      status: 'none', // none | pairing | connected | disconnected | expired | suspended | banned
      everConnected: false,
      createdAt: Date.now(),
      guard: { ...structuredClone(config.DEFAULT_GUARD), allowed: [], badWords: [] },
    });
    save();
  } else if (c.name !== name || c.username !== (u.username || '')) {
    c.name = name;
    c.username = u.username || '';
    save();
  }
  return c;
}

export function removeCustomer(id) {
  delete db.customers[id];
  for (const k of Object.keys(db.warnings)) if (k.startsWith(`${id}|`)) delete db.warnings[k];
  for (const k of Object.keys(db.mutes)) if (k.startsWith(`${id}|`)) delete db.mutes[k];
  for (const k of Object.keys(db.activity)) if (k.startsWith(`${id}|`)) delete db.activity[k];
  for (const k of Object.keys(db.greeted)) if (k.startsWith(`${id}|`)) delete db.greeted[k];
  for (const k of Object.keys(db.birthdays)) if (k.startsWith(`${id}|`)) delete db.birthdays[k];
  for (const k of Object.keys(db.notes)) if (k.startsWith(`${id}|`)) delete db.notes[k];
  for (const k of Object.keys(db.shorts)) if (db.shorts[k].cid === String(id)) delete db.shorts[k];
  db.evidence = db.evidence.filter((e) => e.cid !== String(id));
  save();
}
