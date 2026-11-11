# Roadmap (feature numbers refer to the original feature list)

## Stage 1 - DONE (v2.1.0)
Foundation + core protection: 2, 3, 9, 10, 11 (+84 basic disguised words), 12, 13 (anti-forward), 17 (warn -> remove), 24 (tagall/hidetag/tagadmins), 25 (kick/promote/demote), 26 (open/close/link/revoke), 27 (warn/warnings/resetwarn), 28 (groupinfo/admins), 35 (menu/ping/alive), 41 (prefix), 43 (not-admin alert), 44, 58 (send queue), 93 (a broken feature never crashes the bot), 1 (Telegram notice instead of asking in group).

## Stage 2 - DONE (v2.2.0) - Owner admin panel + subscriptions
43 (disconnected alert), 45 (searchable list), 46 (pause/block/unblock with reason), 47 (extend, plans, trials, reminders), 48 (per-customer limits), 49 (global settings, maintenance), 50 (broadcast: all/connected/expired/expiring/selected), 51 (live monitor + restart), 52 (logs/stats), 53 (staff), 54 (admin PIN, confirmations, action history), 61 (error alerts), 62 (per-customer usage), 63 (subscriptions, expiry, auto-disconnect), 93 (stronger: errors reported, no crash).
Not done here (moved): 55 pin Baileys (see README: needs the installed version, do it after the first install).

## Stage 3 - DONE (v2.3.0) - Group control
Done: 7 (allowed-groups mode, add group by invite link with hourly limit, pause/remove), 8 (failed posts queued, retried 5 times, customer alerted), 13 (anti-number-sharing), 14 (blocked country codes on join), 15 (anti-raid: auto-close + alert), 16 (slow mode), 17 (mute + strike ladder warn > mute > remove, .mute/.unmute), 18 (blacklist via panel and .ban/.unban; whitelist = allowed numbers), 19 (night mode with time zones), 26 (pin, unpin, purge), 28 (setname, setdesc, lockname, lockdesc, inactive, topmembers, report, announce), 85 (lockdown: button and .lockdown/.unlockdown), 86 (account health), 87 (evidence log), 88 (security score), 89 (live threat alerts + weekly report).

Not done yet, and why:
- 7: the private-chat on/off switch moves to Stage 4 with feature 5 (private chats).
- 13: fake-account checks (no reliable signal from WhatsApp yet; only country codes are checked).
- 14: join-request control (needs the join-request API, not wired yet).
- 26 purge and 28 inactive/topmembers only see messages from when the bot started watching a group.
- 88 score is based on the customer's rules, not on each group separately.

## Stage 4 - DONE (v2.4.0) - Welcome, replies, sales, community
Done: 5 (private chats switch), 6 (first-contact greeting, text only: no sticker yet), 29 (welcome, goodbye, .rules), 30 (auto-replies, FAQ-style replies, away reply), 31 (support tickets to Telegram, reply in Telegram to answer), 32 (birthdays, daily summary), 33 (polls, giveaways), 34 (levels, leaderboard), 42 (scheduled posts), 67-70 (sales assistant, buy questions, .shop/.buy, sales topics with their own links), 71 (scheduled promo posts), 72 (anti-repeat: once per person every 6 hours), 73 (all editable in the panel).

Not done, and why:
- 38 (per-group settings) and 39 (copy settings to all groups): the rules are per customer today. Per-group settings would be a larger change.
- 40 (stats/activity log): the usage pages from Stage 1 and 2 already cover this.
- 33: quiz, trivia and games. Only polls and giveaways are done.
- 6: the sticker part of the first greeting.
- 31: replies in Telegram work only while the bot is running (tickets are remembered in memory).
- .link stays the group invite-link command, so the shop command is .shop or .buy.

## Stage 5 - DONE (v2.5.0) - Utility + search
Done: calculator (.calc), time in a zone (.time), unit converter (.convert), jokes and quotes, QR codes (.qr), weather, dictionary, wikipedia, translate, movies (needs OMDB_KEY), headlines (needs NEWS_KEY), YouTube search (needs YOUTUBE_KEY), lyrics search link (.lyrics), site checker (.site: status, response time, SSL days), short links with click counts (.short, admins only, needs PUBLIC_URL), notes and to-do lists per chat, a daily lookup limit per member (off by default), and the "Tools & lookups" screen in the panel with "My short links".

Not done, and why:
- 95 and 96 (media downloaders, song and video downloads): declined. Downloading copyrighted media from other sites is against the rules this bot follows.
- .sticker, .toimg and .tts from 36: they need an image and audio encoder that the project does not include yet.
- Lyrics are not sent as text. The command gives a search link only, because lyrics are copyrighted.
- Short links and the site checker only point at public addresses, to limit phishing and internal network probing.
- Lookups use free public services, so they can be slow or down. Each one says so when it fails.


