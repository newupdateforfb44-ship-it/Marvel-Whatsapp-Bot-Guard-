// ===== EDIT THIS FILE (or set the same names as environment variables on your host) =====
export default {
  // Telegram bot token from @BotFather
  BOT_TOKEN: process.env.BOT_TOKEN || '',

  // Telegram numeric IDs of the admins (get yours from @userinfobot).
  // Env example: ADMIN_IDS=123456789,987654321
  ADMIN_IDS: (process.env.ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),

  // MySQL connection link (recommended on Render, so logins and data survive restarts).
  // Looks like: mysql://user:password@host:3306/database
  // Leave empty to use local files instead.
  MYSQL_URL: process.env.MYSQL_URL || '',
  // Most online MySQL hosts require a secure connection. Set MYSQL_SSL=false only if yours does not.
  MYSQL_SSL: process.env.MYSQL_SSL !== 'false',
  // Optional PEM-encoded CA certificate for database providers using a private CA.
  MYSQL_CA: process.env.MYSQL_CA || '',

  // Public address of this service, used for short links (example: https://your-app.onrender.com)
  PUBLIC_URL: process.env.PUBLIC_URL || '',
  // Stage 9: show the public stats page (/stats) and uptime badge (/badge.svg). Totals only. Off unless true.
  PUBLIC_STATS: process.env.PUBLIC_STATS === 'true',
  // Stage 7: secret key for encrypting WhatsApp logins in the database and backup files (AES-256). Keep it safe:
  // if it changes, saved logins cannot be opened and the numbers must be paired again. Backups need it.
  DATA_KEY: process.env.DATA_KEY || '',
  // Stage 8: AI assistant and voice-note transcripts. Any OpenAI-compatible service works. Off without AI_API_KEY.
  AI_API_KEY: process.env.AI_API_KEY || '',
  AI_BASE_URL: process.env.AI_BASE_URL || '',   // default https://api.openai.com/v1
  AI_MODEL: process.env.AI_MODEL || '',         // chat model for questions and summaries
  AI_STT_MODEL: process.env.AI_STT_MODEL || '', // speech-to-text model for voice notes
  // Optional keys for lookups. Without a key, that lookup says it is off. Weather, dictionary, wiki and translate need none.
  OMDB_KEY: process.env.OMDB_KEY || '',
  NEWS_KEY: process.env.NEWS_KEY || '',
  YOUTUBE_KEY: process.env.YOUTUBE_KEY || '',

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
    adminsAllowed: true, // group admins are exempt from every rule

    // New in 2.1. All OFF until the customer switches them on, so nothing changes for existing customers.
    floodLimit: 0,       // max messages per sender per 10 seconds. 0 = off
    maxLength: 0,        // max characters in one message. 0 = off
    maxEmoji: 0,         // max emojis in one message. 0 = off
    blockForwards: false,
    blockStatusMention: false,
    blockMedia: { image: false, video: false, sticker: false, audio: false, document: false, contact: false },
    badWordsOn: false,
    commands: true,      // WhatsApp commands like .menu .tagall .kick
    prefix: '.',

    // New in 2.3 (Stage 3). All OFF (or empty) until the customer switches them on.
    groupMode: 'all',      // 'all' = protect groups up to the plan limit, 'allowed' = only groups added with an invite link
    antiNumbers: false,    // delete messages that share phone numbers
    slowMode: 0,           // seconds a member must wait between messages. 0 = off
    antiRaid: false,       // 10+ joins in a minute: close the group and alert the customer
    blockCountries: [],    // country-code prefixes (digits). Members joining with these are removed
    blacklist: [],         // numbers removed whenever they join or post
    muteAt: 0,             // mute after this many warnings. 0 = off (strike ladder: warn > mute > remove)
    muteMinutes: 60,
    nightOn: false,        // close protected groups at night, open them in the morning
    nightStart: 23,        // hour (0-23) the groups close
    nightEnd: 7,           // hour they open again
    nightTz: 'UTC',
    joinsPerHour: 5,       // groups a customer may add with an invite link, per hour
    lockdown: false,       // panic mode: strict rules + groups closed. Turned on from the bot or .lockdown

    // New in 2.4 (Stage 4). Private-chat features need privateChats on.
    privateChats: false,   // reply to private messages (greeting, auto-replies, sales, away, tickets)
    greetFirst: false,     // greet each private chat once
    greeting: '',          // first-contact greeting text
    awayOn: false,
    away: '',              // away reply (sent once per person every 6 hours)
    support: false,        // forward private messages to Telegram as tickets; reply in Telegram to answer
    salesOn: false,
    salesLink: '',         // main shop link (.shop, .buy and buy questions)
    salesTopics: [],       // [{ words: [...], link }] a link for a topic
    replies: [],           // [{ words: [...], reply }] auto-replies in private chats
    schedules: [],         // [{ time: 'HH:MM', text, on, lastRun }] posted to protected groups once a day
    welcome: '',           // posted when someone joins a protected group. {name} and {group} are filled in
    goodbye: '',           // posted when someone leaves or is removed
    rules: '',             // shown by .rules
    dailySummary: false,   // 9 pm summary of the day sent to you on Telegram

    // New in 2.5 (Stage 5)
    utilityDailyLimit: 0,  // lookups per member per day (weather, define, wiki, translate, movie, news, yts, site). 0 = no limit

    // New in 2.6 (Stage 6). All off until the customer switches them on.
    autoReact: false,      // react with an emoji to messages (at most once a minute per chat)
    alwaysOnline: false,   // keep the number shown as online
    autoRead: false,       // mark incoming messages as read
    bio: '',               // the WhatsApp "About" text of the number (139 characters max)
    autoTyping: false,     // show "typing..." before automatic private replies
    statusView: false,     // mark friends' statuses as seen (members of protected groups)
    statusLike: false,     // react to statuses with an emoji (at most one every 20 seconds)

    // New in 2.8 (Stage 8)
    signature: '',         // added at the end of the menu, the first greeting and AI answers, e.g. "Powered by Marvel"
    scamScan: false,       // delete messages with suspicious links (short links, look-alike letters, scam wording)
    aiOn: false,           // .ai answers questions; .transcribe makes a transcript of a replied voice note
    aiPersonality: 'friendly', // friendly, formal, fun or teacher
    aiDailyLimit: 20,      // AI calls per day for the customer (questions and transcripts). 0 = no limit
  },

  // Time zones offered for night mode
  TIME_ZONES: ['UTC', 'America/New_York', 'Europe/London', 'Africa/Lagos', 'Asia/Dubai', 'Asia/Kolkata'],

  // Subscription plans. maxGroups = how many groups the guard protects (0 = unlimited).
  // The owner can still override the group limit per customer in the Admin panel.
  PLANS: {
    trial: { label: 'Trial', maxGroups: 2 },
    basic: { label: 'Basic', maxGroups: 5 },
    pro: { label: 'Pro', maxGroups: 20 },
    vip: { label: 'VIP', maxGroups: 0 },
  },

  // Global switches (the owner changes these in Admin panel > Global settings). Stage 2.
  DEFAULT_GLOBAL: {
    maintenance: false,        // customers see the maintenance message; the guard keeps protecting groups
    requireSubscription: false, // OFF = nobody expires, exactly like before Stage 2
    trialDays: 3,              // free trial given to a new customer on first connect (only when subscriptions are required)
    errorAlerts: true,         // owner gets Telegram alerts for errors, drops and new customers
  },

  // Texts shown by the bot. Admin can edit these inside the bot (Admin panel > Edit messages).
  DEFAULT_MESSAGES: {
    welcome:
      '👋 Welcome to Group Guard!\n\nI keep your WhatsApp group clean: I delete links and mass-tags, warn the sender, and remove repeat offenders.\n\nTap a button below to get started.',
    howItWorks:
      '📘 How it works\n\n1. Tap "Connect WhatsApp" and send me the number the guard will use (use a SEPARATE number, not your personal one).\n2. I give you a pairing code. In WhatsApp go to Linked devices > Link a device > Link with phone number instead, and enter the code.\n3. Add that number to your group and make it a group ADMIN.\n4. Use Settings here to choose what is blocked.',
    limitReached:
      '😔 Sorry, all slots are taken right now.\n\nPlease contact the admin to get access.',
    maintenance:
      '🚧 The bot is under maintenance for a short while.\n\nYour groups stay protected. Please try again later.',
    expired:
      '⏰ Your subscription is not active.\n\nPlease contact the admin to subscribe or renew.',
  },
};
