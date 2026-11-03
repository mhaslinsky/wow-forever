# Deployed interactions smoke fixture

The orchestrator applies the main stack and runs the smoke script. This lane has not applied Terraform or called AWS.

Run `npm run build` first. The production handler is `build/interactions/index.mjs`, with `PUBLIC_KEY_PARAM` and `CLAIMS_TABLE` set by Terraform. `AWS_LAMBDA_FUNCTION_NAME` comes from Lambda. The claims TTL is `expiresAt`.

Run the mandatory deployment checks with:

```text
node scripts/smoke-interactions.mts --url "$INTERACTIONS_URL" --function wow-forever-interactions --skip-discord --skip-fixtures
```

Skipping Discord or fixtures requires the corresponding flag. Unavailable checks fail. The production stale probe uses an untrusted throwaway key and reports "rejected (signature or freshness, not isolated)". Its 401 does not verify freshness.

`--discord` replaces `--skip-discord` and requires `DISCORD_BOT_TOKEN`. It PATCHes the current application's interactions endpoint through Discord's API. Discord validates the endpoint with a signed PING before accepting the update. The returned endpoint must match. This sets the application's endpoint URL and requires task 2.1.

Build the separate fixture with:

```text
npx esbuild test/interactions-smoke-fixture.mts --bundle --platform=node --target=node22 --format=esm --outfile=build/interactions-smoke-fixture/index.mjs --banner:js='import { createRequire } from "node:module"; const require = createRequire(import.meta.url);'
```

Create the fixture table separately from the main Terraform stack:

```text
aws dynamodb create-table --table-name wow-forever-claims-fixture --attribute-definitions AttributeName=pk,AttributeType=S --key-schema AttributeName=pk,KeyType=HASH --billing-mode PAY_PER_REQUEST
aws dynamodb wait table-exists --table-name wow-forever-claims-fixture
aws dynamodb update-time-to-live --table-name wow-forever-claims-fixture --time-to-live-specification Enabled=true,AttributeName=expiresAt
```

Create a separate fixture role with InvokeFunction on the fixture Lambda only and writes to its own log group. Add this claims policy after replacing ACCOUNT_ID with the fixture table's AWS account. Grant no other DynamoDB permissions to the fixture role:

```json
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["dynamodb:PutItem","dynamodb:GetItem","dynamodb:UpdateItem"],"Resource":"arn:aws:dynamodb:us-east-1:ACCOUNT_ID:table/wow-forever-claims-fixture"}]}
```

The table has a string `pk`, TTL `expiresAt` and on-demand billing. The fixture never uses production's `wow-forever-claims` table or role.

Deploy the fixture bundle to its separate Lambda: Node 22, arm64, handler `index.handler`, timeout 60 seconds, function-error retries disabled, event age 600 seconds, and no function URL. Set `CLAIMS_TABLE` to `wow-forever-claims-fixture`; the fixture rejects any other table name.

Replace `--skip-fixtures` with `--fixture-function <fixture-name>`. The fixture uses the production HTTP router and worker, real Lambda async invokes, and conditional DynamoDB claims on its own table. Only Discord HTTP delivery is replaced with recorded replies. Test routes record work counts in the fixture table.

The `fixture freshness` check uses one trusted throwaway key for a fresh and a stale signed request, requiring 200 then 401. The slow check requires a deferred response and one completed reply. The watchdog waits for the real Lambda deadline to cancel work. The duplicate check waits for both workers to finish and the winner's reply to be recorded, then requires one work call and one reply. A deadline bounds the wait; no quiet period determines success.

Observation records and claims expire after an hour. After smoke, delete the fixture table, Lambda, role and log group. Keep production storage untouched.

Not yet applied. Actual deployed checks remain the orchestrator's responsibility.