## Stage 6 - DONE (v2.6.1) - Automation
Done: 98 (auto-react: one emoji from a set, at most once a minute per chat), 99 (scheduled posts, up to 5, with an optional status target and {days YYYY-MM-DD} countdowns), 100 (scheduled posts to the bot's status, audience = members of protected groups, up to 300), 101 (view and react to members' statuses, off by default), 102 (always online, mark as read, typing indicator before automatic private replies), 103 (keyword replies can include a picture), 104 (bot "About" text), 105 (a Telegram sticker saved as sticker:name, used in welcome, goodbye, replies and posts), 107 (countdown posts), 108 (reminders with .remind, admins only), 109 (voice notes saved from Telegram as voice:name, sent with .voice name or in any message).

Not built, and why:
- 20 (view-once saver), 21 (anti-delete), 22 (status saver): declined. They recover content the sender chose to hide, delete, or show only to some people.
- 106 (auto-forward): declined. It can pass on other people's private messages.
- 110 (cloning someone's voice): declined.
- 23 (tagging contacts in statuses): declined. Mass-tagging people who have not asked to be tagged.
- 108 auto-thank: not built. It needs a trigger such as an order or payment feed, which the bot does not have. Welcome messages already thank new members.

Not tested against real WhatsApp: status posting and status reactions. The status audience is group members only, because the bot cannot read the phone's contact list.

## Stage 7 - DONE (v2.7.0) - Reliability, backups, uptime keeper
Done: 56 (a session stuck "connecting" for 10 minutes is restarted; pairing is not affected; the health check from earlier stages stays), 57 (old logs, errors, evidence, activity and daily counts are cleaned up every hour), 60 (with DATA_KEY set, WhatsApp logins in the database are encrypted with AES-256-GCM), 64 (encrypted backup of the whole database, sent to the owners daily at 03:00 UTC; the owner can restore from a backup file after a confirmation), 66 (tests and README), 74 to 76 (uptime keeper: each site checked every 5 to 14 minutes, the customer is told when it goes down and when it is back, .addsite, .sites, .removesite; only public addresses), 77 (uptime percentage and response time in .sites), 113 (subscription reminders, from Stage 2), 114 (order notifications: your website POSTs JSON {"text": "..."} to a private link, and the customer gets it on Telegram; 4 KB limit, 30 requests a minute). Also already in place: 59 (owner and staff levels), 92 (audit log of admin actions), 90 (restart on crash).

Not done, and why:
- 55 (pin the Baileys version): needs the version that is installed and tested on a real account. It cannot be checked offline.
- 65 (broadcast into customers' groups): declined. It would send unrequested messages into groups the customer does not own.
- 75 (down alerts go to the customer on Telegram only, not to members of the group).
- 77 (public status page): not built yet.
- 91 (zero-downtime updates): needs more than one running instance, which the free host does not give.
- Logs are not yet audited for secrets. The bot does not print tokens on purpose, but this is not verified.

Caution: if DATA_KEY changes or is removed, saved logins cannot be opened and the numbers must be paired again.

## Stage 8 - DONE (v2.8.0) - AI and advanced security
Done: 78 (AI assistant with the .ai command, in groups; four personalities: friendly, formal, fun, teacher; the answer follows the language of the question; daily limit per customer), 79 (signature line, for example "Powered by Marvel", added to the menu, the first greeting and AI answers), 80 (scam and link scanner: short links, IP addresses, look-alike letters, hidden logins, risky domain endings, scam wording next to a link; off by default), 81 (.transcribe, admins only, replies to a voice note with a transcript and a short summary).

Not done, and why:
- 82 (image tools): needs an image library that cannot be installed offline. Sticker and image conversion (from features 4 and 36) is also still missing for the same reason.
- AI replies in private chats: only the .ai command works in groups for now.
- The scanner checks links with rules only. It does not look links up online, so new scam sites can pass.
- The AI and transcription services were tested with a fake service. Check them with your real key before relying on them.

Privacy: .ai and .transcribe send the text or the voice note to the AI service you configure. Only voice notes an admin asks about are sent.

## Stage 9 - DONE (v2.9.0) - Business and growth
Done: 116 (public stats page and uptime badge, off unless PUBLIC_STATS=true; totals only, no names or numbers), 117 (.ping shows a speed label), 121 (referral links: a new customer who starts the bot through a link gives the referrer 3 free days, up to 10 times; leaderboards for group points were already in Stage 4), 123 (a read-only customer dashboard with a private link: today, this week, groups, websites, invited friends).

Already in place from earlier stages: 118 (pairing with a code), 119 (the signature line from Stage 8), 122 (announcements to all customers through the admin broadcast), 124 (support tickets to Telegram).

Not built, and why:
- 120 (reseller system): needs rules for who pays, who manages which customers and what they may see. Not invented here.
- 125 (beta club): would be a flag with no effect yet.
- 126 (plugin system): declined. Loading third-party code into a bot that holds WhatsApp sessions and customer data is a security risk.

Note: referral days only matter when subscriptions are required in the global settings.
