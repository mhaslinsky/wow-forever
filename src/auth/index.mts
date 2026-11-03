import type { Kind } from "../data/records.mts";

export type Role = "Member" | "Officer";
declare const principalBrand: unique symbol;
declare const resultBrand: unique symbol;
export type Principal<Mode extends "user" | "system" = "user" | "system"> = {
  readonly [principalBrand]: Mode;
};
export type UserResult<Value> = ReadonlyArray<Value> & {
  readonly [resultBrand]: "user";
};
export type SystemResult<Value> = ReadonlyArray<Value> & {
  readonly [resultBrand]: "system";
};
type Authority = {
  mode: "user" | "system";
  userId: string;
  roles: readonly Role[];
  writableKinds: readonly Kind[];
};
const authorities = new WeakMap<Principal, Authority>();

export function authority(principal: Principal): Readonly<Authority> {
  const value = authorities.get(principal);
  if (!value) throw new Error("INVALID_PRINCIPAL");
  return value;
}

export function createPrincipalFactory(config: {
  guildId: string;
  memberRoleId: string;
  officerRoleId: string;
  jobs: Readonly<Record<string, readonly Kind[]>>;
}) {
  const guildId = config.guildId;
  const memberRoleId = config.memberRoleId;
  const officerRoleId = config.officerRoleId;
  if (
    !guildId ||
    !memberRoleId ||
    !officerRoleId ||
    memberRoleId === officerRoleId
  )
    throw new Error("INVALID_ROLE_CONFIG");
  const jobs = new Map(
    Object.entries(config.jobs).map(([name, kinds]) => [name, [...kinds]]),
  );
  function user(userId: string, guild: string, roleIds: readonly string[]) {
    const roles: Role[] = [];
    if (
      userId &&
      guildId &&
      guild === guildId &&
      memberRoleId &&
      officerRoleId
    ) {
      if (roleIds.includes(officerRoleId)) roles.push("Officer", "Member");
      else if (roleIds.includes(memberRoleId)) roles.push("Member");
    }
    const principal = Object.freeze({}) as Principal<"user">;
    authorities.set(
      principal,
      Object.freeze({
        mode: "user",
        userId,
        roles: Object.freeze(roles),
        writableKinds: Object.freeze([]),
      }),
    );
    return principal;
  }
  return {
    // The caller must verify the interaction signature before using this constructor.
    fromVerifiedInteraction(interaction: {
      guild_id: string;
      member?: { user: { id: string }; roles: readonly string[] };
    }): Principal<"user"> {
      return user(
        interaction.member?.user.id ?? "",
        interaction.guild_id,
        interaction.member?.roles ?? [],
      );
    },
    async fromGateway(
      event: {
        guildId: string;
        userId: string;
      },
      fetchCurrentMember: (
        guildId: string,
        userId: string,
      ) => Promise<
        | {
            userId: string;
            roleIds: readonly string[];
          }
        | undefined
      >,
    ): Promise<Principal<"user">> {
      if (event.guildId !== guildId) return user(event.userId, "", []);
      try {
        const member = await fetchCurrentMember(event.guildId, event.userId);
        return user(
          event.userId,
          event.guildId,
          member?.userId === event.userId ? member.roleIds : [],
        );
      } catch {
        return user(event.userId, event.guildId, []);
      }
    },
    systemPrincipal(jobName: string): Principal<"system"> {
      const kinds = jobs.get(jobName);
      if (!kinds) throw new Error("UNKNOWN_JOB");
      // Facts belong to a user, so jobs cannot declare writes to them.
      if (kinds.includes("fact")) throw new Error("INVALID_JOB_KINDS");
      const principal = Object.freeze({}) as Principal<"system">;
      authorities.set(
        principal,
        Object.freeze({
          mode: "system",
          userId: "",
          roles: Object.freeze([]),
          writableKinds: Object.freeze(kinds),
        }),
      );
      return principal;
    },
  };
}
