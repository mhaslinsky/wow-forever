import {
  ChannelType as DiscordType,
  PermissionFlagsBits as flags,
} from "discord.js";
import {
  compilePermissions,
  normalizeOverwrites,
  protectiveOverwrite,
} from "./permissions.mts";
import type {
  Channel,
  IdMap,
  Layout,
  LiveChannel,
  Overwrite,
  Snapshot,
} from "./types.mts";

function privateChannel(
  snapshot: Snapshot,
  ids: IdMap,
  desired?: Channel,
  live?: LiveChannel,
): boolean {
  if (desired && Object.values(desired.access).some((entry) => !entry.view))
    return true;
  if (!live) return false;
  const everyone = snapshot.roles.find((role) => role.id === snapshot.guildId);
  return [snapshot.guildId, ...Object.values(ids.roles)].some((id) => {
    const role = snapshot.roles.find((role) => role.id === id);
    if (!role) return false;
    let bits = BigInt(everyone?.permissions ?? "0") | BigInt(role.permissions);
    if (bits & flags.Administrator) return false;
    for (const target of new Set([snapshot.guildId, id])) {
      const entry = live.overwrites.find(
        (entry) => entry.type === "role" && entry.id === target,
      );
      if (entry) bits = (bits & ~BigInt(entry.deny)) | BigInt(entry.allow);
    }
    return !(bits & flags.ViewChannel);
  });
}
function denyView(overwrites: Overwrite[], targets: string[]): Overwrite[] {
  const entries = normalizeOverwrites(overwrites);
  for (const id of targets) {
    let entry = entries.find(
      (entry) => entry.type === "role" && entry.id === id,
    );
    if (!entry) {
      entry = { type: "role", id, allow: "0", deny: "0" };
      entries.push(entry);
    }
    entry.allow = (BigInt(entry.allow) & ~flags.ViewChannel).toString();
    entry.deny = (BigInt(entry.deny) | flags.ViewChannel).toString();
  }
  return normalizeOverwrites(entries);
}
const canonical = (entries: Overwrite[], everyoneId: string) =>
  JSON.stringify(
    normalizeOverwrites(entries).filter(
      (entry) =>
        !(
          entry.type === "role" &&
          entry.id === everyoneId &&
          entry.allow === "0" &&
          entry.deny === "0"
        ),
    ),
  );
function unsync(
  type: Channel["type"],
  everyoneId: string,
  overwrites: Overwrite[],
  categoryStates: Overwrite[][],
  operatorRoleIds: ReadonlySet<string>,
): Overwrite[] {
  let result = overwrites;
  for (let remaining = categoryStates.length; remaining >= 0; remaining--) {
    const category = categoryStates.find(
      (entries) =>
        canonical(entries, everyoneId) === canonical(result, everyoneId),
    );
    if (!category) return result;
    const actor = result.filter((entry) => operatorRoleIds.has(entry.id));
    result = normalizeOverwrites([
      ...protectiveOverwrite(
        {
          type,
          everyoneId,
          overwrites: result.filter((entry) => !operatorRoleIds.has(entry.id)),
        },
        {
          overwrites: category.filter(
            (entry) => !operatorRoleIds.has(entry.id),
          ),
        },
      ),
      ...actor,
    ]);
  }
  throw new Error("Cannot unsync protective overwrites");
}

export type ProtectionTarget = {
  key?: string;
  live?: LiveChannel;
  desired?: Channel;
  create: boolean;
  writable: boolean;
  roleIds: string[];
  overwrites: Overwrite[];
};

/** Selects affected channels and every child of a category this plan writes, including ignored children.
 * All live roles remain deny candidates across Administrator removal; operator/application roles retain ViewChannel.
 * New channels need declared role denies only: @everyone blocks other base grants without existing overwrites.
 * Unmanaged children matching any category state block the plan without receiving a write.
 */
