import { REST } from "discord.js";
import { createSystemPrincipal } from "../auth/index.mts";
import { createDynamoDataAccess } from "../data/index.mts";
import { latestSnapshot } from "../data/snapshots.mts";
import { readSecret } from "../interactions/index.mts";
import { createAwardCheck } from "../loot-council/awards.mts";
import { discordAlertMessage } from "../recruiting/alerts.mts";
import { createDepartures } from "./departures.mts";

function required(name: string) {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`Missing ${name}`);
  return value;
}

export function createDepartureSnapshotHandler(
  data: Parameters<typeof createDepartures>[0],
  guildId: string,
  guildKey: string,
  post: Parameters<typeof createDepartures>[2],
) {
  if (!guildId.trim() || !guildKey.trim())
    throw new Error("DEPARTURE_GUILD_REQUIRED");
  const departures = createDepartures(data, guildId, post);
  const checkAwards = createAwardCheck(data, guildId, post);
  const store = data.forSystem(createSystemPrincipal([]));
  return async () => {
    const accepted = await latestSnapshot(store, guildKey);
    if (!accepted) return;
    await departures.checkSnapshot(guildKey, accepted);
    await checkAwards(accepted);
  };
}

export async function handler() {
  const guildId = required("GUILD_ID");
  return createDepartureSnapshotHandler(
    createDynamoDataAccess({
      tableName: required("GUILD_TABLE"),
      region: required("AWS_REGION"),
    }),
    guildId,
    required("GUILDOS_GUILD_KEY"),
    async (content, components) => {
      const token = await readSecret(
        "/wow-forever/discord_bot_token",
        AbortSignal.timeout(15_000),
      );
      const rest = new REST({ timeout: 15_000, retries: 0 }).setToken(token);
      return discordAlertMessage(rest, guildId)(content, components);
    },
  )();
}
