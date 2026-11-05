import { Client } from "discord.js";
import { createSystemPrincipal, type Principal } from "../auth/index.mts";
import { createDynamoDataAccess } from "../data/index.mts";
import type { Interaction } from "../interactions/core.mts";
import type { createRecruiting } from "./core.mts";
import { recruitingContext, recruitingForGuild } from "./discord.mts";

export type ResolveRecruitingContext = (
  interaction: Interaction,
  signal: AbortSignal,
) => Promise<{
  core: ReturnType<typeof createRecruiting>;
  actor: Principal<"user">;
}>;

const client = new Client({
  intents: [],
  rest: { timeout: 5000, retries: 0 },
});

export const recruitingContextForInteraction: ResolveRecruitingContext = async (
  interaction,
  signal,
) => {
  const guildId = process.env.GUILD_ID;
  if (
    !guildId ||
    interaction.guild_id !== guildId ||
    !interaction.member?.user?.id
  )
    throw new Error("GUILD_MEMBER_REQUIRED");
  const { readSecret } = await import("../interactions/index.mts");
  const token = await readSecret("/wow-forever/discord_bot_token", signal);
  signal.throwIfAborted();
  client.rest.setToken(token);
  const guild = await client.guilds.fetch(guildId);
  const { factory } = await recruitingContext(guild);
  const actor = factory.fromVerifiedInteraction({
    guild_id: guildId,
    member: {
      user: { id: interaction.member.user.id },
      roles: interaction.member.roles ?? [],
    },
  });
  const core = await recruitingForGuild(
    guild,
    createDynamoDataAccess({ tableName: "wow-forever", region: "us-east-1" }),
    createSystemPrincipal(["candidate", "officerNote", "recruitingIntake"]),
  );
  signal.throwIfAborted();
  return { core, actor };
};
