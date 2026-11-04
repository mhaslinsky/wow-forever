import { authority, type Principal } from "../auth/index.mts";
import { parseTargets } from "../data/needs.mts";
import {
  type Interaction,
  message,
  type Route,
} from "../interactions/core.mts";
import type { createNeeds } from "./core.mts";

export function createNeedsRoutes(
  resolve: (
    interaction: Interaction,
    signal: AbortSignal,
  ) => Promise<{
    actor: Principal<"user">;
    core: ReturnType<typeof createNeeds>;
  }>,
): readonly Route[] {
  return [
    {
      type: 2,
      name: "needs",
      description: "Manage raid recruiting needs",
      mode: "slow",
      visibility: "ephemeral",
      options: [
        {
          type: 1,
          name: "message",
          description: "Get recruiting text for current gaps",
        },
        {
          type: 1,
          name: "targets",
          description: "Set a raid team's targets",
          options: [
            {
              type: 3,
              name: "team",
              description: "Team name",
              required: true,
              max_length: 80,
            },
            {
              type: 3,
              name: "counts",
              description:
                'JSON: {"roles":{"Tank":2,"Healer":4,"Damage":14},"classes":{"Priest":2}}',
              required: true,
            },
          ],
        },
        {
          type: 1,
          name: "assign",
          description: "Set a member's raid team",
          options: [
            {
              type: 6,
              name: "member",
              description: "Registered member",
              required: true,
            },
            { type: 3, name: "team", description: "Team name", required: true },
            {
              type: 5,
              name: "active",
              description: "Count this member toward targets",
              required: true,
            },
          ],
        },
      ],
      async handler(interaction, signal) {
        const context = await resolve(interaction, signal);
        if (!authority(context.actor).roles.includes("Officer"))
          return message("Officers only, sorry.");
        const options = interaction.data?.options;
        const command = Array.isArray(options) ? options[0] : undefined;
        if (command?.name === "message")
          return message(await context.core.message(context.actor));
        const option = (name: string) =>
          Array.isArray(command?.options)
            ? command.options.find(
                (entry: { name: string }) => entry.name === name,
              )?.value
            : undefined;
        const team = option("team");
        if (typeof team !== "string") return message("Need a team name");
        if (command?.name === "targets") {
          let targets: ReturnType<typeof parseTargets>;
          try {
            targets = parseTargets(option("counts"));
          } catch {
            return message("Need valid role and class counts");
          }
          await context.core.setTargets(context.actor, team, targets);
        } else if (command?.name === "assign") {
          const member = option("member");
          const active = option("active");
          if (typeof member !== "string" || typeof active !== "boolean")
            return message("Need a member and active status");
          await context.core.assign(context.actor, member, team, active);
        } else return message("Choose a needs command");
        return message("Got it, needs updated.");
      },
    },
  ];
}
