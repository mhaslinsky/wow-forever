import assert from "node:assert/strict";
import test from "node:test";
import { DynamoDBDocumentClient, type PutCommand } from "@aws-sdk/lib-dynamodb";
import { createSystemPrincipal } from "../src/auth/index.mts";
import {
  applicationRecord,
  createGowStore,
} from "../src/data/gow-applications.mts";
import { createDataAccess } from "../src/data/index.mts";
import { type GuildRecord, recordKey } from "../src/data/records.mts";
import { captureApplications } from "../src/gow-intake/core.mts";
import { mapApplications } from "../src/gow-intake/mapping.mts";
import { createRecruiting } from "../src/recruiting/core.mts";

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
  const data = createDataAccess({
    get: async (key) => items.get(`${key.pk}/${key.sk}`),
    query: async (partition) => ({
      items: [...items.values()].filter((item) => item.pk === partition),
    }),
    batch: async () => [],
    put: async (item) => {
      items.set(`${item.pk}/${item.sk}`, item);
    },
  });
  const records = data.forSystem(
    createSystemPrincipal(["gowApplication", "candidate", "officerNote"]),
  );
  const threads: { name: string; content: string }[] = [];
  const core = createRecruiting(
    data,
    createSystemPrincipal(["candidate", "officerNote"]),
    "synthetic-guild",
    {
      tags: async () => [
        { id: "new", name: "New" },
        { id: "gow", name: "Guilds of WoW" },
      ],
      create: async (input) => {
        threads.push(input);
        return "synthetic-thread";
      },
      post: async () => {
        assert.fail("already mapped application must not post again");
      },
      tagsFor: async () => [],
      setTags: async () => {},
    },
  );
  return { items, records, threads, core };
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
      content: "Class: Warrior\nRole: Tank\n\nSynthetic application text",
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
