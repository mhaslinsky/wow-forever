import { createDynamoDataAccess } from "../data/index.mts";
import type { Interaction } from "../interactions/core.mts";
import { recruitingContextForInteraction } from "../recruiting/runtime.mts";
import { createWishlist } from "./core.mts";

export async function wishlistContextForInteraction(
  interaction: Interaction,
  signal: AbortSignal,
) {
  const { actor } = await recruitingContextForInteraction(interaction, signal);
  const lockMinutes = process.env.WISHLIST_LOCK_MINUTES;
  if (lockMinutes === undefined || !/^\d+$/.test(lockMinutes))
    throw new Error("INVALID_WISHLIST_CONFIG");
  return {
    actor,
    core: createWishlist(
      createDynamoDataAccess({ tableName: "wow-forever", region: "us-east-1" }),
      { guildId: interaction.guild_id ?? "", lockMinutes: Number(lockMinutes) },
    ),
  };
}
