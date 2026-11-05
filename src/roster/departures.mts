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
  type Departure = Extract<GuildRecord, { kind: "departure" }>;
  const conflict = (error: unknown) =>
    error instanceof Error && error.message === "WRITE_CONFLICT";
  async function deliver(flag: Departure) {
    try {
      await post(`Confirm departure for <@${flag.memberId}>?`, [
        {
          type: 1,
          components: ["Confirm", "Keep"].map((label) => ({
            type: 2,
            style: label === "Confirm" ? 4 : 2,
            label,
            custom_id: `departure:${label.toLowerCase()}:${flag.memberId}:${flag.requestId}`,
          })),
        },
      ]);
    } catch (error) {
      await store.transitionDeparture(
        { ...flag, delivery: "undelivered" },
        { requestId: flag.requestId, state: "pending", delivery: "sending" },
      );
      throw error;
    }
    try {
      await store.transitionDeparture(
        { ...flag, delivery: "delivered" },
        { requestId: flag.requestId, state: "pending", delivery: "sending" },
      );
    } catch (error) {
      if (!conflict(error)) throw error;
    }
  }
  async function retryUndelivered() {
    for (const flag of await store.query(`DEPARTURE#${guildId}`)) {
      if (
        flag.kind !== "departure" ||
        flag.state !== "pending" ||
        flag.delivery !== "undelivered"
      )
        continue;
      const claimed = { ...flag, delivery: "sending" };
      try {
        await store.transitionDeparture(claimed, {
          requestId: flag.requestId,
          state: "pending",
          delivery: "undelivered",
        });
      } catch (error) {
        if (conflict(error)) continue;
        throw error;
      }
      await deliver(claimed);
    }
  }
  async function flag(member: Member, evidence: string) {
    if (member.active === false || member.sk !== `MEMBER#${guildId}`) return;
    const pending: Departure = {
      ...recordKey("departure", guildId, member.ownerId),
      kind: "departure",
      ownerId: guildId,
      memberId: member.ownerId,
      evidence,
      requestId: randomUUID(),
      state: "pending",
      delivery: "sending",
    };
    try {
      await store.transitionDeparture(pending, { claim: true });
    } catch (error) {
      if (conflict(error)) return;
      throw error;
    }
    await deliver(pending);
  }
  async function checkSnapshot(
    guildKey: string,
    retry: boolean,
  ): Promise<void> {
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
    const identity = (name: string) => {
      const [character, ...realm] = name.trim().toLowerCase().split("-");
      return `${character}-${(realm.join("-") || snapshot.snapshot.realm).toLowerCase().replaceAll(" ", "")}`;
    };
    const oldCounts: Record<string, { misses: number; evidence: string }> =
      previous?.kind === "departureCheck" ? JSON.parse(previous.counts) : {};
    const counts: typeof oldCounts = {};
    const names = new Set(
      snapshot.snapshot.members.map((member) => identity(member.name)),
    );
    const requests: { member: Member; evidence: string }[] = [];
    for (const member of await store.lookup("MEMBER#ALL")) {
      if (
        member.kind !== "member" ||
        member.sk !== `MEMBER#${guildId}` ||
        member.active === false ||
        !member.roster?.length
      )
        continue;
      const old = oldCounts[member.ownerId];
      const present = member.roster.some((character) =>
        names.has(identity(character.name)),
      );
      const misses = present ? 0 : Math.min(2, (old?.misses ?? 0) + 1);
      const evidence =
        misses === 0 || !old?.misses ? latest.snapshotId : old.evidence;
      counts[member.ownerId] = { misses, evidence };
      if (misses === 2) requests.push({ member, evidence });
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
      if (!conflict(error)) throw error;
      if (retry) await checkSnapshot(guildKey, false);
      return;
    }
    let failure: unknown;
    for (const request of requests) {
      try {
        await flag(request.member, request.evidence);
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) throw failure;
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
      await retryUndelivered();
      await checkSnapshot(guildKey, true);
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
        return false;
      try {
        await store.transitionDeparture(
          { ...flag, state: action === "keep" ? "kept" : "confirmed" },
          { requestId, state: "pending" },
        );
      } catch (error) {
        if (conflict(error)) return false;
        throw error;
      }
      if (action === "confirm") {
        const member = (
          await store.get(recordKey("member", memberId, guildId))
        )[0];
        if (member?.kind !== "member") throw new Error("MEMBER_MISSING");
        await store.write({ ...member, active: false });
      }
      return true;
    },
  };
}
