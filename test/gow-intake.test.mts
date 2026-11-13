import assert from "node:assert/strict";
import test from "node:test";
import { DynamoDBDocumentClient, type PutCommand } from "@aws-sdk/lib-dynamodb";
import type { ForumChannel } from "discord.js";
import { createSystemPrincipal } from "../src/auth/index.mts";
import {
  applicationRecord,
  createGowStore,
} from "../src/data/gow-applications.mts";
import { createDataAccess } from "../src/data/index.mts";
import { type GuildRecord, recordKey } from "../src/data/records.mts";
import { captureApplications } from "../src/gow-intake/core.mts";
import { mapApplications } from "../src/gow-intake/mapping.mts";
import { syncStatuses } from "../src/gow-intake/status.mts";
import { createRecruiting } from "../src/recruiting/core.mts";
import { discordForum } from "../src/recruiting/discord.mts";

test("unseen recruit is stored once across polls and alerts without its payload", async (context) => {
  const records = new Map<string, unknown>();
  let writes = 0;
  context.mock.method(
    DynamoDBDocumentClient.prototype,
    "send",
    async (command: PutCommand) => {
      const input = command.input;
      assert.ok(input.Item);
      assert.equal(input.ConditionExpression, "attribute_not_exists(pk)");
      if (records.has(input.Item.sk)) {
        const error = new Error("already stored");
        error.name = "ConditionalCheckFailedException";
        throw error;
      }
      records.set(input.Item.sk, input.Item);
      writes++;
      return {};
    },
  );
  const recruit = {
    id: "synthetic-application",
    unknownField: "synthetic payload",
  };
  const logs: string[] = [];
  context.mock.method(console, "log", (line: string) => logs.push(line));
  const input = {
    guildId: "synthetic-guild",
    apiKey: "synthetic-key",
    save: createGowStore(
      "synthetic-table",
      createSystemPrincipal(["gowApplication"]),
    ),
    fetch: async (_url: unknown, init?: RequestInit) => {
      assert.deepEqual(init?.headers, {
        Authorization: "Bearer synthetic-key",
      });
      return Response.json({ success: true, data: { recruits: [recruit] } });
    },
  };
  assert.deepEqual(await captureApplications(input), { captured: 1 });
  assert.deepEqual(await captureApplications(input), { captured: 0 });
  assert.equal(writes, 1);
  const record = applicationRecord(input.guildId, recruit);
  assert.deepEqual(records.get(record.sk), record);
  assert.deepEqual(JSON.parse(record.payload), recruit);
  assert.equal(logs.length, 1);
  const event = JSON.parse(logs[0]);
  assert.equal(event.event, "GOW_APPLICATION_CAPTURED");
  assert.equal(event.RecruitingError, 1);
  assert.equal(event.recordKey, record.sk);
  assert.ok(!logs[0].includes("synthetic payload"));
  assert.equal(
    applicationRecord(input.guildId, { nested: { second: 2, first: 1 } }).sk,
    applicationRecord(input.guildId, { nested: { first: 1, second: 2 } }).sk,
  );
});

test("empty recruit list stores nothing", async () => {
  assert.deepEqual(
    await captureApplications({
      guildId: "synthetic-guild",
      apiKey: "synthetic-key",
      fetch: async () =>
        Response.json({ success: true, data: { recruits: [] } }),
      save: async () => {
        assert.fail("empty list must not write");
      },
      report: () => {
        assert.fail("empty list must not alert");
      },
    }),
    { captured: 0 },
  );
});

function mappingFixture() {
  const items = new Map<string, GuildRecord>();
  const hooks = {
    afterGet: () => {},
    setTags: async (_tags: string[]) => {},
    accepted: 0,
  };
  const data = createDataAccess({
    get: async (key) => {
      const item = items.get(`${key.pk}/${key.sk}`);
      hooks.afterGet();
      return item;
    },
    query: async (partition) => ({
      items: [...items.values()].filter((item) => item.pk === partition),
    }),
    batch: async () => [],
    put: async (item, condition) => {
      const stored = items.get(`${item.pk}/${item.sk}`);
      const previous = condition?.candidatePrevious;
      if (
        previous &&
        stored?.kind === "candidate" &&
        JSON.stringify(stored.recruiting) !==
          JSON.stringify(previous.recruiting)
      )
        throw Object.assign(new Error("condition failed"), {
          name: "ConditionalCheckFailedException",
        });
      items.set(`${item.pk}/${item.sk}`, item);
    },
  });
  const records = data.forSystem(
    createSystemPrincipal([
      "gowApplication",
      "candidate",
      "officerNote",
      "recruitingIntake",
    ]),
  );
  const threads: { name: string; content: string; tags: string[] }[] = [];
  const core = createRecruiting(
    data,
    createSystemPrincipal(["candidate", "officerNote", "recruitingIntake"]),
    "synthetic-guild",
    {
      tags: async () => [
        { id: "new", name: "New" },
        { id: "declined", name: "Declined" },
        { id: "accepted", name: "Accepted" },
        { id: "gow", name: "Guilds of WoW" },
      ],
      create: discordForum({
        threads: {
          create: async (posted: {
            name: string;
            message: { content: string };
            appliedTags: string[];
          }) => {
            threads.push({
              name: posted.name,
              content: posted.message.content,
              tags: posted.appliedTags,
            });
            return {
              id:
                threads.length === 1
                  ? "synthetic-thread"
                  : `thread-${threads.length}`,
            };
          },
        },
      } as unknown as ForumChannel).create,
      post: async () => {
        assert.fail("already mapped application must not post again");
      },
      tagsFor: async () => [],
      setTags: async (_threadId: string, tags: string[]) => hooks.setTags(tags),
    },
    undefined,
    async () => {
      hooks.accepted++;
    },
  );
  return { items, records, threads, core, hooks };
}

