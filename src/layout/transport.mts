import childProcess from "node:child_process";
import { REST, type RESTOptions, type RequestMethod } from "@discordjs/rest";
import type { APIGuildForumTag, APIRole, ChannelType } from "discord.js";
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
  readonly kind: "keychain" | "http" | "network" | "identity" | "snapshot";
  readonly status?: number;

  constructor(
    kind: "keychain" | "http" | "network" | "identity" | "snapshot",
    message: string,
    status?: number,
  ) {
    super(message);
    this.name = "LayoutTransportError";
    this.kind = kind;
    this.status = status;
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
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      )
      .trim();
  } catch {
    throw new LayoutTransportError("keychain", "Operator token unavailable");
  }
  if (!token)
    throw new LayoutTransportError("keychain", "Operator token is missing");
  return token;
}

export function discordTransport(
  token: string,
  options: Partial<RESTOptions> = {},
): DiscordPort {
  const rest = new REST({ ...options, version: "10", retries: 0 }).setToken(
    token,
  );
  return {
    async request(method, route, body) {
      try {
        return await rest.request({
          method: method as RequestMethod,
          fullRoute: route,
          body,
        });
      } catch (error) {
        const status =
          error &&
          typeof error === "object" &&
          "status" in error &&
          typeof error.status === "number"
            ? error.status
            : undefined;
        // Upstream errors may contain the token in response or request details.
        throw new LayoutTransportError(
          status === undefined ? "network" : "http",
          `Discord ${method} failed`,
          status,
        );
      }
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
      channels: channels.map((channel) => ({
        id: channel.id,
        name: channel.name,
        type: channel.type,
        parent: channel.parent_id,
        topic: channel.topic ?? "",
        position: channel.position,
        tags: decodeTags(channel.available_tags ?? []),
        overwrites: (channel.permission_overwrites ?? []).map((entry) => ({
          ...entry,
          type: entry.type === 0 ? "role" : "member",
        })),
      })),
    });
  } catch (error) {
    if (error instanceof LayoutTransportError) throw error;
    throw new LayoutTransportError("snapshot", "Invalid Discord inventory");
  }
}
