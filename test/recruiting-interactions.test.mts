import assert from "node:assert/strict";
import test from "node:test";
import {
  createPrincipalFactory,
  createSystemPrincipal,
} from "../src/auth/index.mts";
import { createDataAccess } from "../src/data/index.mts";
import type { GuildRecord } from "../src/data/records.mts";
import { SOURCES, STAGES } from "../src/data/recruiting.mts";
import {
  findRoute,
  type Interaction,
  message,
} from "../src/interactions/core.mts";
import { createRecruiting } from "../src/recruiting/core.mts";
import { createRecruitingRoutes } from "../src/recruiting/interactions.mts";

function fixture(role = "visitor") {
  const items: GuildRecord[] = [];
  const tags = [...STAGES, ...SOURCES].map((name) => ({ id: name, name }));
  let applied: string[] = [];
  const core = createRecruiting(
    createDataAccess({
      get: async (key) =>
        items.find((item) => item.pk === key.pk && item.sk === key.sk),
      query: async () => ({ items }),
      batch: async () => [],
      put: async (item) => {
        items.unshift(item);
      },
    }),
    createSystemPrincipal(["candidate", "officerNote"]),
    "guild",
    {
      tags: async () => tags,
      tagsFor: async () => applied,
      create: async (input) => {
        applied = input.tags;
        return "thread";
      },
      setTags: async (_thread, next) => {
        applied = next;
      },
    },
  );
  const actor = createPrincipalFactory({
    guildId: "guild",
    memberRoleId: "member",
    officerRoleId: "officer",
    officerRoleIds: ["gm"],
    jobs: {},
  }).fromVerifiedInteraction({
    guild_id: "guild",
    member: { user: { id: "person" }, roles: [role] },
  });
  const interaction: Interaction = {
    id: "interaction",
    application_id: "app",
    token: "synthetic",
    guild_id: "guild",
    type: 2,
    member: { user: { id: "person" }, roles: [role] },
  };
  const routes = createRecruitingRoutes(
    async () => ({ core, actor }),
    () => "guild",
  );
  const run = (input: Interaction) => {
    const route = findRoute(routes, input);
    assert.ok(route);
    return route.handler(input, new AbortController().signal);
  };
  return { items, interaction, run, applied: () => applied };
}
const lead = {
  name: "lead",
  options: [
    { type: 3, name: "name", value: "Synthetic" },
    { type: 3, name: "class", value: "Mage" },
    { type: 3, name: "source", value: "Group finder" },
  ],
};
const details = {
  name: "Synthetic",
  class: "Mage",
  spec: "Frost",
  raidRole: "Damage",
};
test("/apply submission creates an Applied candidate", async () => {
  const setup = fixture();
  const result = await setup.run({
    ...setup.interaction,
    type: 5,
    data: {
      custom_id: "apply",
      components: Object.entries(details).map(([custom_id, value]) => ({
        type: 1,
        components: [{ type: 4, custom_id, value }],
      })),
    },
  });
  assert.deepEqual(result, message("Application sent"));
  const candidate = setup.items.find((item) => item.kind === "candidate");
  assert.ok(candidate?.kind === "candidate");
  assert.equal(candidate.recruiting?.stage, "Applied");
  assert.equal(candidate.discordUserId, "person");
  assert.deepEqual(candidate.characters, [{ ...details, main: true }]);
  assert.deepEqual(setup.applied(), ["Apply form", "Applied"]);
});
test("/lead creates a New candidate owned by the officer", async () => {
  for (const role of ["officer", "gm"]) {
    const setup = fixture(role);
    assert.deepEqual(
      await setup.run({ ...setup.interaction, data: lead }),
      message("Lead added"),
    );
    const candidate = setup.items.find((item) => item.kind === "candidate");
    assert.ok(candidate?.kind === "candidate");
    assert.equal(candidate.recruiting?.owner, "person");
    assert.equal(candidate.recruiting?.stage, "New");
    assert.deepEqual(setup.applied(), ["New", "Officer lead"]);
  }
});
test("/lead from a non-officer is refused", async () => {
  const setup = fixture("member");
  assert.deepEqual(
    await setup.run({ ...setup.interaction, data: lead }),
    message("Officers only"),
  );
  assert.equal(setup.items.length, 0);
});
