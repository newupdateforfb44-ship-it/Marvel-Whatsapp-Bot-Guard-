// Telegram side: customer menu + admin panel, all driven by buttons.
import { Bot, InlineKeyboard, Keyboard } from 'grammy';
import config from '../config.js';
import { db, save, usedSlots, ensureCustomer, removeCustomer } from './store.js';
import { startSession, stopSession, events } from './guard.js';

export const bot = new Bot(config.BOT_TOKEN);

const isAdmin = (id) => config.ADMIN_IDS.map(String).includes(String(id));
const msgs = () => db.settings.messages;
const waiting = new Map(); // telegram id -> what we are waiting the user to type
const esc = (t) => String(t).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

const cancelKb = () => new InlineKeyboard().text('⬅️ Cancel', 'home');
const contactBtn = (kb) => (config.ADMIN_CONTACT_URL ? kb.url('📞 Contact admin', config.ADMIN_CONTACT_URL).row() : kb);

async function show(ctx, text, kb, extra = {}) {
  const opts = { reply_markup: kb, ...extra };
  try {
    if (ctx.callbackQuery) await ctx.editMessageText(text, opts);
    else await ctx.reply(text, opts);
  } catch (e) {
    if (String(e.message).includes('not modified')) return;
    try {
      await ctx.reply(text, opts);
    } catch {}
  }
}

// ---------- customer: home ----------
async function showHome(ctx) {
  const c = ensureCustomer(ctx.from);
  const kb = new InlineKeyboard();
  let text = msgs().welcome;

  if (c.status === 'banned') {
    text = '🚫 Your access has been blocked. Please contact the admin.';
    contactBtn(kb);
  } else {
    if (c.status === 'connected') {
      text += `\n\n✅ Connected: +${c.number}`;
      kb.text('⚙️ Settings', 'settings').row().text('🔌 Disconnect', 'disc').row();
    } else {
      kb.text('➕ Connect WhatsApp', 'connect').row();
    }
    kb.text('📘 How it works', 'how').row();
    contactBtn(kb);
    if (isAdmin(ctx.from.id)) kb.text('🛠 Admin panel', 'a:home').row();
  }
  await show(ctx, text, kb);
}

// ---------- customer: connect ----------
async function onConnect(ctx) {
  const c = ensureCustomer(ctx.from);
  if (c.status === 'banned' || c.status === 'connected') return showHome(ctx);

  const hasSlot = c.number || isAdmin(ctx.from.id) || usedSlots() < db.settings.maxCustomers;
  if (!hasSlot) return show(ctx, msgs().limitReached, contactBtn(new InlineKeyboard()).text('⬅️ Back', 'home'));

  waiting.set(String(ctx.from.id), { type: 'number' });
  await show(
    ctx,
    '📱 Send me the WhatsApp number the guard will use.\n\nInclude the country code, digits only. Example: 2348012345678\n\nUse a SEPARATE number, not your personal one.',
    cancelKb()
  );
}

async function onNumber(ctx, text) {
  const c = ensureCustomer(ctx.from);
  const num = text.replace(/\D/g, '');
  if (num.length < 8 || num.length > 15) {
    return ctx.reply('That does not look like a valid number. Send it with the country code, digits only.', {
      reply_markup: cancelKb(),
    });
  }
  if (Object.values(db.customers).some((x) => x.id !== c.id && x.number === num)) {
    return ctx.reply('That number is already in use by another account. Send a different number.', {
      reply_markup: cancelKb(),
    });
  }
  waiting.delete(String(ctx.from.id));
  await stopSession(c.id, { wipe: true });
  c.number = num;
  c.status = 'pairing';
  save();
  await ctx.reply('⏳ Generating your pairing code, one moment...');
  try {
    await startSession(c.id, { pairNumber: num });
  } catch (e) {
    console.error('startSession failed:', e.message);
    c.status = c.everConnected ? 'disconnected' : 'none';
    if (!c.everConnected) c.number = null;
    save();
    await ctx.reply('⚠️ Could not start the connection. Please try again.', {
      reply_markup: new InlineKeyboard().text('➕ Try again', 'connect'),
    });
  }
}

// ---------- customer: settings ----------
const yn = (v) => (v ? 'Yes' : 'No');