const capturedPayload = {
  character: {
    name: "SyntheticApplicant",
    classId: 1,
    className: "Warrior",
    realm: {
      refId: 1,
      name: "SyntheticRealm",
      slug: "synthetic-realm",
      category: "Normal",
      regionId: 1,
      regionName: "SyntheticRegion",
      regionIsoName: "XX",
      regionCode: "xx",
      timeZone: "UTC",
    },
    displayName: "SyntheticApplicant",
    thumbnail: "https://example.com/avatar",
    armoryLink: "https://example.com/character",
  },
  characterInviteTag: "SyntheticApplicant-SyntheticRealm",
  selectedRoles: [1],
  selectedRolesText: "Tank",
  id: 101,
  appliedTo: "SyntheticGuild",
  message: "Synthetic application text",
  statusText: "New",
  isActive: true,
  createDate: "2026-01-01T00:00:00Z",
  modifyDate: "2026-01-01T00:00:00Z",
  likes: 0,
  dislikes: 0,
  priority: 0,
  isBanned: false,
};

test("captured real-shaped application maps once to a Guilds of WoW candidate", async () => {
  const setup = mappingFixture();
  const record = applicationRecord("synthetic-guild", capturedPayload);
  await setup.records.write(record);
  for (const payload of [
    { ...capturedPayload, id: 102, isActive: false },
    { ...capturedPayload, id: 103, isBanned: true },
  ]) {
    await setup.records.write(applicationRecord("synthetic-guild", payload));
  }
  const input = {
    guildId: "synthetic-guild",
    records: setup.records,
    create: setup.core.create,
  };
  assert.deepEqual(await mapApplications(input), { mapped: 1 });
  assert.deepEqual(await mapApplications(input), { mapped: 0 });
  assert.deepEqual(setup.threads, [
    {
      name: "SyntheticApplicant",
      content:
        "Class: Warrior\nRole: Tank\n\nSynthetic application text\n-# ref 1523e46235416cfbb726a4caea5cb5af46653972e292f502539bef254433a67e",
      tags: ["new", "gow"],
    },
  ]);
  const [candidate] = await setup.records.query(
    recordKey("candidate", "synthetic-guild", "unused").pk,
  );
  assert.equal(
    candidate.kind === "candidate" && candidate.recruiting?.source,
    "Guilds of WoW",
  );
  const [stored] = await setup.records.get(record);
  assert.equal(
    stored.kind === "gowApplication" && stored.mappedThreadId,
    "synthetic-thread",
  );
  assert.equal(
    stored.kind === "gowApplication" && stored.payload,
    record.payload,
  );
  await setup.records.write(record);
  assert.deepEqual(await mapApplications(input), { mapped: 1 });
  assert.equal(setup.threads.length, 1);
});

test("missing character name retains raw JSON and raises the parse-failure alarm", async (context) => {
  const setup = mappingFixture();
  const record = applicationRecord("synthetic-guild", {
    ...capturedPayload,
    character: { className: "Warrior" },
  });
  await setup.records.write(record);
  const logs: string[] = [];
  context.mock.method(console, "error", (line: string) => logs.push(line));
  assert.deepEqual(
    await mapApplications({
      guildId: "synthetic-guild",
      records: setup.records,
      create: setup.core.create,
    }),
    { mapped: 0 },
  );
  assert.deepEqual(await setup.records.get(record), [record]);
  assert.equal(setup.threads.length, 0);
  assert.equal(logs.length, 1);
  assert.equal(JSON.parse(logs[0]).RecruitingError, 1);
  assert.equal(JSON.parse(logs[0]).code, "GOW_APPLICATION_PARSE_FAILED");
  assert.ok(!logs[0].includes("Warrior"));
});

