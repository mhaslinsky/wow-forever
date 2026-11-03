import { PermissionFlagsBits as flags } from "discord.js";
import {
  adoptionCandidates,
  bindings,
  discordTypes,
  untracked,
} from "./inventory.mts";
import {
  compilePermissions,
  normalizeOverwrites,
  protectiveOverwrite,
  rolePermissions,
} from "./permissions.mts";
import type {
  Channel,
  IdMap,
  Layout,
  Operation,
  ReplacementOverwrite,
  Snapshot,
} from "./types.mts";

export function plan(layout: Layout, snapshot: Snapshot, idMap: IdMap) {
  const ids = bindings(layout, snapshot, idMap);
  const errors: string[] = [];
  const liveRole = (key: string) =>
    snapshot.roles.find((entry) => entry.id === ids.roles[key]);
  const liveChannel = (key: string) =>
    snapshot.channels.find((entry) => entry.id === ids.channels[key]);
  const equal = (left: unknown, right: unknown) =>
    JSON.stringify(left) === JSON.stringify(right);
  const operations: Operation[] = [];
  const creates: Operation[] = [],
    updates: Operation[] = [],
    protects: Operation[] = [],
    replacements: Operation[] = [],
    reorders: Operation[] = [],
    deletes: Operation[] = [];
  const candidates = adoptionCandidates(layout, snapshot, ids);
  const operator = snapshot.roles.find(
    (role) => role.applicationId === snapshot.applicationId,
  );
  if (!operator) throw new Error("Missing operator role");
  const permissions =
    BigInt(operator.permissions) |
    BigInt(
      snapshot.roles.find((role) => role.id === snapshot.guildId)
        ?.permissions ?? "0",
    );
  if (
    !(permissions & flags.Administrator) &&
    (permissions & (flags.ManageRoles | flags.ManageChannels)) !==
      (flags.ManageRoles | flags.ManageChannels)
  )
    errors.push("Operator lacks ManageRoles or ManageChannels");
  for (const role of layout.roles) {
    const live = liveRole(role.key);
    if (role.kind === "operator" || role.kind === "observed") {
      if (!live) errors.push(`Missing role: ${role.key}`);
      continue;
    }
    if (!live) {
      if (candidates.roles[role.key])
        errors.push(`Adoption required: ${role.key}`);
      else if (role.kind === "everyone") errors.push("Missing everyone role");
      else creates.push({ kind: "createRole", role });
      continue;
    }
    if (
      role.kind === "managed" &&
      (live.position >= operator.position || live.managed)
    )
      errors.push(`Uneditable role: ${role.key}`);
    const { allow, managed } = rolePermissions(role);
    if (
      (BigInt(live.permissions) & managed) !== allow ||
      (role.kind !== "everyone" &&
        (live.name !== role.name ||
          live.color !== role.color ||
          live.hoist !== role.hoist ||
          live.mentionable !== role.mentionable))
    )
      updates.push({ kind: "updateRole", role });
  }
  const replacement = (channel: Channel): ReplacementOverwrite[] => {
    const managed = compilePermissions(layout, channel);
    const live = liveChannel(channel.key);
    const preserved =
      live?.overwrites.filter(
        (entry) =>
          entry.type === "member" ||
          (layout.ignore.overwrites.includes(
            snapshot.roles.find((role) => role.id === entry.id)?.name ?? "",
          ) &&
            !managed.some((target) => ids.roles[target.roleKey] === entry.id)),
      ) ?? [];
    return [
      ...managed.map((entry) => ({ kind: "compiled" as const, ...entry })),
      ...preserved.map((overwrite) => ({
        kind: "preserved" as const,
        overwrite: { ...overwrite },
      })),
    ];
  };
  const replacedCategories = new Set<string>();
  const changingParents = new Set<string>();
  let typeChange = false;
  for (const channel of layout.channels) {
    const live = liveChannel(channel.key);
    const compiled = compilePermissions(layout, channel);
    const overwrites = compiled.map(({ roleKey, ...entry }) => ({
      ...entry,
      id: ids.roles[roleKey] ?? `new:${roleKey}`,
    }));
    const retained = replacement(channel).flatMap((entry) =>
      entry.kind === "preserved" ? [entry.overwrite] : [],
    );
    const expected = normalizeOverwrites([...overwrites, ...retained]);
    if (!live || live.type !== discordTypes[channel.type]) {
      if (!live && candidates.channels[channel.key])
        errors.push(`Adoption required: ${channel.key}`);
      else {
        const parent = channel.parent ? liveChannel(channel.parent) : undefined;
        const protectedList =
          parent && Object.values(channel.access).some((access) => !access.view)
            ? protectiveOverwrite(
                {
                  type: channel.type,
                  everyoneId: snapshot.guildId,
                  overwrites,
                },
                parent,
              )
            : overwrites;
        const createOverwrites = protectedList.map(({ id, ...entry }) => {
          const target = compiled.find(
            (target) =>
              (ids.roles[target.roleKey] ?? `new:${target.roleKey}`) === id,
          );
          if (!target) throw new Error(`Unbound protective overwrite: ${id}`);
          return { ...entry, roleKey: target.roleKey };
        });
        creates.push({
          kind:
            channel.type === "category" ? "createCategory" : "createChannel",
          channel,
          overwrites: createOverwrites,
        });
        if (!equal(protectedList, normalizeOverwrites(overwrites)))
          replacements.push({
            kind: "replaceOverwrites",
            channelKey: channel.key,
            overwrites: replacement(channel),
          });
      }
      if (live) {
        typeChange = true;
        deletes.push({
          kind:
            live.type === discordTypes.category
              ? "deleteCategory"
              : "deleteChannel",
          key: channel.key,
          id: live.id,
          destructive: true,
        });
        if (live.type === discordTypes.category)
          replacedCategories.add(live.id);
      }
      continue;
    }
    if (
      live.name !== channel.name ||
      live.topic !== channel.topic ||
      live.parent !== (channel.parent ? ids.channels[channel.parent] : null)
    ) {
      updates.push({ kind: "updateChannel", channel, lockPermissions: false });
      if (
        live.parent !== (channel.parent ? ids.channels[channel.parent] : null)
      )
        changingParents.add(live.id);
    }
    if (!equal(normalizeOverwrites(live.overwrites), expected)) {
      replacements.push({
        kind: "replaceOverwrites",
        channelKey: channel.key,
        overwrites: replacement(channel),
      });
      if (channel.type === "category") replacedCategories.add(live.id);
    }
    for (const tag of channel.tags)
      if (
        !ids.tags[channel.key]?.[tag.key] &&
        candidates.tags[channel.key]?.[tag.key]
      )
        errors.push(`Adoption required: ${channel.key}/${tag.key}`);
    const tags = channel.tags.map((tag) => ({
      ...tag,
      ...(live.tags.some(
        (entry) => entry.id === ids.tags[channel.key]?.[tag.key],
      )
        ? { id: ids.tags[channel.key][tag.key] }
        : {}),
    }));
    const tagValues = (entries: typeof tags | typeof live.tags) =>
      entries.map((tag) => [tag.id, tag.name, tag.moderated, tag.emoji]);
    if (!equal(tagValues(tags), tagValues(live.tags)))
      updates.push({
        kind: "setForumTags",
        channelKey: channel.key,
        tags,
        destructive: live.tags.some(
          (tag) => !tags.some((desired) => desired.id === tag.id),
        ),
      });
  }
  for (const channel of layout.channels) {
    const live = liveChannel(channel.key);
    const parent = snapshot.channels.find((entry) => entry.id === live?.parent);
    if (
      !live ||
      live.type !== discordTypes[channel.type] ||
      !parent ||
      (!replacedCategories.has(parent.id) && !changingParents.has(live.id)) ||
      !Object.values(channel.access).some((access) => !access.view)
    )
      continue;
    let overwrites = protectiveOverwrite(
      {
        type: channel.type,
        everyoneId: snapshot.guildId,
        overwrites: live.overwrites,
      },
      parent,
    );
    const destination = channel.parent
      ? liveChannel(channel.parent)
      : undefined;
    if (changingParents.has(live.id) && destination)
      overwrites = protectiveOverwrite(
        { type: channel.type, everyoneId: snapshot.guildId, overwrites },
        destination,
      );
    if (!equal(overwrites, normalizeOverwrites(live.overwrites))) {
      protects.push({
        kind: "protectOverwrites",
        channelKey: channel.key,
        overwrites,
      });
      if (
        !replacements.some(
          (entry) =>
            entry.kind === "replaceOverwrites" &&
            entry.channelKey === channel.key,
        )
      )
        replacements.push({
          kind: "replaceOverwrites",
          channelKey: channel.key,
          overwrites: replacement(channel),
        });
    }
  }
  const roleKeys = layout.roles
    .filter((role) => role.kind === "managed")
    .map((role) => role.key);
  const reorder = (
    keys: string[],
    position: (key: string) => number | undefined,
  ) =>
    keys.length > 1 &&
    (keys.some((key) => position(key) === undefined) ||
      !equal(
        keys,
        [...keys].sort(
          (left, right) =>
            (position(left) ?? Infinity) - (position(right) ?? Infinity),
        ),
      ));
  if (reorder(roleKeys, (key) => liveRole(key)?.position))
    reorders.push({ kind: "reorderRoles", roleKeys });
  for (const parentKey of [
    undefined,
    ...layout.channels
      .filter((channel) => channel.type === "category")
      .map((channel) => channel.key),
  ]) {
    const channelKeys = layout.channels
      .filter((channel) => channel.parent === parentKey)
      .map((channel) => channel.key);
    if (
      reorder(channelKeys, (key) =>
        creates.some((entry) => "channel" in entry && entry.channel.key === key)
          ? undefined
          : liveChannel(key)?.position,
      )
    )
      reorders.push({
        kind: "reorderChannels",
        channelKeys,
        ...(parentKey ? { parentKey } : {}),
      });
  }
  for (const [key, id] of Object.entries(ids.channels)) {
    const live = snapshot.channels.find((entry) => entry.id === id);
    if (live && !layout.channels.some((entry) => entry.key === key))
      deletes.push({
        kind:
          live.type === discordTypes.category
            ? "deleteCategory"
            : "deleteChannel",
        key,
        id,
        destructive: true,
      });
  }
  for (const channel of layout.channels) {
    const live = liveChannel(channel.key);
    if (live?.type !== discordTypes[channel.type]) continue;
    for (const entry of live.overwrites)
      if (entry.type === "member")
        deletes.push({
          kind: "removeOverwrite",
          channelKey: channel.key,
          id: entry.id,
          destructive: true,
        });
  }
  for (const [key, id] of Object.entries(ids.roles)) {
    const live = snapshot.roles.find((entry) => entry.id === id);
    if (
      live &&
      !layout.roles.some((entry) => entry.key === key) &&
      id !== snapshot.guildId &&
      live.applicationId !== snapshot.applicationId
    ) {
      if (live.managed || live.position >= operator.position)
        errors.push(`Uneditable role: ${key}`);
      else deletes.push({ kind: "deleteRole", key, id, destructive: true });
    }
  }
  const phases = [
    "createRole",
    "updateRole",
    "createCategory",
    "createChannel",
  ];
  for (const kind of phases)
    operations.push(
      ...[...creates, ...updates].filter((entry) => entry.kind === kind),
    );
  operations.push(
    ...protects,
    ...updates.filter((entry) => entry.kind !== "updateRole"),
    ...replacements,
    ...reorders,
  );
  for (const kind of [
    "deleteChannel",
    "deleteCategory",
    "removeOverwrite",
    "deleteRole",
  ])
    operations.push(...deletes.filter((entry) => entry.kind === kind));
  const inventory = untracked(layout, snapshot, ids);
  return {
    operations,
    untracked: inventory,
    uneditable: snapshot.roles
      .filter(
        (role) =>
          role.id !== snapshot.guildId &&
          (role.managed || role.position >= operator.position),
      )
      .map((role) => role.id),
    errors,
    ok: errors.length === 0 && inventory.length === 0,
    destructive:
      typeChange ||
      operations.some((entry) => "destructive" in entry && entry.destructive),
  };
}
