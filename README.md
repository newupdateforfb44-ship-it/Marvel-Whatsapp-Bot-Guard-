# WA Group Guard Service

A Telegram bot where customers connect their own WhatsApp number. The guard then deletes links and mass-tags in their groups, warns the sender, and removes repeat offenders. Everything is button-driven.

## Setup
1. Create a Telegram bot with @BotFather and copy the token.
2. Get your numeric Telegram ID from @userinfobot.
3. Set these (environment variables on your host, or edit config.js):
   - `BOT_TOKEN`
   - `ADMIN_IDS` (comma separated)
   - `ADMIN_CONTACT_URL` (for example https://t.me/your_username)
4. `npm install` then `npm start`.

## What is new in 2.9 (Stage 9: business and growth)
- **Invite friends** (Settings > Invite friends): your link is `t.me/<bot>?start=ref_<code>`. When someone new starts the bot through it, you get 3 free days, up to 10 times. Free days only matter when subscriptions are required.
- **My dashboard** (Settings > My dashboard): a private, read-only page with your numbers for today and this week, your groups, websites, and invited friends. Anyone with the link can see it, so keep it private. Make a new link with **🔄 New link** if it leaks. It needs `PUBLIC_URL`.
- **Speed label**: `.ping` shows the response time and a label (Lightning, Fast, Slow, Very slow).
- **Public stats**: set `PUBLIC_STATS=true` and the host serves `/stats` (totals only) and `/badge.svg` (an uptime badge). Off by default.

Not included: resellers, the beta club, and a plugin system.

## What is new in 2.8 (Stage 8: AI and safety)
- **Setup (host environment)**: `AI_API_KEY`, and optionally `AI_BASE_URL` (default https://api.openai.com/v1), `AI_MODEL` and `AI_STT_MODEL` (the speech-to-text model). Any service with the OpenAI-style API works. Without a key the AI is off.
- **Assistant**: members type `.ai your question` once it is switched on in **Settings > AI & safety**. Pick a personality there: friendly, formal, fun or teacher. Answers follow the language of the question.
- **Transcripts**: an admin replies to a voice note with `.transcribe` to get the text and a short summary. The voice note is sent to your AI service.
- **Daily limit**: AI calls per customer per day (10, 20, 50, or no limit). Default 20.
- **Scam scanner**: in the same panel, delete messages with suspicious links. It checks for short links, IP addresses, look-alike letters, hidden logins, risky domain endings and scam wording next to a link. No outside lookups are made.
- **Signature**: set a line such as "Powered by Marvel" under Settings > Messages & links. It is added to the menu, the first greeting and AI answers.

Not included: image tools, AI replies in private chats.

## What is new in 2.7 (Stage 7: reliability, backups, uptime)
- **Encryption**: set `DATA_KEY` in your host's environment (a long random text). WhatsApp logins in the database are then encrypted. Keep the key safe. If it changes, saved logins cannot be opened and each number must be paired again.
- **Backups**: the owner can press **💾 Backup** in the admin panel. Every day at 03:00 UTC the backup is also sent to the owners on Telegram. Backups are always encrypted, so `DATA_KEY` must be set. **♻️ Restore** takes a backup file and replaces the data after a confirmation. Restart the bot afterwards.
- **Website uptime**: `.addsite example.com`, `.sites`, `.removesite 1` (admins). Up to 5 sites, each checked every 5 to 14 minutes. You get a Telegram message when a site goes down and when it is back. Private and local addresses are refused.
- **Order notifications**: in **Settings > Automation > Order webhook**, get your private link. Your website sends a POST with JSON `{"text": "New order #123"}` to it. Make a new link with **🔄 New link** if it leaks. It needs `PUBLIC_URL`.
- **Self-recovery**: a session stuck "connecting" for 10 minutes is restarted automatically.
- **Storage cleanup**: old logs and counters are removed every hour.

Not included: pinning the Baileys version (done on a real install), broadcasts into customers' groups, a public status page, and zero-downtime updates.

## What is new in 2.6 (Stage 6: automation)
In **Settings > Automation**. Everything is OFF until you switch it on.
- **Auto-react**: one emoji (👍 ❤️ 🔥 😂 🙏), at most once a minute per chat.
- **Always online** and **mark as read**: both change how the number looks to others.
- **Typing indicator** before automatic private replies.
- **Statuses**: mark members' statuses as seen, and react to them (one every 20 seconds). Post to your status with a scheduled post (write `status` after the time). The audience is members of your protected groups.
- **Bot bio**: the "About" text, applied within a minute.
- **Voice notes & stickers**: send a voice note or a sticker to the bot on Telegram, give it a short name, and use it as the whole message: `voice:name` or `sticker:name`, in replies, welcome or goodbye text, or scheduled posts. Members play a voice note with `.voice name`.
- **Replies with pictures**: add a picture link as a third part: `price, cost | Our prices | https://example.com/prices.jpg`.
- **Scheduled posts**: up to 5. Use `{days 2026-12-25}` for a countdown.
- **Reminders**: admins type `.remind 30m text` (minutes, hours or days; up to 7 days).

Not included: view-once saver, anti-delete, status saver, auto-forward, voice cloning, and tagging people in statuses. The bot does not recover content people hid or deleted, and it does not forward or clone other people's messages.

## What is new in 2.5 (Stage 5: tools and lookups)
Commands for everyone (in the group): `.calc`, `.time`, `.convert`, `.joke`, `.quote`, `.qr`, `.weather`, `.define`, `.wiki`, `.translate fr hello`, `.movie`, `.news`, `.yts`, `.lyrics`, `.site`, `.note`, `.todo`.
- **Setup**: weather, dictionary, wiki and translate need no keys. Movies, news and YouTube need `OMDB_KEY`, `NEWS_KEY` and `YOUTUBE_KEY` in your host's environment. Short links need `PUBLIC_URL` (your service's address, e.g. `https://your-app.onrender.com`).
- **Daily lookup limit**: in **Settings > Tools & lookups**, set how many lookups each member may make per day (off by default).
- **Short links**: only group admins can run `.short https://...`. Visitors to `/r/<code>` are sent on, and each click is counted. See the counts under "My short links".
- **Site checker**: `.site example.com` shows the status, response time and days left on the SSL certificate. Private and local addresses are refused.
- **Notes and to-dos**: kept per group. Anyone can add and tick items, and admins can delete to-dos.
- Not included: media downloaders and song or video downloads.

Things to know:
- Lookups send the search words to the outside service they use (for example wttr.in or Wikipedia).
- Short-link visits are redirected by the bot, so they only work while the bot is running.

## What is new in 2.4 (Stage 4: welcome, replies, sales, community)
In **Settings > Replies & sales**. Everything is OFF until you switch it on.
- **Private chats**: switch on "Reply to private chats" first. Then the switches below apply.
- **First-contact greeting**: each new private chat gets your greeting once.
- **Auto-replies**: a list of word groups and replies (example: `price, cost | Our prices are on the shop page.`). Each person gets the same reply at most once every 2 minutes.
- **Away reply**: sent to each person at most once every 6 hours.
- **Sales assistant**: when someone asks about buying ("how much", "buy", "where can I..."), I send your shop link. Add topic links too (example: `sms, numbers | https://your-shop/sms`). Each person gets a sales link at most once every 6 hours. Groups get it from `.shop` or `.buy`.
- **Support tickets**: private messages reach you on Telegram as "Ticket #n". Reply to that message in Telegram and the answer goes to the WhatsApp chat.
- **Welcome and goodbye** for protected groups (use `{name}` and `{group}`), plus `.rules` for your rules text.
- **Scheduled posts**: a message posted to every protected group once a day at a time you choose (`18:00 | text`). Time zone comes from Night mode.
- **Birthdays**: members send `.birthday DD-MM` in the group and get wished at 9 am.
- **Daily summary** at 9 pm on Telegram: messages checked, deleted, warnings, removals.
- **Polls and giveaways**: `.poll Question | Option 1 | Option 2` and `.giveaway [n]` (draws from members who posted in the last 7 days).
- **Levels**: 1 point per message. `.level` shows yours, `.leaderboard` shows the top 10.

Things to know:
- Private messages are personal data. With tickets on, their text is forwarded to your Telegram and is not kept in the database. The database keeps only the date of each first greeting and the ticket counter.
- Ticket routing is kept in memory: after a restart, old tickets can't be answered from Telegram. New tickets work.

## What is new in 2.3 (Stage 3: group control)
Customer side, in **Settings** and the new **Groups**, **Anti-abuse**, **Night mode** and **Safety** screens. Every new rule is OFF until you switch it on.
- **Groups**: choose *all groups (plan limit)* or *only groups I add by link*. Add a group with an invite link (the bot joins as a member, then make it an ADMIN). Pause a group or stop protecting it. Joins are limited per hour (default 5).
- **Anti-number-sharing**: deletes messages with phone numbers (9 to 15 digits).
- **Slow mode**: members wait 5, 10 or 30 seconds between messages.
- **Anti-raid**: 10 joins in a minute close the group and alert you.
- **Blocked country codes**: members who join with those codes are removed.
- **Blacklist**: numbers removed when they join, and their messages deleted. Also `.ban` / `.unban` in the group.
- **Strikes**: warn, then mute (you choose after how many warnings and for how long), then remove.
- **Night mode**: groups close at night and open in the morning, in your time zone.
- **Lockdown**: strict rules on and groups closed to members with one button or `.lockdown`. Ending it restores your old rules.
- **Failed posts** (for example a locked group) are retried and you are told if they still fail.
- **Evidence**: the last removals with reason and the first 120 characters of the message.
- **Alerts**: mass deletes in 10 minutes, anti-raid, member reports (`.report`), and a weekly summary every 7 days.
- **Security score** from your rules, and an **account health** score from failed posts and drops in the last day.

New WhatsApp commands (admins unless noted): `.mute [minutes]`, `.unmute`, `.ban`, `.unban`, `.pin`, `.unpin` (reply to a message), `.purge [n]` (up to 30 recent member messages), `.setname`, `.setdesc`, `.lockname on|off`, `.lockdesc on|off`, `.inactive [days]`, `.topmembers`, `.announce`, `.lockdown`, `.unlockdown`, and `.report` (everyone, reply to a message).

Things to know:
- Purge only sees messages from when the bot started watching the group. After a restart, older messages cannot be purged.
- `.lockname` and `.lockdesc` use one WhatsApp switch, so they change both together.
- The evidence log keeps the start of deleted messages in your database. Clear it with a database edit if your customers need that.
- Not in this stage: private-chat replies and the private-chat switch (Stage 4), fake-account checks, and join-request control.

## What is new in 2.2 (Stage 2: owner panel + subscriptions)
Everything below is in **Telegram > Admin panel** (owner), and a smaller version for **staff**.
- **Customers**: searchable list with filters (connected, expiring soon, expired, paused, blocked, no number yet). Each customer page shows plan, expiry, number, groups, status and live connection info.
- **Subscriptions**: plans (Trial, Basic, Pro, VIP: edit them in `config.js`), extend by days, lifetime, give a trial. Customers get automatic reminders 3 days and 1 day before expiry. When it ends, the guard disconnects automatically but keeps the WhatsApp login, so renewing reconnects it in seconds.
- **Subscriptions are OFF by default** (Global settings > Require subscription). While OFF nobody expires, exactly like before. When you switch it ON, the panel shows who has no active plan and offers a 7-day grace so nobody is cut off by surprise.
- **Pause / block with a reason**: the customer sees the reason. Pause keeps their login (resume is instant). Block unlinks it.
- **Per-customer limits**: max groups (or use the plan's) and max bad words. Groups over the limit are not guarded and the customer gets one Telegram notice. Groups count in the order the bot first sees them.
- **Broadcast** to everyone, connected, expired, expiring within 7 days, or customers you tick. You see a preview and confirm first.
- **Live monitor**: per-customer connection state, uptime, queue, last message, reconnect count, RAM, Baileys version, with Restart session, Restart all, and Restart whole bot.
- **Stats and usage**: all-time totals, last 7 days, top customers, and a per-customer usage page (messages checked, deleted, warnings, removed, commands, per group).
- **Logs**: action history (who did what), events (connects, drops, expiries) and recent errors.
- **Alerts to you** on Telegram: errors (rate limited, never more than 10 per hour), a customer's connection down for 2+ minutes and back, unlinked numbers, subscriptions ended, new customers. Switch off in Global settings.
- **Maintenance mode**: customers only see the maintenance message. Groups stay protected.
- **Staff**: add people by Telegram ID. They can view, extend up to 30 days, pause/resume and message one customer. They cannot change plans or limits, block, remove, broadcast, change settings, restart or manage staff. Every action is logged.
- **Admin lock**: optional 4-8 digit PIN for the admin panel (stays open 30 minutes; 5 wrong tries lock it for 15 minutes). Forgot it? Set `RESET_ADMIN_PIN=true`, redeploy once, then remove the variable.
- Counters are saved in batches (every 2 minutes and on shutdown), so heavy groups do not hammer your database.
- A bug in one feature no longer crashes the bot: it is logged and reported to you. Only 5+ crashes in a minute trigger a clean restart.
- Upgrading: existing customers keep working. They get new fields filled in automatically and no plan, so nothing changes until you turn subscriptions on.

## Keep Baileys fixed
`package.json` still says `"latest"` for Baileys. After your first successful install, open Admin panel > Live monitor, read the "Baileys: x.y.z" line, then change `package.json` to that exact version (no `^`, no `latest`) and commit `package-lock.json`. A new Baileys release can then never break your live customers. `.npmrc` makes future installs save exact versions.

## What came in 2.1 (Stage 1)
- **Spam control**: flood, long messages, emoji spam, forwarded messages, status-mention tags.
- **Bad-word filter** (per customer list; catches f.u.c.k, f u c k, fuuuck, leet letters).
- **Media filter**: block images, videos, stickers, audio, documents or contact cards.
- **WhatsApp commands** (prefix is per customer, default `.`): menu, ping, alive, groupinfo, admins, tagall, hidetag, tagadmins, kick, promote, demote, open, close, link, revoke, warn, warnings, resetwarn. Admin commands work for group admins and for the bot number itself.
- The bot no longer asks to be made admin inside the group. It sends the customer a Telegram notice (at most once per 6 hours per group).
- Anti-ban send queue: every message leaves with a short random pause.
- Every new rule is OFF until the customer switches it on in Settings, so existing customers see no change after the upgrade. Their saved settings are upgraded automatically.
- `npm test` runs the automated tests.

## Menu
Customers get Telegram's Menu button (lists Start and Menu) plus a "📋 Menu" button pinned at the bottom of the chat. Either one shows all the buttons again.

## Customer flow
Start the bot > Connect WhatsApp > send the number > enter the pairing code in WhatsApp (Linked devices > Link with phone number instead) > add the number to the group as ADMIN > adjust Settings.

## Admin panel (inside Telegram)
Open the bot and tap "Admin panel" (owners are the IDs in `ADMIN_IDS`). The customer limit, message editing (now also the maintenance and subscription-ended messages) and everything in the 2.2 list above live there.

## Important
- Never upload the `auth` or `data` folders anywhere. `auth` holds the WhatsApp logins.
- With `MYSQL_URL` set, logins and data live in your database, so Render restarts lose nothing. Without it you need a disk that keeps files. Back up `auth` and `data`.
- Each connected customer uses roughly 50-100 MB RAM.
- Baileys is unofficial: a customer number can be banned by WhatsApp. Tell customers to use a separate number.
- After your first successful `npm install`, keep `package-lock.json` so the Baileys version stays fixed.