export function protectionTargets(
  layout: Layout,
  snapshot: Snapshot,
  ids: IdMap,
  changes: {
    touched: ReadonlySet<string>;
    roleBitsChanged: boolean;
    recreated: ReadonlySet<string>;
    finalOverwrites: ReadonlyMap<string, Overwrite[]>;
  },
) {
  const errors: string[] = [];
  const roleId = (key: string) => ids.roles[key] ?? `new:${key}`;
  const operatorRoleIds = new Set([
    ...layout.roles
      .filter((role) => role.kind === "operator")
      .map((role) => roleId(role.key)),
    ...snapshot.roles
      .filter((role) => role.applicationId === snapshot.applicationId)
      .map((role) => role.id),
  ]);
  const roleIds = [...new Set(snapshot.roles.map((role) => role.id))].filter(
    (id) => !operatorRoleIds.has(id),
  );
  const createRoleIds = layout.roles
    .map((role) => roleId(role.key))
    .filter((id) => !operatorRoleIds.has(id));
  const liveByKey = (key: string) =>
    snapshot.channels.find((channel) => channel.id === ids.channels[key]);
  const desiredByKey = (key: string) =>
    layout.channels.find((channel) => channel.key === key);
  const categoryKeys = new Set(
    [...changes.touched].filter(
      (key) =>
        desiredByKey(key)?.type === "category" ||
        liveByKey(key)?.type === DiscordType.GuildCategory,
    ),
  );
  const targets: ProtectionTarget[] = [];
  for (const [key, id] of Object.entries(ids.channels)) {
    const live = snapshot.channels.find((channel) => channel.id === id);
    if (!live) continue;
    const desired = desiredByKey(key);
    const writable =
      Boolean(desired) || !layout.ignore.channels.includes(live.name);
    if (
      !writable ||
      !(
        changes.roleBitsChanged ||
        changes.touched.has(key) ||
        (desired?.parent && changes.touched.has(desired.parent))
      ) ||
      !privateChannel(snapshot, ids, desired, live)
    )
      continue;
    targets.push({
      key,
      live,
      desired,
      create: false,
      writable,
      roleIds,
      overwrites: [],
    });
    if (live.type === DiscordType.GuildCategory) categoryKeys.add(key);
  }
  const parentKeys = new Map(
    [...categoryKeys].flatMap((key) =>
      ids.channels[key] ? [[ids.channels[key], key] as const] : [],
    ),
  );
  for (const live of snapshot.channels) {
    if (
      !live.parent ||
      !parentKeys.has(live.parent) ||
      targets.some((target) => target.live?.id === live.id)
    )
      continue;
    const key = Object.keys(ids.channels).find(
      (key) => ids.channels[key] === live.id,
    );
    const desired = key ? desiredByKey(key) : undefined;
    const writable =
      key !== undefined &&
      (Boolean(desired) || !layout.ignore.channels.includes(live.name));
    targets.push({
      key,
      live,
      desired,
      create: false,
      writable,
      roleIds,
      overwrites: [],
    });
  }
  for (const desired of layout.channels)
    if (
      changes.recreated.has(desired.key) &&
      privateChannel(snapshot, ids, desired)
    ) {
      targets.push({
        key: desired.key,
        desired,
        create: true,
        writable: true,
        roleIds: createRoleIds,
        overwrites: [],
      });
    }
  const categoryStates = new Map<string, Overwrite[][]>();
  for (const key of categoryKeys) {
    const live = liveByKey(key),
      desired = desiredByKey(key);
    const states: Overwrite[][] = [];
    if (live?.type === DiscordType.GuildCategory) states.push(live.overwrites);
    const final = changes.finalOverwrites.get(key);
    if (desired?.type === "category" && final) states.push(final);
    categoryStates.set(key, states);
  }
  const protect = (entries: Overwrite[], denied: string[]) => {
    const result = denyView(entries, denied);
    for (const id of operatorRoleIds) {
      let actor = result.find(
        (entry) => entry.type === "role" && entry.id === id,
      );
      if (!actor) {
        actor = { type: "role", id, allow: "0", deny: "0" };
        result.push(actor);
      }
      actor.allow = (BigInt(actor.allow) | flags.ViewChannel).toString();
      actor.deny = (BigInt(actor.deny) & ~flags.ViewChannel).toString();
    }
    return normalizeOverwrites(result);
  };
  const initial = (target: ProtectionTarget): Overwrite[] => {
    if (!target.create) return target.live?.overwrites ?? [];
    if (!target.desired) throw new Error("Missing private create layout");
    return compilePermissions(layout, target.desired).map(
      ({ roleKey, ...entry }) => ({ ...entry, id: roleId(roleKey) }),
    );
  };
  for (const target of targets)
    if (
      target.live?.type === DiscordType.GuildCategory ||
      (target.create && target.desired?.type === "category")
    ) {
      target.overwrites = protect(initial(target), target.roleIds);
      if (target.key) categoryStates.get(target.key)?.push(target.overwrites);
    }
  const allCategoryStates = [...categoryStates.values()].flat();
  for (const target of targets) {
    const isCategory = target.create
      ? target.desired?.type === "category"
      : target.live?.type === DiscordType.GuildCategory;
    if (!isCategory && target.writable) {
      const type = target.desired?.type ?? "text";
      target.overwrites = unsync(
        type,
        snapshot.guildId,
        protect(initial(target), target.roleIds),
        allCategoryStates,
        operatorRoleIds,
      );
    }
    if (!target.writable && target.live) {
      target.overwrites = structuredClone(target.live.overwrites);
      const key = target.live.parent
        ? parentKeys.get(target.live.parent)
        : undefined;
      if (
        key &&
        (categoryStates.get(key) ?? []).some(
          (state) =>
            canonical(state, snapshot.guildId) ===
            canonical(target.live?.overwrites ?? [], snapshot.guildId),
        )
      ) {
        const policy = layout.ignore.channels.includes(target.live.name)
          ? "ignored"
          : "unbound";
        errors.push(
          `${policy} channel ${target.live.name} is synced to managed category ${liveByKey(key)?.name ?? desiredByKey(key)?.name ?? key}, which this plan changes; unsync it or manage it`,
        );
      }
    }
  }
  return { channels: targets, errors };
}
