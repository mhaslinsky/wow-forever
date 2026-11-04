import { authority, type Principal } from "../auth/index.mts";
import type { createDataAccess } from "../data/index.mts";
import { recordKey } from "../data/records.mts";
import {
  type CharacterDeclaration,
  characterDeclarations,
} from "../data/recruiting.mts";
import {
  type RecruitingFailure,
  reportRecruitingFailure,
} from "../recruiting/alarm.mts";
import type { Candidate } from "../recruiting/core.mts";

export function createRoster(
  data: ReturnType<typeof createDataAccess>,
  guildId: string,
) {
  async function save(
    principal: Principal,
    userId: string,
    characters: CharacterDeclaration[],
  ) {
    if (!userId.trim() || !characterDeclarations(characters))
      throw new Error("INVALID_ROSTER");
    const records =
      authority(principal).mode === "system"
        ? data.forSystem(principal as Principal<"system">)
        : data.forUser(principal as Principal<"user">);
    const key = recordKey("member", userId, guildId);
    const previous = (await records.get(key))[0];
    const confirmed = new Set(
      previous?.kind === "member"
        ? previous.roster
            ?.filter((character) => character.confirmed)
            .map((character) => character.name.toLowerCase())
        : [],
    );
    const main = characters.find((character) => character.main);
    if (!main) throw new Error("INVALID_ROSTER");
    await records.write({
      ...key,
      kind: "member",
      ownerId: userId,
      name: main.name,
      roster: characters.map((character) => ({
        ...character,
        confirmed: confirmed.has(character.name.toLowerCase()),
      })),
    });
  }
  return {
    async register(
      actor: Principal<"user">,
      characters: CharacterDeclaration[],
    ) {
      const identity = authority(actor);
      if (!identity.roles.includes("Member")) throw new Error("WRITE_DENIED");
      await save(actor, identity.userId, characters);
    },
    async accept(
      candidate: Candidate,
      principal: Principal<"system">,
      grantMember: (userId: string) => Promise<void>,
      report: (failure: RecruitingFailure) => void = reportRecruitingFailure,
    ) {
      if (
        !candidate.discordUserId ||
        !characterDeclarations(candidate.characters)
      )
        throw new Error("CANDIDATE_ROSTER_MISSING");
      try {
        await grantMember(candidate.discordUserId);
      } catch (cause) {
        report({
          code: "MEMBER_ROLE_GRANT_FAILED",
          threadId: candidate.recruiting?.threadId ?? candidate.sk,
        });
        throw new Error("MEMBER_ROLE_GRANT_FAILED", { cause });
      }
      await save(principal, candidate.discordUserId, candidate.characters);
    },
  };
}
