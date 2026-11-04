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
    name?: string,
  ) {
    if (
      !userId.trim() ||
      (characters.length > 0 && !characterDeclarations(characters))
    )
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
    const memberName = main?.name ?? name;
    if (!memberName) throw new Error("INVALID_ROSTER");
    await records.write({
      ...key,
      kind: "member",
      ownerId: userId,
      name: memberName,
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
      if (!characterDeclarations(characters)) throw new Error("INVALID_ROSTER");
      await save(actor, identity.userId, characters);
    },
    async accept(
      candidate: Candidate,
      principal: Principal<"system">,
      grantMember: (userId: string) => Promise<void>,
      report: (failure: RecruitingFailure) => void = reportRecruitingFailure,
    ) {
      if (!candidate.discordUserId) {
        report({
          code: "MEMBER_GRANT_SKIPPED",
          threadId: candidate.recruiting?.threadId ?? candidate.sk,
        });
        return;
      }
      try {
        await grantMember(candidate.discordUserId);
      } catch (cause) {
        report({
          code: "MEMBER_ROLE_GRANT_FAILED",
          threadId: candidate.recruiting?.threadId ?? candidate.sk,
        });
        throw new Error("MEMBER_ROLE_GRANT_FAILED", { cause });
      }
      await save(
        principal,
        candidate.discordUserId,
        candidate.characters ?? [],
        candidate.name,
      );
    },
  };
}
