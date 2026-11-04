import { createDynamoDataAccess } from "../data/index.mts";
import type { Interaction } from "../interactions/core.mts";
import { recruitingContextForInteraction } from "../recruiting/runtime.mts";
import { createNeeds } from "./core.mts";

export async function needsContextForInteraction(
  interaction: Interaction,
  signal: AbortSignal,
) {
  const { actor } = await recruitingContextForInteraction(interaction, signal);
  return {
    actor,
    core: createNeeds(
      createDynamoDataAccess({ tableName: "wow-forever", region: "us-east-1" }),
      interaction.guild_id as string,
    ),
  };
}
