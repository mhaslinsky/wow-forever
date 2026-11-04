import { randomUUID } from "node:crypto";
import { authority, type Principal } from "../auth/index.mts";
import type { createDataAccess } from "../data/index.mts";
import { recordKey } from "../data/records.mts";

export type WishlistRevision = {
  savedAt: number;
  items: string[];
};

export function parseWishlist(value: string): string[] {
  const items = value.split(";").map((item) => item.trim());
  if (
    items.length > 25 ||
    items.some((item) => !item || item.length > 100) ||
    new Set(items.map((item) => item.toLowerCase())).size !== items.length
  )
    throw new Error("INVALID_WISHLIST");
  return items;
}

export function createWishlist(
  data: ReturnType<typeof createDataAccess>,
  config: { guildId: string; lockMinutes: number; now?: () => number },
) {
  if (
    !config.guildId ||
    !Number.isSafeInteger(config.lockMinutes) ||
    config.lockMinutes < 0
  )
    throw new Error("INVALID_WISHLIST_CONFIG");
  const now = config.now ?? Date.now;
  const prefix = `${config.guildId}:`;
  const cutoff = (startTime: number) => {
    if (!Number.isFinite(startTime) || startTime <= 0)
      throw new Error("INVALID_RAID_START");
    return startTime * 1000 - config.lockMinutes * 60_000;
  };
  function member(actor: Principal<"user">) {
    const identity = authority(actor);
    if (!identity.roles.includes("Member") || !identity.userId)
      throw new Error("MEMBER_REQUIRED");
    return identity.userId;
  }
  return {
    async save(actor: Principal<"user">, value: string) {
      const ownerId = member(actor);
      const items = parseWishlist(value);
      const savedAt = now();
      const reader = data.forUser(actor);
      const raids = await reader.query(`SIGNUP#${config.guildId}`);
      const starts = raids
        .filter((record) => record.kind === "signup")
        .map((record) => Number(record.startTime))
        // Invalid poller dates must not prevent members from saving wishlists.
        .filter(
          (start) =>
            Number.isFinite(start * 1000) &&
            start > 0 &&
            start * 1000 > savedAt,
        )
        .sort((left, right) => left - right);
      const nextStart = starts[0];
      await reader.write({
        ...recordKey(
          "wishlist",
          ownerId,
          `${prefix}${savedAt}:${randomUUID()}`,
        ),
        kind: "wishlist",
        ownerId,
        item: JSON.stringify({ savedAt, items } satisfies WishlistRevision),
      });
      return {
        items,
        locked: nextStart !== undefined && savedAt >= cutoff(nextStart),
      };
    },
    async forRaid(
      actor: Principal<"user">,
      ownerId: string,
      startTime: number,
    ): Promise<string[]> {
      member(actor);
      const lockTime = cutoff(startTime);
      const records = await data.forUser(actor).query(`WISHLIST#${ownerId}`);
      const revisions = records
        .filter(
          (record) =>
            record.kind === "wishlist" &&
            record.sk.startsWith(`WISHLIST#${prefix}`),
        )
        .map((record) => {
          if (record.kind !== "wishlist") throw new Error("INVALID_WISHLIST");
          const revision = JSON.parse(record.item) as WishlistRevision;
          if (
            !revision ||
            !Number.isSafeInteger(revision.savedAt) ||
            !Array.isArray(revision.items) ||
            revision.items.some((item) => typeof item !== "string")
          )
            throw new Error("INVALID_WISHLIST");
          parseWishlist(revision.items.join(";"));
          return { ...revision, key: record.sk };
        })
        .filter((revision) => revision.savedAt < lockTime)
        .sort(
          (left, right) =>
            right.savedAt - left.savedAt || right.key.localeCompare(left.key),
        );
      return revisions[0]?.items ?? [];
    },
  };
}
