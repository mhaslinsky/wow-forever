import {
  AuditLogEvent,
  ChannelType,
  type Client,
  type ForumChannel,
  type Guild,
  PermissionFlagsBits,
} from "discord.js";
import { createPrincipalFactory, type Principal } from "../auth/index.mts";
import type { createDataAccess } from "../data/index.mts";
import type { Handlers } from "../gateway/client.mts";
import { reportRecruitingFailure } from "./alarm.mts";
import { createRecruiting, type ForumPort, sameTags } from "./core.mts";

type AppliedTagsChange = { key: "applied_tags"; new?: unknown };

async function recruitingContext(guild: Guild) {
  const roles = await guild.roles.fetch();
  function roleId(name: string) {
    const matches = roles.filter((role) => role.name === name);
    const role = matches.first();
    if (matches.size !== 1 || !role)
      throw new Error(`ROLE_MISSING_OR_AMBIGUOUS:${name}`);
    return role.id;
  }
  const memberId = roleId("Member");
  const factory = createPrincipalFactory({
    guildId: guild.id,
    memberRoleId: memberId,
    officerRoleId: roleId("Officer"),
    officerRoleIds: [roleId("GM")],
    jobs: {},
  });
  const channels = await guild.channels.fetch();
  const matches = channels.filter((channel) => channel?.name === "recruiting");
  const forum = matches.first();
  if (matches.size !== 1 || forum?.type !== ChannelType.GuildForum)
    throw new Error("RECRUITING_FORUM_MISSING_OR_AMBIGUOUS");
  if (
    forum
      .permissionsFor(guild.roles.everyone)
      ?.has(PermissionFlagsBits.ViewChannel)
  )
    throw new Error("RECRUITING_FORUM_PUBLIC");
  if (forum.permissionsFor(memberId)?.has(PermissionFlagsBits.ViewChannel))
    throw new Error("RECRUITING_FORUM_VISIBLE_TO_MEMBERS");
  return { forum, factory };
}

export async function checkRecruitingAuditAccess(guild: Guild) {
  try {
    const bot = await guild.members.fetchMe({ force: true });
    if (bot.permissions.has(PermissionFlagsBits.ViewAuditLog)) return;
  } catch {}
  reportRecruitingFailure({
    code: "RECRUITING_AUDIT_UNAVAILABLE",
    guildId: guild.id,
  });
}

export function discordForum(forum: ForumChannel): ForumPort {
  return {
    async tags() {
      return (await forum.fetch()).availableTags;
    },
    async create(input) {
      const thread = await forum.threads.create({
        name: input.name,
        message: { content: input.content, allowedMentions: { parse: [] } },
        appliedTags: input.tags,
      });
      return thread.id;
    },
    async tagsFor(threadId) {
      const thread = await forum.threads.fetch(threadId, { force: true });
      if (!thread || thread.parentId !== forum.id)
        throw new Error("CANDIDATE_THREAD_MISSING");
      return thread.appliedTags;
    },
    async setTags(threadId, tags, expected) {
      const thread = await forum.threads.fetch(threadId, { force: true });
      if (!thread || thread.parentId !== forum.id)
        throw new Error("CANDIDATE_THREAD_MISSING");
      // A correction must not erase an edit that arrived during the fetch.
      if (!sameTags(thread.appliedTags, expected)) return;
      await thread.setAppliedTags(tags);
    },
  };
}

export async function recruitingForGuild(
  guild: Guild,
  data: ReturnType<typeof createDataAccess>,
  principal: Principal<"system">,
) {
  const { forum } = await recruitingContext(guild);
  return createRecruiting(data, principal, guild.id, discordForum(forum));
}

export function recruitingHandlers(
  client: Client,
  data: ReturnType<typeof createDataAccess>,
  principal: Principal<"system">,
  guildId: string,
): Handlers {
  if (!guildId.trim()) throw new Error("GUILD_ID_REQUIRED");
  const pending = new Map<string, Promise<void>>();
  return {
    async guildAuditLogEntryCreate(entry, guild) {
      if (
        guild.id !== guildId ||
        entry.action !== AuditLogEvent.ThreadUpdate ||
        !entry.targetId ||
        !entry.executorId ||
        entry.executorId === client.user?.id
      )
        return;
      const change = (entry.changes as unknown as AppliedTagsChange[]).find(
        (value) => value.key === "applied_tags",
      );
      if (!change) return;
      const previous = pending.get(guild.id) ?? Promise.resolve();
      const processEntry = async () => {
        const thread = await guild.channels.fetch(entry.targetId as string);
        if (!thread?.isThread() || thread.parent?.name !== "recruiting") return;
        const next = change.new === undefined ? [] : change.new;
        if (
          !Array.isArray(next) ||
          !next.every((tag) => typeof tag === "string")
        )
          throw new Error("RECRUITING_AUDIT_TAGS_INVALID");
        const { forum, factory } = await recruitingContext(guild);
        const fetchMember = () =>
          guild.members.fetch({
            user: entry.executorId as string,
            force: true,
          });
        const member = await fetchMember()
          .catch(fetchMember)
          .catch((cause: unknown) => {
            reportRecruitingFailure({
              code: "RECRUITING_MEMBER_LOOKUP_FAILED",
              threadId: thread.id,
            });
            throw new Error(`RECRUITING_MEMBER_LOOKUP_FAILED:${thread.id}`, {
              cause,
            });
          });
        const actor = await factory.fromGateway(
          { guildId: guild.id, userId: entry.executorId as string },
          async () => ({
            userId: member.id,
            roleIds: [...member.roles.cache.keys()],
          }),
        );
        const core = createRecruiting(
          data,
          principal,
          guild.id,
          discordForum(forum),
        );
        await core.officerTags({
          threadId: thread.id,
          tags: next,
          actor,
          eventId: entry.id,
          at: entry.createdAt.toISOString(),
        });
      };
      const operation = previous.then(processEntry, processEntry);
      pending.set(guild.id, operation);
      try {
        await operation;
      } finally {
        if (pending.get(guild.id) === operation) pending.delete(guild.id);
      }
    },
  };
}
