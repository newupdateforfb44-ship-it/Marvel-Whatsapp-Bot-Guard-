import http from 'http';
import config from './config.js';
import { handleRedirect } from './src/utility.js';
import { handleHook } from './src/webhook.js';
import { handleDash } from './src/dashboard.js';
import { handlePublicRoute } from './src/publicstats.js';
import { db } from './src/store.js';

if (!config.BOT_TOKEN) {
  console.error('BOT_TOKEN is missing. Put it in config.js or set the BOT_TOKEN environment variable.');
  process.exit(1);
}
if (!config.ADMIN_IDS.length) {
  console.error('ADMIN_IDS is missing. Add your Telegram numeric ID (get it from @userinfobot).');
  process.exit(1);
}

// Small web page so hosts like Render see an open port, and your uptime pinger has something to call.
const PORT = process.env.PORT || 3000;
const server = http
  .createServer((req, res) => {
    // short links: /r/<code> counts a click and redirects
    if (String(req.url).startsWith('/r/')) return handleRedirect(req, res);
    // Stage 7: order notifications from your website
    if (String(req.url).startsWith('/hook/')) return handleHook(req, res);
    // Stage 9: customer dashboard, and the public stats page and badge (if PUBLIC_STATS=true)
    if (String(req.url).startsWith('/dash/')) return handleDash(req, res, db.customers);
    if (handlePublicRoute(req, res, config.PUBLIC_STATS)) return;
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  });

const { initStore, flush, startAutosave, save } = await import('./src/store.js');
await initStore();
startAutosave();
server.listen(PORT, () => console.log(`Health page on port ${PORT}`));

// Forgot the admin PIN? Set RESET_ADMIN_PIN=true, redeploy once, then remove the variable.
if (process.env.RESET_ADMIN_PIN === 'true' && db.settings.pin) {
  db.settings.pin = '';
  save();
  console.log('Admin PIN was reset. Remove RESET_ADMIN_PIN from your environment.');
}

const { reportError } = await import('./src/alerts.js');
const { bot, wireEvents, setupMenu } = await import('./src/bot.js');
const { startAll } = await import('./src/guard.js');
const { subscriptionTick } = await import('./src/subs.js');

// A bug in one feature must never take the whole bot down: log it, tell the owner, keep going.
// If it keeps crashing (more than 5 times in a minute) save and exit so the host restarts it cleanly.
process.on('unhandledRejection', (e) => reportError('unhandled', e));
let crashes = [];
process.on('uncaughtException', async (e) => {
  reportError('crash', e);
  crashes = crashes.filter((t) => Date.now() - t < 60000).concat(Date.now());
  if (crashes.length > 5) {
    await flush().catch((saveError) => console.error('Could not flush before crash exit:', saveError.message));
    process.exit(1);
  }
});

// Render sends SIGTERM on every deploy/restart: save first
let shuttingDown = false;
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await flush();
      process.exit(0);
    } catch (e) {
      console.error('Could not save data during shutdown:', e.message);
      process.exit(1);
    }
  });
}

wireEvents();
setupMenu();
bot.start({ onStart: (me) => console.log(`✅ Telegram bot @${me.username} is running.`) });

// expire first, so ended subscriptions are not started again after a restart
await subscriptionTick().catch((e) => reportError('subscriptions', e));
startAll().then(() => console.log('WhatsApp sessions restored.'));
setInterval(() => subscriptionTick().catch((e) => reportError('subscriptions', e)), 10 * 60 * 1000);

// Stage 7: website uptime (checks every minute, each site on its own random 5 to 14 minute schedule),
// storage cleanup, and the daily backup to the owners at 03:00 UTC
const { runAllSites } = await import('./src/uptime.js');
const { pruneStorage } = await import('./src/cleanup.js');
const { sendBackup } = await import('./src/backup.js');
setInterval(() => runAllSites().catch((e) => reportError('uptime', e)), 60 * 1000);
pruneStorage();
setInterval(() => pruneStorage(), 60 * 60 * 1000);
let lastBackupAttemptAt = 0;
async function runDailyBackup() {
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  if (now.getUTCHours() < 3 || db.lastBackupDay === day || Date.now() - lastBackupAttemptAt < 60 * 60 * 1000) return;
  lastBackupAttemptAt = Date.now();
  const delivered = await sendBackup(bot.api);
  if (!delivered) throw new Error('Daily backup could not be delivered to every configured owner.');
  db.lastBackupDay = day;
  save();
}
void runDailyBackup().catch((e) => reportError('backup', e));
const backupTimer = setInterval(() => runDailyBackup().catch((e) => reportError('backup', e)), 5 * 60 * 1000);
backupTimer.unref?.();
