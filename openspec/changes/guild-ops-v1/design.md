## Context

The guild master (GM) runs an Alliance PvE guild in WoW: Forever, mostly friends plus recruited strangers. Forever constraints that shape everything:

- No Blizzard roster, character or guild API for Forever. Warcraft Logs has announced nothing.
- Forever inherits the modern addon restrictions: no combat log for addons, and addons may not message other players inside instances, so in-raid loot council addons (RCLootCouncil) cannot work and have no Forever build.
- Addons cannot make network calls; data leaves the game only through the SavedVariables file written on logout or `/reload`.

The Guild OS addon (MIT, Forever build) already records roster, measured attendance, master-loot results, wishlists and recruiting activity in game. Its site, Discord bot and Windows companion are closed and are not used.

Prior art reused from the operator's Palworld and Valheim server bot: Discord interactions over a Lambda function URL with Ed25519 signature checks, a cooldown row claimed fail-closed before any paid model call, an async worker invoked with retries off, a watchdog that edits the deferred reply before the Lambda timeout, an SNS alarm topic forwarded to Discord, and a billing alarm.

## Goals / Non-Goals

**Goals:**
- One place where officers see every candidate, whatever the source.
- A roster and needs board that stay current without a Blizzard API.
- Loot council decisions made and recorded in Discord, using in-game data.
- Members get grounded answers about the guild and the game.
- Run for well under $30 a month.

**Non-Goals:**
- Any automation of the game client or of a normal Discord user account.
- A guest or non-member chat tier.
- Watching other guilds' Discord servers.
- Raid and class guides (later change).
- Rebuilding the Guild OS companion's push of a planned roster back into the game.
- Depending on Raidify, RCLootCouncil, softres.it or Warcraft Logs.

## Decisions

1. **Two runtimes, one codebase.** Lambda handles interactions (slash commands, buttons, modals) and EventBridge Scheduler jobs; a t4g.nano runs a discord.js gateway client for message, member and voice events. Both write the same DynamoDB tables. Alternative: Lambda only, polling channels every minute. Rejected because voice attendance needs live presence and the cost difference is about $7 a month.
2. **DynamoDB single table, on-demand.** Candidates, members, characters, raids, attendance, loot, wishlists, memory facts. Alternative: Postgres. Rejected for idle cost and operations.
3. **Officer forum channel as the recruiting UI.** One thread per candidate; forum tags are the stages and stay in sync both ways (an officer moving a tag moves the stage). The table exists for deduplication and the digest; nobody works from it.
4. **Guilds of WoW intake through its Discord alerts.** Guilds of WoW posts applications into a private intake channel; the gateway client parses each message into a candidate. An unparseable alert raises an alarm instead of being dropped. Alternative: a public API, which it does not offer.
5. **Guild OS data through our own reader.** A TypeScript reader on the GM's Windows PC watches the addon's SavedVariables file, parses the Lua table, and uploads a normalized snapshot to an authenticated bot endpoint. The payload format is taken from the addon's source (`tools/companion-payload.lua`). If the addon changes or stalls, we fork it.
6. **Loot council in Discord.** Officers start a vote with `/lc item`; the bot posts contenders with wishlist rank, attendance and loot history, officers vote with buttons, and the award is recorded with a reason. The raid leader hands the item out in game; the next reader upload confirms it.
7. **Data boundary in code.** Every read path takes the asker's roles and returns only what that role may see. Candidate notes, loot reasons and officer threads never reach a non-officer, and the model is never given data the asker may not see.
8. **Two Discord identities.** The guild bot holds the Officer role. The operator's agent identity is a separate application at the operator's rank, used only in supervised sessions through a pinned Discord MCP server; its token never leaves the operator's machine.
9. **Members-only assistant on Bedrock.** Sonnet at low or medium effort, web search, grounded first on guild data. Memory stores only facts a member asks it to keep, with `/forget`. Per-user cooldown and a monthly spend circuit breaker.

## Risks / Trade-offs

- [Guild OS changes its saved-data shape or stops updating] → Pin the addon version the reader was built against, fail loudly on unknown shapes, fork when needed.
- [Guild OS records less inside raid instances than claimed] → First raid week check; fallback is raid voice presence for attendance and officer entry for loot.
- [Guilds of WoW changes its alert format] → Alarm on any unparseable alert, keep the raw message in the thread.
- [The reader only uploads when the GM logs out or reloads] → Attendance and loot land after the raid, which is when loot history matters; live votes use the last upload plus officer entry.
- [Spend creep on the assistant] → Cooldown, monthly circuit breaker, billing alarm.
- [A bad layout apply exposes private channels] → Plan output reviewed by the operator before every apply; permission readback after.

## Migration Plan

New stack first. After its alarms are live, retire the Valheim estate in the `palworld-server` repository with a reviewed Terraform destroy plan; final world and mod config archives are already kept off AWS.

## Open Questions

- Does Guild OS record attendance and loot inside a Forever raid instance? (first raid week)
- Gargul or Guild OS master loot in game? (first raid week)
- Exact shape of a Guilds of WoW application alert. (capture one before building the parser)
- Which Onboarding and AutoMod settings the Discord API and the MCP server can set, and which need a supervised click.
