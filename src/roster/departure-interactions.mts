import { createDynamoDataAccess } from "../data/index.mts";
import { message, type Route } from "../interactions/core.mts";
import { recruitingContextForInteraction } from "../recruiting/runtime.mts";
import { createDepartures } from "./departures.mts";

export const departureRoutes: readonly Route[] = [
  {
    type: 3,
    name: "departure",
    mode: "slow",
    visibility: "ephemeral",
    async handler(interaction, signal) {
      const { actor } = await recruitingContextForInteraction(
        interaction,
        signal,
      );
      const [, action, memberId, requestId, extra] =
        interaction.data?.custom_id?.split(":") ?? [];
      if (
        !memberId ||
        !requestId ||
        extra ||
        !["keep", "confirm"].includes(action)
      )
        return message("That request is out of date.");
      const resolved = await createDepartures(
        createDynamoDataAccess({
          tableName: "wow-forever",
          region: "us-east-1",
        }),
        interaction.guild_id as string,
        async () => {
          throw new Error("POST_UNAVAILABLE");
        },
      ).resolve(actor, memberId, action, requestId);
      return message(
        !resolved
          ? "That request is out of date."
          : action === "keep"
            ? "Kept."
            : "Marked inactive.",
      );
    },
  },
];
