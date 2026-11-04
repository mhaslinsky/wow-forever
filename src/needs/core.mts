import {
  authority,
  createSystemPrincipal,
  type Principal,
} from "../auth/index.mts";
import type { createDataAccess } from "../data/index.mts";
import {
  DEFAULT_TARGETS,
  DEFAULT_TEAM,
  parseTargets,
  type Targets,
  targetsValid,
} from "../data/needs.mts";
import { type GuildRecord, recordKey } from "../data/records.mts";

export function createNeeds(
  data: ReturnType<typeof createDataAccess>,
  guildId: string,
) {
  function officer(actor: Principal<"user">) {
    if (!authority(actor).roles.includes("Officer"))
      throw new Error("WRITE_DENIED");
    return data.forUser(actor);
  }
  return {
    async boards(actor: Principal) {
      const records =
        authority(actor).mode === "system"
          ? data.forSystem(actor as Principal<"system">)
          : data.forUser(actor as Principal<"user">);
      if (
        authority(actor).mode === "user" &&
        !authority(actor).roles.includes("Member")
      )
        throw new Error("READ_DENIED");
      const stored = (await records.query(`RAID_TEAM#${guildId}`)).filter(
        (item) => item.kind === "raidTeam",
      );
      const teams = stored.map((team) => ({
        name: team.name,
        targets: parseTargets(team.targets),
      }));
      if (!teams.some((team) => team.name === DEFAULT_TEAM))
        teams.push({ name: DEFAULT_TEAM, targets: DEFAULT_TARGETS });
      const members = (await records.lookup("MEMBER#ALL")).filter(
        (item): item is Extract<GuildRecord, { kind: "member" }> =>
          item.kind === "member" &&
          item.sk === recordKey("member", item.ownerId, guildId).sk &&
          item.active !== false,
      );
      return teams
        .sort((first, second) => first.name.localeCompare(second.name))
        .map((team) => {
          const mains = members
            .filter((member) => (member.raidTeam ?? DEFAULT_TEAM) === team.name)
            .flatMap(
              (member) =>
                member.roster?.filter((character) => character.main) ?? [],
            );
          const gaps = (["roles", "classes"] as const).flatMap((group) =>
            Object.entries(team.targets[group]).flatMap(([name, target]) => {
              const count = mains.filter(
                (character) =>
                  (group === "roles" ? character.raidRole : character.class) ===
                  name,
              ).length;
              return target > count ? [{ name, count: target - count }] : [];
            }),
          );
          return { name: team.name, targets: team.targets, gaps };
        });
    },
    async setTargets(actor: Principal<"user">, team: string, targets: Targets) {
      const records = officer(actor);
      if (!team.trim() || team.length > 80 || !targetsValid(targets))
        throw new Error("INVALID_TARGETS");
      await records.write({
        ...recordKey("raidTeam", guildId, team),
        kind: "raidTeam",
        ownerId: guildId,
        name: team,
        targets: JSON.stringify(targets),
      });
    },
    async assign(
      actor: Principal<"user">,
      userId: string,
      team: string,
      active: boolean,
    ) {
      const records = officer(actor);
      const teams = await this.boards(actor);
      if (!teams.some((entry) => entry.name === team))
        throw new Error("TEAM_MISSING");
      const member = (
        await records.get(recordKey("member", userId, guildId))
      )[0];
      if (member?.kind !== "member") throw new Error("MEMBER_MISSING");
      await data
        .forSystem(createSystemPrincipal(["member"]))
        .write({ ...member, raidTeam: team, active });
    },
    async message(actor: Principal<"user">) {
      officer(actor);
      const boards = await this.boards(actor);
      return (
        boards
          .filter((board) => board.gaps.length)
          .map(
            (board) =>
              `${board.name}: recruiting ${board.gaps.map((gap) => `${gap.count} ${gap.name}`).join(", ")}.`,
          )
          .join("\n") || "No recruiting gaps"
      );
    },
  };
}