function settingsText(c) {
  const g = c.guard;
  return (
    `⚙️ Settings for +${c.number}\n\n` +
    `🔗 Links: ${g.blockAllLinks ? 'delete ALL links' : 'delete only WhatsApp group invite links'}\n` +
    `🏷 Max tags per message: ${g.maxMentions > 0 ? g.maxMentions : 'off'}\n` +
    `⚠️ Warnings before removal: ${g.warnLimit > 0 ? g.warnLimit : 'never remove'}\n` +
    `👮 Group admins may post links: ${yn(g.adminsAllowed)}\n` +
    `✅ Allowed numbers: ${g.allowed.length}`
  );
}

function settingsKb(c) {
  const g = c.guard;
  const mark = (on, t) => (on ? '✅ ' : '') + t;
  return new InlineKeyboard()
    .text(g.blockAllLinks ? '🔗 Block: all links (tap to change)' : '🔗 Block: invite links only (tap to change)', 'set:links')
    .row()
    .text('🏷 Max tags:', 'noop')
    .text(mark(g.maxMentions === 0, 'Off'), 'set:ment:0')
    .text(mark(g.maxMentions === 3, '3'), 'set:ment:3')
    .text(mark(g.maxMentions === 5, '5'), 'set:ment:5')
    .text(mark(g.maxMentions === 10, '10'), 'set:ment:10')
    .row()
    .text('⚠️ Warns:', 'noop')
    .text(mark(g.warnLimit === 0, 'Never'), 'set:warn:0')
    .text(mark(g.warnLimit === 2, '2'), 'set:warn:2')
    .text(mark(g.warnLimit === 3, '3'), 'set:warn:3')
    .text(mark(g.warnLimit === 5, '5'), 'set:warn:5')
    .row()
    .text(`👮 Admins may post links: ${yn(g.adminsAllowed)}`, 'set:adm')
    .row()
    .text('✅ Allowed numbers', 'allowed')
    .row()
    .text('⬅️ Back', 'home');
}

async function showSettings(ctx) {
  const c = ensureCustomer(ctx.from);
  if (c.status !== 'connected') return showHome(ctx);
  await show(ctx, settingsText(c), settingsKb(c));
}

async function showAllowed(ctx) {
  const c = ensureCustomer(ctx.from);
  const kb = new InlineKeyboard();
  c.guard.allowed.forEach((n) => kb.text(`❌ +${n}`, `allow:del:${n}`).row());
  kb.text('➕ Add numbers', 'allow:add').row().text('⬅️ Back', 'settings');
  await show(
    ctx,
    '✅ Allowed numbers can post links and tag people freely.\n\n' +
      (c.guard.allowed.length ? 'Tap a number to remove it.' : 'No numbers added yet.'),
    kb
  );
}

// ---------- admin ----------
async function adminHome(ctx) {
  const all = Object.values(db.customers);
  const connected = all.filter((c) => c.status === 'connected').length;
  const text =
    `🛠 Admin panel\n\n` +
    `Slots used: ${usedSlots()} / ${db.settings.maxCustomers}\n` +
    `Connected now: ${connected}\n` +
    `Total users: ${all.length}`;
  const kb = new InlineKeyboard()
    .text('👥 Customers', 'a:list:0')
    .row()
    .text('🎚 Set customer limit', 'a:limit')
    .row()
    .text('✏️ Edit messages', 'a:msgs')
    .row()
    .text('📢 Broadcast', 'a:cast')
    .row()
    .text('⬅️ Home', 'home');
  await show(ctx, text, kb);
}

const PAGE = 8;
async function adminList(ctx, page) {
  const list = Object.values(db.customers)
    .filter((c) => c.number || c.status === 'banned')
    .sort((a, b) => b.createdAt - a.createdAt);
  const slice = list.slice(page * PAGE, page * PAGE + PAGE);
  const kb = new InlineKeyboard();
  slice.forEach((c) => kb.text(`${c.name || c.username || c.id} • ${c.status}`, `a:c:${c.id}`).row());
  if (page > 0) kb.text('◀️ Prev', `a:list:${page - 1}`);
  if ((page + 1) * PAGE < list.length) kb.text('Next ▶️', `a:list:${page + 1}`);
  if (page > 0 || (page + 1) * PAGE < list.length) kb.row();
  kb.text('⬅️ Back', 'a:home');
  await show(ctx, list.length ? `👥 Customers (${list.length})` : '👥 No customers yet.', kb);
}

