// Shared Telegram helpers (used by the customer screens in bot.js and the admin panel in admin.js).
import { Bot, InlineKeyboard } from 'grammy';
import config from '../config.js';
import { db } from './store.js';

export const bot = new Bot(config.BOT_TOKEN);

const ownerIds = () => config.ADMIN_IDS.map(String);
export const isOwner = (id) => ownerIds().includes(String(id));
export const isStaff = (id) => (db.settings.staff || []).includes(String(id));
export const canAdmin = (id) => isOwner(id) || isStaff(id);

export const msgs = () => db.settings.messages;
export const waiting = new Map(); // telegram id -> what we are waiting the user to type
export const esc = (t) => String(t).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

export const cancelKb = () => new InlineKeyboard().text('⬅️ Cancel', 'home');
export const contactBtn = (kb) => (config.ADMIN_CONTACT_URL ? kb.url('📞 Contact admin', config.ADMIN_CONTACT_URL).row() : kb);

export async function show(ctx, text, kb, extra = {}) {
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

// Message every owner (used for alerts).
export function notifyOwners(text) {
  for (const id of ownerIds()) bot.api.sendMessage(id, text).catch(() => {});
}
