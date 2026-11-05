import { createSystemPrincipal } from "../auth/index.mts";
import type { createDataAccess } from "../data/index.mts";
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
  const attendees = new Set(
    snapshot
      ? snapshot.memberIds
      : input.presence
          .filter((entry) => {
            if (entry.channelId !== raid.channelId) return false;
            const joined = Date.parse(entry.joinedAt);
            const left = entry.leftAt ? Date.parse(entry.leftAt) : raid.endsAt;
            if (
              !memberId(entry.memberId) ||
              !Number.isFinite(joined) ||
              !Number.isFinite(left) ||
              left < joined
            )
              throw new Error("INVALID_VOICE_PRESENCE");
            // A restart cannot prove presence between the last join and startup.
            return entry.endUnknown
              ? joined >= raid.startsAt && joined < raid.endsAt
              : joined < raid.endsAt && left > raid.startsAt;
          })
          .map((entry) => entry.memberId),
  );
  const signedUp = new Set(input.signedUp);
  return {
    source,
    attendance: [...attendees].sort().map((memberId) => ({ memberId, source })),
    noShows: [...signedUp].filter((id) => !attendees.has(id)).sort(),
    unsignedAttendees: [...attendees].filter((id) => !signedUp.has(id)).sort(),
    signedAndCame: [...signedUp].filter((id) => attendees.has(id)).sort(),
  };
}

export function attendanceMessages(raidId: string, report: AttendanceReport) {
  const lines = [
    `Raid ${raidId} attendance (${report.source})`,
    ...(
      [
        ["No-shows", report.noShows],
        ["Unsigned attendees", report.unsignedAttendees],
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
    const report = resolveAttendance({
      raid,
      signedUp: acceptedSignups(signup.signUps),
      snapshot,
      presence: Array.from(presence).filter(
        (entry): entry is Extract<GuildRecord, { kind: "voicePresence" }> =>
          entry.kind === "voicePresence",
      ),
    });
    await data.write({
      ...recordKey("attendance", config.guildId, raid.raidId),
      kind: "attendance",
      ownerId: config.guildId,
      raidId: raid.raidId,
      source: report.source,
      attendees: JSON.stringify(report.attendance),
    });
    for (const content of attendanceMessages(raid.raidId, report))
      await config.post(content);
    return report;
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
