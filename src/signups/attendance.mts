import { createSystemPrincipal } from "../auth/index.mts";
import {
  type createDataAccess,
  reportInvalidDataItem,
} from "../data/index.mts";
import { type GuildRecord, recordKey } from "../data/records.mts";
import { createDigestDiscord } from "../recruiting/alerts.mts";
import type { SignUp } from "./poller.mts";

export type AttendanceSource = "guildos" | "voice";
export type Attendance = { memberId: string; source: AttendanceSource };
export type SnapshotAttendance = {
  raidId: string;
  memberIds: string[];
};
export type SnapshotAttendancePort = (
  raidId: string,
) => Promise<SnapshotAttendance | undefined>;
export type RaidWindow = {
  raidId: string;
  channelId: string;
  startsAt: number;
  endsAt: number;
};
type Presence = Pick<
  Extract<GuildRecord, { kind: "voicePresence" }>,
  "memberId" | "channelId" | "joinedAt" | "leftAt" | "endUnknown"
>;
export type AttendanceReport = {
  source: AttendanceSource;
  skippedBadVoiceRecords: number;
  attendance: Attendance[];
  noShows: string[];
  unsignedAttendees: string[];
  signedAndCame: string[];
};

function memberId(value: unknown): value is string {
  return typeof value === "string" && /^[\w-]{1,128}$/.test(value);
}

function acceptedSignups(raw: string): string[] {
  const parsed: unknown = JSON.parse(raw);
  if (
    !Array.isArray(parsed) ||
    !parsed.every(
      (entry: Partial<SignUp> | null) =>
        entry &&
        memberId(entry.userId) &&
        ["primary", "secondary", "queued"].includes(String(entry.status)),
    )
  )
    throw new Error("INVALID_SIGNUPS");
  return parsed
    .filter((entry: SignUp) => entry.status === "primary")
    .map((entry: SignUp) => entry.userId);
}

export function resolveAttendance(input: {
  raid: RaidWindow;
  signedUp: string[];
  snapshot?: SnapshotAttendance;
  presence: readonly Presence[];
}): AttendanceReport {
  const { raid, snapshot } = input;
  if (
    !memberId(raid.raidId) ||
    !memberId(raid.channelId) ||
    !Number.isFinite(raid.startsAt) ||
    !Number.isFinite(raid.endsAt) ||
    raid.endsAt <= raid.startsAt ||
    !input.signedUp.every(memberId)
  )
    throw new Error("INVALID_RAID_ATTENDANCE_INPUT");
  if (
    snapshot &&
    (snapshot.raidId !== raid.raidId || !snapshot.memberIds.every(memberId))
  )
    throw new Error("INVALID_SNAPSHOT_ATTENDANCE");
  const source: AttendanceSource = snapshot ? "guildos" : "voice";
  let skippedBadVoiceRecords = 0;
  const attendees = new Set(
    snapshot
      ? snapshot.memberIds
      : input.presence
          .filter((entry) => {
            if (entry.channelId !== raid.channelId) return false;
            const joined = Date.parse(entry.joinedAt);
            const left = entry.leftAt ? Date.parse(entry.leftAt) : raid.endsAt;
            if (
              joined >= raid.endsAt ||
              (Number.isFinite(left) && left <= raid.startsAt && left >= joined)
            )
              return false;
            if (
              !memberId(entry.memberId) ||
              !Number.isFinite(joined) ||
              !Number.isFinite(left) ||
              left < joined
            ) {
              skippedBadVoiceRecords++;
              return false;
            }
            // A restart cannot prove presence between the last join and startup.
            return entry.endUnknown
              ? joined >= raid.startsAt && joined < raid.endsAt
              : joined < raid.endsAt && left > raid.startsAt;
          })
          .map((entry) => entry.memberId),
  );
  return buildReport(
    source,
    [...attendees],
    input.signedUp,
    skippedBadVoiceRecords,
  );
}

