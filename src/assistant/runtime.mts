import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { REST } from "discord.js";
import { createPrincipalFactory } from "../auth/index.mts";
import { createDynamoDataAccess } from "../data/index.mts";
import { createSpendStore } from "../data/spend.mts";
import { clock, type Interaction } from "../interactions/core.mts";
import { discordAlerts } from "../recruiting/alerts.mts";
import { createChannelContext, interactionHistoryChannel } from "./context.mts";
import {
  createAssistant,
  createConverse,
  createRouting,
  createSearch,
  REFUSAL,
} from "./core.mts";
import { createSpend, spendMetric, spendTotalMetric } from "./spend.mts";

export function assistantRoleIds(roles: unknown) {
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
  return roleId;
}

export async function assistantPrincipal(
  guildId: string,
  userId: string,
  get: (path: string) => Promise<unknown>,
) {
  const roleId = assistantRoleIds(
    await get(`/guilds/${encodeURIComponent(guildId)}/roles`),
  );
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
  const { readSecret } = await import("../interactions/index.mts");
  const token = await readSecret("/wow-forever/discord_bot_token", signal);
  const get = async (path: string, abortSignal = signal): Promise<unknown> => {
    const response = await fetch(`https://discord.com/api/v10${path}`, {
      headers: { authorization: `Bot ${token}` },
      signal: abortSignal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("ASSISTANT_IDENTITY_UNAVAILABLE");
    }
    return response.json();
  };
  const actor = await assistantPrincipal(guildId, userId, get);
  return (await runtimeAssistant(guildId, get))(
    actor,
    question,
    signal,
    createChannelContext(
      { clock, get },
      interactionHistoryChannel(interaction),
    ),
  );
}

export async function runtimeAssistant(
  guildId: string,
  get: (path: string) => Promise<unknown>,
) {
  const { readSecret, claimAssistant } = await import(
    "../interactions/index.mts"
  );
  const spend = createSpend({
    store: createSpendStore(process.env.CLAIMS_TABLE ?? ""),
    guildId,
    limitUsd:
      process.env.ASSISTANT_MONTHLY_LIMIT_USD === undefined
        ? undefined
        : Number(process.env.ASSISTANT_MONTHLY_LIMIT_USD),
    inputPerMillionUsd: Number(process.env.ASSISTANT_INPUT_PER_MILLION_USD),
    outputPerMillionUsd: Number(process.env.ASSISTANT_OUTPUT_PER_MILLION_USD),
    searchUsd: Number(process.env.ASSISTANT_SEARCH_USD),
    now: clock.now,
    report: spendMetric,
    total: spendTotalMetric,
    notify: async (content) => {
      const token = await readSecret(
        "/wow-forever/discord_bot_token",
        AbortSignal.timeout(5000),
      );
      await discordAlerts(
        new REST({ version: "10", timeout: 5000, retries: 0 }).setToken(token),
        guildId,
      )(content);
    },
  });
  const bedrock = new BedrockRuntimeClient({
    region: "us-east-1",
    maxAttempts: 1,
  });
  const metered = spend.bedrock((command, options) =>
    bedrock.send(command, options),
  );
  return createAssistant({
    checkSpend: spend.check,
    guildId,
    data: createDynamoDataAccess({
      tableName: process.env.GUILD_TABLE ?? "wow-forever",
      region: "us-east-1",
    }),
    claim: (asker, abortSignal) => claimAssistant(guildId, asker, abortSignal),
    search: createSearch({
      prepareRequest: spend.request,
      clock,
      secret: (abortSignal) =>
        readSecret("/wow-forever/parallel_api_key", abortSignal),
      http: fetch,
    }),
    converse: createConverse(metered),
    route: createRouting(metered),
    privateTerms: async () => {
      const guild = await get(`/guilds/${encodeURIComponent(guildId)}`);
      if (
        !guild ||
        typeof guild !== "object" ||
        !("name" in guild) ||
        typeof guild.name !== "string" ||
        !guild.name.trim()
      )
        throw new Error("ASSISTANT_GUILD_NAME_UNAVAILABLE");
      return [
        guild.name,
        ...(process.env.GUARD_EXTRA_TERMS ?? "")
          .split(",")
          .map((term) => term.trim())
          .filter(Boolean),
      ];
    },
  });
}
