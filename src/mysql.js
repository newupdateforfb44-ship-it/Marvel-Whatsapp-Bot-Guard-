// Optional MySQL connection. If MYSQL_URL is not set, the bot falls back to local files.
import mysql from 'mysql2/promise';
import config from '../config.js';

export const sqlEnabled = Boolean(config.MYSQL_URL);
let poolPromise = null;

export function getPool() {
  if (!poolPromise) {
    poolPromise = (async () => {
      const u = new URL(config.MYSQL_URL);
      const pool = mysql.createPool({
        host: u.hostname,
        port: Number(u.port) || 3306,
        user: decodeURIComponent(u.username),
        password: decodeURIComponent(u.password),
        database: decodeURIComponent(u.pathname.replace(/^\//, '')),
        waitForConnections: true,
        connectionLimit: 5,
        enableKeepAlive: true,
        ssl: config.MYSQL_SSL ? { minVersion: 'TLSv1.2', rejectUnauthorized: false } : undefined,
      });
      await pool.query(
        'CREATE TABLE IF NOT EXISTS kv (k VARCHAR(64) PRIMARY KEY, v LONGTEXT NOT NULL)'
      );
      await pool.query(
        'CREATE TABLE IF NOT EXISTS auth (id VARCHAR(255) PRIMARY KEY, cid VARCHAR(32) NOT NULL, v LONGTEXT NOT NULL, INDEX (cid))'
      );
      return pool;
    })();
  }
  return poolPromise;
}
