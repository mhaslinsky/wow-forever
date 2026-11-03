import { AsyncLocalStorage } from "node:async_hooks";
import childProcess from "node:child_process";
import {
  RateLimitError,
  REST,
  RESTEvents,
  type RequestMethod,
} from "@discordjs/rest";
import { type APIGuildForumTag, type APIRole, ChannelType } from "discord.js";
import { normalizeSnapshot } from "./normalize.mts";
import type { Overwrite, Snapshot, Tag } from "./types.mts";

export type Method = "GET" | "POST" | "PATCH" | "DELETE";
export type DiscordPort = {
  request(
    method: Method,
    route: `/${string}`,
    body?: unknown,
  ): Promise<unknown>;
};
export type Target = { guildId: string; applicationId: string };

export class LayoutTransportError extends Error {
  readonly kind:
    | "keychain"
    | "http"
    | "network"
    | "identity"
    | "snapshot"
    | "rate_limit";
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(
    kind:
      | "keychain"
      | "http"
      | "network"
      | "identity"
      | "snapshot"
      | "rate_limit",
    message: string,
    status?: number,
    retryAfterMs?: number,
  ) {
    super(message);
    this.name = "LayoutTransportError";
    this.kind = kind;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export function keychainToken(): string {
  let token: string;
  try {
    token = childProcess
      .execFileSync(
        "/usr/bin/security",
        [
          "find-generic-password",
          "-s",
          "wow-forever-discord-operator-token",
          "-a",
          "wow-forever",
          "-w",
        ],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 10_000,
        },
      )
      .trim();
  } catch {
    throw new LayoutTransportError("keychain", "Operator token unavailable");
  }
  if (!token)
    throw new LayoutTransportError("keychain", "Operator token is missing");
  return token;
}

export function discordTransport(token: string): DiscordPort {
  if (!token.trim())
    throw new LayoutTransportError("keychain", "Operator token is missing");
  const responses = new AsyncLocalStorage<{ status?: number }>();
  const rest = new REST({
    api: "https://discord.com/api",
    authPrefix: "Bot",
    version: "10",
    retries: 0,
    rejectOnRateLimit: () => true,
  }).setToken(token);
  rest.on(RESTEvents.Response, (_request, response) => {
    const current = responses.getStore();
    if (current) current.status = response.status;
  });
  return {
    request(method, route, body) {
      const response: { status?: number } = {};
      return responses.run(response, async () => {
        try {
          return await rest.request({
            method: method as RequestMethod,
            fullRoute: route,
            body,
          });
        } catch (error) {
          if (error instanceof RateLimitError)
            throw new LayoutTransportError(
              "rate_limit",
              "Discord rate limited",
              429,
              error.retryAfter,
            );
          // Upstream errors may contain the token in response or request details.
          throw new LayoutTransportError(
            response.status === undefined ? "network" : "http",
            `Discord ${method} failed`,
            response.status,
          );
        }
      });
    },
  };
}

export function decodeTags(
  tags: APIGuildForumTag[],
): (Omit<Tag, "key"> & { id: string })[] {
  return tags.map((tag) => ({
    id: tag.id,
    name: tag.name,
    moderated: tag.moderated,
    ...(tag.emoji_id || tag.emoji_name
      ? { emoji: tag.emoji_id ?? tag.emoji_name ?? undefined }
      : {}),
  }));
}
export function wireOverwrites(entries: Overwrite[]) {
  return entries.map((entry) => ({
    ...entry,
    type: entry.type === "role" ? 0 : 1,
  }));
}
export function wireTags(tags: (Tag & { id?: string })[]) {
  return tags.map(({ key: _key, emoji, ...tag }) => ({
    ...tag,
    emoji_id: emoji && /^\d+$/.test(emoji) ? emoji : null,
    emoji_name: emoji && !/^\d+$/.test(emoji) ? emoji : null,
  }));
}

export async function fetchSnapshot(
  port: DiscordPort,
  target: Target,
): Promise<Snapshot> {
  try {
    const application = (await port.request(
      "GET",
      "/oauth2/applications/@me",
    )) as { id: string };
    if (application.id !== target.applicationId)
      throw new LayoutTransportError(
        "identity",
        "Operator application differs",
      );
    const guild = (await port.request("GET", `/guilds/${target.guildId}`)) as {
      id: string;
    };
    if (guild.id !== target.guildId)
      throw new LayoutTransportError("identity", "Target guild differs");
    const roles = (await port.request(
      "GET",
      `/guilds/${target.guildId}/roles`,
    )) as APIRole[];
    const channels = (await port.request(
      "GET",
      `/guilds/${target.guildId}/channels`,
    )) as {
      id: string;
      name: string;
      type: ChannelType;
      parent_id?: string | null;
      topic?: string | null;
      position: number;
      available_tags?: APIGuildForumTag[];
      permission_overwrites?: {
        id: string;
        type: 0 | 1;
        allow: string;
        deny: string;
      }[];
    }[];
    return normalizeSnapshot({
      ...target,
      roles: roles.map((role) => ({
        id: role.id,
        name: role.name,
        permissions: role.permissions,
        color: role.color,
        hoist: role.hoist,
        mentionable: role.mentionable,
        managed: role.managed,
        position: role.position,
        ...(role.tags?.bot_id ? { applicationId: role.tags.bot_id } : {}),
      })),
      channels: channels.map((channel) => {
        // Missing lists could erase preserved overwrites or tags during replacement.
        if (!Array.isArray(channel.permission_overwrites))
          throw new LayoutTransportError(
            "snapshot",
            "Channel permissions are missing",
          );
        if (
          (channel.type === ChannelType.GuildForum ||
            channel.type === ChannelType.GuildMedia) &&
          !Array.isArray(channel.available_tags)
        )
          throw new LayoutTransportError(
            "snapshot",
            "Channel tags are missing",
          );
        return {
          id: channel.id,
          name: channel.name,
          type: channel.type,
          parent: channel.parent_id,
          topic: channel.topic ?? "",
          position: channel.position,
          tags: decodeTags(channel.available_tags ?? []),
          overwrites: channel.permission_overwrites.map((entry) => ({
            ...entry,
            type: entry.type === 0 ? "role" : "member",
          })),
        };
      }),
    });
  } catch (error) {
    if (error instanceof LayoutTransportError) throw error;
    throw new LayoutTransportError("snapshot", "Invalid Discord inventory");
  }
}
