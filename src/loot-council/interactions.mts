import type { APIEmbed } from "discord.js";
import type { Principal } from "../auth/index.mts";
import {
  type Interaction,
  message,
  type Route,
} from "../interactions/core.mts";
import type { createLootCouncil } from "./core.mts";

export function createLootCouncilRoutes(
  resolve: (
    interaction: Interaction,
    signal: AbortSignal,
  ) => Promise<{
    actor: Principal<"user">;
    core: ReturnType<typeof createLootCouncil>;
    post(
      content: string,
      components: unknown[],
      embeds: APIEmbed[],
    ): Promise<unknown>;
  }>,
): readonly Route[] {
  const errors: Record<string, string> = {
    OFFICER_REQUIRED: "Officers only",
    RAID_NOT_FOUND: "No raid found. Pick one with the raid option.",
    NO_CONTENDERS: "No contenders found",
    VOTE_NOT_FOUND: "Vote not found",
    INVALID_ITEM: "Enter an item name",
  };
  async function handle(interaction: Interaction, signal: AbortSignal) {
    const context = await resolve(interaction, signal);
    try {
      if (interaction.type === 3) {
        const [, voteId] = interaction.data?.custom_id?.split(":") ?? [];
        const selected = interaction.data?.values;
        await context.core.vote(
          context.actor,
          voteId ?? "",
          Array.isArray(selected) && typeof selected[0] === "string"
            ? selected[0]
            : "",
          interaction.id,
        );
        return message("Vote saved");
      }
      const options = interaction.data?.options as
        | { name: string; options?: { name: string; value: unknown }[] }[]
        | undefined;
      const command = options?.find((entry) => entry.name === "item");
      const item = command?.options?.find(
        (entry) => entry.name === "name",
      )?.value;
      const raid = command?.options?.find(
        (entry) => entry.name === "raid",
      )?.value;
      if (typeof item !== "string") return message("Enter an item name");
      const post = await context.core.start(
        context.actor,
        interaction.id,
        item,
        typeof raid === "string" ? raid : undefined,
      );
      await context.post(post.content, post.components, post.embeds);
      return message("Vote posted in loot-council");
    } catch (error) {
      if (error instanceof Error && errors[error.message])
        return message(errors[error.message]);
      throw error;
    }
  }
  return [
    {
      type: 2,
      name: "lc",
      description: "Loot council",
      mode: "slow",
      visibility: "ephemeral",
      options: [
        {
          type: 1,
          name: "item",
          description: "Start an item vote",
          options: [
            {
              type: 3,
              name: "name",
              description: "Item name",
              required: true,
              max_length: 100,
            },
            {
              type: 3,
              name: "raid",
              description: "Raid start time in Unix seconds",
            },
          ],
        },
      ],
      handler: handle,
    },
    {
      type: 3,
      name: "lc-vote",
      mode: "slow",
      visibility: "ephemeral",
      handler: handle,
    },
  ];
}
