import { authority } from "../auth/index.mts";
import { message, type Route } from "../interactions/core.mts";
import type { IntakeResolution } from "./resolve.mts";
import type { ResolveRecruitingContext } from "./runtime.mts";

const refusals: Record<string, string> = {
  WRITE_DENIED: "Officers only.",
  INVALID_INTAKE_RESOLUTION:
    "Supply a ref and either a thread or release:true.",
  INVALID_INTAKE_LINK: "Use a Discord thread link from this server.",
  INTAKE_VERIFICATION_FAILED: "Could not verify that thread.",
  CANDIDATE_RETAINED: "That candidate was removed.",
  CANDIDATE_INTAKE_MISSING: "Intake not found.",
  CANDIDATE_INTAKE_IN_PROGRESS: "Intake is in progress.",
  CANDIDATE_INTAKE_ALREADY_RESOLVED: "Intake already resolved.",
  CANDIDATE_INTAKE_BLOCKED: "Intake is still blocked.",
};

export function resolveRoute(
  resolveContext: ResolveRecruitingContext,
  inGuild: (interaction: Parameters<ResolveRecruitingContext>[0]) => boolean,
): Route {
  return {
    type: 2,
    name: "recruit",
    description: "Manage recruiting intake",
    options: [
      {
        type: 1,
        name: "resolve",
        description: "Resolve a blocked intake",
        options: [
          { type: 3, name: "ref", description: "Intake ref", required: true },
          { type: 3, name: "thread", description: "Thread link to adopt" },
          { type: 5, name: "release", description: "Allow one new try" },
        ],
      },
    ],
    mode: "slow",
    visibility: "ephemeral",
    async handler(interaction, signal) {
      if (!inGuild(interaction))
        return message("Use this command in the server.");
      try {
        const { core, actor } = await resolveContext(interaction, signal);
        if (!authority(actor).roles.includes("Officer"))
          return message("Officers only.");
        const options = interaction.data?.options;
        if (
          !Array.isArray(options) ||
          options.length !== 1 ||
          options[0]?.type !== 1 ||
          options[0]?.name !== "resolve" ||
          !Array.isArray(options[0].options)
        )
          throw new Error("INVALID_INTAKE_RESOLUTION");
        const values: Record<string, unknown> = {};
        for (const option of options[0].options) {
          if (
            !option ||
            !["ref", "thread", "release"].includes(option.name) ||
            Object.hasOwn(values, option.name) ||
            (option.name === "release"
              ? option.type !== 5 || typeof option.value !== "boolean"
              : option.type !== 3 || typeof option.value !== "string")
          )
            throw new Error("INVALID_INTAKE_RESOLUTION");
          values[option.name] = option.value;
        }
        if (typeof values.ref !== "string")
          throw new Error("INVALID_INTAKE_RESOLUTION");
        const result = await core.resolveIntake(
          actor,
          values as IntakeResolution,
        );
        return message(
          result === "adopted" ? "Adopted." : "Released for one new try.",
        );
      } catch (error) {
        return message(
          error instanceof Error && Object.hasOwn(refusals, error.message)
            ? refusals[error.message]
            : "Could not resolve intake.",
        );
      }
    },
  };
}
