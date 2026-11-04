import assert from "node:assert/strict";
import test from "node:test";
import {
  createPrincipalFactory,
  createSystemPrincipal,
} from "../src/auth/index.mts";
import { createDataAccess } from "../src/data/index.mts";
import { type GuildRecord, recordKey } from "../src/data/records.mts";
import { createNeeds } from "../src/needs/core.mts";
import { createNeedsRoutes } from "../src/needs/interactions.mts";
import { createRoster } from "../src/roster/core.mts";

function fixture() {
  const items = new Map<string, GuildRecord>();
  const data = createDataAccess({
    get: async (key) => items.get(`${key.pk}/${key.sk}`),
    query: async (partition, index) => ({
      items: [...items.values()].filter((item) =>
        index
          ? item.pk.startsWith(partition.replace("ALL", ""))
          : item.pk === partition,
      ),
    }),
    batch: async () => [],
    put: async (item) => {
      items.set(`${item.pk}/${item.sk}`, item);
    },
  });
  const factory = createPrincipalFactory({
    guildId: "guild",
    memberRoleId: "member",
    officerRoleId: "officer",
    jobs: {},
  });
  const actor = factory.fromVerifiedInteraction({
    guild_id: "guild",
    member: { user: { id: "user" }, roles: ["officer"] },
  });
  return { data, actor, core: createNeeds(data, "guild") };
}

test("default target is one 20-player team", async () => {
  const { core, actor } = fixture();
  const [board] = await core.boards(actor);
  assert.deepEqual(await core.boards(actor), [
    {
      name: "Team 1",
      targets: { roles: { Tank: 2, Healer: 4, Damage: 14 }, classes: {} },
      gaps: [
        { name: "Tank", count: 2 },
        { name: "Healer", count: 4 },
        { name: "Damage", count: 14 },
      ],
    },
  ]);
  assert.equal(
    Object.values(board.targets.roles).reduce(
      (total, count) => total + count,
      0,
    ),
    20,
  );
});

test("adding a healer removes that healer gap", async () => {
  const { core, actor, data } = fixture();
  await core.setTargets(actor, "Team 1", {
    roles: { Healer: 1 },
    classes: { Priest: 1 },
  });
  assert.equal((await core.boards(actor))[0].gaps.length, 2);
  await createRoster(data, "guild").register(actor, [
    {
      name: "Synthetic",
      class: "Priest",
      spec: "Holy",
      raidRole: "Healer",
      main: true,
    },
  ]);
  assert.deepEqual((await core.boards(actor))[0].gaps, []);
  await core.assign(actor, "user", "Team 1", false);
  assert.equal((await core.boards(actor))[0].gaps.length, 2);
  await core.assign(actor, "user", "Team 1", true);
  assert.deepEqual((await core.boards(actor))[0].gaps, []);
});

test("/needs message lists only current gaps", async () => {
  const { core, actor, data } = fixture();
  await core.setTargets(actor, "Team 1", {
    roles: { Healer: 1, Damage: 2 },
    classes: { Priest: 1, Mage: 1 },
  });
  await data.forSystem(createSystemPrincipal(["member"])).write({
    ...recordKey("member", "user", "guild"),
    kind: "member",
    ownerId: "user",
    name: "Synthetic",
    roster: [
      {
        name: "Synthetic",
        class: "Priest",
        spec: "Holy",
        raidRole: "Healer",
        main: true,
        confirmed: false,
      },
      {
        name: "Alt",
        class: "Mage",
        spec: "Fire",
        raidRole: "Damage",
        main: false,
        confirmed: false,
      },
    ],
  });
  const [route] = createNeedsRoutes(async () => ({ core, actor }));
  const reply = await route.handler(
    {
      id: "event",
      application_id: "app",
      token: "synthetic",
      type: 2,
      data: { name: "needs", options: [{ name: "message" }] },
    },
    new AbortController().signal,
  );
  assert.deepEqual(reply, {
    type: 4,
    data: { content: "Team 1: recruiting 2 Damage, 1 Mage.", flags: 64 },
  });
});
