import { deepEqual, equal } from "node:assert/strict";
import { test } from "node:test";
import { ChannelType } from "discord.js";
import { createDataAccess } from "../src/data/index.mts";
import type { GuildRecord } from "../src/data/records.mts";
import { createVoicePresenceHandler } from "../src/gateway/voice-presence.mts";

const state = (name: string | null, category = "Forever") =>
  ({
    id: "member",
    guild: { id: "guild" },
    channelId: name,
    channel: name
      ? { type: ChannelType.GuildVoice, name, parent: { name: category } }
      : null,
  }) as Parameters<ReturnType<typeof createVoicePresenceHandler>>[0];
function fixture() {
  const records = new Map<string, GuildRecord>();
  const data = createDataAccess({
    get: async () => undefined,
    batch: async () => [],
    query: async () => ({ items: [...records.values()] }),
    put: async (record) => {
      records.set(record.sk, record);
    },
  });
  return { records, data };
}
test("raid joins and leaves persist presence intervals", async () => {
  const { records, data } = fixture();
  let time = 0;
  const handle = createVoicePresenceHandler(data, "guild", () => time);
  await handle(state(null), state("Raid"));
  time = 60000;
  await handle(state("Raid"), state(null));
  const record = [...records.values()][0];
  equal(record.kind, "voicePresence");
  if (record.kind !== "voicePresence") throw new Error("Missing presence");
  deepEqual(
    [record.joinedAt, record.leftAt],
    [new Date(0).toISOString(), new Date(time).toISOString()],
  );
});
test("other voice channels are ignored", async () => {
  const { records, data } = fixture();
  const handle = createVoicePresenceHandler(data, "guild");
  await handle(state(null), state("Social"));
  await handle(state("Raid", "Other"), state(null));
  equal(records.size, 0);
});
test("queued joins snapshot mutable voice state", async () => {
  const { records, data } = fixture();
  const handle = createVoicePresenceHandler(data, "guild");
  const mutable = state("Raid");
  const join = handle(state(null), mutable);
  const leave = handle(state("Raid"), state(null));
  Object.assign(mutable, {
    channelId: null,
    id: "changed",
    guild: { id: "changed" },
  });
  await Promise.all([join, leave]);
  const record = [...records.values()][0];
  equal(record.kind === "voicePresence" && record.memberId, "member");
  equal(record.kind === "voicePresence" && Boolean(record.leftAt), true);
});
test("ready closes pre-restart intervals as unknown and opens current occupants", async () => {
  const { records, data } = fixture();
  const first = createVoicePresenceHandler(data, "guild", () => 0);
  await first(state(null), state("Raid"));
  const restarted = createVoicePresenceHandler(data, "guild", () => 60000);
  await restarted.ready([state("Raid")]);
  const intervals = [...records.values()].filter(
    (record) => record.kind === "voicePresence",
  );
  equal(intervals.length, 2);
  equal(intervals[0].endUnknown, true);
  equal(intervals[0].leftAt, new Date(60000).toISOString());
  equal(intervals[1].joinedAt, new Date(60000).toISOString());
  equal(intervals[1].leftAt, undefined);
});
test("events from other guilds are ignored", async () => {
  const { records, data } = fixture();
  await createVoicePresenceHandler(data, "other")(state(null), state("Raid"));
  equal(records.size, 0);
});
