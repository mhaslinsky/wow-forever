## 1. Platform

- [x] 1.1 Scaffold the TypeScript project: package.json, tsconfig, node:test runner, lint, and a GitHub Actions workflow running lint and tests on pull requests (complexity: mechanical) (gate: none)
  Done in PR #2 (PER-296).
- [x] 1.2 Terraform base stack: remote state, SSM parameters for tokens, SNS alarm topic with a Discord-forwarding Lambda, billing alarm (depends on: 1.1) (complexity: standard) (gate: none)
  Done in PR #3 (PER-297), applied; topic policy fixed in PR #10.
- [x] 1.3 Interactions endpoint: Lambda function URL with Ed25519 verification, command router, deferred async worker with retries off and a timeout watchdog, cooldown claim before paid work (depends on: 1.2) (complexity: judgment) (gate: none)
  Split: code in PR #5 (PER-300); Terraform and deployed smoke in PR #8 (PER-330), applied, smoke passed except the Discord PING check, which waits on 2.1.
- [x] 1.4 DynamoDB single-table schema and data access layer where every read takes the asker's roles and filters officer-only records (depends on: 1.1) (complexity: judgment) (gate: none)
  Done in PR #4 (PER-298), table applied.
- [x] 1.5 Always-connected client on a t4g.nano: discord.js gateway with reconnect and resume, heartbeat metric and a ten-minute silence alarm, deploy over SSM (depends on: 1.2, 1.4) (complexity: standard) (gate: none)
  Code and infrastructure merged in PR #7 (PER-301); not applied or deployed until 2.1 stores the bot token.
- [ ] 1.6 Guild-scoped slash command registration script driven by the command router's definitions (depends on: 1.3) (complexity: mechanical) (gate: none)

## 2. Discord server

- [x] 2.1 OPS (no PR): create the guild bot and operator-identity Discord applications, enable required intents, store the bot token in SSM and the operator token on the Mac, install the pinned Discord MCP restricted to the guild after reading its source; Done when both apps exist and the MCP lists the guild's channels (depends on: 1.2) (complexity: standard) (gate: none)
- [x] 2.2 Layout tool: layout file schema plus plan, apply and permission readback commands, apply idempotent (depends on: 1.1) (complexity: judgment) (gate: none)
  Split into four PRs: core schema and compilation, PR #6 (PER-299, merged); planner and adoption, PR #9 (PER-332, merged); readback (PER-333); executor, state, transport and CLI (PER-331).
- [ ] 2.3 Initial server layout file (categories, channels, roles, role order, overwrites) applied after the operator reviews the plan, readback clean (depends on: 2.1, 2.2) (complexity: standard) (gate: none)
- [ ] 2.4 OPS (no PR): AutoMod rules, Onboarding questions and ping roles, Raid-Helper and anti-raid bot installs, Forever news webhooks, pinned charter and loot policy; Done when a test account onboards and sees only public channels (depends on: 2.3) (complexity: standard) (gate: none)

## 3. Recruiting

- [ ] 3.1 Recruiting core: candidate records, one thread per candidate in the officer forum channel, stage tags synced both ways through the gateway client (depends on: 1.4, 1.5, 2.3) (complexity: standard) (gate: none)
- [ ] 3.2 `/apply` modal for people in the server and officer `/lead` command (depends on: 1.3, 3.1) (complexity: standard) (gate: none)
- [ ] 3.3 Guilds of WoW intake: capture a real application alert, parse alerts in the private intake channel into candidates, alarm and keep the raw message when parsing fails (depends on: 3.1) (complexity: standard) (gate: none)
- [ ] 3.4 Candidate deduplication by Discord account or character name, merging into the existing thread (depends on: 3.1) (complexity: standard) (gate: none)
- [ ] 3.5 Owner and next-action date per candidate, daily overdue digest on a schedule (depends on: 3.1) (complexity: standard) (gate: none)
- [ ] 3.6 Retention purge of notes for Declined and Withdrawn candidates (depends on: 3.1) (complexity: standard) (gate: none)

## 4. Roster

- [ ] 4.1 Roster model, `/register` for mains and alts, Accepted stage grants Member and creates the roster entry (depends on: 1.3, 1.4, 3.1) (complexity: standard) (gate: none)
- [ ] 4.2 Departure flags from member-leave events and two-snapshot absence, with Confirm and Keep buttons for officers (depends on: 4.1, 5.3) (complexity: standard) (gate: none)
- [ ] 4.3 Raid targets per team, pinned needs board, `/needs message` recruiting text (depends on: 4.1) (complexity: standard) (gate: none)

## 5. Guild data reader

- [ ] 5.1 SPIKE (no PR): capture a Guild OS SavedVariables file from jetragon and map its sections against the addon's companion payload code; Done when a section map and a scrubbed sample are recorded (complexity: standard) (gate: none)
- [ ] 5.2 SavedVariables parser and normalizer to a versioned snapshot, rejecting unknown shapes by name (depends on: 1.1, 5.1) (complexity: standard) (gate: none)
- [ ] 5.3 Snapshot ingest endpoint: authenticated, idempotent, newer snapshots win (depends on: 1.3, 1.4, 5.2) (complexity: judgment) (gate: none)
- [ ] 5.4 Windows reader app: file watcher, upload with backoff, start at login on jetragon (depends on: 5.2, 5.3) (complexity: standard) (gate: none)

## 6. Raid attendance

- [ ] 6.1 Raid-Helper sign-up poller storing sign-ups per raid (depends on: 1.4) (complexity: standard) (gate: none)
- [ ] 6.2 Raid voice presence recording in the gateway client (depends on: 1.5) (complexity: standard) (gate: none)
- [ ] 6.3 Attendance resolution (snapshot first, voice fallback, source recorded) and the post-raid said-yes-versus-came report (depends on: 5.3, 6.1, 6.2) (complexity: standard) (gate: none)

## 7. Loot council

- [ ] 7.1 `/wishlist` ranked lists with a pre-raid lock (depends on: 4.1) (complexity: standard) (gate: none)
- [ ] 7.2 `/lc item` vote post with contender evidence and officer vote buttons (depends on: 5.3, 6.3, 7.1) (complexity: standard) (gate: none)
- [ ] 7.3 Vote close with required reason, officer-only decision log, award confirmation and mismatch alert from snapshots (depends on: 7.2) (complexity: standard) (gate: none)

## 8. Member assistant

- [ ] 8.1 `/ask` and @-mention: members-only gate, Bedrock Sonnet worker grounded on guild records with web search, per-user cooldown (depends on: 1.3, 1.4, 1.5, 4.1) (complexity: judgment) (gate: none)
- [ ] 8.2 Consented memory and `/forget` (depends on: 8.1) (complexity: standard) (gate: none)
- [ ] 8.3 Monthly assistant spend circuit breaker with officer notice (depends on: 8.1) (complexity: standard) (gate: none)

## 9. Retirement

- [ ] 9.1 Retire the Valheim AWS estate in the palworld-server repository: lift the deletion guards, review the destroy plan with the operator, apply, keep only the final archives (depends on: 1.2) (complexity: judgment) (gate: none)

## 10. Live checks

- [ ] 10.1 SPIKE (no PR): first raid week on the live client, confirm what Guild OS records inside a raid instance, choose Gargul or Guild OS master loot, and verify attendance and award confirmation end to end; Done when findings are recorded and any fork or fallback is ticketed (depends on: 5.4, 6.3, 7.3) (complexity: judgment) (gate: none)
