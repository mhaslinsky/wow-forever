import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  Client,
  Collection,
  type Guild,
  GuildAuditLogsEntry,
} from "discord.js";
import fc from "fast-check";
import { createSystemPrincipal } from "../src/auth/index.mts";
import { createDataAccess } from "../src/data/index.mts";
import type { GuildRecord } from "../src/data/records.mts";
import { SOURCES, STAGES } from "../src/data/recruiting.mts";
import type { RecruitingFailure } from "../src/recruiting/alarm.mts";
import { createRecruiting, type ForumPort } from "../src/recruiting/core.mts";
import { recruitingHandlers } from "../src/recruiting/discord.mts";

function fixture() {
  const items = new Map<string, GuildRecord>();
  const failures: RecruitingFailure[] = [];
  let failWrites = false;
  const data = createDataAccess({
    get: async (key) => items.get(`${key.pk}/${key.sk}`),
    query: async () => ({ items: [...items.values()] }),
    batch: async () => [],
    put: async (item) => {
      if (failWrites) throw new Error("storage unavailable");
      items.set(`${item.pk}/${item.sk}`, item);
    },
  });
  const tags = [...STAGES, ...SOURCES].map((name) => ({
    name,
    id: `TAG_${name.toUpperCase()}_ID`,
  }));
  let applied: string[] = [];
  let created = 0;
  const port: ForumPort = {
    tags: async () => tags,
    create: async (input) => {
      created++;
      applied = input.tags;
      return "THREAD_ID";
    },
    tagsFor: async () => applied,
    setTags: async (_threadId, next) => {
      applied = next;
    },
  };
  const principal = createSystemPrincipal(["candidate", "officerNote"]);
  const core = createRecruiting(data, principal, "guild", port, (failure) =>
    failures.push(failure),
  );
  return {
    core,
    failures,
    failWrites: () => {
      failWrites = true;
    },
    data,
    principal,
    items,
    tags,
    port,
    applied: () => applied,
    created: () => created,
  };
}

test("new candidate creates one thread with the New tag", async () => {
  const setup = fixture();
  const candidate = await setup.core.create({
    name: "Synthetic",
    source: "Officer lead",
    actorId: "officer",
  });
  assert.equal(setup.created(), 1);
  assert.deepEqual(setup.applied(), ["TAG_NEW_ID", "TAG_OFFICER LEAD_ID"]);
  assert.deepEqual(await setup.core.candidate("THREAD_ID"), candidate);
  setup.failWrites();
  await assert.rejects(
    setup.core.create({
      name: "Synthetic",
      source: "Apply form",
      actorId: "applicant",
    }),
    /CANDIDATE_SAVE_FAILED:THREAD_ID/,
  );
  assert.deepEqual(setup.failures, [
    { code: "CANDIDATE_SAVE_FAILED", threadId: "THREAD_ID" },
  ]);
});

test("officer tag change updates the stored stage with actor", async (context) => {
  const setup = fixture();
  await setup.core.create({
    name: "Synthetic",
    source: "Officer lead",
    actorId: "officer",
  });
  const roles = new Collection([
    ...["Member", "Officer", "GM"].map(
      (name) => [name, { id: name, name }] as const,
    ),
    ["everyone", { id: "everyone", name: "@everyone" }],
  ]);
  const forum = {
    id: "forum",
    name: "recruiting",
    type: 15,
    permissionsFor: () => ({ has: () => false }),
    fetch: async () => ({ availableTags: setup.tags }),
    threads: {
      fetch: async () => ({
        parentId: "forum",
        setAppliedTags: async () => {},
      }),
    },
  };
  const thread = { id: "THREAD_ID", parent: forum, isThread: () => true };
  const guild = {
    id: "guild",
    client: new Client({ intents: [] }),
    roles: { everyone: roles.get("everyone"), fetch: async () => roles },
    channels: {
      cache: new Collection([["THREAD_ID", thread]]),
      fetch: async (id?: string) =>
        id ? thread : new Collection([["forum", forum]]),
    },
    members: {
      fetch: async () => ({
        id: "ACTOR_USER_ID",
        roles: { cache: new Collection([["GM", {}]]) },
      }),
    },
  } as unknown as Guild;
  const sample = JSON.parse(
    readFileSync(
      new URL("./fixtures/recruiting-audit.json", import.meta.url),
      "utf8",
    ),
  );
  sample.id = ((BigInt(Date.now()) - 1420070400000n) << 22n).toString();
  const entry = Reflect.construct(GuildAuditLogsEntry, [
    guild,
    sample,
  ]) as GuildAuditLogsEntry;
  const handler = recruitingHandlers(
    { user: { id: "bot" } } as Client,
    setup.data,
    setup.principal,
    "guild",
  ).guildAuditLogEntryCreate;
  assert.ok(handler);
  await handler(entry, guild);
  const candidate = await setup.core.candidate("THREAD_ID");
  assert.equal(candidate?.recruiting?.stage, "Interview");
  assert.equal(candidate?.recruiting?.changedBy, "ACTOR_USER_ID");
  assert.ok(
    [...setup.items.values()].some(
      (record) =>
        record.kind === "officerNote" &&
        JSON.parse(record.text).actorId === "ACTOR_USER_ID",
    ),
  );
  setup.items.clear();
  const errorLog = context.mock.method(
    console,
    "error",
    (..._messages: unknown[]) => {},
  );
  await assert.rejects(handler(entry, guild), /CANDIDATE_NOT_FOUND:THREAD_ID/);
  const alarm = JSON.parse(errorLog.mock.calls[0].arguments[0]);
  assert.equal(alarm.threadId, "THREAD_ID");
  assert.equal(alarm.RecruitingError, 1);
  assert.deepEqual(alarm._aws.CloudWatchMetrics[0].Dimensions, [[]]);
  errorLog.mock.restore();
});

test("bot stage change updates the tag", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.constantFrom(...STAGES), { minLength: 1, maxLength: 12 }),
      async (stages) => {
        const setup = fixture();
        await setup.core.create({
          name: "Synthetic",
          source: "Apply form",
          actorId: "applicant",
        });
        for (const [index, stage] of stages.entries()) {
          await setup.core.setStage(
            "THREAD_ID",
            stage,
            "bot",
            `event-${index}`,
          );
          assert.equal(
            (await setup.core.candidate("THREAD_ID"))?.recruiting?.stage,
            stage,
          );
          assert.deepEqual(setup.applied(), [
            "TAG_APPLY FORM_ID",
            `TAG_${stage.toUpperCase()}_ID`,
          ]);
        }
        assert.equal(setup.created(), 1);
      },
    ),
    { numRuns: 20 },
  );
});