function buildReport(
  source: AttendanceSource,
  members: string[],
  accepted: string[],
  skippedBadVoiceRecords: number,
): AttendanceReport {
  const attendees = new Set(members);
  const signedUp = new Set(accepted);
  return {
    source,
    skippedBadVoiceRecords,
    attendance: [...attendees].sort().map((memberId) => ({ memberId, source })),
    noShows: [...signedUp].filter((id) => !attendees.has(id)).sort(),
    unsignedAttendees: [...attendees].filter((id) => !signedUp.has(id)).sort(),
    signedAndCame: [...signedUp].filter((id) => attendees.has(id)).sort(),
  };
}

export function attendanceMessages(raidId: string, report: AttendanceReport) {
  const lines = [
    `Raid ${raidId} attendance (${report.source})`,
    ...(report.skippedBadVoiceRecords > 0
      ? [`Skipped ${report.skippedBadVoiceRecords} bad voice records`]
      : []),
    ...(
      [
        ["No-shows", report.noShows],
        ["Walk-ins", report.unsignedAttendees],
        ["Signed and came", report.signedAndCame],
      ] as const
    ).flatMap(([label, members]) => [
      `${label}:`,
      ...(members.length ? members.map((id) => `<@${id}>`) : ["None"]),
    ]),
  ];
  const messages: string[] = [];
  let content = "";
  for (const line of lines) {
    if (content.length + line.length + 1 > 2000) {
      messages.push(content);
      content = "";
    }
    content += `${content ? "\n" : ""}${line}`;
  }
  if (content) messages.push(content);
  return messages;
}

export function createPostRaidReporter(config: {
  guildId: string;
  data: ReturnType<typeof createDataAccess>;
  post(content: string): Promise<void>;
  snapshots?: SnapshotAttendancePort;
  now?: () => number;
  metric?: (count: number) => void;
}) {
  if (!config.guildId.trim()) throw new Error("GUILD_ID_REQUIRED");
  const data = config.data.forSystem(createSystemPrincipal(["attendance"]));
  return async (raid: RaidWindow) => {
    if (raid.endsAt > (config.now ?? Date.now)())
      throw new Error("RAID_NOT_FINISHED");
    const [signup] = await data.get(
      recordKey("signup", config.guildId, raid.raidId),
    );
    if (signup?.kind !== "signup") throw new Error("RAID_SIGNUPS_MISSING");
    const snapshot = await config.snapshots?.(raid.raidId);
    const presence = snapshot
      ? []
      : await data.query(recordKey("voicePresence", config.guildId, "all").pk);
    const signedUp = acceptedSignups(signup.signUps);
    const report = resolveAttendance({
      raid,
      signedUp,
      snapshot,
      presence: Array.from(presence).filter(
        (entry): entry is Extract<GuildRecord, { kind: "voicePresence" }> =>
          entry.kind === "voicePresence",
      ),
    });
    try {
      if (report.skippedBadVoiceRecords > 0)
        (config.metric ?? reportInvalidDataItem)(report.skippedBadVoiceRecords);
    } catch {
      console.error(JSON.stringify({ event: "ATTENDANCE_METRIC_FAILED" }));
    }
    const key = recordKey("attendance", config.guildId, raid.raidId);
    try {
      await data.write({
        ...key,
        kind: "attendance",
        ownerId: config.guildId,
        raidId: raid.raidId,
        source: report.source,
        attendees: JSON.stringify(report.attendance),
      });
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "WRITE_CONFLICT")
        throw error;
    }
    const [persisted] = await data.get(key);
    if (persisted?.kind !== "attendance" || persisted.raidId !== raid.raidId)
      throw new Error("ATTENDANCE_NOT_SAVED");
    const members: Attendance[] = JSON.parse(persisted.attendees);
    const winner = buildReport(
      persisted.source as AttendanceSource,
      members.map((entry) => entry.memberId),
      signedUp,
      report.skippedBadVoiceRecords,
    );
    for (const content of attendanceMessages(raid.raidId, winner))
      await config.post(content);
    return winner;
  };
}

export function createDiscordPostRaidReporter(config: {
  guildId: string;
  token: string;
  data: ReturnType<typeof createDataAccess>;
  snapshots?: SnapshotAttendancePort;
}) {
  return createPostRaidReporter({
    ...config,
    post: createDigestDiscord(config.token, config.guildId),
  });
}
