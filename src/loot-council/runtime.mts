import { REST } from "discord.js";
import { createDynamoDataAccess } from "../data/index.mts";
import type { Interaction } from "../interactions/core.mts";
import { discordAlertMessage } from "../recruiting/alerts.mts";
import { recruitingContextForInteraction } from "../recruiting/runtime.mts";
import { createLootCouncil } from "./core.mts";

export async function lootCouncilContext(
  interaction: Interaction,
  signal: AbortSignal,
) {
  const { actor } = await recruitingContextForInteraction(interaction, signal);
  const lockMinutes = process.env.WISHLIST_LOCK_MINUTES;
  if (lockMinutes === undefined || !/^\d+$/.test(lockMinutes))
    throw new Error("INVALID_WISHLIST_CONFIG");
  const { readSecret } = await import("../interactions/index.mts");
  const token = await readSecret("/wow-forever/discord_bot_token", signal);
  const guildId = interaction.guild_id ?? "";
  return {
    actor,
    core: createLootCouncil(
      createDynamoDataAccess({ tableName: "wow-forever", region: "us-east-1" }),
      {
        guildId,
        guildKey: process.env.GUILDOS_GUILD_KEY,
        lockMinutes: Number(lockMinutes),
      },
    ),
    post: discordAlertMessage(
      new REST({ version: "10", timeout: 5000, retries: 0 }).setToken(token),
      guildId,
      "loot-council",
    ),
  };
}
