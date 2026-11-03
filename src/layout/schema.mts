import { PermissionFlagsBits } from "discord.js";
import { parseDocument } from "yaml";
import type { Access, Channel, Layout, Role, Tag } from "./types.mts";
import { channelTypes } from "./types.mts";

function fail(message: string): never {
  throw new Error(`Invalid layout: ${message}`);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("expected an object");
  return value as Record<string, unknown>;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) fail("expected an array");
  return value;
}
function string(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "")
    fail("expected a nonempty string");
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") fail("expected a boolean");
  return value;
}
function fields(value: Record<string, unknown>, allowed: string[]) {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) fail(`unknown field ${key}`);
}
function unique(keys: string[]) {
  if (new Set(keys).size !== keys.length) fail("duplicate keys");
}
function names(value: unknown): string[] {
  const result = array(value).map(string);
  unique(result);
  return result;
}
function key(value: unknown): string {
  const result = string(value);
  if (!/^[a-z][a-z0-9-]*$/.test(result)) fail(`invalid stable key ${result}`);
  return result;
}
function role(value: unknown): Role {
  const entry = object(value);
  fields(entry, [
    "key",
    "name",
    "kind",
    "permissions",
    "color",
    "hoist",
    "mentionable",
  ]);
  const kind = string(entry.kind) as Role["kind"];
  if (!["everyone", "operator", "managed", "observed"].includes(kind))
    fail("unknown role kind");
  const permissions = Object.fromEntries(
    Object.entries(object(entry.permissions)).map(([permission, enabled]) => {
      if (!Object.hasOwn(PermissionFlagsBits, permission))
        fail(`unknown permission ${permission}`);
      return [permission, boolean(enabled)];
    }),
  );
  if (permissions.Administrator && kind !== "operator")
    fail("Administrator requires the operator role");
  const color = entry.color === undefined ? 0 : entry.color;
  if (!Number.isInteger(color) || Number(color) < 0 || Number(color) > 0xffffff)
    fail("invalid role color");
  return {
    key: key(entry.key),
    name: string(entry.name),
    kind,
    permissions,
    color: Number(color),
    hoist: boolean(entry.hoist === undefined ? false : entry.hoist),
    mentionable: boolean(
      entry.mentionable === undefined ? false : entry.mentionable,
    ),
  };
}
function tag(value: unknown): Tag {
  const entry = object(value);
  fields(entry, ["key", "name", "moderated", "emoji"]);
  return {
    key: key(entry.key),
    name: string(entry.name),
    moderated: boolean(entry.moderated === undefined ? false : entry.moderated),
    ...(entry.emoji === undefined ? {} : { emoji: string(entry.emoji) }),
  };
}
function access(value: unknown, type: Channel["type"]): Access {
  const entry = object(value);
  fields(entry, ["view", "send", "connect", "manageThreads"]);
  const result = {
    view: boolean(entry.view),
    send: boolean(
      type === "voice" && entry.send === undefined ? false : entry.send,
    ),
    connect: boolean(entry.connect),
    manageThreads: boolean(entry.manageThreads),
  };
  if (!result.view && (result.send || result.connect || result.manageThreads))
    fail("view denied with another access allowed");
  if (type === "voice" && result.manageThreads)
    fail("voice channels cannot declare text access");
  if (type !== "voice" && type !== "category" && result.connect)
    fail("text channels cannot declare connect");
  return result;
}

/** Validates unknown input before making any permission or identity decisions. */
export function validateLayout(value: unknown): Layout {
  const entry = object(value);
  fields(entry, ["roles", "channels", "ignore"]);
  const roles = array(entry.roles).map(role);
  unique(roles.map((entry) => entry.key));
  for (const kind of ["everyone", "operator"])
    if (roles.filter((entry) => entry.kind === kind).length !== 1)
      fail(`expected one ${kind} role`);
  const channels: Channel[] = array(entry.channels).map((value) => {
    const entry = object(value);
    fields(entry, ["key", "name", "type", "parent", "topic", "access", "tags"]);
    const type = string(entry.type) as Channel["type"];
    if (!channelTypes.includes(type)) fail("unknown channel type");
    const table = object(entry.access);
    if (
      Object.keys(table).length !== roles.length ||
      roles.some((role) => !Object.hasOwn(table, role.key))
    )
      fail("incomplete access coverage");
    const accessTable = Object.fromEntries(
      Object.entries(table).map(([roleKey, value]) => [
        roleKey,
        access(value, type),
      ]),
    );
    for (const role of roles) {
      if (
        role.permissions.Administrator &&
        (!accessTable[role.key].view ||
          (type === "voice"
            ? !accessTable[role.key].connect || !accessTable[role.key].send
            : !accessTable[role.key].send ||
              !accessTable[role.key].manageThreads) ||
          (type === "category" && !accessTable[role.key].connect))
      )
        fail("Administrator must expect every access");
    }
    const tags = array(entry.tags === undefined ? [] : entry.tags).map(tag);
    unique(tags.map((entry) => entry.key));
    if (tags.length > 20 || (type !== "forum" && tags.length))
      fail("invalid forum tags");
    const topic = entry.topic === undefined ? "" : entry.topic;
    if (typeof topic !== "string") fail("expected a topic string");
    return {
      key: key(entry.key),
      name: string(entry.name),
      type,
      topic,
      ...(entry.parent === undefined ? {} : { parent: key(entry.parent) }),
      access: accessTable,
      tags,
    };
  });
  unique(channels.map((entry) => entry.key));
  for (const channel of channels) {
    if (channel.type === "category" && channel.parent)
      fail("categories cannot have parents");
    if (
      channel.parent &&
      !channels.some(
        (parent) => parent.key === channel.parent && parent.type === "category",
      )
    )
      fail("missing category parent");
  }
  const ignore = object(
    entry.ignore === undefined
      ? { roles: [], channels: [], overwrites: [] }
      : entry.ignore,
  );
  fields(ignore, ["roles", "channels", "overwrites"]);
  return {
    roles,
    channels,
    ignore: {
      roles: names(ignore.roles),
      channels: names(ignore.channels),
      overwrites: names(ignore.overwrites),
    },
  };
}

/** YAML has no Discord IDs; live identities belong to the private state file. */
export function parseLayout(source: string): Layout {
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length)
    fail(document.errors.map((error) => error.message).join("; "));
  return validateLayout(document.toJS({ maxAliasCount: 0 }));
}
