import type { Principal } from "../auth/index.mts";
import {
  type Interaction,
  message,
  type Route,
} from "../interactions/core.mts";
import type { createWishlist } from "./core.mts";

export function createWishlistRoutes(
  resolveContext: (
    interaction: Interaction,
    signal: AbortSignal,
  ) => Promise<{
    actor: Principal<"user">;
    core: ReturnType<typeof createWishlist>;
  }>,
): readonly Route[] {
  return [
    {
      type: 2,
      name: "wishlist",
      description: "Set your ranked loot wishlist",
      mode: "slow",
      visibility: "ephemeral",
      options: [
        {
          type: 3,
          name: "items",
          description: "Items in rank order, separated by semicolons",
          required: true,
          max_length: 2500,
        },
      ],
      async handler(interaction, signal) {
        const options = interaction.data?.options;
        const value = Array.isArray(options)
          ? options.find((entry) => entry?.name === "items")?.value
          : undefined;
        if (typeof value !== "string")
          return message("Enter items in rank order, separated by semicolons");
        const context = await resolveContext(interaction, signal);
        try {
          const result = await context.core.save(context.actor, value);
          return message(
            result.locked
              ? "Wishlist saved for the next raid"
              : "Wishlist saved",
          );
        } catch (error) {
          if (error instanceof Error && error.message === "INVALID_WISHLIST")
            return message(
              "Enter up to 25 different items, separated by semicolons",
            );
          throw error;
        }
      },
    },
  ];
}
