import { PermissionFlagsBits as flags } from "discord.js";
import {
  bounded,
  type Clock,
  type Interaction,
} from "../interactions/core.mts";

export type ChannelMessage = { author: string; content: string };
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
                author: name.slice(0, 100),
                content: raw.content.trim().slice(0, 500),
              };
            })
            .filter(
              (entry) =>
                entry.content &&
                entry.timestamp >= now - 43200000 &&
                entry.timestamp <= now,
            )
            .sort((left, right) => left.timestamp - right.timestamp)
            .map(({ author, content }) => ({ author, content }));
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
