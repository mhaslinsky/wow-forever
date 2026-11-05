import { randomUUID } from "node:crypto";
import {
  authority,
  createSystemPrincipal,
  type Principal,
} from "../auth/index.mts";
import type { createDataAccess } from "../data/index.mts";
import { type GuildRecord, recordKey } from "../data/records.mts";
import { latestSnapshot, type SnapshotHistory } from "../data/snapshots.mts";
import { reportRecruitingFailure } from "../recruiting/alarm.mts";
import { characterIdentity } from "./identity.mts";

type Member = Extract<GuildRecord, { kind: "member" }>;
export function createDepartures(
  data: ReturnType<typeof createDataAccess>,
  guildId: string,
  post: (content: string, components: unknown[]) => Promise<string>,
  now = Date.now,
) {
  const store = data.forSystem(
    createSystemPrincipal(["departure", "departureCheck", "member"]),
  );
  type Departure = Extract<GuildRecord, { kind: "departure" }>;
  const conflict = (error: unknown) =>
    error instanceof Error && error.message === "WRITE_CONFLICT";
  async function flag(member: Member, evidence: string) {
    if (
      member.active === false ||
      member.sk !== `MEMBER#${guildId}` ||
      !member.roster?.length
    )
      return;
    const pending: Departure = {
      ...recordKey("departure", guildId, member.ownerId),
      kind: "departure",
      ownerId: guildId,
      memberId: member.ownerId,
      evidence,
      requestId: randomUUID(),
      state: "pending",
      claimedAt: now(),
    };
    try {
      await store.transitionDeparture(pending, {
        claim: true,
        expiredBefore: now() - 10 * 60 * 1000,
      });
    } catch (error) {
      if (conflict(error)) return;
      throw error;
    }
    let messageId: string;
    try {
      messageId = await post(`Confirm departure for <@${member.ownerId}>?`, [
        {
          type: 1,
          components: ["Confirm", "Keep"].map((label) => ({
            type: 2,
            style: label === "Confirm" ? 4 : 2,
            label,
            custom_id: `departure:${label.toLowerCase()}:${member.ownerId}:${pending.requestId}`,
          })),
        },
      ]);
      if (!messageId) throw new Error("DEPARTURE_MESSAGE_ID_MISSING");
    } catch (error) {
      try {
        await store.releaseDeparture(pending);
      } catch {
        reportRecruitingFailure({
          code: "DEPARTURE_CLAIM_RELEASE_FAILED",
          guildId,
        });
      }
      throw error;
    }
    try {
      await store.transitionDeparture(
        { ...pending, messageId },
        { requestId: pending.requestId, state: "pending" },
      );
    } catch (error) {
      if (!conflict(error)) throw error;
    }
  }
  async function checkSnapshot(
    guildKey: string,
    retry: boolean,
    accepted?: SnapshotHistory,
  ): Promise<void> {
    if (!guildKey.trim()) throw new Error("GUILD_KEY_REQUIRED");
    const key = recordKey("departureCheck", guildId, guildKey);
    const previous = (await store.get(key))[0];
    const snapshot = accepted ?? (await latestSnapshot(store, guildKey));
    if (!snapshot) return;
    const latest = snapshot;
    const processed =
      previous?.kind === "departureCheck" &&
      previous.snapshotId === latest.snapshotId;
    const identity = (name: string) =>
      characterIdentity(name, snapshot.snapshot.realm);
    const oldCounts: Record<
      string,
      { misses: number; evidence: string; rosterSignature: string }
    > = previous?.kind === "departureCheck" ? JSON.parse(previous.counts) : {};
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
      const rosterSignature = JSON.stringify(
        member.roster.map((character) => identity(character.name)).sort(),
      );
      const saved = oldCounts[member.ownerId];
      const old =
        saved?.rosterSignature === rosterSignature ? saved : undefined;
      const present = member.roster.some((character) =>
        names.has(identity(character.name)),
      );
      const misses = present
        ? 0
        : Math.min(2, (old?.misses ?? 0) + (processed ? 0 : 1));
      const evidence =
        misses === 0 || !old?.misses ? latest.snapshotId : old.evidence;
      counts[member.ownerId] = { misses, evidence, rosterSignature };
      if (misses === 2) requests.push({ member, evidence });
    }
    const check = {
      ...key,
      kind: "departureCheck" as const,
      ownerId: guildId,
      snapshotId: latest.snapshotId,
      counts: JSON.stringify(counts),
    };
    if (!processed)
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
    async checkSnapshot(guildKey: string, accepted?: SnapshotHistory) {
      await checkSnapshot(guildKey, true, accepted);
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
        if (action === "confirm")
          await store.confirmDeparture({ ...flag, state: "confirmed" });
        else
          await store.transitionDeparture(
            { ...flag, state: "kept" },
            { requestId, state: "pending" },
          );
      } catch (error) {
        if (conflict(error)) return false;
        throw error;
      }
      return true;
    },
  };
}
