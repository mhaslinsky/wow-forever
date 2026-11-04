import { Client } from "discord.js";
import { createSystemPrincipal } from "../auth/index.mts";
import { createGowStore } from "../data/gow-applications.mts";
import { createDynamoDataAccess } from "../data/index.mts";
import { readSecret } from "../interactions/index.mts";
import { recruitingForGuild } from "../recruiting/discord.mts";
import { captureApplications } from "./core.mts";
import { mapApplications } from "./mapping.mts";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

export async function handler() {
  try {
    const captured = await captureApplications({
      guildId: required("GUILD_ID"),
      apiKey: await readSecret(
        "/wow-forever/guildsofwow_api_key",
        AbortSignal.timeout(15_000),
      ),
      save: createGowStore(
        required("GUILD_TABLE"),
        createSystemPrincipal(["gowApplication"]),
      ),
    });
    const principal = createSystemPrincipal([
      "gowApplication",
      "candidate",
      "officerNote",
    ]);
    const data = createDynamoDataAccess({
      tableName: required("GUILD_TABLE"),
      region: required("AWS_REGION"),
    });
    const client = new Client({
      intents: [],
      rest: { timeout: 5000, retries: 0 },
    });
    client.rest.setToken(
      await readSecret(
        "/wow-forever/discord_bot_token",
        AbortSignal.timeout(15_000),
      ),
    );
    try {
      const core = await recruitingForGuild(
        await client.guilds.fetch(required("GUILD_ID")),
        data,
        principal,
      );
      const mapped = await mapApplications({
        guildId: required("GUILD_ID"),
        records: data.forSystem(principal),
        create: core.create,
      });
      return { ...captured, ...mapped };
    } finally {
      client.destroy();
    }
  } catch {
    throw new Error("GOW_INTAKE_FAILED");
  }
}
