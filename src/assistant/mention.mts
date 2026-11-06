import { PermissionFlagsBits as flags, PermissionsBitField } from "discord.js";
import { capToMember } from "../auth/index.mts";
import type { ChannelContext } from "./context.mts";
import { type createAssistant, REFUSAL } from "./core.mts";
import { assistantPrincipal, assistantRoleIds } from "./runtime.mts";
import { timeoutReply } from "./timeout.mts";

export type Mention = {
  guildId: string;
  channelId: string;
  messageId: string;
  authorId: string;
};
type Role = { id: string; permissions: string };
type Member = { user: { id: string; bot?: boolean }; roles: string[] };
type Overwrite = { id: string; type: number; allow: string; deny: string };
type Channel = {
  id: string;
  guild_id: string;
  type: number;
  parent_id?: string;
  permission_overwrites: Overwrite[];
};
type Guild = { id: string; owner_id: string };

export function canView(
  member: Member,
  channel: Pick<Channel, "permission_overwrites">,
  roles: Role[],
  guild: Guild,
  permission: bigint = flags.ViewChannel,
): boolean {
  if (member.user.id === guild.owner_id) return true;
  const permissions = new PermissionsBitField();
  for (const role of roles)
    if (role.id === guild.id || member.roles.includes(role.id))
      permissions.add(BigInt(role.permissions));
  if (permissions.has(flags.Administrator)) return true;
  const apply = (entries: Overwrite[]) => {
    let deny = 0n;
    let allow = 0n;
    for (const entry of entries) {
      deny |= BigInt(entry.deny);
      allow |= BigInt(entry.allow);
    }
    permissions.remove(deny).add(allow);
  };
  apply(
    channel.permission_overwrites.filter(
      (entry) => entry.type === 0 && entry.id === guild.id,
    ),
  );
  apply(
    channel.permission_overwrites.filter(
      (entry) =>
        entry.type === 0 &&
        entry.id !== guild.id &&
        member.roles.includes(entry.id),
    ),
  );
  apply(
    channel.permission_overwrites.filter(
      (entry) => entry.type === 1 && entry.id === member.user.id,
    ),
  );
  return permissions.has(permission, false);
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("INVALID_RESPONSE");
  return value as Record<string, unknown>;
}
function id(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("INVALID_ID");
  return value;
}
function bits(value: unknown): string {
  if (typeof value !== "string" || !/^\d+$/.test(value))
    throw new Error("INVALID_PERMISSIONS");
  return value;
}
function channel(value: unknown, expectedId: string, guildId: string): Channel {
  const raw = object(value);
  if (
    raw.id !== expectedId ||
    raw.guild_id !== guildId ||
    typeof raw.type !== "number" ||
    ![0, 5, 10, 11, 12, 15, 16].includes(raw.type)
  )
    throw new Error("INVALID_CHANNEL");
  const thread = [10, 11, 12].includes(Number(raw.type));
  if (!thread && !Array.isArray(raw.permission_overwrites))
    throw new Error("INVALID_OVERWRITES");
  const overwrites = (
    thread ? [] : (raw.permission_overwrites as unknown[])
  ).map((value) => {
    const entry = object(value);
    if (entry.type !== 0 && entry.type !== 1)
      throw new Error("INVALID_OVERWRITE");
    return {
      id: id(entry.id),
      type: entry.type,
      allow: bits(entry.allow),
      deny: bits(entry.deny),
    };
  });
  return {
    id: expectedId,
    guild_id: guildId,
    type: Number(raw.type),
    ...(thread ? { parent_id: id(raw.parent_id) } : {}),
    permission_overwrites: overwrites,
  };
}

