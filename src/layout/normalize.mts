import { ChannelType } from "discord.js";
import { normalizeBits, normalizeOverwrites } from "./permissions.mts";
import type { LiveChannel, LiveRole, Snapshot } from "./types.mts";

type RawRole = Omit<
  LiveRole,
  "permissions" | "color" | "hoist" | "mentionable" | "managed"
> &
  Partial<Pick<LiveRole, "color" | "hoist" | "mentionable" | "managed">> & {
    permissions: string | number | bigint;
  };
type RawChannel = Omit<LiveChannel, "topic" | "parent" | "tags"> &
  Partial<Pick<LiveChannel, "topic" | "parent" | "tags">>;

/** Accepts decoded REST fields; transport errors and missing inventories must remain errors. */
export function normalizeSnapshot(
  snapshot: Omit<Snapshot, "roles" | "channels"> & {
    roles: RawRole[];
    channels: RawChannel[];
  },
): Snapshot {
  return {
    guildId: snapshot.guildId,
    applicationId: snapshot.applicationId,
    roles: snapshot.roles.map((role) => ({
      ...role,
      permissions: normalizeBits(role.permissions),
      color: role.color ?? 0,
      hoist: role.hoist ?? false,
      mentionable: role.mentionable ?? false,
      managed: role.managed ?? false,
    })),
    channels: snapshot.channels
      .filter(
        (channel) =>
          ![
            ChannelType.AnnouncementThread,
            ChannelType.PublicThread,
            ChannelType.PrivateThread,
          ].includes(channel.type),
      )
      .map((channel) => ({
        ...channel,
        topic: channel.topic ?? "",
        parent: channel.parent ?? null,
        tags: (channel.tags ?? []).map((tag) => ({ ...tag })),
        overwrites: normalizeOverwrites(channel.overwrites),
      })),
  };
}
