import { createSystemPrincipal } from "../auth/index.mts";
import { createDynamoDataAccess } from "../data/index.mts";
import { readSecret } from "../interactions/index.mts";
import { createRaidHelper, createSignUpPoller } from "./poller.mts";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

export async function handler() {
  const guildId = required("GUILD_ID");
  const data = createDynamoDataAccess({
    tableName: required("GUILD_TABLE"),
    region: required("AWS_REGION"),
  }).forSystem(createSystemPrincipal(["signup"]));
  return createSignUpPoller({
    guildId,
    data,
    api: createRaidHelper({
      guildId,
      apiKey: () =>
        readSecret(
          "/wow-forever/raid_helper_api_key",
          AbortSignal.timeout(15_000),
        ),
    }),
    report: (code) => console.error(JSON.stringify({ event: code })),
  })();
}
