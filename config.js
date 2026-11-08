// ===== EDIT THIS FILE (or set the same names as environment variables on your host) =====
export default {
  // Telegram bot token from @BotFather
  BOT_TOKEN: process.env.BOT_TOKEN || '',

  // Telegram numeric IDs of the admins (get yours from @userinfobot).
  // Env example: ADMIN_IDS=123456789,987654321
  ADMIN_IDS: (process.env.ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),

  // Link shown on the "Contact admin" button, e.g. https://t.me/your_username
  ADMIN_CONTACT_URL: process.env.ADMIN_CONTACT_URL || '',

  // How many customers can connect a WhatsApp number at the start.
  // Admin can change this later inside the Telegram bot.
  DEFAULT_MAX_CUSTOMERS: 10,

  // Starting protection settings for every new customer (they can change them in the bot)
  DEFAULT_GUARD: {
    blockAllLinks: true, // true = all links, false = only WhatsApp invite links
    maxMentions: 5,      // delete messages tagging more people than this. 0 = off
    warnLimit: 3,        // warnings before removal. 0 = never remove
    adminsAllowed: true, // group admins may post links
  },

  // Texts shown by the bot. Admin can edit these inside the bot (Admin panel > Edit messages).
  DEFAULT_MESSAGES: {
    welcome:
      '👋 Welcome to Group Guard!\n\nI keep your WhatsApp group clean: I delete links and mass-tags, warn the sender, and remove repeat offenders.\n\nTap a button below to get started.',
    howItWorks:
      '📘 How it works\n\n1. Tap "Connect WhatsApp" and send me the number the guard will use (use a SEPARATE number, not your personal one).\n2. I give you a pairing code. In WhatsApp go to Linked devices > Link a device > Link with phone number instead, and enter the code.\n3. Add that number to your group and make it a group ADMIN.\n4. Use Settings here to choose what is blocked.',
    limitReached:
      '😔 Sorry, all slots are taken right now.\n\nPlease contact the admin to get access.',
  },
};
