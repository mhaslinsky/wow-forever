import { authority } from "../auth/index.mts";
import type { CharacterDeclaration } from "../data/recruiting.mts";
import {
  type Interaction,
  message,
  type Reply,
  type Route,
} from "../interactions/core.mts";
import type { ResolveRecruitingContext } from "./runtime.mts";

const fields = [
  ["name", "Character name", 100],
  ["class", "Class", 30],
  ["spec", "Specialization", 50],
  ["raidRole", "Raid role (Tank, Healer, Damage)", 6],
] as const;

function formValues(interaction: Interaction): Record<string, string> {
  const rows = interaction.data?.components;
  if (!Array.isArray(rows)) throw new Error("INVALID_APPLICATION");
  const values: Record<string, string> = {};
  for (const row of rows) {
    if (!row || !Array.isArray(row.components))
      throw new Error("INVALID_APPLICATION");
    for (const field of row.components) {
      if (
        !field ||
        typeof field.custom_id !== "string" ||
        typeof field.value !== "string"
      )
        throw new Error("INVALID_APPLICATION");
      if (Object.hasOwn(values, field.custom_id))
        throw new Error("INVALID_APPLICATION");
      values[field.custom_id] = field.value.trim();
    }
  }
  return values;
}

export function createRecruitingRoutes(
  resolveContext: ResolveRecruitingContext,
  guildId: () => string | undefined = () => process.env.GUILD_ID,
): readonly Route[] {
  function inGuild(interaction: Interaction) {
    const configured = guildId();
    return (
      !!configured &&
      interaction.guild_id === configured &&
      !!interaction.member?.user?.id
    );
  }
  return [
    {
      type: 2,
      name: "apply",
      description: "Apply to the guild",
      mode: "fast",
      visibility: "ephemeral",
      async handler(interaction): Promise<Reply> {
        if (!inGuild(interaction)) return message("Apply in the server");
        return {
          type: 9,
          data: {
            custom_id: "apply",
            title: "Guild application",
            components: fields.map(([custom_id, label, max_length]) => ({
              type: 1,
              components: [
                {
                  type: 4,
                  custom_id,
                  label,
                  style: 1,
                  required: true,
                  max_length,
                },
              ],
            })),
          },
        };
      },
    },
    {
      type: 5,
      name: "apply",
      mode: "slow",
      visibility: "ephemeral",
      async handler(interaction, signal) {
        if (!inGuild(interaction)) return message("Apply in the server");
        let values: Record<string, string>;
        try {
          values = formValues(interaction);
        } catch {
          return message("Complete all application fields");
        }
        if (
          fields.some(
            ([name, , max]) => !values[name] || values[name].length > max,
          )
        )
          return message("Complete all application fields");
        const raidRole = values.raidRole;
        if (
          raidRole !== "Tank" &&
          raidRole !== "Healer" &&
          raidRole !== "Damage"
        )
          return message("Choose Tank, Healer, or Damage");
        const character: CharacterDeclaration = {
          name: values.name,
          class: values.class,
          spec: values.spec,
          raidRole,
          main: true,
        };
        const { core, actor } = await resolveContext(interaction, signal);
        const actorId = authority(actor).userId;
        const candidate = await core.create({
          name: character.name,
          source: "Apply form",
          actorId,
          discordUserId: actorId,
          characters: [character],
          content: `${character.name}\nClass: ${character.class}\nSpec: ${character.spec}\nRole: ${character.raidRole}`,
        });
        if (!candidate.recruiting) throw new Error("CANDIDATE_THREAD_MISSING");
        await core.setStage(
          candidate.recruiting.threadId,
          "Applied",
          actorId,
          interaction.id,
        );
        return message("Application sent");
      },
    },
    {
      type: 2,
      name: "lead",
      description: "Add a recruiting lead",
      options: [
        {
          type: 3,
          name: "name",
          description: "Character name",
          required: true,
          max_length: 100,
        },
        {
          type: 3,
          name: "class",
          description: "Character class",
          required: true,
          max_length: 30,
        },
        {
          type: 3,
          name: "source",
          description: "Where you found them",
          required: true,
          max_length: 1000,
        },
      ],
      mode: "slow",
      visibility: "ephemeral",
      async handler(interaction, signal) {
        if (!inGuild(interaction))
          return message("Use this command in the server");
        const { core, actor } = await resolveContext(interaction, signal);
        const officer = authority(actor);
        if (!officer.roles.includes("Officer")) return message("Officers only");
        const options = interaction.data?.options;
        if (!Array.isArray(options))
          return message("Enter name, class, and source");
        const values = new Map<string, string>();
        for (const option of options) {
          if (
            !option ||
            option.type !== 3 ||
            typeof option.name !== "string" ||
            typeof option.value !== "string"
          )
            return message("Enter name, class, and source");
          values.set(option.name, option.value.trim());
        }
        const name = values.get("name"),
          characterClass = values.get("class"),
          source = values.get("source");
        if (
          !name ||
          name.length > 100 ||
          !characterClass ||
          characterClass.length > 30 ||
          !source ||
          source.length > 1000
        )
          return message("Enter name, class, and source");
        await core.create({
          name,
          source: "Officer lead",
          actorId: officer.userId,
          owner: officer.userId,
          content: `${name}\nClass: ${characterClass}\nFound: ${source}`,
        });
        return message("Lead added");
      },
    },
  ];
}