async function adminCustomer(ctx, id) {
  const c = db.customers[id];
  if (!c) return adminList(ctx, 0);
  const text =
    `👤 ${c.name || '(no name)'}${c.username ? ` @${c.username}` : ''}\n` +
    `Telegram ID: ${c.id}\n` +
    `WhatsApp: ${c.number ? '+' + c.number : '-'}\n` +
    `Status: ${c.status}\n` +
    `Joined: ${new Date(c.createdAt).toISOString().slice(0, 10)}`;
  const kb = new InlineKeyboard();
  if (c.status === 'banned') kb.text('✅ Unblock', `a:unban:${id}`);
  else kb.text('🚫 Block', `a:ban:${id}`);
  kb.row().text('🗑 Remove customer', `a:del:${id}`).row().text('⬅️ Back', 'a:list:0');
  await show(ctx, text, kb);
}

const MSG_LABELS = { welcome: 'Welcome message', howItWorks: 'How it works', limitReached: 'Limit reached message' };

async function adminMsgs(ctx) {
  const kb = new InlineKeyboard();
  Object.entries(MSG_LABELS).forEach(([k, label]) => kb.text(`✏️ ${label}`, `a:edit:${k}`).row());
  kb.text('⬅️ Back', 'a:home');
  await show(ctx, '✏️ Which message do you want to edit?', kb);
}

