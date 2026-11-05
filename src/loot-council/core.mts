import { authority, type Principal } from "../auth/index.mts";
import type { createDataAccess } from "../data/index.mts";
import { recordKey } from "../data/records.mts";
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
      const snapshots = config.guildKey
        ? (await store.query(`SNAPSHOT#${config.guildKey}`))
            .filter((entry) => entry.kind === "guildSnapshot")
            .sort((left, right) => right.exportedAt - left.exportedAt)
        : [];
      const snapshot = snapshots[0]?.snapshot;
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
          member?.roster?.map((entry) => entry.name.toLowerCase()) ?? [
            ...(member ? [member.name.toLowerCase()] : []),
          ],
        );
        const loot = snapshot?.loot
          .filter(
            (entry) =>
              names.has(entry.player.toLowerCase()) &&
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
            ? `${contenders.length - 25} contenders left out`
            : "",
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
    async vote(actor: Principal<"user">, voteId: string, contenderId: string) {
      const officerId = officer(actor);
      const store = data.forUser(actor);
      const [vote] = await store.get(
        recordKey("lootVote", config.guildId, voteId),
      );
      if (
        vote?.kind !== "lootVote" ||
        !(JSON.parse(vote.contenders) as { id: string }[]).some(
          (entry) => entry.id === contenderId,
        )
      )
        throw new Error("VOTE_NOT_FOUND");
      await store.write({
        ...recordKey("lootBallot", `${config.guildId}:${voteId}`, officerId),
        kind: "lootBallot",
        ownerId: `${config.guildId}:${voteId}`,
        contenderId,
      });
    },
  };
}
