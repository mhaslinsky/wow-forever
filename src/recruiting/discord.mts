import {
  AuditLogEvent,
  ChannelType,
  type Client,
  type ForumChannel,
  type Guild,
  PermissionFlagsBits,
  Routes,
} from "discord.js";
import {
  createPrincipalFactory,
  createSystemPrincipal,
  type Principal,
} from "../auth/index.mts";
import type { createDataAccess } from "../data/index.mts";
import type { Handlers } from "../gateway/client.mts";
import { createRoster } from "../roster/core.mts";
import { reportRecruitingFailure } from "./alarm.mts";
import { discordAlerts } from "./alerts.mts";
import { createRecruiting, type ForumPort, sameTags } from "./core.mts";

export const APPROVAL_MESSAGE =
  "Hey, you've been approved! Hop on and whisper any officer in game for a guild invite. Once you're in we'll get your Discord access sorted.";

type AppliedTagsChange = { key: "applied_tags"; old?: unknown; new?: unknown };

// Withdrawing a deleted thread's candidate never touches the forum, so every
// thread delete in the guild must not depend on the forum being healthy.
const noForum = new Proxy({} as ForumPort, {
  get: () => async () => {
    throw new Error("FORUM_UNUSED_ON_DELETE");
  },
});

function tagList(value: unknown): string[] {
  const list = value === undefined ? [] : value;
  if (!Array.isArray(list) || !list.every((tag) => typeof tag === "string"))
    throw new Error("RECRUITING_AUDIT_TAGS_INVALID");
  return list;
}

export async function recruitingContext(guild: Guild) {
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

function discordText(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 3)}...` : value;
}

export function discordForum(forum: ForumChannel): ForumPort {
  return {
    async verifyIntake(threadId, ref) {
      try {
        const bot = (await forum.client.rest.get(Routes.user())) as {
          id?: string;
        };
        const thread = await forum.threads.fetch(threadId, { force: true });
        if (
          !bot.id ||
          !thread ||
          thread.type !== ChannelType.PublicThread ||
          thread.guildId !== forum.guild.id ||
          thread.parentId !== forum.id ||
          thread.ownerId !== bot.id
        )
          throw new Error("INTAKE_VERIFICATION_FAILED");
        const starter = await thread.fetchStarterMessage({ force: true });
        if (
          !starter ||
          starter.author.id !== bot.id ||
          !starter.content.trimEnd().endsWith(`\n-# ref ${ref}`)
        )
          throw new Error("INTAKE_VERIFICATION_FAILED");
      } catch (cause) {
        throw new Error("INTAKE_VERIFICATION_FAILED", { cause });
      }
    },
    async tags() {
      return (await forum.fetch()).availableTags;
    },
    async create(input) {
      const reference = input.ref ? `\n-# ref ${input.ref}` : "";
      const thread = await forum.threads.create({
        name: discordText(input.name, 100),
        message: {
          content:
            discordText(input.content, 2000 - reference.length) + reference,
          allowedMentions: { parse: [] },
        },
        appliedTags: input.tags,
      });
      return thread.id;
    },
    async post(threadId, content) {
      const thread = await forum.threads.fetch(threadId, { force: true });
      if (!thread || thread.parentId !== forum.id)
        throw new Error("CANDIDATE_THREAD_MISSING");
      if (thread.archived) await thread.setArchived(false);
      await thread.send({ content, allowedMentions: { parse: [] } });
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

export function acceptForGuild(
  guild: Guild,
  data: ReturnType<typeof createDataAccess>,
) {
  const roster = createRoster(data, guild.id);
  return (candidate: import("./core.mts").Candidate) =>
    roster.accept(
      candidate,
      createSystemPrincipal(["member"]),
      // Plain REST calls: user.send reads client.user, which is null on the
      // Lambdas' clients that never log in.
      async (userId) => {
        const channel = (await guild.client.rest.post(Routes.userChannels(), {
          body: { recipient_id: userId },
        })) as { id?: string };
        if (!channel?.id) throw new Error("APPROVAL_DM_CHANNEL_MISSING");
        await guild.client.rest.post(Routes.channelMessages(channel.id), {
          body: { content: APPROVAL_MESSAGE, allowed_mentions: { parse: [] } },
        });
      },
    );
}

export async function recruitingForGuild(
  guild: Guild,
  data: ReturnType<typeof createDataAccess>,
  principal: Principal<"system">,
) {
  const { forum } = await recruitingContext(guild);
  return createRecruiting(
    data,
    principal,
    guild.id,
    discordForum(forum),
    reportRecruitingFailure,
    acceptForGuild(guild, data),
    discordAlerts(guild.client.rest, guild.id),
  );
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
        !entry.targetId ||
        !entry.executorId ||
        entry.executorId === client.user?.id
      )
        return;
      const deleted = entry.action === AuditLogEvent.ThreadDelete;
      const change = deleted
        ? undefined
        : entry.action === AuditLogEvent.ThreadUpdate
          ? (entry.changes as unknown as AppliedTagsChange[]).find(
              (value) => value.key === "applied_tags",
            )
          : undefined;
      if (!deleted && !change) return;
      const previous = pending.get(guild.id) ?? Promise.resolve();
      const processDelete = async () => {
        await createRecruiting(
          data,
          principal,
          guild.id,
          noForum,
          reportRecruitingFailure,
        ).threadDeleted({
          threadId: entry.targetId as string,
          actorId: entry.executorId as string,
          eventId: entry.id,
          at: entry.createdAt.toISOString(),
        });
      };
      const processEntry = async () => {
        const thread = await guild.channels.fetch(entry.targetId as string);
        if (!thread?.isThread() || thread.parent?.name !== "recruiting") return;
        const next = tagList(change?.new);
        const previousTags = tagList(change?.old);
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
          reportRecruitingFailure,
          acceptForGuild(guild, data),
        );
        await core.officerTags({
          threadId: thread.id,
          tags: next,
          added: next.filter((tag) => !previousTags.includes(tag)),
          actor,
          eventId: entry.id,
          at: entry.createdAt.toISOString(),
        });
      };
      const work = deleted ? processDelete : processEntry;
      const operation = previous.then(work, work);
      pending.set(guild.id, operation);
      try {
        await operation;
      } finally {
        if (pending.get(guild.id) === operation) pending.delete(guild.id);
      }
    },
  };
}