test("long application maps with bounded Discord text and full stored content", async () => {
  const setup = mappingFixture();
  const payload = {
    ...capturedPayload,
    character: { ...capturedPayload.character, name: "N".repeat(101) },
    message: "M".repeat(2001),
  };
  const record = applicationRecord("synthetic-guild", payload);
  await setup.records.write(record);
  await mapApplications({
    guildId: "synthetic-guild",
    records: setup.records,
    create: setup.core.create,
  });
  assert.equal(setup.threads[0].name, `${"N".repeat(97)}...`);
  assert.equal(setup.threads[0].content.length, 2000);
  assert.match(setup.threads[0].content, /\.\.\.\n-# ref [a-f0-9]{64}$/);
  assert.ok(
    [...setup.items.values()].some(
      (item) =>
        item.kind === "officerNote" &&
        JSON.parse(item.text).content.endsWith(payload.message),
    ),
  );
  assert.deepEqual(JSON.parse(record.payload), payload);
});

test("failed creation alarms once and leaves the next record mapped", async (context) => {
  const setup = mappingFixture();
  const failed = applicationRecord("synthetic-guild", capturedPayload);
  await setup.records.write(failed);
  await setup.records.write(
    applicationRecord("synthetic-guild", { ...capturedPayload, id: 102 }),
  );
  const logs: string[] = [];
  context.mock.method(console, "error", (line: string) => logs.push(line));
  let attempts = 0;
  await assert.rejects(
    mapApplications({
      guildId: "synthetic-guild",
      records: setup.records,
      create: async (input) => {
        if (++attempts === 1) throw new Error("private failure");
        return setup.core.create(input);
      },
    }),
    /GOW_APPLICATION_MAPPING_FAILED/,
  );
  assert.equal(setup.threads.length, 1);
  assert.equal(logs.length, 1);
  assert.equal(JSON.parse(logs[0]).recordKey, failed.sk);
  assert.equal(JSON.parse(logs[0]).RecruitingError, 1);
  assert.ok(!logs[0].includes("private failure"));
});

async function mapStatuses(statuses: string[]) {
  const setup = mappingFixture();
  const recruits = statuses.map((statusText, id) => ({
    ...capturedPayload,
    id,
    character: { ...capturedPayload.character, name: `Applicant${id}` },
    statusText,
  }));
  for (const recruit of recruits)
    await setup.records.write(
      applicationRecord("synthetic-guild", { ...recruit, statusText: "New" }),
    );
  const input = { guildId: "synthetic-guild", records: setup.records };
  await mapApplications({ ...input, create: setup.core.create });
  const notices: string[] = [];
  const sync = { ...input, recruits, recruiting: setup.core };
  const run = () =>
    syncStatuses({ ...sync, notify: async (text) => void notices.push(text) });
  const stage = async (threadId: string) =>
    (await setup.core.candidate(threadId))?.recruiting;
  return { setup, run, notices, stage };
}

test("Guilds of WoW decisions move open candidates once and alert once on statuses they cannot apply", async (context) => {
  context.mock.method(console, "error", () => {});
  const { setup, run, notices, stage } = await mapStatuses([
    "Rejected",
    "Invited",
    " ",
    "Accepted",
    "Hold\n`x`",
    "Accepted",
  ]);
  await setup.core.setStage("thread-4", "Declined", "officer", "manual");
  assert.deepEqual(await run(), { synced: 2 });
  assert.deepEqual(await run(), { synced: 0 });
  assert.equal((await stage("synthetic-thread"))?.stage, "Declined");
  assert.equal((await stage("thread-4"))?.changedBy, "officer");
  assert.equal((await stage("thread-6"))?.stage, "Accepted");
  assert.equal(setup.hooks.accepted, 1);
  assert.deepEqual(notices, [
    "Guilds of WoW status `Invited` on <#thread-2> isn't one I handle.",
    "Guilds of WoW sent no status for <#thread-3>.",
    "Guilds of WoW status `Hold x` on <#thread-5> isn't one I handle.",
  ]);
});

test("a decision is not applied over an officer change made after it was read", async (context) => {
  context.mock.method(console, "error", () => {});
  const { setup, run, stage } = await mapStatuses(["Accepted"]);
  const officer = setup.core.setStage.bind(setup.core);
  let raced = false;
  setup.hooks.afterGet = () => {
    if (raced) return;
    raced = true;
    void officer("synthetic-thread", "Declined", "officer", "manual");
  };
  assert.deepEqual(await run(), { synced: 0 });
  assert.equal((await stage("synthetic-thread"))?.changedBy, "officer");
  assert.equal((await stage("synthetic-thread"))?.stage, "Declined");
  assert.equal(setup.hooks.accepted, 0);
});

test("a decision whose tag update failed is finished on the next run", async (context) => {
  context.mock.method(console, "error", () => {});
  const { setup, run } = await mapStatuses(["Rejected"]);
  const written: string[][] = [];
  setup.hooks.setTags = async (tags) => {
    written.push(tags);
    if (written.length === 1) throw new Error("synthetic Discord failure");
  };
  await assert.rejects(run(), /GOW_STATUS_SYNC_FAILED/);
  assert.deepEqual(await run(), { synced: 0 });
  assert.deepEqual(await run(), { synced: 0 });
  assert.deepEqual(written, [
    ["gow", "declined"],
    ["gow", "declined"],
  ]);
});
