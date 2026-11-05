import { randomUUID } from "node:crypto";
import {
  authority,
  createSystemPrincipal,
  type Principal,
} from "../auth/index.mts";
import type { createDataAccess } from "../data/index.mts";
import { type GuildRecord, recordKey } from "../data/records.mts";

type Member = Extract<GuildRecord, { kind: "member" }>;
export function createDepartures(
  data: ReturnType<typeof createDataAccess>,
  guildId: string,
  post: (content: string, components: unknown[]) => Promise<void>,
) {
  const store = data.forSystem(
    createSystemPrincipal(["departure", "departureCheck", "member"]),
  );
  async function flag(member: Member, evidence: string) {
    if (member.active === false || member.sk !== `MEMBER#${guildId}`) return;
    const key = recordKey("departure", guildId, member.ownerId);
    const previous = (await store.get(key))[0];
    if (
      previous?.kind === "departure" &&
      (previous.state === "pending" || previous.evidence === evidence)
    )
      return;
    const requestId = randomUUID();
    await post(`Confirm departure for <@${member.ownerId}>?`, [
      {
        type: 1,
        components: ["Confirm", "Keep"].map((label) => ({
          type: 2,
          style: label === "Confirm" ? 4 : 2,
          label,
          custom_id: `departure:${label.toLowerCase()}:${member.ownerId}:${requestId}`,
        })),
      },
    ]);
    await store.write({
      ...key,
      kind: "departure",
      ownerId: guildId,
      memberId: member.ownerId,
      evidence,
      requestId,
      state: "pending",
    });
  }
  return {
    async memberRemoved(event: { id: string; guild: { id: string } }) {
      if (event.guild.id !== guildId) return;
      const member = (
        await store.get(recordKey("member", event.id, guildId))
      )[0];
      if (member?.kind === "member") await flag(member, randomUUID());
    },
    async checkSnapshot(guildKey: string) {
      if (!guildKey.trim()) throw new Error("GUILD_KEY_REQUIRED");
      const key = recordKey("departureCheck", guildId, guildKey);
      const previous = (await store.get(key))[0];
      const latest = (
        await store.get(recordKey("guildSnapshotLatest", guildKey, "latest"))
      )[0];
      if (!latest) return;
      if (latest.kind !== "guildSnapshotLatest")
        throw new Error("INVALID_SNAPSHOT_POINTER");
      if (
        previous?.kind === "departureCheck" &&
        previous.snapshotId === latest.snapshotId
      )
        return;
      const snapshot = (
        await store.get(
          recordKey(
            "guildSnapshot",
            guildKey,
            `${String(latest.exportedAt).padStart(16, "0")}#${latest.snapshotId}`,
          ),
        )
      )[0];
      if (snapshot?.kind !== "guildSnapshot")
        throw new Error("LATEST_SNAPSHOT_MISSING");
      const oldCounts: Record<string, { misses: number; evidence: string }> =
        previous?.kind === "departureCheck" ? JSON.parse(previous.counts) : {};
      const counts: typeof oldCounts = {};
      const names = new Set(
        snapshot.snapshot.members.map((member) => member.name.toLowerCase()),
      );
      const requests: { member: Member; evidence: string }[] = [];
      for (const member of await store.lookup("MEMBER#ALL")) {
        if (
          member.kind !== "member" ||
          member.sk !== `MEMBER#${guildId}` ||
          member.active === false
        )
          continue;
        for (const character of member.roster ?? []) {
          const name = character.name.toLowerCase();
          const characterKey = JSON.stringify([member.ownerId, name]);
          const old = oldCounts[characterKey];
          const misses = names.has(name)
            ? 0
            : Math.min(2, (old?.misses ?? 0) + 1);
          const evidence =
            misses === 0 || !old?.misses ? latest.snapshotId : old.evidence;
          counts[characterKey] = { misses, evidence };
          if (misses === 2)
            requests.push({ member, evidence: `${characterKey}:${evidence}` });
        }
      }
      const check = {
        ...key,
        kind: "departureCheck" as const,
        ownerId: guildId,
        snapshotId: latest.snapshotId,
        counts: JSON.stringify(counts),
      };
      try {
        await store.advanceDepartureCheck(
          check,
          previous?.kind === "departureCheck" ? previous.snapshotId : null,
        );
      } catch (error) {
        if (error instanceof Error && error.message === "WRITE_CONFLICT")
          return;
        throw error;
      }
      try {
        for (const request of requests)
          await flag(request.member, request.evidence);
      } catch (error) {
        await store.advanceDepartureCheck(
          previous?.kind === "departureCheck"
            ? previous
            : { ...check, snapshotId: "unprocessed", counts: "{}" },
          latest.snapshotId,
        );
        throw error;
      }
    },
    async resolve(
      actor: Principal<"user">,
      memberId: string,
      action: string,
      requestId: string,
    ) {
      if (!authority(actor).roles.includes("Officer"))
        throw new Error("WRITE_DENIED");
      if (!["confirm", "keep"].includes(action))
        throw new Error("INVALID_DEPARTURE_ACTION");
      const flag = (
        await store.get(recordKey("departure", guildId, memberId))
      )[0];
      if (
        flag?.kind !== "departure" ||
        flag.state !== "pending" ||
        flag.requestId !== requestId
      )
        throw new Error("DEPARTURE_REQUEST_EXPIRED");
      if (action === "confirm") {
        const member = (
          await store.get(recordKey("member", memberId, guildId))
        )[0];
        if (member?.kind !== "member") throw new Error("MEMBER_MISSING");
        await store.write({ ...member, active: false });
      }
      await store.write({
        ...flag,
        state: action === "keep" ? "kept" : "confirmed",
      });
    },
  };
}
