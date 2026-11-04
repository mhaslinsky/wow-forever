import type { Principal } from "../auth/index.mts";
import type { CharacterDeclaration } from "../data/recruiting.mts";
import {
  type Interaction,
  message,
  type Route,
} from "../interactions/core.mts";
import type { createRecruiting } from "../recruiting/core.mts";

export type RegisterContext = {
  actor: Principal<"user">;
  core: ReturnType<typeof createRecruiting>;
};
export function parseCharacters(
  main: string,
  alts: string,
): CharacterDeclaration[] {
  return [main, ...alts.split(";").filter((entry) => entry.trim())].map(
    (entry, index) => {
      const fields = entry.split(",").map((field) => field.trim());
      if (
        fields.length !== 4 ||
        !["Tank", "Healer", "Damage"].includes(fields[3])
      )
        throw new Error("INVALID_CHARACTER");
      return {
        name: fields[0],
        class: fields[1],
        spec: fields[2],
        raidRole: fields[3] as CharacterDeclaration["raidRole"],
        main: index === 0,
      };
    },
  );
}
export function createRegisterRoutes(
  resolveContext: (
    interaction: Interaction,
    signal: AbortSignal,
  ) => Promise<RegisterContext>,
): readonly Route[] {
  return [
    {
      type: 2,
      name: "register",
      description: "Register your main and alts",
      mode: "slow",
      visibility: "ephemeral",
      options: [
        {
          type: 3,
          name: "main",
          description: "Name, class, spec, role (Tank, Healer, Damage)",
          required: true,
        },
        {
          type: 3,
          name: "alts",
          description: "Name, class, spec, role; separate alts with semicolons",
          required: false,
        },
      ],
      async handler(interaction, signal) {
        const context = await resolveContext(interaction, signal);
        const options = interaction.data?.options;
        if (!Array.isArray(options))
          return message("Enter your main character");
        const option = (name: string) =>
          options.find((entry) => entry?.name === name)?.value;
        const main = option("main");
        const alts = option("alts");
        if (
          typeof main !== "string" ||
          (alts !== undefined && typeof alts !== "string")
        )
          return message("Enter name, class, spec, and role");
        let characters: CharacterDeclaration[];
        try {
          characters = parseCharacters(main, alts ?? "");
        } catch {
          return message("Enter name, class, spec, and role");
        }
        await context.core.registerRoster(context.actor, characters);
        return message("Roster updated");
      },
    },
  ];
}
