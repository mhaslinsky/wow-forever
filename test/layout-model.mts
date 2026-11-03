import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ChannelType as DiscordType, PermissionFlagsBits } from "discord.js";
import type {
  CompiledOverwrite,
  IdMap,
  Layout,
  Operation,
  Overwrite,
  Snapshot,
} from "../src/layout/index.mts";
import { parseLayout, plan } from "../src/layout/index.mts";
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
    channels: [],
    roles: [
      {
        ...fixture().roles[0],
        id: "guild",
        permissions: "0",
        position: 0,
        managed: false,
      },
      {
        ...fixture().roles[1],
        id: "app-role",
        permissions: "8",
        position: 100,
        managed: true,
        applicationId: "app",
      },
    ],
  };
  let serial = 0;
  const nextId = () => `synthetic-${++serial}`;
  const channelByKey = (key: string) =>
    snapshot.channels.find((entry) => entry.id === ids.channels[key]);
  const compiled = (entries: CompiledOverwrite[]) =>
    entries.map(({ roleKey, ...entry }) => ({
      ...entry,
      id: ids.roles[roleKey],
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
        ...role,
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
        ...channel,
        type: discordTypes[channel.type],
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
        parent: parentId,
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
    } else if (operation.kind === "reorderChannels") {
      const entries = operation.channelKeys.map((key) => {
        const channel = channelByKey(key);
        assert.ok(channel);
        return channel;
      });
      const positions = entries
        .map((entry) => entry.position)
        .sort((left, right) => left - right);
      entries.forEach((entry, index) => {
        entry.position = positions[index];
      });
    } else if (operation.kind === "removeOverwrite") {
      const live = channelByKey(operation.channelKey);
      if (live)
        live.overwrites = live.overwrites.filter(
          (entry) => entry.id !== operation.id,
        );
    } else throw new Error(`Unsupported model operation: ${operation.kind}`);
  };
  return { snapshot, ids, apply };
}
export function canView(
  snapshot: Snapshot,
  channelId: string,
  roleId: string,
): boolean {
  const channel = snapshot.channels.find((entry) => entry.id === channelId);
  if (!channel) return false;
  let bits = snapshot.roles
    .filter((role) => role.id === snapshot.guildId || role.id === roleId)
    .reduce((bits, role) => bits | BigInt(role.permissions), 0n);
  if (bits & PermissionFlagsBits.Administrator) return true;
  for (const id of [snapshot.guildId, roleId]) {
    const entry = channel.overwrites.find(
      (entry) => entry.type === "role" && entry.id === id,
    );
    if (entry) bits = (bits & ~BigInt(entry.deny)) | BigInt(entry.allow);
  }
  return Boolean(bits & PermissionFlagsBits.ViewChannel);
}
export const fixture = () =>
  parseLayout(
    readFileSync(new URL("./fixtures/layout.yaml", import.meta.url), "utf8"),
  );
export const access = (view = false, connect = false) => ({
  view,
  send: view,
  connect,
  manageThreads: view,
});
export function category(layout: Layout, key = "category") {
  const channel = {
    ...structuredClone(layout.channels[0]),
    key,
    name: key,
    type: "category" as const,
    tags: [],
  };
  channel.access.operator.connect = true;
  return channel;
}
export function applied(layout = fixture()) {
  const server = model();
  const run = () => {
    const result = plan(layout, server.snapshot, server.ids);
    assert.equal(result.ok, true, JSON.stringify(result));
    result.operations.forEach(server.apply);
    return result;
  };
  run();
  const live = (key = "lobby") => {
    const channel = server.snapshot.channels.find(
      (entry) => entry.id === server.ids.channels[key],
    );
    assert.ok(channel);
    return channel;
  };
  return { ...server, layout, run, live };
}
