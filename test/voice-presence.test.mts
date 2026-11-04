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
  await createVoicePresenceHandler(data, () => time)(
    state(null),
    state("Raid"),
  );
  time = 60000;
  await createVoicePresenceHandler(data, () => time)(
    state("Raid"),
    state(null),
  );
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
  const handle = createVoicePresenceHandler(data);
  await handle(state(null), state("Social"));
  await handle(state("Raid", "Other"), state(null));
  equal(records.size, 0);
});
