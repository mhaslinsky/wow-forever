## Why

A new Alliance PvE guild in World of Warcraft: Forever needs to recruit strangers, keep a roster, run loot council and answer members' questions, and the guild master wants software to carry as much of that work as possible. Recruiting is the biggest time sink. Forever offers no roster or character API, and its addon restrictions block in-raid addon messaging, so the usual tools (RCLootCouncil, armory sync, Warcraft Logs) do not cover it. The guild launches with the game on Nov 4, 2026 and raids open Dec 9.

## What Changes

- A guild Discord bot with two runtimes: a Lambda endpoint for slash commands, buttons and scheduled jobs, and a small always-connected process for live events (new messages, members leaving, voice presence).
- A single officer-only recruiting forum channel. Every candidate source (Guilds of WoW application alerts, an in-Discord `/apply`, an officer `/lead`, in-game recruits) becomes one thread with stage tags, deduplicated, with an overdue digest.
- A guild roster and a needs board built from guild data rather than any Blizzard API.
- A reader on the guild master's Windows PC that parses the Guild OS addon's saved data (roster, measured attendance, loot history) and sends it to the bot. The addon is MIT; the closed Guild OS site, bot and companion are not used.
- Raid sign-ups on Raid-Helper, compared with measured attendance to show who signed up and who came.
- Loot council held in Discord: officers vote on buttons with each contender's wishlist rank, attendance and loot history shown, and the decision and reason are logged.
- A members-only question bot (Claude Sonnet) with web search and consented memory.
- A declarative server layout applied by the operator's own supervised agent identity, plus native AutoMod, Onboarding and news webhooks.
- Retirement of the previous Valheim server AWS estate once this stack's alarms run.

## Capabilities

### New Capabilities
- `guild-bot-platform`: the two bot runtimes, storage, secrets, alarms, and the role-based rule for what each asker may see.
- `discord-server-setup`: the server layout file, the operator's agent identity, AutoMod, Onboarding and news feeds.
- `recruiting-pipeline`: intake sources, the officer forum channel, stages, deduplication, the overdue digest.
- `guild-roster`: members and characters, acceptance and departures, raid targets and the needs board.
- `guild-data-reader`: the Windows reader for the Guild OS addon's saved data and its upload to the bot.
- `raid-attendance`: Raid-Helper sign-ups compared with measured attendance and raid voice presence.
- `loot-council`: wishlists, loot history, Discord voting and the decision log.
- `member-assistant`: the members-only `/ask` and @-mention question bot with consented memory.

### Modified Capabilities
- None (new repository).

## Impact

- New public repository `wow-forever` (TypeScript, Terraform) and a new AWS stack: Lambda, DynamoDB on-demand, SSM parameters, SNS alarms, EventBridge Scheduler, one t4g.nano instance, Bedrock.
- Two new Discord applications: the guild bot and the operator's setup identity.
- Third-party dependencies: Guild OS addon (in game, forkable), Raid-Helper (Discord bot and API), Guilds of WoW (application page and Discord alerts).
- The `palworld-server` repository loses its Valheim AWS resources in one teardown change.
