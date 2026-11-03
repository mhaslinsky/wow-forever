import { ChannelType as DiscordType, PermissionFlagsBits } from "discord.js";
import type {
  IdMap,
  Operation,
  Overwrite,
  Snapshot,
} from "../src/layout/index.mts";

import { discordTypes } from "../src/layout/inventory.mts";

export function model() {
  const ids: IdMap = {
    roles: { everyone: "guild", operator: "app-role" },
    channels: {},
    tags: {},
  };
  const snapshot: Snapshot = {
    guildId: "guild",
    applicationId: "app",
    roles: [
      {
        id: "guild",
        name: "@everyone",
        permissions: "0",
        position: 0,
        color: 0,
        hoist: false,
        mentionable: false,
        managed: false,
      },
      {
        id: "app-role",
        name: "Operator",
        permissions: "8",
        position: 100,
        color: 0,
        hoist: false,
        mentionable: false,
        managed: true,
        applicationId: "app",
      },
    ],
    channels: [],
  };
  let serial = 0;
  const nextId = () => `synthetic-${++serial}`;
  const channelByKey = (key: string) =>
    snapshot.channels.find((entry) => entry.id === ids.channels[key]);
  const compiled = (
    entries: {
      roleKey: string;
      allow: string;
      deny: string;
      type: "role" | "member";
    }[],
  ) =>
    entries.map((entry) => ({
      type: entry.type,
      allow: entry.allow,
      deny: entry.deny,
      id: ids.roles[entry.roleKey],
    }));
  const replace = (key: string, overwrites: Overwrite[]) => {
    const channel = channelByKey(key);
    if (!channel) throw new Error(`Missing channel ${key}`);
    const signature = (entries: Overwrite[]) =>
      entries
        .filter(
          (entry) =>
            !(
              entry.type === "role" &&
              entry.id === snapshot.guildId &&
              BigInt(entry.allow) === 0n &&
              BigInt(entry.deny) === 0n
            ),
        )
        .map(
          (entry) =>
            `${entry.type}:${entry.id}:${BigInt(entry.allow)}:${BigInt(entry.deny)}`,
        )
        .sort()
        .join("|");
    if (channel.type === DiscordType.GuildCategory)
      for (const child of snapshot.channels) {
        if (
          child.parent === channel.id &&
          signature(child.overwrites) === signature(channel.overwrites)
        )
          child.overwrites = structuredClone(overwrites);
      }
    channel.overwrites = structuredClone(overwrites);
  };
  const apply = (operation: Operation) => {
    if (operation.kind === "createRole" || operation.kind === "updateRole") {
      const { role } = operation;
      if (operation.kind === "createRole") {
        for (const entry of snapshot.roles)
          if (entry.id !== "guild") entry.position++;
        ids.roles[role.key] = nextId();
        snapshot.roles.push({
          ...role,
          id: ids.roles[role.key],
          permissions: "0",
          position: 1,
          managed: false,
        });
      }
      const live = snapshot.roles.find(
        (entry) => entry.id === ids.roles[role.key],
      );
      if (!live) throw new Error("Missing role");
      let allow = 0n,
        managed = 0n;
      for (const [name, enabled] of Object.entries(role.permissions)) {
        const bit =
          PermissionFlagsBits[name as keyof typeof PermissionFlagsBits];
        managed |= bit;
        if (enabled) allow |= bit;
      }
      Object.assign(live, {
        name: role.name,
        color: role.color,
        hoist: role.hoist,
        mentionable: role.mentionable,
        permissions: ((BigInt(live.permissions) & ~managed) | allow).toString(),
      });
    } else if (
      operation.kind === "createCategory" ||
      operation.kind === "createChannel"
    ) {
      const { channel } = operation;
      ids.channels[channel.key] = nextId();
      snapshot.channels.push({
        id: ids.channels[channel.key],
        name: channel.name,
        type: discordTypes[channel.type],
        topic: channel.topic,
        parent: channel.parent ? ids.channels[channel.parent] : null,
        position: snapshot.channels.length,
        tags: [],
        overwrites: compiled(operation.overwrites),
      });
      if (channel.tags.length)
        apply({
          kind: "setForumTags",
          channelKey: channel.key,
          tags: channel.tags,
          destructive: false,
        });
    } else if (operation.kind === "updateChannel") {
      const live = channelByKey(operation.channel.key);
      if (!live) throw new Error("Missing channel");
      const parentId = operation.channel.parent
        ? ids.channels[operation.channel.parent]
        : null;
      if (live.parent !== parentId)
        live.position =
          Math.max(
            -1,
            ...snapshot.channels
              .filter((entry) => entry.parent === parentId)
              .map((entry) => entry.position),
          ) + 1;
      Object.assign(live, {
        name: operation.channel.name,
        topic: operation.channel.topic,
        parent: operation.channel.parent
          ? ids.channels[operation.channel.parent]
          : null,
      });
    } else if (operation.kind === "protectOverwrites")
      replace(operation.channelKey, operation.overwrites);
    else if (operation.kind === "replaceOverwrites")
      replace(
        operation.channelKey,
        operation.overwrites.flatMap((entry) =>
          entry.kind === "preserved" ? [entry.overwrite] : compiled([entry]),
        ),
      );
    else if (operation.kind === "setForumTags") {
      ids.tags[operation.channelKey] = {};
      const live = channelByKey(operation.channelKey);
      if (!live) throw new Error("Missing forum");
      live.tags = operation.tags.map(({ key, ...tag }) => {
        const id = tag.id ?? nextId();
        ids.tags[operation.channelKey][key] = id;
        return { ...tag, id };
      });
    } else if (
      operation.kind === "reorderChannels" ||
      operation.kind === "reorderRoles"
    ) {
      const entries =
        operation.kind === "reorderRoles"
          ? operation.roleKeys.map((key) =>
              snapshot.roles.find((entry) => entry.id === ids.roles[key]),
            )
          : operation.channelKeys.map(channelByKey);
      const positions = entries
        .map((entry) => {
          if (!entry) throw new Error("Missing reorder target");
          return entry.position;
        })
        .sort((left, right) => left - right);
      entries.forEach((entry, index) => {
        if (entry) entry.position = positions[index];
      });
    } else if (operation.kind === "removeOverwrite") {
      const live = channelByKey(operation.channelKey);
      if (live)
        live.overwrites = live.overwrites.filter(
          (entry) => entry.id !== operation.id,
        );
    } else if ("id" in operation) {
      if (operation.kind === "deleteRole")
        snapshot.roles = snapshot.roles.filter(
          (entry) => entry.id !== operation.id,
        );
      else {
        for (const child of snapshot.channels)
          if (child.parent === operation.id) child.parent = null;
        snapshot.channels = snapshot.channels.filter(
          (entry) => entry.id !== operation.id,
        );
      }
    }
  };
  return { snapshot, ids, apply };
}
