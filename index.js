import http from 'http';
import config from './config.js';

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
http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  })
  .listen(PORT, () => console.log(`Health page on port ${PORT}`));

process.on('unhandledRejection', (e) => console.error('Unhandled:', e?.message || e));

const { initStore, flush } = await import('./src/store.js');
await initStore();

const { bot, wireEvents, setupMenu } = await import('./src/bot.js');
const { startAll } = await import('./src/guard.js');

// Render sends SIGTERM on every deploy/restart: save first
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    await flush();
    process.exit(0);
  });
}

wireEvents();
setupMenu();
bot.start({ onStart: (me) => console.log(`✅ Telegram bot @${me.username} is running.`) });
startAll().then(() => console.log('WhatsApp sessions restored.'));
