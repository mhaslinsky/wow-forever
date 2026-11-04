export const KIND_POLICY = Object.freeze({
  candidate: "Officer",
  officerNote: "Officer",
  lootDecision: "Officer",
  member: "Member",
  character: "Member",
  raid: "Member",
  attendance: "Member",
  signup: "Member",
  lootAward: "Member",
  wishlist: "Member",
  fact: "Owner",
} as const);
export type Kind = keyof typeof KIND_POLICY;
export type Key = { pk: string; sk: string };
const CODECS = Object.freeze({
  candidate: { prefix: "CANDIDATE", fields: ["name"] },
  officerNote: { prefix: "OFFICER_NOTE", fields: ["text"] },
  member: { prefix: "MEMBER", fields: ["name"] },
  character: { prefix: "CHARACTER", fields: ["name"] },
  raid: { prefix: "RAID", fields: ["date"] },
  attendance: { prefix: "ATTENDANCE", fields: ["raidId"] },
  signup: {
    prefix: "SIGNUP",
    fields: ["raidId", "startTime", "signUps", "polledAt"],
  },
  lootAward: {
    prefix: "LOOT_AWARD",
    fields: ["item", "winner", "raidId", "date"],
  },
  lootDecision: {
    prefix: "LOOT_DECISION",
    fields: ["winner", "votes", "decidingOfficer", "reason"],
  },
  wishlist: { prefix: "WISHLIST", fields: ["item"] },
  fact: { prefix: "FACT", fields: ["text"] },
} as const);
type Fields<Current extends Kind> = (typeof CODECS)[Current]["fields"][number];
export type GuildRecord = {
  [Current in Kind]: Key & { kind: Current; ownerId: string } & Record<
      Fields<Current>,
      string
    >;
}[Kind];
export type RecordInput =
  | GuildRecord
  | Omit<Extract<GuildRecord, { kind: "fact" }>, "ownerId">;

export function recordKey(kind: Kind, ownerId: string, id: string): Key {
  return {
    pk: `${CODECS[kind].prefix}#${ownerId}`,
    sk: `${CODECS[kind].prefix}#${id}`,
  };
}

export function decode(raw: unknown): GuildRecord | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
  const item = raw as Record<string, unknown>;
  if (typeof item.kind !== "string" || !Object.hasOwn(CODECS, item.kind))
    return;
  const kind = item.kind as Kind;
  const codec = CODECS[kind];
  const prefix = `${codec.prefix}#`;
  if (
    typeof item.ownerId !== "string" ||
    !item.ownerId ||
    item.pk !== `${prefix}${item.ownerId}` ||
    typeof item.sk !== "string" ||
    !item.sk.startsWith(prefix) ||
    item.sk.length === prefix.length
  )
    return;
  const output: Record<string, string> = {
    kind,
    pk: item.pk,
    sk: item.sk,
    ownerId: item.ownerId,
  };
  for (const field of codec.fields) {
    if (typeof item[field] !== "string" || !item[field]) return;
    output[field] = item[field];
  }
  return output as GuildRecord;
}
