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

## Menu
Customers get Telegram's Menu button (lists Start and Menu) plus a "📋 Menu" button pinned at the bottom of the chat. Either one shows all the buttons again.

## Customer flow
Start the bot > Connect WhatsApp > send the number > enter the pairing code in WhatsApp (Linked devices > Link with phone number instead) > add the number to the group as ADMIN > adjust Settings.

## Admin panel (inside Telegram)
Open the bot and tap "Admin panel": set the customer limit, view/block/remove customers, edit the welcome / how-it-works / limit-reached messages, and broadcast to all users. When the limit is full, new customers see the limit message and a Contact admin button.

## Important
- Never upload the `auth` or `data` folders anywhere. `auth` holds the WhatsApp logins.
- Needs an always-on server with a disk that keeps files (VPS or a host with a persistent disk). Back up `auth` and `data`.
- Each connected customer uses roughly 50-100 MB RAM.
- Baileys is unofficial: a customer number can be banned by WhatsApp. Tell customers to use a separate number.
- After your first successful `npm install`, keep `package-lock.json` so the Baileys version stays fixed.
