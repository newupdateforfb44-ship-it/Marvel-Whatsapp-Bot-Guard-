// Stage 7: encryption at rest. With DATA_KEY set, WhatsApp logins in the database and backup files are
// sealed with AES-256-GCM. Without it, values are stored as they are (same as before).
import crypto from 'crypto';
import config from '../config.js';

const PREFIX = 'enc1:';
const keyBytes = () => (config.DATA_KEY ? crypto.createHash('sha256').update(config.DATA_KEY).digest() : null);
export const encryptionOn = () => Boolean(config.DATA_KEY);

export function sealText(text) {
  const k = keyBytes();
  if (!k) return String(text);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', k, iv);
  const ct = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return PREFIX + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

// The plain text, or null when the value is sealed and this DATA_KEY cannot open it
export function openText(v) {
  if (typeof v !== 'string' || !v.startsWith(PREFIX)) return v;
  const k = keyBytes();
  if (!k) return null;
  try {
    const b = Buffer.from(v.slice(PREFIX.length), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', k, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}
