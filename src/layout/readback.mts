import { PermissionFlagsBits as flags, PermissionsBitField } from "discord.js";
import { bindings, discordTypes, untracked } from "./inventory.mts";
import { normalizeBits, normalizeOverwrites } from "./permissions.mts";
import type {
  Access,
  IdMap,
  Layout,
  LiveChannel,
  Overwrite,
  Snapshot,
} from "./types.mts";

export type PermissionRow = {
  channelKey: string;
  roleKey: string;
  actual: Access;
  expected: Access;
};
export type ReadbackFinding = {
  channelId: string;
  roleKey: string;
  reason: "ignored channel visible through a guild grant";
};

export function effectivePermissions(
  base: bigint,
  overwrites: Overwrite[],
  everyoneId: string,
  roleId: string,
): PermissionsBitField {
  const permissions = new PermissionsBitField(base);
  if (permissions.has(flags.Administrator))
    return new PermissionsBitField(PermissionsBitField.All);
  for (const id of roleId === everyoneId
    ? [everyoneId]
    : [everyoneId, roleId]) {
    const entry = overwrites.find(
      (overwrite) => overwrite.type === "role" && overwrite.id === id,
    );
    if (entry) permissions.remove(BigInt(entry.deny)).add(BigInt(entry.allow));
  }
  return permissions.has(flags.ViewChannel, false)
    ? permissions
    : new PermissionsBitField();
}
function access(
  permissions: PermissionsBitField,
  type: keyof typeof discordTypes,
  requireAll = true,
): Access {
  // Denied access must reject even one granted bit in a permission bundle.
  const has = (mask: bigint) =>
    requireAll ? permissions.has(mask, false) : permissions.any(mask, false);
  return {
    view: has(flags.ViewChannel),
    send: has(
      flags.SendMessages |
        flags.SendMessagesInThreads |
        (type === "voice"
          ? 0n
          : flags.CreatePublicThreads | flags.CreatePrivateThreads),
    ),
    connect:
      (type === "voice" || type === "category") &&
      has(flags.Connect | flags.Speak),
    manageThreads: type !== "voice" && has(flags.ManageThreads),
  };
}

function snapshotErrors(snapshot: Snapshot): string[] {
  const errors: string[] = [];
  if (!snapshot.guildId || !snapshot.applicationId)
    errors.push("Missing snapshot identity");
  for (const kind of ["roles", "channels"] as const) {
    if (!Array.isArray(snapshot[kind])) {
      errors.push(`Missing snapshot ${kind}`);
      continue;
    }
    const identities = new Set<string>();
    for (const entry of snapshot[kind]) {
      if (!entry?.id || identities.has(entry.id))
        errors.push(`Missing or duplicate ${kind} identity`);
      else identities.add(entry.id);
    }
  }
  if (errors.length) return errors;
  for (const role of snapshot.roles) {
    try {
      normalizeBits(role.permissions);
      if (!Number.isFinite(role.position))
        errors.push(`Missing role position: ${role.id}`);
    } catch {
      errors.push(`Invalid role permissions: ${role.id}`);
    }
  }
  for (const channel of snapshot.channels) {
    try {
      normalizeOverwrites(channel.overwrites);
      for (const overwrite of channel.overwrites) {
        if (!overwrite.id || !["role", "member"].includes(overwrite.type))
          errors.push(`Invalid overwrite target: ${channel.id}`);
        if (
          overwrite.type === "role" &&
          !snapshot.roles.some((role) => role.id === overwrite.id)
        )
          errors.push(`Missing overwrite role: ${channel.id}/${overwrite.id}`);
      }
    } catch {
      errors.push(`Invalid channel overwrites: ${channel.id}`);
    }
  }
  return errors;
}

function ignoredGrantFindings(
  layout: Layout,
  snapshot: Snapshot,
  ids: IdMap,
): ReadbackFinding[] {
  const findings: ReadbackFinding[] = [];
  const everyone = snapshot.roles.find((role) => role.id === snapshot.guildId);
  if (!everyone) return findings;
  for (const channel of snapshot.channels) {
    if (
      layout.channels.some((entry) => ids.channels[entry.key] === channel.id) ||
      !layout.ignore.channels.includes(channel.name)
    )
      continue;
    for (const role of layout.roles) {
      const liveRole = snapshot.roles.find(
        (entry) => entry.id === ids.roles[role.key],
      );
      if (!liveRole) continue;
      const everyoneBits = BigInt(everyone.permissions);
      const roleBits = BigInt(liveRole.permissions);
      const base = everyoneBits | roleBits;
      // Live grants can drift from the layout and expose ignored channels.
      const withoutGrant = base & ~flags.ViewChannel;
      const visible = (bits: bigint) =>
        effectivePermissions(
          bits,
          channel.overwrites,
          snapshot.guildId,
          liveRole.id,
        ).has(flags.ViewChannel, false);
      if (visible(base) && !visible(withoutGrant))
        findings.push({
          channelId: channel.id,
          roleKey: role.key,
          reason: "ignored channel visible through a guild grant",
        });
    }
  }
  return findings;
}