export function createMention(ports: {
  guildId: string;
  get(path: string): Promise<unknown>;
  patch?(path: string, body: unknown, signal: AbortSignal): Promise<unknown>;
  claim(key: string, expiresAt: number, signal: AbortSignal): Promise<boolean>;
  now(): number;
  context?(channelId: string, signal: AbortSignal): ReturnType<ChannelContext>;
  answer: ReturnType<typeof createAssistant>;
  reply(event: Mention, content: string, signal: AbortSignal): Promise<void>;
  report(reason: string): void;
}) {
  const getChannel = async (channelId: string) =>
    channel(
      await ports.get(`/channels/${encodeURIComponent(channelId)}`),
      channelId,
      ports.guildId,
    );
  async function verify(channelId: string) {
    let target = await getChannel(channelId);
    if ([10, 11, 12].includes(target.type))
      target = await getChannel(id(target.parent_id));
    if ([10, 11, 12].includes(target.type)) throw new Error("INVALID_PARENT");
    const guildPath = `/guilds/${encodeURIComponent(ports.guildId)}`;
    const rawGuild = object(await ports.get(guildPath));
    if (rawGuild.id !== ports.guildId) throw new Error("INVALID_GUILD");
    const guild = { id: ports.guildId, owner_id: id(rawGuild.owner_id) };
    const rawRoles = await ports.get(`${guildPath}/roles`);
    const roleId = assistantRoleIds(rawRoles);
    const allowed = [roleId("Member"), roleId("Officer"), roleId("GM")];
    const roles = (rawRoles as unknown[]).map((value) => {
      const role = object(value);
      return { id: id(role.id), permissions: bits(role.permissions) };
    });
    if (
      !roles.some((role) => role.id === guild.id) ||
      new Set(roles.map((role) => role.id)).size !== roles.length ||
      new Set(allowed).size !== 3
    )
      throw new Error("INVALID_ROLES");
    const publicViewer = { user: { id: "" }, roles: [] };
    let guildRecords = !canView(publicViewer, target, roles, guild);
    let after = "";
    let count = 0;
    let history =
      guildRecords ||
      canView(publicViewer, target, roles, guild, flags.ReadMessageHistory);
    for (;;) {
      const page = await ports.get(
        `${guildPath}/members?limit=1000${after ? `&after=${encodeURIComponent(after)}` : ""}`,
      );
      if (!Array.isArray(page) || page.length > 1000)
        throw new Error("INVALID_MEMBERS");
      for (const value of page) {
        const raw = object(value);
        const user = object(raw.user);
        if (
          !Array.isArray(raw.roles) ||
          !raw.roles.every(
            (role) =>
              typeof role === "string" &&
              roles.some((known) => known.id === role),
          ) ||
          (user.bot !== undefined && typeof user.bot !== "boolean")
        )
          throw new Error("INVALID_MEMBER");
        const member = {
          user: { id: id(user.id), bot: user.bot === true },
          roles: raw.roles as string[],
        };
        if (
          canView(member, target, roles, guild) &&
          !canView(member, target, roles, guild, flags.ReadMessageHistory)
        )
          history = false;
        if (
          !member.user.bot &&
          canView(member, target, roles, guild) &&
          !member.roles.some((role) => allowed.includes(role))
        )
          guildRecords = false;
      }
      count += page.length;
      if (page.length < 1000) break;
      const next = id(object(object(page.at(-1)).user).id);
      if (next === after) throw new Error("INVALID_PAGINATION");
      after = next;
    }
    if (!count) throw new Error("EMPTY_MEMBERS");
    return { guildRecords, history };
  }
  async function audience(channelId: string) {
    try {
      return await verify(channelId);
    } catch (error) {
      ports.report(
        error instanceof Error ? error.message : "VERIFICATION_FAILED",
      );
      return { guildRecords: false, history: false };
    }
  }
  return async (event: Mention, signal: AbortSignal) => {
    if (
      event?.guildId !== ports.guildId ||
      ![event.channelId, event.messageId, event.authorId].every(
        (value) => typeof value === "string" && value,
      )
    ) {
      ports.report("INVALID_EVENT");
      return;
    }
    try {
      const claimed = await ports.claim(
        `mention-message#${event.guildId}#${event.channelId}#${event.messageId}`,
        Math.ceil(ports.now() / 1000) + 86400,
        signal,
      );
      if (!claimed) {
        ports.report("DUPLICATE");
        return;
      }
      await getChannel(event.channelId);
      const message = object(
        await ports.get(
          `/channels/${encodeURIComponent(event.channelId)}/messages/${encodeURIComponent(event.messageId)}`,
        ),
      );
      const bot = object(await ports.get("/users/@me"));
      const botId = id(bot.id);
      if (
        message.id !== event.messageId ||
        message.channel_id !== event.channelId ||
        object(message.author).id !== event.authorId ||
        object(message.author).bot === true ||
        !Array.isArray(message.mentions) ||
        !message.mentions.some((user) => object(user).id === botId)
      ) {
        ports.report("INVALID_MESSAGE");
        return;
      }
      if (typeof message.content !== "string")
        throw new Error("INVALID_CONTENT");
      const question = message.content
        .split(`<@${botId}>`)
        .join("")
        .split(`<@!${botId}>`)
        .join("")
        .trim();
      const principal = await assistantPrincipal(
        event.guildId,
        event.authorId,
        ports.get,
      );
      const timeout = await timeoutReply(
        principal,
        question,
        {
          guildId: ports.guildId,
          get: ports.get,
          patch: ports.patch,
          report: ports.report,
          now: ports.now,
        },
        signal,
      );
      if (timeout !== undefined) {
        await ports.reply(event, timeout, signal);
        return;
      }
      const actor = capToMember(principal);
      const context = ports.context;
      const answer = await ports.answer(
        actor,
        question,
        signal,
        context
          ? (abortSignal) => context(event.channelId, abortSignal)
          : undefined,
        () => audience(event.channelId),
      );
      if (answer === REFUSAL) return;
      await ports.reply(event, answer, signal);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "MENTION_FAILED";
      ports.report(reason);
    }
  };
}
