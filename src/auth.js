// WhatsApp login storage: MySQL when MYSQL_URL is set, otherwise local files.
import { useMultiFileAuthState, initAuthCreds, BufferJSON, proto } from '@whiskeysockets/baileys';
import fs from 'fs';
import { sqlEnabled, getPool } from './mysql.js';

const authDir = (cid) => `./auth/${cid}`;

async function useSqlAuthState(cid) {
  const pool = await getPool();
  const id = (name) => `${cid}:${name}`;
  const write = (data, name) =>
    pool.query('INSERT INTO auth (id, cid, v) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)', [
      id(name),
      String(cid),
      JSON.stringify(data, BufferJSON.replacer),
    ]);
  const read = async (name) => {
    const [rows] = await pool.query('SELECT v FROM auth WHERE id = ?', [id(name)]);
    return rows.length ? JSON.parse(rows[0].v, BufferJSON.reviver) : null;
  };
  const remove = (name) => pool.query('DELETE FROM auth WHERE id = ?', [id(name)]);

  const creds = (await read('creds')) || initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (i) => {
              let value = await read(`${type}-${i}`);
              if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
              data[i] = value;
            })
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const cat in data) {
            for (const i in data[cat]) {
              const v = data[cat][i];
              tasks.push(v ? write(v, `${cat}-${i}`) : remove(`${cat}-${i}`));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => write(creds, 'creds'),
  };
}

export const getAuth = (cid) => (sqlEnabled ? useSqlAuthState(cid) : useMultiFileAuthState(authDir(cid)));

export async function wipeAuth(cid) {
  if (sqlEnabled) await (await getPool()).query('DELETE FROM auth WHERE cid = ?', [String(cid)]);
  else fs.rmSync(authDir(cid), { recursive: true, force: true });
}
