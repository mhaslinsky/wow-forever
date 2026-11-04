import assert from "node:assert/strict";
import test from "node:test";
import { createPrincipalFactory } from "../src/auth/index.mts";
import { createDataAccess } from "../src/data/index.mts";
import { type GuildRecord, recordKey } from "../src/data/records.mts";
import { createWishlist } from "../src/wishlist/core.mts";
import { createWishlistRoutes } from "../src/wishlist/interactions.mts";

function fixture() {
  const startTime = Date.parse("2026-11-05T00:00:00Z") / 1000;
  let time = (startTime - 7200) * 1000;
  const records: GuildRecord[] = [
    {
      ...recordKey("signup", "guild", "raid"),
      kind: "signup",
      ownerId: "guild",
      raidId: "raid",
      startTime: String(startTime),
      signUps: "[]",
      polledAt: new Date(time).toISOString(),
    },
  ];
  const data = createDataAccess({
    get: async () => undefined,
    query: async (partition) => ({
      items: records.filter((record) => record.pk === partition),
    }),
    batch: async () => [],
    put: async (record) => {
      records.push(record);
    },
  });
  const actor = createPrincipalFactory({
    guildId: "guild",
    memberRoleId: "member",
    officerRoleId: "officer",
    jobs: {},
  }).fromVerifiedInteraction({
    guild_id: "guild",
    member: { user: { id: "user" }, roles: ["member"] },
  });
  const core = createWishlist(data, {
    guildId: "guild",
    lockMinutes: 60,
    now: () => time,
  });
  const [route] = createWishlistRoutes(async () => ({ actor, core }));
  const save = (value: string) =>
    route.handler(
      {
        id: "interaction",
        application_id: "application",
        token: "synthetic",
        type: 2,
        data: { name: "wishlist", options: [{ name: "items", value }] },
      },
      new AbortController().signal,
    );
  return {
    records,
    core,
    actor,
    startTime,
    save,
    setTime: (value: number) => {
      time = value;
    },
  };
}

test("edits before the lock apply to the next raid", async () => {
  const setup = fixture();
  await setup.save("Example Sword; Example Ring");
  setup.setTime((setup.startTime - 3601) * 1000);
  await setup.save("Example Ring; Example Sword");
  assert.deepEqual(
    await setup.core.forRaid(setup.actor, "user", setup.startTime),
    ["Example Ring", "Example Sword"],
  );
});

test("edits after the lock do not change the current raid's list", async () => {
  const setup = fixture();
  await setup.save("Example Sword; Example Ring");
  setup.setTime((setup.startTime - 3600) * 1000);
  assert.deepEqual(await setup.save("Example Ring"), {
    type: 4,
    data: { content: "Got it, saved for the next raid", flags: 64 },
  });
  assert.deepEqual(
    await setup.core.forRaid(setup.actor, "user", setup.startTime),
    ["Example Sword", "Example Ring"],
  );
  assert.deepEqual(
    await setup.core.forRaid(setup.actor, "user", setup.startTime + 86400),
    ["Example Ring"],
  );
});

test("an unusable signup start does not block wishlist edits", async () => {
  const setup = fixture();
  Object.assign(setup.records[0], { startTime: "not-a-time" });
  await setup.save("Example Ring");
  assert.deepEqual(
    await setup.core.forRaid(setup.actor, "user", setup.startTime),
    ["Example Ring"],
  );
});
