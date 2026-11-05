import { createSystemPrincipal } from "../auth/index.mts";
import type { createDataAccess } from "../data/index.mts";
import type { SnapshotHistory } from "../data/snapshots.mts";
import { characterIdentity } from "../roster/identity.mts";

export function createAwardCheck(
  data: ReturnType<typeof createDataAccess>,
  guildId: string,
  post: (content: string, components: unknown[]) => Promise<string>,
) {
  const store = data.forSystem(createSystemPrincipal(["lootDecision"]));
  return async (accepted: SnapshotHistory) => {
    const snapshot = accepted.snapshot;
    for (const decision of await store.query(`LOOT_DECISION#${guildId}`)) {
      if (
        decision.kind !== "lootDecision" ||
        !decision.award ||
        decision.award.status !== "pending"
      )
        continue;
      const award = decision.award;
      if (accepted.exportedAt <= award.baselineExportedAt) continue;
      const loot = snapshot.loot
        .filter(
          (entry) =>
            entry.itemName.trim().toLowerCase() === award.item.toLowerCase() &&
            entry.timestamp >= award.raidStart &&
            !award.baselineLoot.includes(
              JSON.stringify([
                entry.itemId,
                characterIdentity(entry.playerKey, snapshot.realm),
                entry.timestamp,
                entry.raid,
              ]),
            ),
        )
        .sort((left, right) => left.timestamp - right.timestamp)[0];
      if (!loot) continue;
      const matches = award.names.some(
        (name) =>
          characterIdentity(name, snapshot.realm) ===
          characterIdentity(loot.playerKey, snapshot.realm),
      );
      if (!matches) {
        const messageId = await post(
          `Loot mismatch: ${award.item.slice(0, 100)} went to ${loot.playerKey.slice(0, 100)}; expected <@${decision.winner}>`,
          [],
        );
        if (!messageId) throw new Error("AWARD_ALERT_MESSAGE_ID_MISSING");
      }
      await store.write({
        ...decision,
        award: {
          ...award,
          status: matches ? "confirmed" : "mismatch",
          snapshotId: accepted.snapshotId,
        },
      });
    }
  };
}
