import { ActionRowBuilder, StringSelectMenuBuilder } from "discord.js";
import { authority } from "../auth/index.mts";
import {
  type Application,
  applicationAnswers,
  classes,
  NIGHTS,
  rolesFor,
  specsFor,
} from "../data/application.mts";
import type { CharacterDeclaration } from "../data/recruiting.mts";
import {
  type Interaction,
  message,
  type Reply,
  type Route,
} from "../interactions/core.mts";
import { resolveRoute } from "./resolve-interactions.mts";
import type { ResolveRecruitingContext } from "./runtime.mts";

type RaidRole = CharacterDeclaration["raidRole"];
function select(
  customId: string,
  prompt: string,
  options: string[],
  multiple = false,
): Reply {
  return {
    type: 4,
    data: {
      content: prompt,
      flags: 64,
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>()
          .addComponents(
            new StringSelectMenuBuilder()
              .setCustomId(customId)
              .setPlaceholder(prompt)
              .setMinValues(1)
              .setMaxValues(multiple ? options.length : 1)
              .addOptions(
                options.map((value) => ({
                  label: value === "Damage" ? "DPS" : value,
                  value,
                })),
              ),
          )
          .toJSON(),
      ],
    },
  };
}
function applicationModal(
  characterClass: string,
  spec: string,
  raidRole: RaidRole,
  offspecs: string,
  nights: string,
): Reply {
  return {
    type: 9,
    data: {
      custom_id: [
        "apply",
        characterClass,
        spec,
        raidRole,
        offspecs,
        nights,
      ].join(":"),
      title: "Guild application",
      components: [
        ["name", "Character name", 1, true, 100, "Your character's name"],
        [
          "raidHistory",
          "Raid history",
          2,
          true,
          700,
          "Previous guilds, what you cleared and why you left",
        ],
        ["logsUrl", "Logs or armory link", 1, false, 300, "https://..."],
        [
          "about",
          "Why us? Anything else?",
          2,
          false,
          500,
          "What brings you here?",
        ],
      ].map(([custom_id, label, style, required, max_length, placeholder]) => ({
        type: 1,
        components: [
          {
            type: 4,
            custom_id,
            label,
            style,
            required,
            max_length,
            placeholder,
          },
        ],
      })),
    },
  };
}

