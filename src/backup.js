// Stage 7: backup and restore. A backup is the whole database, always encrypted (needs DATA_KEY).
// Daily at 03:00 UTC the owners get the file on Telegram. The owner can also restore from a file.
import { InputFile } from 'grammy';
import config from '../config.js';
import { db, save } from './store.js';
import { sealText, openText, encryptionOn } from './crypto.js';

const NEED_KEY = 'Backups need DATA_KEY. Set it in the host environment first, then try again.';

export function makeBackup(now = Date.now()) {
  if (!encryptionOn()) return { error: NEED_KEY };
  const body = JSON.stringify({ format: 'gg-backup', v: 1, t: now, db });
  const day = new Date(now).toISOString().slice(0, 10);
  return { buf: Buffer.from(sealText(body), 'utf8'), name: `groupguard-${day}.bak` };
}

export function restoreBackup(text) {
  if (!encryptionOn()) return { error: NEED_KEY };
  const plain = openText(String(text || '').trim());
  if (plain === null) return { error: 'This backup cannot be opened with the current DATA_KEY.' };
  let data;
  try {
    data = JSON.parse(plain);
  } catch {
    return { error: 'This is not a backup file.' };
  }
  if (data?.format !== 'gg-backup' || !data.db || typeof data.db !== 'object') return { error: 'This is not a backup file.' };
  for (const k of Object.keys(data.db)) if (k in db) db[k] = data.db[k];
  save();
  return { ok: true, customers: Object.keys(db.customers).length, t: data.t };
}

// Sends the backup to every owner. Used by the daily job and the Backup button.
export async function sendBackup(api) {
  const r = makeBackup();
  let delivered = config.ADMIN_IDS.length > 0 && !r.error;
  for (const id of config.ADMIN_IDS) {
    try {
      if (r.error) await api.sendMessage(id, `⚠️ ${r.error}`);
      else await api.sendDocument(id, new InputFile(r.buf, r.name), { caption: '💾 Backup of Group Guard. Keep it private.' });
    } catch {
      delivered = false;
    }
  }
  return delivered;
}
