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
    REASON_REQUIRED: "Enter a reason (1 to 1000 characters)",
    INVALID_WINNER: "Choose a contender",
    WINNER_CHARACTER_REQUIRED: "Winner needs a registered character",
    VOTE_CLOSED: "Vote closed",
    VOTE_CHANGED: "Try again",
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
      const close = options?.find((entry) => entry.name === "close");
      if (close) {
        const value = (name: string) => {
          const found = close.options?.find(
            (entry) => entry.name === name,
          )?.value;
          return typeof found === "string" ? found : "";
        };
        const decision = await context.core.close(
          context.actor,
          value("vote"),
          value("winner"),
          value("reason"),
        );
        await context.post(
          "Decision recorded",
          [],
          [
            {
              title: `Award: ${decision.award.item}`,
              fields: [
                { name: "Winner", value: `<@${decision.winner}>` },
                {
                  name: "Votes",
                  value:
                    Object.entries(
                      JSON.parse(decision.votes) as Record<string, number>,
                    )
                      .map(([id, count]) => `<@${id}>: ${count}`)
                      .join("\n") || "No votes",
                },
                { name: "Reason", value: decision.reason },
                { name: "Closed by", value: `<@${decision.decidingOfficer}>` },
              ],
            },
          ],
        );
        return message("Decision recorded");
      }
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
          name: "close",
          description: "Close an item vote",
          options: [
            {
              type: 3,
              name: "vote",
              description: "Vote ID from the vote message",
              required: true,
            },
            {
              type: 6,
              name: "winner",
              description: "Winner",
              required: true,
            },
            {
              type: 3,
              name: "reason",
              description: "Award reason",
              required: true,
              max_length: 1000,
            },
          ],
        },
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
