import { randomUUID } from "node:crypto";
import { authority, type Principal } from "../auth/index.mts";
import type { createDataAccess } from "../data/index.mts";
import { recordKey } from "../data/records.mts";
import { latestSnapshot } from "../data/snapshots.mts";
import type { Snapshot } from "../guildos/index.mts";
import { characterIdentity } from "../roster/identity.mts";
import { createWishlist } from "../wishlist/core.mts";

export function createLootCouncil(
  data: ReturnType<typeof createDataAccess>,
  config: {
    guildId: string;
    guildKey?: string;
    lockMinutes: number;
    now?: () => number;
  },
) {
  const now = config.now ?? Date.now;
  const wishlist = createWishlist(data, config);
  function officer(actor: Principal<"user">) {
    const identity = authority(actor);
    if (!identity.roles.includes("Officer"))
      throw new Error("OFFICER_REQUIRED");
    return identity.userId;
  }
  return {
    async start(
      actor: Principal<"user">,
      voteId: string,
      item: string,
      raid?: string,
    ) {
      officer(actor);
      if (!item.trim() || item.length > 100) throw new Error("INVALID_ITEM");
      const store = data.forUser(actor);
      const signups = (await store.query(`SIGNUP#${config.guildId}`)).filter(
        (entry) => entry.kind === "signup",
      );
      const startTime =
        raid === undefined
          ? signups
              .map((entry) => Number(entry.startTime))
              .filter(
                (start) =>
                  start * 1000 <= now() + 3_600_000 &&
                  start * 1000 >= now() - 43_200_000,
              )
              .sort((left, right) => right - left)[0]
          : Number(raid);
      if (
        !startTime ||
        !Number.isFinite(startTime) ||
        !signups.some((entry) => Number(entry.startTime) === startTime)
      )
        throw new Error("RAID_NOT_FOUND");
      const owners = new Set(
        (await store.lookup("WISHLIST#ALL"))
          .filter(
            (entry) =>
              entry.kind === "wishlist" &&
              entry.sk.startsWith(`WISHLIST#${config.guildId}:`),
          )
          .map((entry) => entry.ownerId),
      );
      const attendance = (
        await store.query(`ATTENDANCE#${config.guildId}`)
      ).filter((entry) => entry.kind === "attendance");
      let snapshot: Snapshot | undefined;
      if (config.guildKey) {
        const [latest] = await store.get(
          recordKey("guildSnapshotLatest", config.guildKey, "latest"),
        );
        if (latest) {
          if (latest.kind !== "guildSnapshotLatest")
            throw new Error("INVALID_SNAPSHOT_POINTER");
          const [history] = await store.get(
            recordKey(
              "guildSnapshot",
              config.guildKey,
              `${String(latest.exportedAt).padStart(16, "0")}#${latest.snapshotId}`,
            ),
          );
          if (history?.kind !== "guildSnapshot")
            throw new Error("LATEST_SNAPSHOT_MISSING");
          snapshot = history.snapshot;
        }
      }
      const contenders: {
        id: string;
        name: string;
        rank: number;
        evidence: string;
      }[] = [];
      for (const ownerId of owners) {
        const [record] = await store.get(
          recordKey("member", ownerId, config.guildId),
        );
        const member = record?.kind === "member" ? record : undefined;
        const items = await wishlist.forRaid(actor, ownerId, startTime);
        const rank = items.findIndex(
          (entry) => entry.toLowerCase() === item.trim().toLowerCase(),
        );
        if (rank < 0) continue;
        const attended = attendance.filter((entry) =>
          (JSON.parse(entry.attendees) as { memberId: string }[]).some(
            (entry) => entry.memberId === ownerId,
          ),
        ).length;
        const main = member?.roster?.find((entry) => entry.main);
        const names = new Set(
          (member?.roster?.length
            ? member.roster.map((entry) => entry.name)
            : member
              ? [member.name]
              : []
          ).map((name) => characterIdentity(name, snapshot?.realm ?? "")),
        );
        const loot = snapshot?.loot
          .filter(
            (entry) =>
              names.has(characterIdentity(entry.playerKey, snapshot.realm)) &&
              entry.timestamp * 1000 >= now() - 30 * 86_400_000,
          )
          .sort((left, right) => right.timestamp - left.timestamp)
          .slice(0, 3);
        contenders.push({
          id: ownerId,
          name: (member?.name ?? ownerId).slice(0, 48),
          rank: rank + 1,
          evidence: `Wishlist: ${rank + 1}\nAttendance: ${attendance.length ? `${Math.round((attended / attendance.length) * 100)}% (${[...new Set(attendance.map((entry) => entry.source))].join(", ")})` : "no data"}\nRecent loot: ${loot?.length ? loot.map((entry) => entry.itemName.slice(0, 24)).join(", ") : "no data"}\nRole: ${main?.raidRole ?? "no data"}`,
        });
      }
      if (!contenders.length) throw new Error("NO_CONTENDERS");
      contenders.sort(
        (left, right) =>
          left.rank - right.rank || left.id.localeCompare(right.id),
      );
      const listed = contenders.slice(0, 25);
      await store.write({
        ...recordKey("lootVote", config.guildId, voteId),
        kind: "lootVote",
        ownerId: config.guildId,
        item: item.trim(),
        contenders: JSON.stringify(listed),
        raidStart: String(startTime),
      });
      return {
        content:
          contenders.length > 25
            ? `Vote ${voteId}: ${contenders.length - 25} contenders left out`
            : `Vote ${voteId}`,
        embeds: [
          {
            title: `Vote: ${item.trim()}`,
            fields: listed.map((entry) => ({
              name: entry.name,
              value: `<@${entry.id}>\n${entry.evidence}`,
            })),
          },
        ],
        components: [
          {
            type: 1,
            components: [
              {
                type: 3,
                custom_id: `lc-vote:${voteId}`,
                placeholder: "Choose a contender",
                min_values: 1,
                max_values: 1,
                options: listed.map((entry) => ({
                  label: entry.name,
                  value: entry.id,
                })),
              },
            ],
          },
        ],
      };
    },
    async vote(
      actor: Principal<"user">,
      voteId: string,
      contenderId: string,
      interactionId: string,
    ) {
      if (!/^[0-9]{1,20}$/.test(interactionId))
        throw new Error("INVALID_INTERACTION_ID");
      const selectionId = interactionId.padStart(20, "0");
      const officerId = officer(actor);
      const store = data.forUser(actor);
      const [vote] = await store.get(
        recordKey("lootVote", config.guildId, voteId),
      );
      if (vote?.kind === "lootVote" && vote.closed)
        throw new Error("VOTE_CLOSED");
      if (
        vote?.kind !== "lootVote" ||
        !(JSON.parse(vote.contenders) as { id: string }[]).some(
          (entry) => entry.id === contenderId,
        )
      )
        throw new Error("VOTE_NOT_FOUND");
      try {
        await store.write(
          {
            ...recordKey(
              "lootBallot",
              `${config.guildId}:${voteId}`,
              officerId,
            ),
            kind: "lootBallot",
            ownerId: `${config.guildId}:${voteId}`,
            contenderId,
            selectionId,
          },
          {
            ballotSelectionId: selectionId,
            council: {
              guildId: config.guildId,
              voteId,
              revision: vote.revision,
              nextRevision: randomUUID(),
            },
          },
        );
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "WRITE_CONFLICT")
          throw error;
        const [current] = await store.get(
          recordKey("lootBallot", `${config.guildId}:${voteId}`, officerId),
        );
        if (
          current?.kind === "lootBallot" &&
          current.selectionId >= selectionId
        )
          return;
        throw new Error("VOTE_CHANGED");
      }
    },
    async close(
      actor: Principal<"user">,
      voteId: string,
      winner: string,
      reason: string,
    ) {
      const decidingOfficer = officer(actor);
      if (!reason.trim() || reason.length > 1000)
        throw new Error("REASON_REQUIRED");
      const store = data.forUser(actor);
      const [vote] = await store.get(
        recordKey("lootVote", config.guildId, voteId),
      );
      if (vote?.kind !== "lootVote") throw new Error("VOTE_NOT_FOUND");
      if (vote.closed) throw new Error("VOTE_CLOSED");
      if (
        !(JSON.parse(vote.contenders) as { id: string }[]).some(
          (entry) => entry.id === winner,
        )
      )
        throw new Error("INVALID_WINNER");
      const [member] = await store.get(
        recordKey("member", winner, config.guildId),
      );
      if (member?.kind !== "member")
        throw new Error("WINNER_CHARACTER_REQUIRED");
      const names = member.roster?.length
        ? member.roster.map((character) => character.name)
        : [member.name];
      const votes: Record<string, number> = {};
      for (const ballot of await store.query(
        `LOOT_BALLOT#${config.guildId}:${voteId}`,
      )) {
        if (ballot.kind === "lootBallot")
          votes[ballot.contenderId] = (votes[ballot.contenderId] ?? 0) + 1;
      }
      const latest = config.guildKey
        ? await latestSnapshot(store, config.guildKey)
        : undefined;
      const decision = {
        ...recordKey("lootDecision", config.guildId, voteId),
        kind: "lootDecision" as const,
        ownerId: config.guildId,
        winner,
        votes: JSON.stringify(votes),
        decidingOfficer,
        reason: reason.trim(),
        award: {
          item: vote.item,
          names,
          raidStart: Number(vote.raidStart),
          closedAt: now(),
          baselineExportedAt: latest?.exportedAt ?? 0,
          baselineLoot:
            latest?.snapshot.loot
              .filter(
                (entry) =>
                  entry.itemName.trim().toLowerCase() ===
                  vote.item.toLowerCase(),
              )
              .map((entry) =>
                JSON.stringify([
                  entry.itemId,
                  characterIdentity(entry.playerKey, latest.snapshot.realm),
                  entry.timestamp,
                  entry.raid,
                ]),
              ) ?? [],
          status: "pending" as const,
        },
      };
      try {
        await store.write(decision, {
          council: {
            guildId: config.guildId,
            voteId,
            revision: vote.revision,
            nextRevision: randomUUID(),
            close: true,
          },
        });
      } catch (error) {
        if (error instanceof Error && error.message === "WRITE_CONFLICT")
          throw new Error("VOTE_CHANGED");
        throw error;
      }
      return decision;
    },
  };
}
