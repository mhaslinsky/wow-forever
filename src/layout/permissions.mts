import { PermissionFlagsBits, PermissionsBitField } from "discord.js";
import type {
  Access,
  Channel,
  CompiledOverwrite,
  Layout,
  Overwrite,
  Role,
} from "./types.mts";

export const permissionBits = PermissionFlagsBits;
const allBits = PermissionsBitField.All;
export function permissionMask(names: string[]): bigint {
  return names.reduce((mask, name) => {
    const bit = PermissionFlagsBits[name as keyof typeof PermissionFlagsBits];
    if (bit === undefined) throw new Error(`Unknown permission ${name}`);
    return mask | bit;
  }, 0n);
}

/** Only declared guild permission names are owned, including explicit false values. */
export function rolePermissions(role: Role): {
  allow: bigint;
  managed: bigint;
} {
  return {
    allow: permissionMask(
      Object.keys(role.permissions).filter((name) => role.permissions[name]),
    ),
    managed: permissionMask(Object.keys(role.permissions)),
  };
}

/** Each access cell owns these bits; all other overwrite bits are drift. */
export function accessBits(
  type: Channel["type"],
): Record<keyof Access, bigint> {
  return {
    view: PermissionFlagsBits.ViewChannel,
    send:
      type === "voice"
        ? 0n
        : PermissionFlagsBits.SendMessages |
          (type === "forum" || type === "category"
            ? PermissionFlagsBits.SendMessagesInThreads
            : 0n),
    connect:
      type === "voice" || type === "category"
        ? PermissionFlagsBits.Connect | PermissionFlagsBits.Speak
        : 0n,
    manageThreads: type === "voice" ? 0n : PermissionFlagsBits.ManageThreads,
  };
}

/** Explicit access bits cannot inherit grants from undeclared guild permissions. */
export function compilePermissions(
  layout: Layout,
  channel: Channel,
): CompiledOverwrite[] {
  if (!layout.roles.some((role) => role.kind === "everyone"))
    throw new Error("Missing everyone role");
  const bits = accessBits(channel.type);
  return layout.roles
    .filter((role) => !role.permissions.Administrator)
    .map((role) => {
      let allow = 0n;
      let deny = 0n;
      for (const [name, mask] of Object.entries(bits)) {
        if (channel.access[role.key][name as keyof Access]) allow |= mask;
        else deny |= mask;
      }
      return {
        roleKey: role.key,
        type: "role",
        allow: allow.toString(),
        deny: deny.toString(),
      };
    });
}

/** Decimal strings and stable ordering make equivalent REST overwrite lists compare equal. */
export function normalizeOverwrites(overwrites: Overwrite[]): Overwrite[] {
  const identities = new Set<string>();
  return overwrites
    .map((entry) => {
      const identity = `${entry.type}:${entry.id}`;
      if (identities.has(identity))
        throw new Error(`Duplicate overwrite ${identity}`);
      identities.add(identity);
      return {
        ...entry,
        allow: normalizeBits(entry.allow),
        deny: normalizeBits(entry.deny),
      };
    })
    .sort((left, right) =>
      `${left.type}:${left.id}`.localeCompare(`${right.type}:${right.id}`),
    );
}

export function normalizeBits(value: string | number | bigint): string {
  if (typeof value === "number" && !Number.isSafeInteger(value))
    throw new Error("Unsafe permission integer");
  if (typeof value === "string" && !/^\d+$/.test(value))
    throw new Error("Invalid permission bitfield");
  const bits = BigInt(value);
  if (bits < 0n || (bits & ~allBits) !== 0n)
    throw new Error("Invalid permission bits");
  return bits.toString();
}

/** Adds a deny to unsync matching children without widening access.
 * Throws if every valid bit on every target is already denied with no allows.
 */
export function protectiveOverwrite(
  child: { everyoneId: string; overwrites: Overwrite[] },
  category: { overwrites: Overwrite[] },
): Overwrite[] {
  const result = normalizeOverwrites(child.overwrites);
  if (
    JSON.stringify(result) !==
    JSON.stringify(normalizeOverwrites(category.overwrites))
  )
    return result;
  let target = result.find(
    (entry) => entry.type === "role" && entry.id === child.everyoneId,
  );
  if (!target) {
    target = { id: child.everyoneId, type: "role", allow: "0", deny: "0" };
    result.push(target);
  }
  for (const candidate of [
    target,
    ...result.filter((entry) => entry !== target),
  ]) {
    const bit = Object.values(PermissionFlagsBits).find(
      (bit) => (BigInt(candidate.deny) & bit) === 0n,
    );
    if (bit === undefined) {
      if (BigInt(candidate.allow) === 0n) continue;
      candidate.allow = "0";
      return normalizeOverwrites(result);
    }
    candidate.allow = (BigInt(candidate.allow) & ~bit).toString();
    candidate.deny = (BigInt(candidate.deny) | bit).toString();
    return normalizeOverwrites(result);
  }
  throw new Error("No stricter protective overwrite is possible");
}
