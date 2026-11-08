// Database: customers, settings, warnings. MongoDB when MONGODB_URI is set, otherwise a local file.
import fs from 'fs';
import config from '../config.js';
import { sqlEnabled, getPool } from './mysql.js';

const DATA_DIR = './data';
const FILE = `${DATA_DIR}/db.json`;

export const db = {
  settings: { maxCustomers: config.DEFAULT_MAX_CUSTOMERS, messages: { ...config.DEFAULT_MESSAGES } },
  customers: {},
  warnings: {},
};

export async function initStore() {
  let raw = {};
  try {
    if (sqlEnabled) {
      const [rows] = await (await getPool()).query("SELECT v FROM kv WHERE k = 'db'");
      raw = rows.length ? JSON.parse(rows[0].v) : {};
    } else {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    }
  } catch {}
  const s = raw.settings || {};
  db.settings = {
    maxCustomers: s.maxCustomers ?? config.DEFAULT_MAX_CUSTOMERS,
    messages: { ...config.DEFAULT_MESSAGES, ...(s.messages || {}) },
  };
  db.customers = raw.customers || {};
  db.warnings = raw.warnings || {};
  console.log(`Storage: ${sqlEnabled ? 'MySQL' : 'local files'}`);
}

let timer = null;
let chain = Promise.resolve();
async function write() {
  if (sqlEnabled) {
    await (await getPool()).query(
      "INSERT INTO kv (k, v) VALUES ('db', ?) ON DUPLICATE KEY UPDATE v = VALUES(v)",
      [JSON.stringify(db)]
    );
  } else {
    fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(db));
    fs.renameSync(`${FILE}.tmp`, FILE);
  }
}
export function flush() {
  timer = null;
  chain = chain.then(write).catch((e) => console.error('Could not save data:', e.message));
  return chain;
}
export function save() {
  if (!timer) timer = setTimeout(flush, 300);
}

export const usedSlots = () =>
  Object.values(db.customers).filter((c) => c.number && c.status !== 'banned').length;

export function ensureCustomer(u) {
  const id = String(u.id);
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ');
  let c = db.customers[id];
  if (!c) {
    c = db.customers[id] = {
      id,
      name,
      username: u.username || '',
      number: null,
      status: 'none', // none | pairing | connected | disconnected | banned
      everConnected: false,
      createdAt: Date.now(),
      guard: { ...config.DEFAULT_GUARD, allowed: [] },
    };
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
  save();
}
