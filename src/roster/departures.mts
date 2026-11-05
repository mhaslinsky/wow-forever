import { randomUUID } from "node:crypto";
import {
  authority,
  createSystemPrincipal,
  type Principal,
} from "../auth/index.mts";
import type { createDataAccess } from "../data/index.mts";
import { type GuildRecord, recordKey } from "../data/records.mts";
import type { SnapshotHistory } from "../data/snapshots.mts";

type Member = Extract<GuildRecord, { kind: "member" }>;
export function createDepartures(
  data: ReturnType<typeof createDataAccess>,
  guildId: string,
  post: (content: string, components: unknown[]) => Promise<void>,
) {
  const store = data.forSystem(createSystemPrincipal(["departure", "member"]));
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
    async compareSnapshots(history: readonly SnapshotHistory[]) {
      const ordered = [...history].sort(
        (left, right) => left.exportedAt - right.exportedAt,
      );
      const latest = ordered.at(-1);
      const previous = ordered.at(-2);
      if (
        !latest ||
        !previous ||
        latest.ownerId !== previous.ownerId ||
        latest.exportedAt === previous.exportedAt
      )
        return;
      const names = (snapshot: SnapshotHistory) =>
        new Set(
          snapshot.snapshot.members.map((member) => member.name.toLowerCase()),
        );
      const currentNames = names(latest);
      const previousNames = names(previous);
      for (const member of await store.lookup("MEMBER#ALL")) {
        if (member.kind !== "member" || member.sk !== `MEMBER#${guildId}`)
          continue;
        for (const character of member.roster ?? []) {
          const name = character.name.toLowerCase();
          if (currentNames.has(name) || previousNames.has(name)) continue;
          const seen = ordered.findLastIndex((snapshot) =>
            names(snapshot).has(name),
          );
          const firstMissing = ordered[seen + 1];
          await flag(
            member,
            `${latest.ownerId}:${name}:${firstMissing.snapshotId}`,
          );
          break;
        }
      }
    },
    async refreshSnapshots() {
      const pointers = await store.lookup("SNAPSHOT_LATEST#ALL");
      if (pointers.length === 0) return;
      if (pointers.length !== 1 || pointers[0].kind !== "guildSnapshotLatest")
        throw new Error("SNAPSHOT_GUILD_AMBIGUOUS");
      const latest = pointers[0];
      const history = (await store.query(`SNAPSHOT#${latest.ownerId}`)).filter(
        (item): item is SnapshotHistory =>
          item.kind === "guildSnapshot" && item.exportedAt <= latest.exportedAt,
      );
      const times = [...new Set(history.map((item) => item.exportedAt))]
        .sort((left, right) => right - left)
        .slice(0, 2);
      if (
        times.some(
          (time) =>
            history.filter((item) => item.exportedAt === time).length !== 1,
        )
      )
        throw new Error("SNAPSHOT_HISTORY_AMBIGUOUS");
      if (!history.some((item) => item.snapshotId === latest.snapshotId))
        throw new Error("LATEST_SNAPSHOT_MISSING");
      await this.compareSnapshots(history);
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
