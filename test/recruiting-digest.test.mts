import assert from "node:assert/strict";
import test from "node:test";
import {
  createPrincipalFactory,
  createSystemPrincipal,
} from "../src/auth/index.mts";
import { createDataAccess } from "../src/data/index.mts";
import type { GuildRecord } from "../src/data/records.mts";
import { SOURCES, STAGES } from "../src/data/recruiting.mts";
import { createRecruiting } from "../src/recruiting/core.mts";
import { createOverdueDigest } from "../src/recruiting/digest.mts";
import { createFollowUpRoutes } from "../src/recruiting/followup.mts";

function fixture() {
  const items = new Map<string, GuildRecord>();
  const data = createDataAccess({
    get: async (key) => items.get(key.sk),
    query: async () => ({ items: [...items.values()] }),
    batch: async () => [],
    put: async (item) => {
      items.set(item.sk, item);
    },
  });
  const principal = createSystemPrincipal(["candidate", "officerNote"]);
  const actor = createPrincipalFactory({
    guildId: "guild",
    memberRoleId: "member",
    officerRoleId: "officer",
    jobs: {},
  }).fromVerifiedInteraction({
    guild_id: "guild",
    member: { user: { id: "officer" }, roles: ["officer"] },
  });
  let sequence = 0;
  const core = createRecruiting(data, principal, "guild", {
    tags: async () =>
      [...STAGES, ...SOURCES].map((name) => ({ id: name, name })),
    create: async () => `thread-${++sequence}`,
    post: async () => {},
    tagsFor: async () => [],
    setTags: async () => {},
  });
  let now = Date.parse("2030-01-02T15:00:00Z");
  const messages: string[] = [];
  const digest = createOverdueDigest({
    data: data.forSystem(principal),
    guildId: "guild",
    now: () => now,
    post: async (text) => {
      messages.push(text);
    },
  });
  const candidate = (nextActionAt?: string, owner?: string) =>
    core.create({
      name: `Synthetic-${items.size}`,
      source: "Apply form",
      actorId: "applicant",
      nextActionAt,
      owner,
    });
  return {
    core,
    actor,
    candidate,
    items,
    messages,
    digest,
    now: () => now,
    step: () => {
      now += 86_400_000;
    },
  };
}

test("digest lists only overdue candidates", async () => {
  const setup = fixture();
  const overdue = await setup.candidate("2030-01-01T15:00:00Z");
  await setup.candidate("2030-01-03T15:00:00Z", "officer");
  const legacy = await setup.candidate();
  assert.ok(legacy.recruiting);
  delete legacy.recruiting.nextActionAt;
  setup.items.set(legacy.sk, legacy);
  const routes = createFollowUpRoutes(
    async () => ({ core: setup.core, actor: setup.actor }),
    setup.now,
  );
  await routes[0].handler(
    {
      id: "command",
      application_id: "app",
      token: "synthetic",
      type: 2,
      data: {
        options: [
          { name: "candidate", value: overdue.recruiting?.threadId },
          { name: "owner", value: "officer" },
        ],
      },
    },
    new AbortController().signal,
  );
  assert.equal(
    (await setup.core.candidate("thread-1"))?.recruiting?.owner,
    "officer",
  );
  assert.deepEqual(await setup.digest(), { overdue: 1 });
  assert.match(setup.messages[0], /thread-1.*<@officer>/);
  assert.doesNotMatch(setup.messages[0], /thread-2|thread-3/);
});

test("empty digest posts one line saying nothing is overdue", async () => {
  const setup = fixture();
  assert.deepEqual(await setup.digest(), { overdue: 0 });
  assert.deepEqual(setup.messages, ["Nothing's overdue today."]);
});

test("digest uses a stepped clock", async () => {
  const setup = fixture();
  await setup.candidate("2030-01-02T15:00:00Z");
  assert.deepEqual(await setup.digest(), { overdue: 0 });
  setup.step();
  assert.deepEqual(await setup.digest(), { overdue: 1 });
  assert.match(setup.messages[1], /thread-1.*no owner/);
});

test("digest excludes closed candidates", async () => {
  const setup = fixture();
  for (const stage of ["Accepted", "Declined", "Withdrawn"] as const) {
    const record = await setup.candidate("2030-01-01T15:00:00Z");
    assert.ok(record.recruiting);
    record.recruiting.stage = stage;
    setup.items.set(record.sk, record);
  }
  assert.deepEqual(await setup.digest(), { overdue: 0 });
});

test("alerts refuses access through other roles and member overwrites", async () => {
  const { discordAlerts } = await import("../src/recruiting/alerts.mts");
  for (const type of [0, 1]) {
    let posts = 0;
    const post = discordAlerts(
      {
        get: async (path) => {
          if (path.endsWith("/roles"))
            return [
              { id: "guild", name: "@everyone", permissions: "0" },
              { id: "member", name: "Member", permissions: "0" },
              { id: "other", name: "Guest", permissions: "0" },
            ];
          if (path === "/users/@me") return { id: "bot" };
          if (path.includes("/members/")) return { roles: ["other"] };
          return [
            {
              id: "alerts",
              name: "alerts",
              type: 0,
              permission_overwrites: [
                { id: "guild", type: 0, deny: "1024", allow: "0" },
                { id: "other", type, deny: "0", allow: "1024" },
              ],
            },
          ];
        },
        post: async () => {
          posts++;
        },
      },
      "guild",
    );
    await assert.rejects(post("private"), /ALERTS_CHANNEL_PUBLIC/);
    assert.equal(posts, 0);
  }
});
