import config from './config.js';

if (!config.BOT_TOKEN) {
  console.error('BOT_TOKEN is missing. Put it in config.js or set the BOT_TOKEN environment variable.');
  process.exit(1);
}
if (!config.ADMIN_IDS.length) {
  console.error('ADMIN_IDS is missing. Add your Telegram numeric ID (get it from @userinfobot).');
  process.exit(1);
}

const { bot, wireEvents, setupMenu } = await import('./src/bot.js');
const { startAll } = await import('./src/guard.js');

process.on('unhandledRejection', (e) => console.error('Unhandled:', e?.message || e));

wireEvents();
setupMenu();
bot.start({ onStart: (me) => console.log(`✅ Telegram bot @${me.username} is running.`) });
startAll().then(() => console.log('WhatsApp sessions restored.'));
