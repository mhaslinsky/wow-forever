import { normalize, type Snapshot } from "../guildos/index.mts";
import { type Application, applicationAnswers } from "./application.mts";
import type { IntakeFields } from "./intake.mts";
import { parseTargets } from "./needs.mts";
import {
  type CharacterDeclaration,
  characterDeclarations,
  type RecruitingState,
  recruitingState,
} from "./recruiting.mts";

export const KIND_POLICY = Object.freeze({
  departureCheck: "Officer",
  departure: "Officer",
  guildSnapshot: "Officer",
  guildSnapshotLatest: "Officer",
  needsBoard: "Officer",
  raidTeam: "Member",
  candidate: "Officer",
  recruitingIntake: "Officer",
  gowApplication: "Officer",
  classNews: "Member",
  officerNote: "Officer",
  lootDecision: "Officer",
  lootVote: "Officer",
  lootBallot: "Officer",
  member: "Member",
  character: "Member",
  raid: "Member",
  attendance: "Member",
  signup: "Member",
  voicePresence: "Member",
  lootAward: "Member",
  wishlist: "Member",
  fact: "Owner",
  memoryReply: "Owner",
} as const);
export type Kind = keyof typeof KIND_POLICY;
export type Key = { pk: string; sk: string };
export type DecisionAward = {
  item: string;
  names: string[];
  raidStart: number;
  closedAt: number;
  baselineExportedAt: number;
  baselineLoot: string[];
  status: "pending" | "confirmed" | "mismatch";
  snapshotId?: string;
  fingerprint?: string;
};
const CODECS = Object.freeze({
  departureCheck: {
    prefix: "DEPARTURE_CHECK",
    fields: ["snapshotId", "counts"],
  },
  departure: {
    prefix: "DEPARTURE",
    fields: ["memberId", "evidence", "state", "requestId"],
  },
  guildSnapshot: { prefix: "SNAPSHOT", fields: ["snapshotId", "addonVersion"] },
  guildSnapshotLatest: { prefix: "SNAPSHOT_LATEST", fields: ["snapshotId"] },
  needsBoard: { prefix: "NEEDS_BOARD", fields: ["channelId", "messageId"] },
  raidTeam: { prefix: "RAID_TEAM", fields: ["name", "targets"] },
  classNews: { prefix: "CLASS_NEWS", fields: ["guid", "className", "status"] },
  gowApplication: { prefix: "GOW_APPLICATION", fields: ["payload"] },
  candidate: { prefix: "CANDIDATE", fields: ["name"] },
  recruitingIntake: {
    prefix: "RECRUITING_INTAKE",
    fields: ["state", "attemptId", "startedAt", "ref"],
  },
  officerNote: { prefix: "OFFICER_NOTE", fields: ["text"] },
  member: { prefix: "MEMBER", fields: ["name"] },
  character: { prefix: "CHARACTER", fields: ["name"] },
  raid: { prefix: "RAID", fields: ["date"] },
  voicePresence: {
    prefix: "VOICE_PRESENCE",
    fields: ["guildId", "memberId", "channelId", "joinedAt"],
  },
  attendance: {
    prefix: "ATTENDANCE",
    fields: ["raidId", "source", "attendees"],
  },
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
  lootVote: {
    prefix: "LOOT_VOTE",
    fields: ["item", "contenders", "raidStart"],
  },
  lootBallot: { prefix: "LOOT_BALLOT", fields: ["contenderId", "selectionId"] },
  wishlist: { prefix: "WISHLIST", fields: ["item"] },
  fact: { prefix: "FACT", fields: ["text"] },
  memoryReply: { prefix: "MEMORY_REPLY", fields: ["messageId"] },
} as const);
type Fields<Current extends Kind> = (typeof CODECS)[Current]["fields"][number];
export type GuildRecord = {
  [Current in Kind]: Key & { kind: Current; ownerId: string } & Record<
      Fields<Current>,
      string
    > &
    (Current extends "lootVote"
      ? { revision?: string; closed?: boolean }
      : Current extends "lootDecision"
        ? { award?: DecisionAward }
        : Current extends "departure"
          ? { claimedAt: number; messageId?: string }
          : Current extends "guildSnapshot"
            ? {
                exportedAt: number;
                receivedAt: number;
                writtenAt: number;
                snapshotVersion: 1;
                snapshot: Snapshot;
              }
            : Current extends "guildSnapshotLatest"
              ? { exportedAt: number }
              : Current extends "recruitingIntake"
                ? IntakeFields
                : Current extends "voicePresence"
                  ? { leftAt?: string; endUnknown?: boolean }
                  : Current extends "candidate"
                    ? {
                        recruiting?: RecruitingState;
                        retention?: {
                          outcome: "Declined" | "Withdrawn";
                          threadId: string;
                          archived: boolean;
                        };
                        application?: Application;
                        discordUserId?: string;
                        characters?: CharacterDeclaration[];
                      }
                    : Current extends "gowApplication"
                      ? { mappedThreadId?: string; gowStatus?: string }
                      : Current extends "member"
                        ? {
                            roster?: (CharacterDeclaration & {
                              confirmed: boolean;
                            })[];
                            raidTeam?: string;
                            active?: boolean;
                            accepted?: string;
                          }
                        : Current extends "attendance"
                          ? { attemptId?: string }
                          : Current extends "fact"
                            ? { createdAt?: number; forgetAt?: number }
                            : Current extends "memoryReply"
                              ? { expiresAt: number }
                              : Record<never, never>);
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
  const output: Record<string, unknown> = {
    kind,
    pk: item.pk,
    sk: item.sk,
    ownerId: item.ownerId,
  };
  for (const field of codec.fields) {
    if (typeof item[field] !== "string" || !item[field]) return;
    output[field] = item[field];
  }
  if (kind === "lootVote") {
    if (item.revision !== undefined) {
      if (typeof item.revision !== "string" || !item.revision) return;
      output.revision = item.revision;
    }
    if (item.closed !== undefined) {
      if (typeof item.closed !== "boolean") return;
      output.closed = item.closed;
    }
  }
  if (kind === "lootDecision" && item.award !== undefined) {
    const award = item.award as DecisionAward;
    if (
      !award ||
      typeof award.item !== "string" ||
      !award.item.trim() ||
      !Array.isArray(award.names) ||
      !award.names.length ||
      !award.names.every((name) => typeof name === "string" && name.trim()) ||
      ![award.raidStart, award.closedAt, award.baselineExportedAt].every(
        (value) => Number.isFinite(value) && value >= 0,
      ) ||
      !Array.isArray(award.baselineLoot) ||
      !award.baselineLoot.every((entry) => typeof entry === "string") ||
      !["pending", "confirmed", "mismatch"].includes(award.status) ||
      (award.fingerprint !== undefined &&
        (typeof award.fingerprint !== "string" || !award.fingerprint)) ||
      (award.snapshotId !== undefined &&
        !/^[a-f0-9]{64}$/.test(award.snapshotId))
    )
      return;
    output.award = structuredClone(award);
  }
  if (kind === "memoryReply") {
    if (
      !Number.isSafeInteger(item.expiresAt) ||
      Number(item.expiresAt) < 0 ||
      item.sk !==
        recordKey(kind, item.ownerId as string, item.messageId as string).sk
    )
      return;
    output.expiresAt = item.expiresAt;
  }
  if (kind === "fact") {
    for (const field of ["createdAt", "forgetAt"] as const) {
      if (item[field] !== undefined) {
        if (!Number.isSafeInteger(item[field]) || Number(item[field]) < 0)
          return;
        output[field] = item[field];
      }
    }
    if (item.forgetAt !== undefined && item.sk !== "FACT#forget") return;
  }
  if (kind === "departureCheck") {
    try {
      const counts = JSON.parse(String(item.counts));
      if (
        !counts ||
        typeof counts !== "object" ||
        Array.isArray(counts) ||
        !Object.values(counts).every((entry) => {
          if (!entry || typeof entry !== "object") return false;
          const count = entry as Record<string, unknown>;
          return (
            [0, 1, 2].includes(Number(count.misses)) &&
            typeof count.misses === "number" &&
            typeof count.evidence === "string" &&
            count.evidence.length > 0 &&
            typeof count.rosterSignature === "string"
          );
        })
      )
        return;
    } catch {
      return;
    }
  }
  if (kind === "departure") {
    if (
      !["pending", "kept", "confirmed"].includes(String(item.state)) ||
      !Number.isFinite(item.claimedAt) ||
      Number(item.claimedAt) < 0
    )
      return;
    output.claimedAt = item.claimedAt;
    if (item.messageId !== undefined) {
      if (typeof item.messageId !== "string" || !item.messageId) return;
      output.messageId = item.messageId;
    }
  }
  if (kind === "guildSnapshot" || kind === "guildSnapshotLatest") {
    if (
      !Number.isSafeInteger(item.exportedAt) ||
      Number(item.exportedAt) < 0 ||
      !/^[a-f0-9]{64}$/.test(String(item.snapshotId))
    )
      return;
    output.exportedAt = item.exportedAt;
    if (kind === "guildSnapshotLatest") {
      if (item.sk !== recordKey(kind, item.ownerId, "latest").sk) return;
    } else {
      if (
        !Number.isFinite(item.receivedAt) ||
        !Number.isFinite(item.writtenAt) ||
        item.snapshotVersion !== 1
      )
        return;
      try {
        const snapshot = item.snapshot as Snapshot;
        const normalized = normalize({
          ...snapshot,
          fmt: "GOSCOMP1",
          count: snapshot.members.length,
        });
        if (
          normalized.guildKey !== item.ownerId ||
          normalized.exportedAt !== item.exportedAt ||
          normalized.addonVersion !== item.addonVersion ||
          item.sk !==
            recordKey(
              kind,
              item.ownerId,
              `${String(item.exportedAt).padStart(16, "0")}#${item.snapshotId}`,
            ).sk
        )
          return;
        Object.assign(output, {
          snapshot: normalized,
          snapshotVersion: 1,
          receivedAt: item.receivedAt,
          writtenAt: item.writtenAt,
        });
      } catch {
        return;
      }
    }
  }
  if (kind === "recruitingIntake") {
    if (
      ![
        "pending",
        "uncertain",
        "created",
        "done",
        "blocked",
        "released",
      ].includes(item.state as string) ||
      !Number.isFinite(Date.parse(item.startedAt as string)) ||
      !/^[a-f0-9]{64}$/.test(item.ref as string) ||
      item.sk !== `${prefix}${item.ref}`
    )
      return;
    if (item.state === "created" || item.state === "done") {
      if (typeof item.threadId !== "string" || !item.threadId) return;
      output.threadId = item.threadId;
    }
    if (item.state === "released" && item.threadId !== undefined) return;
    if (item.released !== undefined) {
      if (
        item.released !== true ||
        !["pending", "uncertain", "created", "blocked"].includes(
          item.state as string,
        )
      )
        return;
      output.released = true;
    }
    if (item.state === "done" || item.state === "released") {
      if (item.payload !== undefined) return;
    } else {
      const payload = item.payload as Record<string, unknown> | undefined;
      if (
        !payload ||
        typeof payload.content !== "string" ||
        !payload.content ||
        typeof payload.submission !== "string" ||
        !payload.submission ||
        !decode({
          ...recordKey("candidate", item.ownerId, "payload"),
          kind: "candidate",
          ownerId: item.ownerId,
          name: payload.name,
          discordUserId: payload.discordUserId,
          characters: payload.characters,
          application: payload.application,
          recruiting: {
            threadId: "payload",
            source: payload.source,
            stage: "New",
            changedBy: payload.actorId,
            changedAt: payload.changedAt,
            owner: payload.owner,
            nextActionAt: payload.nextActionAt,
          },
        })
      )
        return;
      output.payload = structuredClone(payload);
    }
    if (item.state === "blocked") {
      if (
        typeof item.noticeSent !== "boolean" ||
        !["expired", "uncertain", "rejected"].includes(
          item.outcome as string,
        ) ||
        (item.outcome === "rejected" && item.released !== true)
      )
        return;
      output.noticeSent = item.noticeSent;
      output.outcome = item.outcome;
    }
  }
  if (kind === "gowApplication" && item.mappedThreadId !== undefined) {
    if (typeof item.mappedThreadId !== "string" || !item.mappedThreadId) return;
    output.mappedThreadId = item.mappedThreadId;
  }
  if (kind === "gowApplication" && item.gowStatus !== undefined) {
    if (typeof item.gowStatus !== "string" || !item.gowStatus) return;
    output.gowStatus = item.gowStatus;
  }
  if (kind === "attendance") {
    if (item.attemptId !== undefined) {
      if (typeof item.attemptId !== "string" || !item.attemptId) return;
      output.attemptId = item.attemptId;
    }
    if (item.source !== "guildos" && item.source !== "voice") return;
    try {
      const attendees: unknown = JSON.parse(item.attendees as string);
      if (
        !Array.isArray(attendees) ||
        !attendees.every(
          (entry) =>
            entry &&
            typeof entry.memberId === "string" &&
            entry.memberId.length > 0 &&
            entry.source === item.source,
        )
      )
        return;
    } catch {
      return;
    }
  }
  if (kind === "voicePresence" && item.leftAt !== undefined) {
    if (typeof item.leftAt !== "string" || !item.leftAt) return;
    output.leftAt = item.leftAt;
  }
  if (kind === "voicePresence" && item.endUnknown !== undefined) {
    if (typeof item.endUnknown !== "boolean" || !item.leftAt) return;
    output.endUnknown = item.endUnknown;
  }
  if (kind === "candidate" && item.retention !== undefined) {
    const retention = item.retention as Record<string, unknown>;
    if (
      !retention ||
      !["Declined", "Withdrawn"].includes(retention.outcome as string) ||
      typeof retention.threadId !== "string" ||
      !retention.threadId ||
      typeof retention.archived !== "boolean"
    )
      return;
    output.retention = { ...retention };
  }
  if (kind === "candidate" && item.recruiting !== undefined) {
    if (!recruitingState(item.recruiting)) return;
    output.recruiting = { ...item.recruiting };
  }
  if (kind === "candidate") {
    if (item.discordUserId !== undefined) {
      if (typeof item.discordUserId !== "string" || !item.discordUserId.trim())
        return;
      output.discordUserId = item.discordUserId;
    }
    if (item.characters !== undefined) {
      if (!characterDeclarations(item.characters)) return;
      output.characters = item.characters.map((character) => ({
        ...character,
      }));
    }
  }
  if (kind === "candidate" && item.application !== undefined) {
    if (
      !applicationAnswers(
        item.application,
        characterDeclarations(item.characters)
          ? item.characters.find((character) => character.main)
          : undefined,
      )
    )
      return;
    output.application = {
      ...item.application,
      offspecs: [...item.application.offspecs],
      nights: [...item.application.nights],
    };
  }
  if (kind === "raidTeam") {
    try {
      parseTargets(item.targets as string);
    } catch {
      return;
    }
  }
  if (kind === "member") {
    if (item.raidTeam !== undefined) {
      if (typeof item.raidTeam !== "string" || !item.raidTeam.trim()) return;
      output.raidTeam = item.raidTeam;
    }
    if (item.active !== undefined) {
      if (typeof item.active !== "boolean") return;
      output.active = item.active;
    }
    if (item.accepted !== undefined) {
      if (typeof item.accepted !== "string" || !item.accepted) return;
      output.accepted = item.accepted;
    }
  }
  if (kind === "member" && item.roster !== undefined) {
    if (
      !Array.isArray(item.roster) ||
      (item.roster.length > 0 && !characterDeclarations(item.roster)) ||
      !item.roster.every(
        (character) =>
          "confirmed" in character && typeof character.confirmed === "boolean",
      )
    )
      return;
    output.roster = item.roster.map((character) => ({ ...character }));
  }
  return output as GuildRecord;
}
