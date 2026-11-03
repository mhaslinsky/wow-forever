import { ChannelType as DiscordType } from "discord.js";
import type { ChannelType, IdMap, Layout, Snapshot } from "./types.mts";

export const discordTypes: Record<ChannelType, DiscordType> = {
  category: DiscordType.GuildCategory,
  text: DiscordType.GuildText,
  news: DiscordType.GuildAnnouncement,
  forum: DiscordType.GuildForum,
  voice: DiscordType.GuildVoice,
};
export function bindings(
  layout: Layout,
  snapshot: Snapshot,
  idMap: IdMap,
): IdMap {
  const ids = structuredClone(idMap);
  for (const role of layout.roles) {
    if (role.kind === "everyone") ids.roles[role.key] = snapshot.guildId;
    if (role.kind === "operator") {
      const matches = snapshot.roles.filter(
        (live) => live.applicationId === snapshot.applicationId,
      );
      if (matches.length !== 1)
        throw new Error("Expected one operator application role");
      ids.roles[role.key] = matches[0].id;
    }
  }
  return ids;
}
export function adoptionCandidates(
  layout: Layout,
  snapshot: Snapshot,
  idMap: IdMap,
): IdMap {
  const ids = bindings(layout, snapshot, idMap);
  const bind = (
    target: Record<string, string>,
    key: string,
    candidates: { id: string }[],
  ) => {
    if (target[key]) return;
    if (candidates.length > 1) throw new Error(`Ambiguous adoption: ${key}`);
    if (candidates.length === 1) {
      if (Object.values(target).includes(candidates[0].id))
        throw new Error(`Ambiguous adoption: ${key}`);
      target[key] = candidates[0].id;
    }
  };
  for (const role of layout.roles)
    bind(
      ids.roles,
      role.key,
      snapshot.roles.filter((live) => live.name === role.name),
    );
  for (const channel of [
    ...layout.channels.filter((entry) => entry.type === "category"),
    ...layout.channels.filter((entry) => entry.type !== "category"),
  ]) {
    if (channel.parent && !ids.channels[channel.parent]) continue;
    bind(
      ids.channels,
      channel.key,
      snapshot.channels.filter(
        (live) =>
          live.name === channel.name &&
          live.type === discordTypes[channel.type] &&
          live.parent ===
            (channel.parent ? ids.channels[channel.parent] : null),
      ),
    );
    const live = snapshot.channels.find(
      (entry) => entry.id === ids.channels[channel.key],
    );
    ids.tags[channel.key] ??= {};
    const tags = ids.tags[channel.key];
    for (const tag of channel.tags)
      bind(
        tags,
        tag.key,
        live?.tags.filter((entry) => entry.name === tag.name) ?? [],
      );
  }
  return ids;
}
export type Untracked = {
  kind: "role" | "channel" | "overwrite";
  id: string;
  channelId?: string;
};
export function untracked(
  layout: Layout,
  snapshot: Snapshot,
  ids: IdMap,
): Untracked[] {
  const result: Untracked[] = [];
  const operator = snapshot.roles.find(
    (role) => role.applicationId === snapshot.applicationId,
  );
  for (const role of snapshot.roles) {
    if (
      role.id !== snapshot.guildId &&
      !Object.values(ids.roles).includes(role.id) &&
      !role.managed &&
      !role.applicationId &&
      role.position < (operator?.position ?? 0) &&
      !layout.ignore.roles.includes(role.name)
    )
      result.push({ kind: "role", id: role.id });
  }
  for (const channel of snapshot.channels) {
    if (
      !Object.values(ids.channels).includes(channel.id) &&
      !layout.ignore.channels.includes(channel.name)
    )
      result.push({ kind: "channel", id: channel.id });
    if (layout.ignore.channels.includes(channel.name)) continue;
    for (const overwrite of channel.overwrites) {
      const role = snapshot.roles.find((entry) => entry.id === overwrite.id);
      if (
        overwrite.type === "member" ||
        (!Object.values(ids.roles).includes(overwrite.id) &&
          !layout.ignore.overwrites.includes(role?.name ?? ""))
      )
        result.push({
          kind: "overwrite",
          id: overwrite.id,
          channelId: channel.id,
        });
    }
  }
  return result;
}
