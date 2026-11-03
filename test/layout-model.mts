import { equal, ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ChannelType as DiscordType,
  PermissionFlagsBits as flags,
} from "discord.js";
import type {
  CompiledOverwrite,
  IdMap,
  Layout,
  LiveChannel,
  Operation,
  Overwrite,
  Snapshot,
  Tag,
} from "../src/layout/index.mts";
import { parseLayout, plan } from "../src/layout/index.mts";
import { discordTypes } from "../src/layout/inventory.mts";

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
export const overwrite = (
  id = "guild",
  allow = "0",
  deny = "0",
  type: Overwrite["type"] = "role",
): Overwrite => ({ id, type, allow, deny });
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
    roles: fixture()
      .roles.slice(0, 2)
      .map((role, index) => ({
        ...role,
        id: index ? "app-role" : "guild",
        permissions: index ? "8" : "0",
        position: index * 100,
        managed: Boolean(index),
        applicationId: index ? "app" : undefined,
      })),
  };
  let serial = 0;
  const nextId = () => `synthetic-${++serial}`;
  const find = <Entry extends { id: string }>(entries: Entry[], id: string) => {
    const entry = entries.find((entry) => entry.id === id);
    ok(entry, `Missing ID ${id}`);
    return entry;
  };
  const live = (key = "lobby"): LiveChannel =>
    find(snapshot.channels, ids.channels[key]);
  const compiled = (entries: CompiledOverwrite[]) =>
    entries.map(({ roleKey, ...entry }) => ({
      ...entry,
      id: ids.roles[roleKey],
    }));
  const signature = (entries: Overwrite[]) =>
    entries
      .flatMap(({ type, id, allow, deny }) =>
        type === "role" &&
        id === snapshot.guildId &&
        (BigInt(allow) | BigInt(deny)) === 0n
          ? []
          : [`${type}:${id}:${BigInt(allow)}:${BigInt(deny)}`],
      )
      .sort()
      .join("|");
  const replace = (key: string, overwrites: Overwrite[]) => {
    const channel = live(key);
    if (channel.type === DiscordType.GuildCategory)
      for (const child of snapshot.channels)
        if (
          child.parent === channel.id &&
          signature(child.overwrites) === signature(channel.overwrites)
        )
          child.overwrites = structuredClone(overwrites);
    channel.overwrites = structuredClone(overwrites);
  };
  const tags = (key: string, values: (Tag & { id?: string })[]) => {
    ids.tags[key] = {};
    live(key).tags = values.map(({ key: tagKey, ...tag }) => {
      const id = tag.id ?? nextId();
      ids.tags[key][tagKey] = id;
      return { ...tag, id };
    });
  };
  const apply = (operation: Operation) => {
    const { kind } = operation;
    if (kind === "createRole" || kind === "updateRole") {
      const { role } = operation;
      if (kind === "createRole") {
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
      const target = find(snapshot.roles, ids.roles[role.key]);
      let allow = 0n,
        managed = 0n;
      for (const [name, enabled] of Object.entries(role.permissions)) {
        const bit = flags[name as keyof typeof flags];
        managed |= bit;
        if (enabled) allow |= bit;
      }
      Object.assign(target, role, {
        permissions: (
          (BigInt(target.permissions) & ~managed) |
          allow
        ).toString(),
      });
    } else if (kind === "createCategory" || kind === "createChannel") {
      const { channel } = operation;
      ids.channels[channel.key] = nextId();
      snapshot.channels.push({
        ...channel,
        id: ids.channels[channel.key],
        type: discordTypes[channel.type],
        parent: channel.parent ? ids.channels[channel.parent] : null,
        position: snapshot.channels.length,
        tags: [],
        overwrites: compiled(operation.overwrites),
      });
      tags(channel.key, channel.tags);
    } else if (kind === "updateChannel") {
      const target = live(operation.channel.key),
        { name, topic, parent } = operation.channel;
      const parentId = parent ? ids.channels[parent] : null;
      if (target.parent !== parentId)
        target.position =
          Math.max(
            -1,
            ...snapshot.channels
              .filter((entry) => entry.parent === parentId)
              .map((entry) => entry.position),
          ) + 1;
      Object.assign(target, { name, topic, parent: parentId });
    } else if (kind === "protectOverwrites")
      replace(operation.channelKey, operation.overwrites);
    else if (kind === "replaceOverwrites")
      replace(
        operation.channelKey,
        operation.overwrites.flatMap((entry) =>
          entry.kind === "preserved" ? [entry.overwrite] : compiled([entry]),
        ),
      );
    else if (kind === "setForumTags")
      tags(operation.channelKey, operation.tags);
    else if (kind === "reorderChannels" || kind === "reorderRoles") {
      const entries =
        kind === "reorderChannels"
          ? operation.channelKeys.map(live)
          : operation.roleKeys.map((key) =>
              find(snapshot.roles, ids.roles[key]),
            );
      const positions = entries
        .map((entry) => entry.position)
        .sort((left, right) => left - right);
      if (new Set(positions).size !== positions.length) {
        const siblings =
          kind === "reorderRoles"
            ? snapshot.roles
            : snapshot.channels.filter(
                (entry) =>
                  entry.parent === live(operation.channelKeys[0]).parent,
              );
        const occupied = new Set(
          siblings
            .filter((entry) => !entries.some((target) => target === entry))
            .map((entry) => entry.position),
        );
        for (let index = 0, slot = 0; index < positions.length; slot++)
          if (!occupied.has(slot)) positions[index++] = slot;
      }
      entries.forEach((entry, index) => {
        entry.position = positions[index];
      });
    } else if (kind === "removeOverwrite") {
      const channel = live(operation.channelKey);
      channel.overwrites = channel.overwrites.filter(
        (entry) => entry.id !== operation.id,
      );
    } else if (kind === "deleteRole")
      snapshot.roles = snapshot.roles.filter(
        (entry) => entry.id !== operation.id,
      );
    else if (kind === "deleteChannel" || kind === "deleteCategory") {
      for (const child of snapshot.channels)
        if (child.parent === operation.id) child.parent = null;
      snapshot.channels = snapshot.channels.filter(
        (entry) => entry.id !== operation.id,
      );
    } else throw new Error("Unsupported model operation");
  };
  const run = (layout: Layout) => {
    const planned = plan(layout, snapshot, ids);
    equal(planned.ok, true, JSON.stringify(planned));
    planned.operations.forEach(apply);
    return planned;
  };
  return { snapshot, ids, apply, live, run };
}
export function applied(layout = fixture()) {
  const server = model();
  server.run(layout);
  return { ...server, layout, run: () => server.run(layout) };
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
  if (bits & flags.Administrator) return true;
  for (const id of [snapshot.guildId, roleId]) {
    const entry = channel.overwrites.find(
      (entry) => entry.type === "role" && entry.id === id,
    );
    if (entry) bits = (bits & ~BigInt(entry.deny)) | BigInt(entry.allow);
  }
  return Boolean(bits & flags.ViewChannel);
}
