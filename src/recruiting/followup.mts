import { authority, type Principal } from "../auth/index.mts";
import {
  type Interaction,
  message,
  type Route,
} from "../interactions/core.mts";
import type { createRecruiting } from "./core.mts";

type Context = {
  core: ReturnType<typeof createRecruiting>;
  actor: Principal<"user">;
};
export function createFollowUpRoutes(
  resolveContext: (
    interaction: Interaction,
    signal: AbortSignal,
  ) => Promise<Context>,
  now: () => number = Date.now,
): readonly Route[] {
  return [
    {
      type: 2,
      name: "followup",
      description: "Set a candidate's follow-up",
      mode: "slow",
      visibility: "ephemeral",
      options: [
        {
          type: 7,
          name: "candidate",
          description: "Candidate thread",
          required: true,
          channel_types: [11],
        },
        { type: 6, name: "owner", description: "Officer responsible" },
        {
          type: 4,
          name: "days",
          description: "Days until the next action",
          min_value: 0,
          max_value: 365,
        },
      ],
      async handler(interaction, signal) {
        const { core, actor } = await resolveContext(interaction, signal);
        if (!authority(actor).roles.includes("Officer"))
          return message("Officers only");
        const options = interaction.data?.options;
        if (!Array.isArray(options)) return message("Pick a candidate thread");
        const values = new Map(
          options.map((option: { name: string; value: unknown }) => [
            option.name,
            option.value,
          ]),
        );
        const threadId = values.get("candidate");
        const owner = values.get("owner");
        const days = values.get("days");
        if (
          typeof threadId !== "string" ||
          !threadId ||
          (owner !== undefined && (typeof owner !== "string" || !owner)) ||
          (days !== undefined &&
            (typeof days !== "number" ||
              !Number.isInteger(days) ||
              days < 0 ||
              days > 365))
        )
          return message("Something looked off, try again");
        if (owner === undefined && days === undefined)
          return message("Set an owner, days or both");
        await core.setFollowUp(threadId, actor, {
          ...(typeof owner === "string" ? { owner } : {}),
          ...(typeof days === "number"
            ? {
                nextActionAt: new Date(now() + days * 86_400_000).toISOString(),
              }
            : {}),
        });
        return message("Follow-up updated");
      },
    },
  ];
}