// ---------- button router ----------
async function route(ctx, data) {
  const uid = String(ctx.from.id);
  const p = data.split(':');
  if (data !== 'noop') waiting.delete(uid);

  if (p[0] === 'a') {
    if (!isAdmin(uid)) return;
    switch (p[1]) {
      case 'home':
        return adminHome(ctx);
      case 'list':
        return adminList(ctx, Number(p[2]) || 0);
      case 'c':
        return adminCustomer(ctx, p[2]);
      case 'ban': {
        const c = db.customers[p[2]];
        if (c) {
          await stopSession(c.id, { wipe: true, logout: true });
          c.status = 'banned';
          save();
          bot.api.sendMessage(c.id, '🚫 Your access has been blocked by the admin.').catch(() => {});
        }
        return adminCustomer(ctx, p[2]);
      }
      case 'unban': {
        const c = db.customers[p[2]];
        if (c) {
          c.status = 'disconnected';
          save();
          bot.api.sendMessage(c.id, '✅ Your access is back. Open the bot and tap Connect WhatsApp.').catch(() => {});
        }
        return adminCustomer(ctx, p[2]);
      }
      case 'del': {
        if (p[2] === 'yes') {
          await stopSession(p[3], { wipe: true, logout: true });
          removeCustomer(p[3]);
          return adminList(ctx, 0);
        }
        return show(
          ctx,
          'Remove this customer and unlink their WhatsApp? This cannot be undone.',
          new InlineKeyboard().text('🗑 Yes, remove', `a:del:yes:${p[2]}`).row().text('⬅️ No', `a:c:${p[2]}`)
        );
      }
      case 'limit': {
        if (p[2] === 'set') {
          db.settings.maxCustomers = Number(p[3]);
          save();
          return adminHome(ctx);
        }
        if (p[2] === 'custom') {
          waiting.set(uid, { type: 'limit' });
          return show(ctx, 'Type the new customer limit (a number):', new InlineKeyboard().text('⬅️ Cancel', 'a:home'));
        }
        const kb = new InlineKeyboard();
        [5, 10, 20, 50].forEach((n) => kb.text(String(n), `a:limit:set:${n}`));
        kb.row().text('✍️ Custom number', 'a:limit:custom').row().text('⬅️ Back', 'a:home');
        return show(
          ctx,
          `🎚 Customer limit: ${db.settings.maxCustomers}\nSlots used: ${usedSlots()}\n\nWhen the limit is reached, new customers see the "limit reached" message and are told to contact you.`,
          kb
        );
      }
      case 'msgs':
        return adminMsgs(ctx);
      case 'edit': {
        const key = p[2];
        if (!MSG_LABELS[key]) return;
        waiting.set(uid, { type: 'edit', key });
        return show(
          ctx,
          `Current ${MSG_LABELS[key]}:\n\n${msgs()[key]}\n\n— Send the new text now.`,
          new InlineKeyboard().text('↩️ Reset to default', `a:reset:${key}`).row().text('⬅️ Cancel', 'a:msgs')
        );
      }
      case 'reset': {
        if (MSG_LABELS[p[2]]) {
          db.settings.messages[p[2]] = config.DEFAULT_MESSAGES[p[2]];
          save();
        }
        return adminMsgs(ctx);
      }
      case 'cast':
        waiting.set(uid, { type: 'cast' });
        return show(ctx, '📢 Send the message to broadcast to ALL users of this bot.', new InlineKeyboard().text('⬅️ Cancel', 'a:home'));
    }
    return;
  }

  switch (p[0]) {
    case 'home':
      return showHome(ctx);
    case 'noop':
      return;
    case 'how':
      return show(ctx, msgs().howItWorks, new InlineKeyboard().text('⬅️ Back', 'home'));
    case 'connect':
      return onConnect(ctx);
    case 'settings':
      return showSettings(ctx);
    case 'disc': {
      const c = ensureCustomer(ctx.from);
      if (p[1] === 'yes') {
        await stopSession(c.id, { wipe: true, logout: true });
        c.status = 'none';
        c.number = null;
        save();
        return show(ctx, '🔌 Disconnected. Your WhatsApp number was unlinked.', new InlineKeyboard().text('⬅️ Home', 'home'));
      }
      return show(
        ctx,
        'Disconnect your WhatsApp number? The guard will stop working in your groups.',
        new InlineKeyboard().text('🔌 Yes, disconnect', 'disc:yes').row().text('⬅️ No', 'home')
      );
    }
    case 'set': {
      const c = ensureCustomer(ctx.from);
      if (c.status !== 'connected') return showHome(ctx);
      const g = c.guard;
      if (p[1] === 'links') g.blockAllLinks = !g.blockAllLinks;
      if (p[1] === 'adm') g.adminsAllowed = !g.adminsAllowed;
      if (p[1] === 'ment') g.maxMentions = Number(p[2]);
      if (p[1] === 'warn') g.warnLimit = Number(p[2]);
      save();
      return showSettings(ctx);
    }
    case 'allowed':
      return showAllowed(ctx);
    case 'allow': {
      const c = ensureCustomer(ctx.from);
      if (p[1] === 'del') {
        c.guard.allowed = c.guard.allowed.filter((n) => n !== p[2]);
        save();
        return showAllowed(ctx);
      }
      if (p[1] === 'add') {
        waiting.set(uid, { type: 'allow' });
        return show(
          ctx,
          'Send the numbers to allow, with country code, digits only. You can send several separated by spaces or commas.',
          new InlineKeyboard().text('⬅️ Cancel', 'allowed')
        );
      }
    }
  }
}

// ---------- events from the WhatsApp side ----------
export function wireEvents() {
  events.on('pairing-code', (cid, code) => {
    const c = db.customers[cid];
    bot.api
      .sendMessage(
        cid,
        `🔑 <b>Your pairing code</b>\n\n<code>${esc(code)}</code>\n\nOn the phone with +${esc(c?.number || '')}:\nWhatsApp > Linked devices > Link a device > <b>Link with phone number instead</b>, then enter the code.\n\nThe code expires in about 3 minutes.`,
        { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('⬅️ Home', 'home') }
      )
      .catch(() => {});
  });

  events.on('pairing-failed', (cid, why) => {
    const c = db.customers[cid];
    if (c) {
      c.status = c.everConnected ? 'disconnected' : 'none';
      if (!c.everConnected) c.number = null;
      save();
    }
    console.error(`[${cid}] pairing failed:`, why);
    bot.api
      .sendMessage(cid, '⚠️ The pairing code expired or failed. Tap the button to try again.', {
        reply_markup: new InlineKeyboard().text('➕ Connect WhatsApp', 'connect'),
      })
      .catch(() => {});
  });

  events.on('open', (cid) => {
    const c = db.customers[cid];
    if (!c || c.status === 'connected') return;
    c.status = 'connected';
    c.everConnected = true;
    save();
    bot.api
      .sendMessage(
        cid,
        `✅ Connected! +${c.number} is linked.\n\nNow add that number to your WhatsApp group and make it a group ADMIN. Then adjust what gets blocked in Settings.`,
        { reply_markup: new InlineKeyboard().text('⚙️ Settings', 'settings').row().text('⬅️ Home', 'home') }
      )
      .catch(() => {});
  });

  events.on('logged-out', (cid) => {
    const c = db.customers[cid];
    if (!c || c.status === 'none') return;
    c.status = 'disconnected';
    save();
    bot.api
      .sendMessage(cid, '⚠️ Your WhatsApp number was unlinked. Tap the button to connect it again.', {
        reply_markup: new InlineKeyboard().text('➕ Connect WhatsApp', 'connect'),
      })
      .catch(() => {});
  });
}

