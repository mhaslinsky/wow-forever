import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import fc from "fast-check";
import {
  attendanceMessages,
  resolveAttendance,
} from "../src/signups/attendance.mts";

const raid = {
  raidId: "synthetic-raid",
  channelId: "raid-voice",
  startsAt: 1000,
  endsAt: 5000,
};
const snapshot = JSON.parse(
  readFileSync(
    new URL("./fixtures/raid-attendance.json", import.meta.url),
    "utf8",
  ),
);
test("snapshot attendance wins and all report groups are listed", () => {
  const report = resolveAttendance({
    raid,
    signedUp: ["both", "absent"],
    snapshot,
    presence: [
      {
        memberId: "voice",
        channelId: raid.channelId,
        joinedAt: new Date(2000).toISOString(),
      },
    ],
  });
  assert.deepEqual(report.attendance, [
    { memberId: "both", source: "guildos" },
    { memberId: "unsigned", source: "guildos" },
  ]);
  assert.equal(
    attendanceMessages(raid.raidId, report).join("\n"),
    "Raid synthetic-raid attendance (guildos)\nNo-shows:\n<@absent>\nUnsigned attendees:\n<@unsigned>\nSigned and came:\n<@both>",
  );
});
test("voice fallback is marked", () => {
  const report = resolveAttendance({
    raid,
    signedUp: [],
    presence: [
      {
        memberId: "voice",
        channelId: raid.channelId,
        joinedAt: new Date(2000).toISOString(),
      },
    ],
  });
  assert.deepEqual(report.attendance, [{ memberId: "voice", source: "voice" }]);
});
test("report categories match a set model and partition signup and attendance union", () => {
  fc.assert(
    fc.property(
      fc.uniqueArray(fc.nat({ max: 30 })),
      fc.uniqueArray(fc.nat({ max: 30 })),
      (signed, came) => {
        const signedUp = signed.map(String),
          memberIds = came.map(String);
        const report = resolveAttendance({
          raid,
          signedUp,
          snapshot: { raidId: raid.raidId, memberIds },
          presence: [],
        });
        const model = [
          signedUp.filter((id) => !memberIds.includes(id)),
          memberIds.filter((id) => !signedUp.includes(id)),
          signedUp.filter((id) => memberIds.includes(id)),
        ].map((group) => group.sort());
        assert.deepEqual(
          [report.noShows, report.unsignedAttendees, report.signedAndCame],
          model,
        );
      },
    ),
  );
});
