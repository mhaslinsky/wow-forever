import { PermissionFlagsBits as flags } from "discord.js";
import { normalizeOverwrites, protectiveOverwrite } from "./permissions.mts";
import type {
  Channel,
  IdMap,
  LiveChannel,
  Overwrite,
  Snapshot,
} from "./types.mts";

export function privateChannel(
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
export function denyView(
  overwrites: Overwrite[],
  targets: string[],
): Overwrite[] {
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
export function unsync(
  type: Channel["type"],
  everyoneId: string,
  overwrites: Overwrite[],
  categoryStates: Overwrite[][],
): Overwrite[] {
  let result = overwrites;
  for (let remaining = categoryStates.length; remaining >= 0; remaining--) {
    const category = categoryStates.find(
      (entries) =>
        canonical(entries, everyoneId) === canonical(result, everyoneId),
    );
    if (!category) return result;
    result = protectiveOverwrite(
      { type, everyoneId, overwrites: result },
      { overwrites: category },
    );
  }
  throw new Error("Cannot unsync protective overwrites");
}
