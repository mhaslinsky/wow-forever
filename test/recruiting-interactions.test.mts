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
  let content = "";
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
    createSystemPrincipal(["candidate", "officerNote", "recruitingIntake"]),
    "guild",
    {
      tags: async () => tags,
      post: async () => {},
      tagsFor: async () => applied,
      create: async (input) => {
        applied = input.tags;
        content = input.content;
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
  return {
    core,
    items,
    interaction,
    run,
    applied: () => applied,
    content: () => content,
  };
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
test("the officer thread post includes every answer", async () => {
  const setup = fixture();
  const result = await setup.run({
    ...setup.interaction,
    type: 5,
    data: {
      custom_id: "apply:Mage:Frost:Damage:0:04",
      components: Object.entries({
        name: details.name,
        raidHistory: "Cleared synthetic raids; left for a new schedule",
        logsUrl: "https://example.com/logs",
        about: "Friends here",
      }).map(([custom_id, value]) => ({
        type: 1,
        components: [{ type: 4, custom_id, value }],
      })),
    },
  });
  assert.deepEqual(result, message("Got it! An officer will reach out soon."));
  const candidate = setup.items.find((item) => item.kind === "candidate");
  assert.ok(candidate?.kind === "candidate");
  assert.equal(candidate.recruiting?.stage, "Applied");
  assert.equal(candidate.discordUserId, "person");
  assert.deepEqual(candidate.characters, [{ ...details, main: true }]);
  assert.deepEqual(setup.applied(), ["Apply form", "Applied"]);
  assert.deepEqual(candidate.application, {
    offspecs: ["Arcane"],
    nights: ["Monday", "Friday"],
    raidHistory: "Cleared synthetic raids; left for a new schedule",
    logsUrl: "https://example.com/logs",
    about: "Friends here",
  });
  assert.equal(
    setup.content(),
    "Synthetic\nClass: Mage\nSpec: Frost\nRole: DPS\nOffspecs: Arcane\nRaid nights: Monday, Friday\nRaid history: Cleared synthetic raids; left for a new schedule\nLogs or armory: https://example.com/logs\nWhy us: Friends here",
  );
});
test("/lead creates a New candidate owned by the officer", async () => {
  for (const role of ["officer", "gm"]) {
    const setup = fixture(role);
    assert.deepEqual(
      await setup.run({ ...setup.interaction, data: lead }),
      message("Lead added, the thread's up in #recruiting"),
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

test("picking a class offers only that class's specs", async () => {
  const setup = fixture();
  const reply = await setup.run({
    ...setup.interaction,
    type: 3,
    data: { custom_id: "apply:class", values: ["Hunter"] },
  });
  assert.equal(reply.type, 4);
  if (reply.type !== 4) throw new Error("Expected select");
  assert.deepEqual(JSON.parse(JSON.stringify(reply.data.components)), [
    {
      type: 1,
      components: [
        {
          type: 3,
          custom_id: "apply:spec:Hunter",
          placeholder: "What spec?",
          min_values: 1,
          max_values: 1,
          options: ["Beast Mastery", "Marksmanship", "Survival"].map(
            (label) => ({ label, value: label }),
          ),
        },
      ],
    },
  ]);
});
test("the offspec step lists only the class's other specs", async () => {
  const setup = fixture();
  const reply = await setup.run({
    ...setup.interaction,
    type: 3,
    data: { custom_id: "apply:spec:Mage", values: ["Frost"] },
  });
  assert.equal(reply.type, 4);
  if (reply.type !== 4) throw new Error("Expected select");
  const menu = JSON.parse(JSON.stringify(reply.data.components))[0]
    .components[0];
  assert.equal(menu.custom_id, "apply:offspec:Mage:Frost:Damage");
  assert.deepEqual(
    menu.options.map((option: { value: string }) => option.value),
    ["Arcane", "Fire", "No offspec"],
  );
  const nights = await setup.run({
    ...setup.interaction,
    type: 3,
    data: { custom_id: menu.custom_id, values: ["Arcane", "Fire"] },
  });
  assert.equal(nights.type, 4);
  if (nights.type !== 4) throw new Error("Expected nights");
  const nightMenu = JSON.parse(JSON.stringify(nights.data.components))[0]
    .components[0];
  const modal = await setup.run({
    ...setup.interaction,
    type: 3,
    data: { custom_id: nightMenu.custom_id, values: ["Monday", "Friday"] },
  });
  assert.equal(modal.type, 9);
  if (modal.type !== 9) throw new Error("Expected modal");
  assert.equal(modal.data.custom_id, "apply:Mage:Frost:Damage:01:04");
  assert.ok(modal.data.custom_id.length <= 100);
});
test("a submitted combination outside the table is refused", async () => {
  const setup = fixture();
  const reply = await setup.run({
    ...setup.interaction,
    type: 5,
    data: {
      custom_id: "apply:Mage:Frost:Tank",
      components: [{ components: [{ custom_id: "name", value: "Synthetic" }] }],
    },
  });
  assert.deepEqual(reply, message("That timed out, run /apply again"));
  assert.equal(setup.items.length, 0);
});

test("a submit without raid nights or raid history is refused", async () => {
  const setup = fixture();
  for (const [nights, raidHistory, error] of [
    ["-", "Raided", "Pick at least one raid night"],
    ["0", "", "Need your raid history"],
  ]) {
    const reply = await setup.run({
      ...setup.interaction,
      type: 5,
      data: {
        custom_id: `apply:Mage:Frost:Damage:-:${nights}`,
        components: [
          {
            components: [
              { custom_id: "name", value: "Synthetic" },
              { custom_id: "raidHistory", value: raidHistory },
            ],
          },
        ],
      },
    });
    assert.deepEqual(reply, message(error));
  }
  assert.equal(setup.items.length, 0);
});

test("repeat application preserves an existing Trial stage", async () => {
  const setup = fixture();
  await setup.core.create({
    name: "Synthetic",
    source: "Officer lead",
    actorId: "officer",
    discordUserId: "person",
  });
  await setup.core.setStage("thread", "Trial", "officer", "trial");
  await setup.run({
    ...setup.interaction,
    type: 5,
    data: {
      custom_id: "apply:Mage:Frost:Damage:-:0",
      components: [
        {
          components: [
            { custom_id: "name", value: "Synthetic" },
            { custom_id: "raidHistory", value: "Synthetic raids" },
          ],
        },
      ],
    },
  });
  assert.equal(
    (await setup.core.candidate("thread"))?.recruiting?.stage,
    "Trial",
  );
  assert.ok(setup.applied().includes("Trial"));
});
