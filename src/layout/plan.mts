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
  rolePermissions,
} from "./permissions.mts";
import { denyView, privateChannel, unsync } from "./protection.mts";
import type {
  Channel,
  CompiledOverwrite,
  IdMap,
  Layout,
  Operation,
  Overwrite,
  ReplacementOverwrite,
  Snapshot,
} from "./types.mts";

/** Protect; remove role permissions; create roles, categories, then children; update and reparent.
 * Finalize category overwrites before channel overwrites; grant role permissions, reorder, delete.
 * Protection stays until parents are final, preventing category sync and role grants from exposing children.
 */
export function plan(layout: Layout, snapshot: Snapshot, idMap: IdMap) {
  const bound = bindings(layout, snapshot, idMap);
  const staleBindings: {
    kind: "role" | "channel" | "tag";
    key: string;
    id: string;
    channelKey?: string;
  }[] = [];
  for (const kind of ["roles", "channels"] as const)
    for (const [key, id] of Object.entries(bound[kind])) {
      if (!snapshot[kind].some((entry) => entry.id === id)) {
        staleBindings.push({
          kind: kind === "roles" ? "role" : "channel",
          key,
          id,
        });
        delete bound[kind][key];
      }
    }
  for (const [channelKey, tags] of Object.entries(bound.tags))
    for (const [key, id] of Object.entries(tags)) {
      if (
        !snapshot.channels
          .find((entry) => entry.id === bound.channels[channelKey])
          ?.tags.some((entry) => entry.id === id)
      ) {
        staleBindings.push({ kind: "tag", channelKey, key, id });
        delete tags[key];
      }
    }
  const ids = adoptionCandidates(layout, snapshot, bound);
  const errors: string[] = [];
  for (const kind of ["roles", "channels"] as const)
    for (const [key, id] of Object.entries(ids[kind]))
      if (bound[kind][key] !== id) errors.push(`Adoption required: ${key}`);
  for (const [channelKey, tags] of Object.entries(ids.tags))
    for (const [key, id] of Object.entries(tags))
      if (bound.tags[channelKey]?.[key] !== id)
        errors.push(`Adoption required: ${channelKey}/${key}`);
  const liveRole = (key: string) =>
    snapshot.roles.find((entry) => entry.id === ids.roles[key]);
  const liveChannel = (key: string) =>
    snapshot.channels.find((entry) => entry.id === ids.channels[key]);
  const equal = (left: unknown, right: unknown) =>
    JSON.stringify(left) === JSON.stringify(right);
  const sameOverwrites = (left: Overwrite[], right: Overwrite[]) =>
    equal(normalizeOverwrites(left), normalizeOverwrites(right));
  const roleId = (key: string) => ids.roles[key] ?? `new:${key}`;
  const resolve = (entries: CompiledOverwrite[]): Overwrite[] =>
    entries.map(({ roleKey, ...entry }) => ({ ...entry, id: roleId(roleKey) }));
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
  const protects: Operation[] = [],
    removals: Operation[] = [],
    roleCreates: Operation[] = [],
    categoryCreates: Operation[] = [],
    channelCreates: Operation[] = [],
    updates: Operation[] = [],
    grants: Operation[] = [],
    reorders: Operation[] = [],
    deletes: Operation[] = [];
  const replacements = new Map<string, ReplacementOverwrite[]>();
  let roleBitsChanged = false;
  for (const role of layout.roles) {
    const live = liveRole(role.key);
    if (role.kind === "operator" || role.kind === "observed") {
      if (!live) errors.push(`Missing role: ${role.key}`);
      continue;
    }
    if (!live) {
      if (role.kind === "everyone") errors.push("Missing everyone role");
      else roleCreates.push({ kind: "createRole", role });
      continue;
    }
    if (
      role.kind === "managed" &&
      (live.position >= operator.position || live.managed)
    )
      errors.push(`Uneditable role: ${role.key}`);
    const { allow, managed } = rolePermissions(role);
    const current = BigInt(live.permissions) & managed;
    const removed = current & ~allow;
    const added = allow & ~current;
    roleBitsChanged ||= current !== allow;
    const fieldsChanged =
      role.kind !== "everyone" &&
      (live.name !== role.name ||
        live.color !== role.color ||
        live.hoist !== role.hoist ||
        live.mentionable !== role.mentionable);
    if (removed || fieldsChanged)
      removals.push({
        kind: "updateRole",
        role: {
          ...role,
          permissions: Object.fromEntries(
            Object.keys(role.permissions)
              .filter((name) => !role.permissions[name])
              .map((name) => [name, false]),
          ),
        },
      });
    if (added) grants.push({ kind: "updateRole", role });
  }
  const recreated = new Set(
    layout.channels
      .filter(
        (channel) =>
          !liveChannel(channel.key) ||
          liveChannel(channel.key)?.type !== discordTypes[channel.type],
      )
      .map((channel) => channel.key),
  );
  const replacement = (channel: Channel): ReplacementOverwrite[] => {
    const compiled = compilePermissions(layout, channel);
    const preserved = (liveChannel(channel.key)?.overwrites ?? []).filter(
      (entry) =>
        (entry.type === "member" && !recreated.has(channel.key)) ||
        (entry.type === "role" &&
          layout.ignore.overwrites.includes(
            snapshot.roles.find((role) => role.id === entry.id)?.name ?? "",
          ) &&
          !compiled.some((target) => roleId(target.roleKey) === entry.id)),
    );
    return [
      ...compiled.map((entry) => ({ kind: "compiled" as const, ...entry })),
      ...preserved.map((overwrite) => ({
        kind: "preserved" as const,
        overwrite: { ...overwrite },
      })),
    ];
  };
  const finalOverwrites = (channel: Channel) =>
    replacement(channel).flatMap((entry) =>
      entry.kind === "preserved" ? [entry.overwrite] : resolve([entry]),
    );
  const deletedChannel = (
    key: string,
    id: string,
    category: boolean,
  ): Operation => ({
    kind: category ? "deleteCategory" : "deleteChannel",
    key,
    id,
    destructive: true,
  });
  const touched = new Set<string>();
  for (const channel of layout.channels) {
    const live = liveChannel(channel.key);
    if (recreated.has(channel.key)) {
      touched.add(channel.key);
      if (live)
        deletes.push(
          deletedChannel(
            channel.key,
            live.id,
            live.type === discordTypes.category,
          ),
        );
      continue;
    }
    if (!live) throw new Error(`Missing channel: ${channel.key}`);
    if (
      live.name !== channel.name ||
      live.topic !== channel.topic ||
      live.parent !== (channel.parent ? ids.channels[channel.parent] : null) ||
      (channel.parent && recreated.has(channel.parent))
    ) {
      touched.add(channel.key);
      updates.push({ kind: "updateChannel", channel, lockPermissions: false });
    }
    if (!sameOverwrites(live.overwrites, finalOverwrites(channel))) {
      touched.add(channel.key);
      replacements.set(channel.key, replacement(channel));
    }
    const tags = channel.tags.map((tag) => ({
      ...tag,
      ...(ids.tags[channel.key]?.[tag.key]
        ? { id: ids.tags[channel.key][tag.key] }
        : {}),
    }));
    const tagValues = (entries: typeof tags | typeof live.tags) =>
      entries.map((tag) => [tag.id, tag.name, tag.moderated, tag.emoji]);
    if (!equal(tagValues(tags), tagValues(live.tags))) {
      touched.add(channel.key);
      updates.push({
        kind: "setForumTags",
        channelKey: channel.key,
        tags,
        destructive: live.tags.some(
          (tag) => !tags.some((desired) => desired.id === tag.id),
        ),
      });
    }
    for (const entry of live.overwrites)
      if (entry.type === "member") {
        touched.add(channel.key);
        deletes.push({
          kind: "removeOverwrite",
          channelKey: channel.key,
          id: entry.id,
          destructive: true,
        });
      }
  }
  for (const [key, id] of Object.entries(ids.channels)) {
    const live = liveChannel(key);
    if (live && !layout.channels.some((channel) => channel.key === key)) {
      touched.add(key);
      deletes.push(
        deletedChannel(key, id, live.type === discordTypes.category),
      );
    }
  }
  const categories = layout.channels.filter(
    (channel) => channel.type === "category",
  );
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
  const roleKeys = layout.roles
    .filter((role) => role.kind === "managed")
    .map((role) => role.key);
  if (reorder(roleKeys, (key) => liveRole(key)?.position))
    reorders.push({ kind: "reorderRoles", roleKeys });
  for (const parentKey of [
    undefined,
    ...categories.map((channel) => channel.key),
  ]) {
    const channelKeys = layout.channels
      .filter((channel) => channel.parent === parentKey)
      .map((channel) => channel.key);
    const parentId = parentKey ? ids.channels[parentKey] : null;
    if (
      reorder(channelKeys, (key) => {
        const live = liveChannel(key);
        return recreated.has(key) ||
          live?.parent !== parentId ||
          (parentKey && recreated.has(parentKey))
          ? undefined
          : live?.position;
      })
    )
      reorders.push({
        kind: "reorderChannels",
        channelKeys,
        ...(parentKey ? { parentKey } : {}),
      });
  }
  for (const operation of reorders)
    if (operation.kind === "reorderChannels")
      for (const key of operation.channelKeys) touched.add(key);
  const categoryStates = [
    ...snapshot.channels
      .filter((channel) => channel.type === discordTypes.category)
      .map((channel) => channel.overwrites),
    ...categories.map(finalOverwrites),
  ];
  const touchedParentIds = new Set(
    [...touched].map((key) => ids.channels[key]),
  );
  const targets = layout.roles
    .filter((role) => !role.permissions.Administrator)
    .map((role) => roleId(role.key));
  const existingTargets = snapshot.roles
    .filter((role) => !(BigInt(role.permissions) & flags.Administrator))
    .map((role) => role.id);
  const create = (channel: Channel) => {
    const compiled = compilePermissions(layout, channel);
    const normal = resolve(compiled);
    const privateCreate = privateChannel(snapshot, ids, channel);
    const sealed = privateCreate ? denyView(normal, targets) : normal;
    const overwrites =
      channel.type === "category" || !privateCreate
        ? sealed
        : unsync(channel.type, snapshot.guildId, sealed, categoryStates);
    const byId = new Map(
      compiled.map((entry) => [roleId(entry.roleKey), entry.roleKey]),
    );
    const payload = overwrites.map(({ id, ...entry }) => {
      const roleKey = byId.get(id);
      if (!roleKey) throw new Error(`Unbound create overwrite: ${id}`);
      return { ...entry, roleKey };
    });
    (channel.type === "category" ? categoryCreates : channelCreates).push({
      kind: channel.type === "category" ? "createCategory" : "createChannel",
      channel,
      overwrites: payload,
    });
    if (channel.type === "category") categoryStates.push(overwrites);
    if (!sameOverwrites(overwrites, finalOverwrites(channel)))
      replacements.set(channel.key, replacement(channel));
  };
  for (const category of categories)
    if (recreated.has(category.key)) create(category);
  const managedLive = Object.entries(ids.channels).flatMap(([key, id]) => {
    const live = snapshot.channels.find((entry) => entry.id === id);
    return live
      ? [
          {
            key,
            live,
            desired: layout.channels.find((channel) => channel.key === key),
          },
        ]
      : [];
  });
  managedLive.sort(
    (left, right) =>
      Number(right.live.type === discordTypes.category) -
      Number(left.live.type === discordTypes.category),
  );
  for (const { key, live, desired } of managedLive) {
    const affected =
      roleBitsChanged ||
      touched.has(key) ||
      touchedParentIds.has(live.parent ?? "") ||
      (desired?.parent && touched.has(desired.parent));
    if (!affected || !privateChannel(snapshot, ids, desired, live)) continue;
    const type =
      desired?.type ??
      (Object.entries(discordTypes).find(
        ([, value]) => value === live.type,
      )?.[0] as Channel["type"] | undefined);
    if (!type) {
      errors.push(`Unsupported private channel: ${key}`);
      continue;
    }
    const sealed = denyView(live.overwrites, existingTargets);
    const overwrites =
      live.type === discordTypes.category
        ? sealed
        : unsync(type, snapshot.guildId, sealed, categoryStates);
    protects.push({ kind: "protectOverwrites", channelKey: key, overwrites });
    if (live.type === discordTypes.category) categoryStates.push(overwrites);
    if (desired && !recreated.has(key))
      replacements.set(key, replacement(desired));
  }
  for (const channel of layout.channels)
    if (channel.type !== "category" && recreated.has(channel.key))
      create(channel);
  for (const [key, id] of Object.entries(ids.roles)) {
    const live = liveRole(key);
    if (
      live &&
      !layout.roles.some((role) => role.key === key) &&
      id !== snapshot.guildId &&
      live.applicationId !== snapshot.applicationId
    ) {
      if (live.managed || live.position >= operator.position)
        errors.push(`Uneditable role: ${key}`);
      else deletes.push({ kind: "deleteRole", key, id, destructive: true });
    }
  }
  const categoryReplacements: Operation[] = [],
    channelReplacements: Operation[] = [];
  for (const [channelKey, overwrites] of replacements)
    (categories.some((channel) => channel.key === channelKey)
      ? categoryReplacements
      : channelReplacements
    ).push({ kind: "replaceOverwrites", channelKey, overwrites });
  const operations = [
    ...protects,
    ...removals,
    ...roleCreates,
    ...categoryCreates,
    ...channelCreates,
    ...updates,
    ...categoryReplacements,
    ...channelReplacements,
    ...grants,
    ...reorders,
  ];
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
    staleBindings,
    adoptionCandidates: ids,
    errors,
    ok: errors.length === 0 && inventory.length === 0,
    destructive: operations.some(
      (entry) => "destructive" in entry && entry.destructive,
    ),
  };
}
