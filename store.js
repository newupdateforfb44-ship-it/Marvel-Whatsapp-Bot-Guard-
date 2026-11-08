// Tiny JSON database: customers, settings, warnings.
import fs from 'fs';
import config from '../config.js';

const DATA_DIR = './data';
const FILE = `${DATA_DIR}/db.json`;
fs.mkdirSync(DATA_DIR, { recursive: true });

let raw = {};
try {
  raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
} catch {}

const s = raw.settings || {};
export const db = {
  settings: {
    maxCustomers: s.maxCustomers ?? config.DEFAULT_MAX_CUSTOMERS,
    messages: { ...config.DEFAULT_MESSAGES, ...(s.messages || {}) },
  },
  customers: raw.customers || {},
  warnings: raw.warnings || {},
};

let timer = null;
function flush() {
  timer = null;
  try {
    fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(db));
    fs.renameSync(`${FILE}.tmp`, FILE);
  } catch (e) {
    console.error('Could not save data:', e.message);
  }
}
export function save() {
  if (!timer) timer = setTimeout(flush, 300);
}
process.on('exit', () => {
  if (timer) flush();
});

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
