import { ActionRowBuilder, StringSelectMenuBuilder } from "discord.js";
import { authority } from "../auth/index.mts";
import type { CharacterDeclaration } from "../data/recruiting.mts";
import {
  type Interaction,
  message,
  type Reply,
  type Route,
} from "../interactions/core.mts";
import type { ResolveRecruitingContext } from "./runtime.mts";

type RaidRole = CharacterDeclaration["raidRole"];
const damage: RaidRole[] = ["Damage"];
const healer: RaidRole[] = ["Healer"];
const tank: RaidRole[] = ["Tank"];
const classes: Record<string, Record<string, RaidRole[]>> = {
  Druid: { Balance: damage, Feral: ["Tank", "Damage"], Restoration: healer },
  Hunter: { "Beast Mastery": damage, Marksmanship: damage, Survival: damage },
  Mage: { Arcane: damage, Fire: damage, Frost: damage },
  Paladin: { Holy: healer, Protection: tank, Retribution: damage },
  Priest: { Discipline: healer, Holy: healer, Shadow: damage },
  Rogue: { Assassination: damage, Combat: damage, Subtlety: damage },
  Shaman: { Elemental: damage, Enhancement: damage, Restoration: healer },
  Warlock: { Affliction: damage, Demonology: damage, Destruction: damage },
  Warrior: { Arms: damage, Fury: damage, Protection: tank },
};

function specsFor(characterClass: string) {
  return Object.hasOwn(classes, characterClass)
    ? classes[characterClass]
    : undefined;
}
function rolesFor(characterClass: string, spec: string) {
  const specs = specsFor(characterClass);
  return specs && Object.hasOwn(specs, spec) ? specs[spec] : undefined;
}
function select(customId: string, prompt: string, options: string[]): Reply {
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
): Reply {
  return {
    type: 9,
    data: {
      custom_id: ["apply", characterClass, spec, raidRole].join(":"),
      title: "Guild application",
      components: [
        {
          type: 1,
          components: [
            {
              type: 4,
              custom_id: "name",
              label: "Character name",
              style: 1,
              required: true,
              max_length: 100,
            },
          ],
        },
      ],
    },
  };
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
          values.length !== 1 ||
          typeof values[0] !== "string"
        )
          return message("That timed out, run /apply again");
        const selected = values[0];
        const [, step, characterClass, spec] = parts;
        if (step === "class" && parts.length === 2) {
          const specs = specsFor(selected);
          if (specs)
            return select(
              `apply:spec:${selected}`,
              "What spec?",
              Object.keys(specs),
            );
        }
        if (step === "spec" && parts.length === 3) {
          const roles = rolesFor(characterClass, selected);
          if (roles?.length === 1)
            return applicationModal(characterClass, selected, roles[0]);
          if (roles)
            return select(
              `apply:role:${characterClass}:${selected}`,
              "Tank or DPS?",
              roles,
            );
        }
        if (step === "role" && parts.length === 4) {
          const role = rolesFor(characterClass, spec)?.find(
            (role) => role === selected,
          );
          if (role) return applicationModal(characterClass, spec, role);
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
        if (parts.length !== 4 || !raidRole)
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
