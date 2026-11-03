# Deployed interactions smoke fixture

The orchestrator applies the main stack and runs the smoke script. This lane has not applied Terraform or called AWS.

Run `npm run build` first. The production handler is `build/interactions/index.mjs`, with `PUBLIC_KEY_PARAM` and `CLAIMS_TABLE` set by Terraform. `AWS_LAMBDA_FUNCTION_NAME` comes from Lambda. The claims TTL is `expiresAt`.

Run the mandatory deployment checks with:

```text
node scripts/smoke-interactions.mts --url "$INTERACTIONS_URL" --function wow-forever-interactions --skip-discord --skip-fixtures
```

Skipping Discord or fixtures requires the corresponding flag. Omit those flags when their prerequisites exist. Unavailable checks fail. The stale request uses a throwaway signing key; its 401 confirms rejection, but cannot isolate freshness from the wrong-key rejection.

`--discord` replaces `--skip-discord` and requires `DISCORD_BOT_TOKEN`. It PATCHes the current application's interactions endpoint through Discord's API. Discord must validate the endpoint with a signed PING before accepting the update. The returned endpoint must match. This sets the application's endpoint URL and requires task 2.1.

Build the separate fixture with:

```text
npx esbuild test/interactions-smoke-fixture.mts --bundle --platform=node --target=node22 --format=esm --outfile=build/interactions-smoke-fixture/index.mjs --banner:js='import { createRequire } from "node:module"; const require = createRequire(import.meta.url);'
```

Deploy only this bundle to a separate fixture Lambda: Node 22, arm64, handler `index.handler`, timeout 60 seconds, function-error retries disabled, event age 600 seconds, and no function URL. Set `CLAIMS_TABLE` to `wow-forever-claims`. Give its separate role PutItem, GetItem and UpdateItem on that table only, InvokeFunction on itself only, and writes to its own log group. Never add the observation permissions to the production role.

Replace `--skip-fixtures` with `--fixture-function <fixture-name>`. The runner signs fixture requests with a throwaway key. The fixture runs the production HTTP router and worker with real Lambda async invokes and conditional DynamoDB claims. Only the Discord HTTP port records replies instead of sending them. Its test routes record work counts in DynamoDB.

The slow check requires a deferred response and one completed reply. The watchdog leaves work pending until the real Lambda deadline cancels it. The duplicate check sends the same signed request twice and waits for both workers to finish before asserting one work call and one reply. Results appear as `fixture slow`, `fixture watchdog`, and `fixture duplicate`. Observation records and claims expire after an hour. Delete the separate fixture and its role and log group after the smoke run.

Not yet applied. Actual deployed checks remain the orchestrator's responsibility. The Errors alarm depends on PR #7's CloudWatch SNS publish permission, which was unmerged when this lane started.
