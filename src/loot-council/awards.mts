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
    const decisions = await store.query(`LOOT_DECISION#${guildId}`);
    const claimed = new Set(
      decisions.flatMap((decision) =>
        decision.kind === "lootDecision" && decision.award?.fingerprint
          ? [decision.award.fingerprint]
          : [],
      ),
    );
    const fingerprint = (entry: (typeof snapshot.loot)[number]) =>
      JSON.stringify([
        entry.itemId,
        characterIdentity(entry.playerKey, snapshot.realm),
        entry.timestamp,
        entry.raid,
      ]);
    const settled = new Set<string>();
    for (const status of ["confirmed", "mismatch"] as const) {
      for (const decision of decisions) {
        if (
          decision.kind !== "lootDecision" ||
          !decision.award ||
          decision.award.status !== "pending" ||
          settled.has(decision.sk)
        )
          continue;
        const award = decision.award;
        if (accepted.exportedAt <= award.baselineExportedAt) continue;
        const eligible = snapshot.loot
          .filter(
            (entry) =>
              entry.itemName.trim().toLowerCase() ===
                award.item.toLowerCase() &&
              entry.timestamp * 1000 >= award.closedAt &&
              entry.timestamp * 1000 < award.closedAt + 12 * 3_600_000 &&
              !claimed.has(fingerprint(entry)) &&
              !award.baselineLoot.includes(fingerprint(entry)),
          )
          .sort((left, right) => left.timestamp - right.timestamp);
        const isWinner = (entry: (typeof snapshot.loot)[number]) =>
          award.names.some(
            (name) =>
              characterIdentity(name, snapshot.realm) ===
              characterIdentity(entry.playerKey, snapshot.realm),
          );
        const loot = eligible.find(
          (entry) => isWinner(entry) === (status === "confirmed"),
        );
        if (!loot) continue;
        if (status === "mismatch") {
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
            status,
            snapshotId: accepted.snapshotId,
            fingerprint: fingerprint(loot),
          },
        });
        claimed.add(fingerprint(loot));
        settled.add(decision.sk);
      }
    }
  };
}
