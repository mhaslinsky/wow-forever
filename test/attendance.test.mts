import { deepEqual, equal, ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import fc from "fast-check";
import { createDataAccess } from "../src/data/index.mts";
import { type GuildRecord, recordKey } from "../src/data/records.mts";
import {
  attendanceMessages,
  createPostRaidReporter,
  resolveAttendance,
} from "../src/signups/attendance.mts";

const raid = {
  raidId: "synthetic-raid",
  channelId: "raid-voice",
  startsAt: 1000,
  endsAt: 5000,
};
const snapshot = JSON.parse(
  readFileSync("test/fixtures/raid-attendance.json", "utf8"),
);
const voice = (joinedAt = 2000) => ({
  memberId: "voice",
  channelId: raid.channelId,
  joinedAt: new Date(joinedAt).toISOString(),
});
const input = { raid, signedUp: ["both", "absent"], presence: [voice()] };
test("snapshot wins and all report groups are listed", () => {
  const report = resolveAttendance({ ...input, snapshot });
  equal(
    attendanceMessages(raid.raidId, report).join("\n"),
    "Raid synthetic-raid attendance (guildos)\nNo-shows:\n<@absent>\nWalk-ins:\n<@unsigned>\nSigned and came:\n<@both>",
  );
});
test("report categories match a set model and partition the union", () => {
  const ids = fc.subarray(["both", "absent", "unsigned"]);
  fc.assert(
    fc.property(ids, ids, (signedUp, memberIds) => {
      const report = resolveAttendance({
        ...input,
        signedUp,
        snapshot: { raidId: raid.raidId, memberIds },
      });
      const model = [
        signedUp.filter((id) => !memberIds.includes(id)),
        memberIds.filter((id) => !signedUp.includes(id)),
        signedUp.filter((id) => memberIds.includes(id)),
      ].map((group) => group.sort());
      deepEqual(
        [report.noShows, report.unsignedAttendees, report.signedAndCame],
        model,
      );
    }),
  );
});
test("open sessions after raid end are ignored", () => {
  deepEqual(
    resolveAttendance({ ...input, presence: [voice(6000)] }).attendance,
    [],
  );
});
function reporterFixture() {
  const records = new Map<string, GuildRecord>();
  const messages: string[] = [],
    metrics: number[] = [];
  const data = createDataAccess({
    get: async (key) => records.get(key.sk),
    query: async () => ({ items: [...records.values()] }),
    batch: async () => [],
    put: async (item, condition) => {
      const previous = records.get(item.sk);
      if (
        condition?.preserveMeasuredAttendance &&
        previous?.kind === "attendance" &&
        previous.source === "guildos"
      )
        throw Object.assign(new Error("conflict"), {
          name: "ConditionalCheckFailedException",
        });
      records.set(item.sk, item);
    },
  });
  records.set("SIGNUP#synthetic-raid", {
    ...recordKey("signup", "guild", raid.raidId),
    kind: "signup",
    ownerId: "guild",
    raidId: raid.raidId,
    startTime: "1",
    polledAt: "now",
    signUps: "[]",
  });
  const current = { value: snapshot };
  const post = createPostRaidReporter({
    guildId: "guild",
    data,
    now: () => 5000,
    metric: (count) => metrics.push(count),
    snapshots: async () => current.value,
    post: async (content) => {
      messages.push(content);
    },
  });
  return {
    records,
    messages,
    metrics,
    post,
    current,
  };
}
test("measured attendance survives fallback and is posted", async () => {
  const { post, current, messages } = reporterFixture();
  await post(raid);
  current.value = undefined;
  const winner = await post(raid);
  equal(winner.source, "guildos");
  deepEqual(
    winner.attendance.map((entry) => entry.memberId),
    snapshot.memberIds,
  );
  equal(messages[1], messages[0]);
});
test("bad voice records are skipped, counted and reported with a metric", async () => {
  const setup = reporterFixture();
  setup.current.value = undefined;
  for (const [index, fields] of [
    { memberId: "bad id" },
    { joinedAt: "not-time" },
    { leftAt: new Date(0).toISOString() },
    {},
  ].entries()) {
    const record: GuildRecord = {
      ...recordKey("voicePresence", "guild", String(index)),
      kind: "voicePresence",
      ownerId: "guild",
      guildId: "guild",
      ...voice(),
      ...fields,
    };
    setup.records.set(record.sk, record);
  }
  const report = await setup.post(raid);
  deepEqual(report.attendance, [{ memberId: "voice", source: "voice" }]);
  deepEqual(setup.metrics, [3]);
  ok(setup.messages[0].includes("Skipped 3 bad voice records"));
});
