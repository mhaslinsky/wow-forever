import { PermissionFlagsBits as flags } from "discord.js";
import {
  bounded,
  type Clock,
  type Interaction,
} from "../interactions/core.mts";

export type ChannelMessage = {
  author: string;
  content: string;
  authorId?: string;
  timestamp?: number;
  bot?: boolean;
  replyToAuthorId?: string;
};

export function rememberRequest(question: string) {
  return /^(?:please\s+)?remember(?:\s+that)?[\s:]+([\s\S]+)$/iu.exec(
    question.trim(),
  );
}

export async function filterForgottenContext(
  messages: ChannelMessage[],
  cutoff: (userId: string) => Promise<number>,
) {
  const kept: ChannelMessage[] = [];
  for (const entry of messages) {
    if (entry.bot && !entry.replyToAuthorId) continue;
    const userId = entry.bot ? entry.replyToAuthorId : entry.authorId;
    if (
      userId &&
      entry.timestamp !== undefined &&
      entry.timestamp <= (await cutoff(userId))
    )
      continue;
    kept.push(entry);
  }
  return kept;
}
export type ChannelContext = (signal: AbortSignal) => Promise<ChannelMessage[]>;
type ContextReason =
  | "used"
  | "empty"
  | "permission"
  | "schema"
  | "fetch"
  | "timeout";

export function interactionHistoryChannel(
  interaction: Pick<Interaction, "channel_id" | "member">,
) {
  const permissions = interaction.member?.permissions;
  if (
    !interaction.channel_id ||
    typeof permissions !== "string" ||
    !/^\d+$/.test(permissions)
  )
    return undefined;
  const bits = BigInt(permissions);
  const required = flags.ViewChannel | flags.ReadMessageHistory;
  return (bits & flags.Administrator) !== 0n || (bits & required) === required
    ? interaction.channel_id
    : undefined;
}

export function reportContext(reason: ContextReason, count: number) {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: "WowForever",
            Dimensions: [[]],
            Metrics: [{ Name: "ChannelContextMessages", Unit: "Count" }],
          },
        ],
      },
      ChannelContextMessages: count,
      reason,
    }),
  );
}

export function createChannelContext(
  ports: {
    clock: Clock;
    get(path: string, signal: AbortSignal): Promise<unknown>;
    report?: typeof reportContext;
  },
  channelId?: string,
): ChannelContext {
  return async (parent) => {
    parent.throwIfAborted();
    const report = ports.report ?? reportContext;
    if (!channelId) {
      report("permission", 0);
      return [];
    }
    let reason: ContextReason = "fetch";
    try {
      const messages = await bounded(
        ports.clock,
        3000,
        parent,
        async (signal) => {
          const body = await ports.get(
            `/channels/${encodeURIComponent(channelId)}/messages?limit=20`,
            signal,
          );
          reason = "schema";
          if (!Array.isArray(body) || body.length > 20)
            throw new Error("INVALID_HISTORY");
          const now = ports.clock.now();
          const referencedAuthor = (
            raw: Record<string, unknown>,
          ): string | undefined => {
            const reference = raw.referenced_message as
              | { author?: { id?: unknown } }
              | undefined;
            const interaction = raw.interaction_metadata as
              | { user?: { id?: unknown } }
              | undefined;
            const messageId = (
              raw.message_reference as { message_id?: unknown } | undefined
            )?.message_id;
            const original =
              typeof messageId === "string"
                ? body.find((message) => message?.id === messageId)
                : undefined;
            const authorId =
              reference?.author?.id ??
              interaction?.user?.id ??
              original?.author?.id;
            return typeof authorId === "string" ? authorId : undefined;
          };
          return body
            .map((raw: unknown) => {
              if (
                !raw ||
                typeof raw !== "object" ||
                !("content" in raw) ||
                typeof raw.content !== "string" ||
                !("timestamp" in raw) ||
                typeof raw.timestamp !== "string" ||
                !("author" in raw) ||
                !raw.author ||
                typeof raw.author !== "object"
              )
                throw new Error("INVALID_HISTORY");
              const author = raw.author as Record<string, unknown>;
              const member =
                "member" in raw && raw.member && typeof raw.member === "object"
                  ? (raw.member as Record<string, unknown>)
                  : undefined;
              const name =
                member?.nick ?? author.global_name ?? author.username;
              const timestamp = Date.parse(raw.timestamp);
              if (
                typeof name !== "string" ||
                !name.trim() ||
                !Number.isFinite(timestamp)
              )
                throw new Error("INVALID_HISTORY");
              return {
                timestamp,
                authorId: typeof author.id === "string" ? author.id : undefined,
                bot: author.bot === true,
                replyToAuthorId: referencedAuthor(
                  raw as Record<string, unknown>,
                ),
                author: name.slice(0, 100),
                content: raw.content.trim().slice(0, 500),
              };
            })
            .filter(
              (entry) =>
                entry.content &&
                !rememberRequest(
                  entry.content.replace(/<@!?\d+>/gu, "").trim(),
                ) &&
                !(entry.bot && entry.content === "Remembered.") &&
                entry.timestamp >= now - 43200000 &&
                entry.timestamp <= now,
            )
            .sort((left, right) => left.timestamp - right.timestamp)
            .map(
              ({
                author,
                content,
                authorId,
                timestamp,
                bot,
                replyToAuthorId,
              }) => ({
                author,
                content,
                ...(authorId
                  ? { authorId, timestamp, bot, replyToAuthorId }
                  : {}),
              }),
            );
        },
      );
      parent.throwIfAborted();
      report(messages.length ? "used" : "empty", messages.length);
      return messages;
    } catch (error) {
      parent.throwIfAborted();
      report(
        error instanceof Error && error.message === "Request cancelled"
          ? "timeout"
          : reason,
        0,
      );
      return [];
    }
  };
}
