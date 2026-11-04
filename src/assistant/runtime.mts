import { createPrincipalFactory } from "../auth/index.mts";
import { createDynamoDataAccess } from "../data/index.mts";
import { clock, type Interaction } from "../interactions/core.mts";
import {
  createAssistant,
  createConverse,
  createRouting,
  createSearch,
  REFUSAL,
} from "./core.mts";

export async function assistantPrincipal(
  guildId: string,
  userId: string,
  get: (path: string) => Promise<unknown>,
) {
  const roles = await get(`/guilds/${encodeURIComponent(guildId)}/roles`);
  if (!Array.isArray(roles)) throw new Error("INVALID_ROLES");
  const roleId = (name: string) => {
    const matches = roles.filter((role) => role?.name === name);
    if (
      matches.length !== 1 ||
      typeof matches[0].id !== "string" ||
      !matches[0].id
    )
      throw new Error("ROLE_MISSING_OR_AMBIGUOUS");
    return matches[0].id;
  };
  const factory = createPrincipalFactory({
    guildId,
    memberRoleId: roleId("Member"),
    officerRoleId: roleId("Officer"),
    officerRoleIds: [roleId("GM")],
    jobs: {},
  });
  return factory.fromGateway({ guildId, userId }, async () => {
    const member = await get(
      `/guilds/${encodeURIComponent(guildId)}/members/${encodeURIComponent(userId)}`,
    );
    if (
      !member ||
      typeof member !== "object" ||
      !("user" in member) ||
      !member.user ||
      typeof member.user !== "object" ||
      !("id" in member.user) ||
      member.user.id !== userId ||
      !("roles" in member) ||
      !Array.isArray(member.roles) ||
      !member.roles.every((role) => typeof role === "string")
    )
      throw new Error("INVALID_MEMBER");
    return { userId, roleIds: member.roles };
  });
}

export async function assistantAnswer(
  interaction: Interaction,
  question: string,
  signal: AbortSignal,
) {
  const guildId = process.env.GUILD_ID;
  const userId = interaction.member?.user?.id;
  if (!guildId || interaction.guild_id !== guildId || !userId) return REFUSAL;
  const { readSecret, claimAssistant } = await import(
    "../interactions/index.mts"
  );
  const token = await readSecret("/wow-forever/discord_bot_token", signal);
  const get = async (path: string): Promise<unknown> => {
    const response = await fetch(`https://discord.com/api/v10${path}`, {
      headers: { authorization: `Bot ${token}` },
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("ASSISTANT_IDENTITY_UNAVAILABLE");
    }
    return response.json();
  };
  const actor = await assistantPrincipal(guildId, userId, get);
  return createAssistant({
    guildId,
    data: createDynamoDataAccess({
      tableName: process.env.GUILD_TABLE ?? "wow-forever",
      region: "us-east-1",
    }),
    claim: (asker, abortSignal) => claimAssistant(guildId, asker, abortSignal),
    search: createSearch({
      clock,
      secret: (abortSignal) =>
        readSecret("/wow-forever/parallel_api_key", abortSignal),
      http: fetch,
    }),
    converse: createConverse(),
    route: createRouting(),
  })(actor, question, signal);
}
