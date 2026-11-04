import assert from "node:assert/strict";
import test from "node:test";
import {
  createPrincipalFactory,
  createSystemPrincipal,
} from "../src/auth/index.mts";
import { createDataAccess } from "../src/data/index.mts";
import { type GuildRecord, recordKey } from "../src/data/records.mts";
import type { CharacterDeclaration } from "../src/data/recruiting.mts";
import { createRecruiting } from "../src/recruiting/core.mts";
import { createRoster } from "../src/roster/core.mts";
import { createRegisterRoutes } from "../src/roster/interactions.mts";

const main: CharacterDeclaration = {
  name: "Synthetic",
  class: "Priest",
  spec: "Holy",
  raidRole: "Healer",
  main: true,
};
const alt: CharacterDeclaration = { ...main, name: "Example", main: false };
function fixture() {
  const items = new Map<string, GuildRecord>();
  const data = createDataAccess({
    get: async (key) => items.get(`${key.pk}/${key.sk}`),
    query: async () => ({ items: [] }),
    batch: async () => [],
    put: async (item) => {
      items.set(`${item.pk}/${item.sk}`, item);
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
  const principal = createSystemPrincipal([
    "member",
    "candidate",
    "officerNote",
  ]);
  const roster = createRoster(data, "guild");
  const member = () =>
    [...items.values()].find((item) => item.kind === "member");
  const core = createRecruiting(
    data,
    principal,
    "guild",
    {
      tags: async () =>
        ["New", "Accepted", "Apply form"].map((name) => ({ name, id: name })),
      create: async () => "thread",
      tagsFor: async () => ["New", "Apply form"],
      setTags: async () => {},
    },
    () => {},
    (candidate) =>
      roster.accept(candidate, principal, async (userId) => {
        assert.equal(userId, "user");
      }),
  );
  return { data, actor, principal, roster, member, core };
}

test("Accepted grants Member and creates the roster entry", async () => {
  const setup = fixture();
  await setup.core.create({
    name: main.name,
    source: "Apply form",
    actorId: "officer",
    discordUserId: "user",
    characters: [main, alt],
  });
  await setup.core.setStage("thread", "Accepted", "officer", "event");
  assert.deepEqual(
    setup.member()?.roster,
    [main, alt].map((character) => ({ ...character, confirmed: false })),
  );
  assert.equal(
    (await setup.core.candidate("thread"))?.recruiting?.stage,
    "Accepted",
  );
});

test("/register creates and updates mains and alts", async () => {
  const setup = fixture();
  const [route] = createRegisterRoutes(async () => ({
    actor: setup.actor,
    core: setup.core,
  }));
  const interaction = {
    id: "event",
    application_id: "app",
    token: "synthetic",
    type: 2 as const,
    data: {
      name: "register",
      options: [
        { name: "main", value: "Synthetic, Priest, Holy, Healer" },
        { name: "alts", value: "Example, Warrior, Arms, Damage" },
      ],
    },
  };
  assert.deepEqual(
    await route.handler(interaction, new AbortController().signal),
    { type: 4, data: { content: "Roster updated", flags: 64 } },
  );
  assert.equal(setup.member()?.roster?.length, 2);
  interaction.data.options = [
    { name: "main", value: "Example, Warrior, Protection, Tank" },
  ];
  await route.handler(interaction, new AbortController().signal);
  assert.equal(setup.member()?.name, "Example");
  assert.equal(setup.member()?.roster?.length, 1);
});

test("characters seen in a snapshot retain confirmation on registration", async () => {
  const setup = fixture();
  await setup.data.forSystem(setup.principal).write({
    ...recordKey("member", "user", "guild"),
    kind: "member",
    ownerId: "user",
    name: main.name,
    roster: [{ ...main, confirmed: true }],
  });
  await setup.roster.register(setup.actor, [main, alt]);
  assert.deepEqual(
    setup.member()?.roster?.map((character) => character.confirmed),
    [true, false],
  );
});