function offspecStep(
  characterClass: string,
  spec: string,
  role: RaidRole,
): Reply {
  return select(
    `apply:offspec:${characterClass}:${spec}:${role}`,
    "Any offspecs?",
    [
      ...Object.keys(specsFor(characterClass) ?? {}).filter(
        (other) => other !== spec,
      ),
      "No offspec",
    ],
    true,
  );
}
function decodeChoices(
  encoded: string | undefined,
  choices: string[],
): string[] | undefined {
  if (encoded === "-") return [];
  if (!encoded || !/^[0-9]+$/.test(encoded)) return;
  const indices = [...encoded].map(Number);
  if (
    new Set(indices).size !== indices.length ||
    indices.some((index) => index >= choices.length)
  )
    return;
  return indices.map((index) => choices[index]);
}

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
    resolveRoute(resolveContext, inGuild),
    {
      type: 2,
      name: "apply",
      description: "Apply to the guild",
      mode: "fast",
      visibility: "ephemeral",
      async handler(interaction): Promise<Reply> {
        if (!inGuild(interaction))
          return message("This command only works in the server");
        return select(
          "apply:class",
          "What class are you?",
          Object.keys(classes),
        );
      },
    },
    {
      type: 3,
      name: "apply",
      mode: "fast",
      visibility: "ephemeral",
      async handler(interaction) {
        if (!inGuild(interaction))
          return message("This command only works in the server");
        const parts = interaction.data?.custom_id?.split(":") ?? [];
        const values = interaction.data?.values;
        if (
          !Array.isArray(values) ||
          values.length < 1 ||
          !values.every((value) => typeof value === "string")
        )
          return message("That timed out, run /apply again");
        const selected = values[0];
        const [, step, characterClass, spec] = parts;
        if (step === "class" && parts.length === 2 && values.length === 1) {
          const specs = specsFor(selected);
          if (specs)
            return select(
              `apply:spec:${selected}`,
              "What spec?",
              Object.keys(specs),
            );
        }
        if (step === "spec" && parts.length === 3 && values.length === 1) {
          const roles = rolesFor(characterClass, selected);
          if (roles?.length === 1)
            return offspecStep(characterClass, selected, roles[0]);
          if (roles)
            return select(
              `apply:role:${characterClass}:${selected}`,
              "Tank or DPS?",
              roles,
            );
        }
        if (step === "role" && parts.length === 4 && values.length === 1) {
          const role = rolesFor(characterClass, spec)?.find(
            (role) => role === selected,
          );
          if (role) return offspecStep(characterClass, spec, role);
        }
        const role = rolesFor(characterClass, spec)?.find(
          (role) => role === parts[4],
        );
        const otherSpecs = Object.keys(specsFor(characterClass) ?? {}).filter(
          (other) => other !== spec,
        );
        if (
          step === "offspec" &&
          parts.length === 5 &&
          role &&
          new Set(values).size === values.length
        ) {
          if (
            values.every((value) => otherSpecs.includes(value)) ||
            (values.length === 1 && selected === "No offspec")
          ) {
            const encoded =
              selected === "No offspec"
                ? "-"
                : values
                    .map((value) => otherSpecs.indexOf(value))
                    .sort()
                    .join("");
            return select(
              `apply:nights:${characterClass}:${spec}:${role}:${encoded}`,
              "Which nights can you raid?",
              NIGHTS,
              true,
            );
          }
        }
        if (
          step === "nights" &&
          parts.length === 6 &&
          role &&
          decodeChoices(parts[5], otherSpecs) &&
          values.every((value) => NIGHTS.includes(value)) &&
          new Set(values).size === values.length
        ) {
          return applicationModal(
            characterClass,
            spec,
            role,
            parts[5],
            values
              .map((value) => NIGHTS.indexOf(value))
              .sort()
              .join(""),
          );
        }
        return message("That timed out, run /apply again");
      },
    },
    {
      type: 5,
      name: "apply",
      mode: "slow",
      visibility: "ephemeral",
      async handler(interaction, signal) {
        if (!inGuild(interaction))
          return message("This command only works in the server");
        let values: Record<string, string>;
        try {
          values = formValues(interaction);
        } catch {
          return message("Need your character name");
        }
        const parts = interaction.data?.custom_id?.split(":") ?? [];
        const [, characterClass, spec, selectedRole] = parts;
        const raidRole = rolesFor(characterClass, spec)?.find(
          (role) => role === selectedRole,
        );
        if (parts.length !== 6 || !raidRole)
          return message("That timed out, run /apply again");
        if (!values.name || values.name.length > 100)
          return message("Need your character name");
        const character: CharacterDeclaration = {
          name: values.name,
          class: characterClass,
          spec,
          raidRole,
          main: true,
        };
        const otherSpecs = Object.keys(specsFor(characterClass) ?? {}).filter(
          (other) => other !== spec,
        );
        const offspecs = decodeChoices(parts[4], otherSpecs);
        const nights = decodeChoices(parts[5], NIGHTS);
        if (!offspecs) return message("That timed out, run /apply again");
        if (!nights?.length) return message("Pick at least one raid night");
        const application: Application = {
          offspecs,
          nights,
          raidHistory: values.raidHistory ?? "",
          logsUrl: values.logsUrl ?? "",
          about: values.about ?? "",
        };
        if (!application.raidHistory) return message("Need your raid history");
        if (!applicationAnswers(application, character))
          return message("Something looked off, run /apply again");
        const { core, actor } = await resolveContext(interaction, signal);
        const actorId = authority(actor).userId;
        const candidate = await core.create({
          name: character.name,
          source: "Apply form",
          actorId,
          discordUserId: actorId,
          characters: [character],
          application,
          content: `${character.name}\nClass: ${character.class}\nSpec: ${character.spec}\nRole: ${character.raidRole === "Damage" ? "DPS" : character.raidRole}\nOffspecs: ${application.offspecs.join(", ") || "None"}\nRaid nights: ${application.nights.join(", ")}\nRaid history: ${application.raidHistory}\nLogs or armory: ${application.logsUrl || "None"}\nWhy us: ${application.about || "None"}`,
        });
        if (!candidate.recruiting) throw new Error("CANDIDATE_THREAD_MISSING");
        if (candidate.recruiting.stage === "New")
          await core.setStage(
            candidate.recruiting.threadId,
            "Applied",
            actorId,
            interaction.id,
          );
        return message("Got it! An officer will reach out soon.");
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
          return message("This command only works in the server");
        const { core, actor } = await resolveContext(interaction, signal);
        const officer = authority(actor);
        if (!officer.roles.includes("Officer")) return message("Officers only");
        const options = interaction.data?.options;
        if (!Array.isArray(options))
          return message("Need a name, class and where you found them");
        const values = new Map<string, string>();
        for (const option of options) {
          if (
            !option ||
            option.type !== 3 ||
            typeof option.name !== "string" ||
            typeof option.value !== "string"
          )
            return message("Need a name, class and where you found them");
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
          return message("Need a name, class and where you found them");
        await core.create({
          name,
          source: "Officer lead",
          actorId: officer.userId,
          owner: officer.userId,
          content: `${name}\nClass: ${characterClass}\nFound: ${source}`,
        });
        return message("Lead added, the thread's up in #recruiting");
      },
    },
  ];
}