// ---------- telegram handlers ----------
bot.use(async (ctx, next) => {
  if (ctx.chat?.type && ctx.chat.type !== 'private') return; // only work in private chat
  await next();
});

bot.on('callback_query:data', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  await route(ctx, ctx.callbackQuery.data);
});

const MENU_LABEL = '📋 Menu';

// /start: first a small message that pins the "Menu" button at the bottom, then the welcome with all buttons
bot.command('start', async (ctx) => {
  waiting.delete(String(ctx.from.id));
  await ctx.reply('👇 Tap "Menu" below anytime to see all the buttons.', {
    reply_markup: new Keyboard().text(MENU_LABEL).resized().persistent(),
  });
  await showHome(ctx);
});

// /menu (also listed in Telegram's Menu button): show all the buttons again
bot.command('menu', async (ctx) => {
  waiting.delete(String(ctx.from.id));
  await showHome(ctx);
});

bot.on('message:text', async (ctx) => {
  const uid = String(ctx.from.id);
  const st = waiting.get(uid);
  const text = ctx.message.text.trim();

  if (text === MENU_LABEL) {
    waiting.delete(uid);
    return showHome(ctx);
  }

  if (!st || text.startsWith('/')) {
    waiting.delete(uid);
    return showHome(ctx); // any message shows the menu with buttons
  }

  if (st.type === 'number') return onNumber(ctx, text);

  if (st.type === 'allow') {
    const c = ensureCustomer(ctx.from);
    const nums = text.split(/[\s,;]+/).map((n) => n.replace(/\D/g, '')).filter((n) => n.length >= 8 && n.length <= 15);
    if (!nums.length) return ctx.reply('No valid numbers found. Try again.', { reply_markup: new InlineKeyboard().text('⬅️ Cancel', 'allowed') });
    c.guard.allowed = [...new Set([...c.guard.allowed, ...nums])];
    waiting.delete(uid);
    save();
    return showAllowed(ctx);
  }

  if (!isAdmin(uid)) return;

  if (st.type === 'limit') {
    const n = parseInt(text, 10);
    if (!Number.isInteger(n) || n < 0 || n > 100000) return ctx.reply('Send a whole number, for example 25.');
    db.settings.maxCustomers = n;
    waiting.delete(uid);
    save();
    return adminHome(ctx);
  }

  if (st.type === 'edit') {
    if (text.length > 3500) return ctx.reply('Too long. Keep it under 3500 characters.');
    db.settings.messages[st.key] = text;
    waiting.delete(uid);
    save();
    await ctx.reply('✅ Saved.');
    return adminMsgs(ctx);
  }

  if (st.type === 'cast') {
    waiting.delete(uid);
    let sent = 0;
    for (const c of Object.values(db.customers)) {
      try {
        await bot.api.sendMessage(c.id, text);
        sent++;
      } catch {}
      await new Promise((r) => setTimeout(r, 60));
    }
    await ctx.reply(`📢 Sent to ${sent} users.`);
    return adminHome(ctx);
  }
});

// Telegram's own "Menu" button next to the text box
export async function setupMenu() {
  try {
    await bot.api.setMyCommands([
      { command: 'start', description: 'Start the bot' },
      { command: 'menu', description: 'Show all buttons' },
    ]);
    await bot.api.setChatMenuButton({ menu_button: { type: 'commands' } });
  } catch (e) {
    console.error('Could not set menu:', e.message);
  }
}

bot.catch((err) => console.error('Telegram error:', err.message));
