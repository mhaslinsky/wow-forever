import { REST } from "discord.js";
import { createDynamoDataAccess } from "../data/index.mts";
import { readSecret } from "../interactions/index.mts";
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
  return () => departures.checkSnapshot(guildKey);
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