export function readback(layout: Layout, snapshot: Snapshot, idMap: IdMap) {
  const rows: PermissionRow[] = [];
  const errors = snapshotErrors(snapshot);
  const inventory: ReturnType<typeof untracked> = [];
  let findings: ReadbackFinding[] = [];
  const result = () => ({
    rows,
    errors,
    untracked: inventory,
    findings,
    ok: errors.length === 0 && inventory.length === 0 && findings.length === 0,
  });
  if (errors.length) return result();
  let ids: IdMap;
  try {
    ids = bindings(layout, snapshot, idMap);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    return result();
  }
  const everyone = snapshot.roles.find((role) => role.id === snapshot.guildId);
  if (!everyone) errors.push("Missing everyone role");
  const operator = snapshot.roles.find(
    (role) => role.applicationId === snapshot.applicationId,
  );
  if (!operator) errors.push("Missing operator role");
  for (const kind of ["roles", "channels"] as const) {
    const values = Object.values(ids[kind]);
    if (new Set(values).size !== values.length)
      errors.push(`Duplicate ${kind} binding`);
    for (const [key, id] of Object.entries(ids[kind]))
      if (!snapshot[kind].some((entry) => entry.id === id))
        errors.push(`Missing bound ${kind}: ${key}`);
  }
  for (const role of snapshot.roles) {
    if (
      (BigInt(role.permissions) & flags.Administrator ||
        role.position >= (operator?.position ?? Infinity)) &&
      !layout.roles.some((entry) => ids.roles[entry.key] === role.id)
    )
      errors.push(`Missing expected role: ${role.id}`);
  }
  for (const role of layout.roles) {
    const liveRole = snapshot.roles.find(
      (entry) => entry.id === ids.roles[role.key],
    );
    if (!liveRole) errors.push(`Missing role: ${role.key}`);
    else if (
      role.kind === "operator" &&
      role.permissions.Administrator !== undefined &&
      Boolean(BigInt(liveRole.permissions) & flags.Administrator) !==
        role.permissions.Administrator
    )
      errors.push("Operator Administrator mismatch");
  }
  if (!everyone) return result();
  for (const channel of layout.channels) {
    const live: LiveChannel | undefined = snapshot.channels.find(
      (entry) => entry.id === ids.channels[channel.key],
    );
    if (!live || live.type !== discordTypes[channel.type]) {
      errors.push(`Missing channel or wrong type: ${channel.key}`);
      continue;
    }
    if (Object.values(channel.access).some((entry) => !entry.view)) {
      if (live.overwrites.some((entry) => entry.type === "member"))
        errors.push(`Member overwrite in private channel: ${channel.key}`);
      // Ignored integration overwrites can expose channels to members holding that role.
      for (const liveRole of snapshot.roles) {
        if (layout.roles.some((role) => ids.roles[role.key] === liveRole.id))
          continue;
        const permissions = effectivePermissions(
          BigInt(everyone.permissions) | BigInt(liveRole.permissions),
          live.overwrites,
          snapshot.guildId,
          liveRole.id,
        );
        if (permissions.has(flags.ViewChannel, false))
          errors.push(
            `undeclared role can view private channel: ${channel.key}/${liveRole.id}`,
          );
      }
    }
    for (const role of layout.roles) {
      const liveRole = snapshot.roles.find(
        (entry) => entry.id === ids.roles[role.key],
      );
      if (!liveRole) {
        continue;
      }
      const expected = channel.access[role.key];
      if (!expected) {
        errors.push(`Missing expected access: ${channel.key}/${role.key}`);
        continue;
      }
      const permissions = effectivePermissions(
        BigInt(everyone.permissions) | BigInt(liveRole.permissions),
        live.overwrites,
        snapshot.guildId,
        liveRole.id,
      );
      const actual = access(permissions, channel.type);
      const anyAccess = access(permissions, channel.type, false);
      rows.push({
        channelKey: channel.key,
        roleKey: role.key,
        actual,
        expected: { ...expected },
      });
      for (const key of Object.keys(actual) as (keyof Access)[])
        if (expected[key] ? !actual[key] : anyAccess[key])
          errors.push(
            `${channel.key}/${role.key}/${key}: expected ${expected[key] ? "all bits" : "no bits"}, got ${anyAccess[key] ? "some bits" : "no bits"}`,
          );
    }
  }
  inventory.push(...untracked(layout, snapshot, ids));
  findings = ignoredGrantFindings(layout, snapshot, ids);
  return result();
}
