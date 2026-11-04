import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { createSystemPrincipal } from "../src/auth/index.mts";
import { createDynamoDataAccess } from "../src/data/index.mts";
import { recordKey } from "../src/data/records.mts";
import type { Stage } from "../src/data/recruiting.mts";
import { SOURCES, STAGES } from "../src/data/recruiting.mts";
import { createRetentionStorage } from "../src/data/retention.mts";
import type { Candidate } from "../src/recruiting/core.mts";
import { createRecruiting } from "../src/recruiting/core.mts";
import { createRetentionPurge } from "../src/recruiting/retention.mts";

function candidate(stage: Stage): Candidate {
  return {
    ...recordKey("candidate", "guild", stage),
    kind: "candidate",
    ownerId: "guild",
    name: "Synthetic",
    recruiting: {
      threadId: stage,
      stage,
      source: "Officer lead",
      changedBy: "officer",
      changedAt: "2030-01-01T00:00:00Z",
    },
  };
}

test("notes removed only after retention for Declined and Withdrawn", async (context) => {
  const candidates = [candidate("Declined"), candidate("Withdrawn")];
  const items = new Map(candidates.map((record) => [record.sk, record]));
  const notes = new Map(
    candidates.map((record) => [
      `OFFICER_NOTE#${record.recruiting?.threadId}#submission#synthetic-hash`,
      {
        pk: "OFFICER_NOTE#guild",
        sk: `OFFICER_NOTE#${record.recruiting?.threadId}#submission#synthetic-hash`,
        text: "synthetic submission",
      },
    ]),
  );
  context.mock.method(
    DynamoDBDocumentClient.prototype,
    "send",
    async (command: unknown) => {
      if (command instanceof QueryCommand) {
        const prefix = command.input.ExpressionAttributeValues?.[":prefix"];
        return {
          Items: prefix
            ? [...notes.values()].filter((note) => note.sk.startsWith(prefix))
            : [...items.values()],
        };
      }
      if (command instanceof TransactWriteCommand) {
        for (const operation of command.input.TransactItems ?? []) {
          if (operation.Delete) notes.delete(operation.Delete.Key?.sk);
          if (operation.Put) {
            const record = operation.Put.Item as Candidate;
            items.set(record.sk, record);
          }
        }
        return {};
      }
      if (command instanceof UpdateCommand) return {};
      assert.fail("Unexpected storage command");
    },
  );
  const storage = createRetentionStorage({
    tableName: "synthetic",
    region: "us-east-1",
    guildId: "guild",
  });
  const archived: string[] = [];
  let now = Date.parse("2030-01-31T00:00:00Z");
  const purge = createRetentionPurge({
    ...storage,
    retentionDays: 30,
    now: () => now,
    archive: async (threadId) => {
      archived.push(threadId);
    },
  });
  assert.deepEqual(await purge(), { purged: 0 });
  assert.equal(notes.size, 2);
  now += 1;
  assert.deepEqual(await purge(), { purged: 2 });
  assert.equal(notes.size, 0);
  for (const record of items.values()) {
    assert.equal(record.recruiting, undefined);
    assert.deepEqual(record.retention, {
      outcome: record.sk.split("#")[1],
      threadId: record.sk.split("#")[1],
      archived: false,
    });
  }
  assert.deepEqual(archived, ["Declined", "Withdrawn"]);
});

test("Accepted candidates untouched", async () => {
  const accepted = candidate("Accepted");
  const untouched = async () => {
    assert.fail("Accepted candidate changed");
  };
  const purge = createRetentionPurge({
    archived: untouched,
    candidates: async () => [accepted],
    retentionDays: 30,
    now: () => Date.parse("2031-01-01T00:00:00Z"),
    archive: untouched,
    purge: untouched,
  });
  assert.deepEqual(await purge(), { purged: 0 });
});

test("in-flight acceptance cannot overwrite a retention redaction", async (context) => {
  let stored = {
    ...candidate("Declined"),
    discordUserId: "synthetic-user",
  } as Candidate;
  const redacted: Candidate = {
    pk: stored.pk,
    sk: stored.sk,
    kind: "candidate",
    ownerId: "guild",
    name: "Synthetic",
    retention: { outcome: "Declined", threadId: "Declined", archived: false },
  };
  context.mock.method(
    DynamoDBDocumentClient.prototype,
    "send",
    async (command: unknown) => {
      if (command instanceof GetCommand) {
        const snapshot = stored;
        stored = redacted;
        return { Item: snapshot };
      }
      if (command instanceof PutCommand) {
        if (
          command.input.ConditionExpression?.includes(
            "attribute_not_exists(retention)",
          ) &&
          stored.retention
        ) {
          throw Object.assign(new Error("stale candidate"), {
            name: "ConditionalCheckFailedException",
          });
        }
        stored = command.input.Item as Candidate;
        return {};
      }
      assert.fail("Unexpected storage command");
    },
  );
  const core = createRecruiting(
    createDynamoDataAccess({ tableName: "synthetic", region: "us-east-1" }),
    createSystemPrincipal(["candidate", "officerNote"]),
    "guild",
    {
      tags: async () =>
        [...STAGES, ...SOURCES].map((name) => ({ name, id: name })),
      create: async () => "Declined",
      post: async () => {},
      tagsFor: async () => [],
      setTags: async () => {},
    },
    () => {},
    async () => {
      assert.fail("Fenced acceptance granted membership");
    },
  );
  await assert.rejects(
    core.setStage("Declined", "Accepted", "officer", "event"),
    /CANDIDATE_WRITE_CONFLICT:Declined/,
  );
  assert.deepEqual(stored, redacted);
});

function intakeFixture(context: TestContext, reapply = false) {
  const original = candidate("Declined");
  const redacted: Candidate = {
    pk: original.pk,
    sk: original.sk,
    kind: "candidate",
    ownerId: "guild",
    name: original.name,
    retention: { outcome: "Declined", threadId: "Declined", archived: true },
  };
  let stored = reapply ? redacted : original;
  const notes: unknown[] = [];
  let created = 0;
  let posted = 0;
  context.mock.method(
    DynamoDBDocumentClient.prototype,
    "send",
    async (command: unknown) => {
      if (command instanceof QueryCommand) return { Items: [stored] };
      if (command instanceof GetCommand) return {};
      if (command instanceof PutCommand) {
        if (command.input.Item?.kind === "officerNote")
          notes.push(command.input.Item);
        else if (command.input.Item?.sk === "CANDIDATE#fresh")
          stored = command.input.Item as Candidate;
        else stored = redacted;
        return {};
      }
      if (command instanceof TransactWriteCommand) {
        const check = command.input.TransactItems?.[0]?.ConditionCheck;
        if (check && stored.retention)
          throw Object.assign(new Error("fenced"), {
            name: "TransactionCanceledException",
            CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
          });
        notes.push(command.input.TransactItems?.[1]?.Put?.Item);
        return {};
      }
      assert.fail("Unexpected storage command");
    },
  );
  const core = createRecruiting(
    createDynamoDataAccess({ tableName: "synthetic", region: "us-east-1" }),
    createSystemPrincipal(["candidate", "officerNote"]),
    "guild",
    {
      tags: async () =>
        [...STAGES, ...SOURCES].map((name) => ({ name, id: name })),
      create: async () => {
        created++;
        return "fresh";
      },
      post: async () => {
        posted++;
      },
      tagsFor: async () => [],
      setTags: async () => {},
    },
    () => {},
  );
  return {
    core,
    notes,
    created: () => created,
    posted: () => posted,
    redacted,
  };
}

test("repeat-intake note racing a purge is rejected and leaves no note", async (context) => {
  const setup = intakeFixture(context);
  await assert.rejects(
    setup.core.create({
      name: "Synthetic",
      source: "Officer lead",
      actorId: "officer",
    }),
    /CANDIDATE_WRITE_CONFLICT:Declined/,
  );
  assert.deepEqual(setup.notes, []);
  assert.equal(setup.posted(), 0);
});

test("reapplying after a purge creates a fresh candidate and thread", async (context) => {
  const setup = intakeFixture(context, true);
  const record = await setup.core.create({
    name: "Synthetic",
    source: "Officer lead",
    actorId: "officer",
  });
  assert.equal(record.recruiting?.threadId, "fresh");
  assert.equal(setup.created(), 1);
  assert.equal(setup.redacted.retention?.outcome, "Declined");
});

test("Applied then Trial both succeed and both audit notes exist", async (context) => {
  context.mock.timers.enable({
    apis: ["Date"],
    now: Date.parse("2030-02-01T00:00:00Z"),
  });
  let stored = candidate("New");
  const notes: string[] = [];
  let core: ReturnType<typeof createRecruiting>;
  context.mock.method(
    DynamoDBDocumentClient.prototype,
    "send",
    async (command: unknown) => {
      if (command instanceof GetCommand) return { Item: stored };
      if (command instanceof PutCommand) {
        stored = command.input.Item as Candidate;
        return {};
      }
      if (command instanceof TransactWriteCommand) {
        const operations = command.input.TransactItems;
        const note = operations?.[1]?.Put?.Item;
        const stage = JSON.parse(note?.text).to as string;
        if (stage === "Applied") {
          context.mock.timers.tick(1);
          await core.setStage("New", "Trial", "officer", "trial");
        }
        const check = operations?.[0]?.ConditionCheck;
        if (
          stored.retention ||
          (check?.ConditionExpression?.includes("recruiting.changedAt") &&
            stored.recruiting?.changedAt !==
              check.ExpressionAttributeValues?.[":changedAt"])
        )
          throw Object.assign(new Error("condition failed"), {
            name: "TransactionCanceledException",
            CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
          });
        notes.push(stage);
        return {};
      }
      assert.fail("Unexpected storage command");
    },
  );
  core = createRecruiting(
    createDynamoDataAccess({ tableName: "synthetic", region: "us-east-1" }),
    createSystemPrincipal(["candidate", "officerNote"]),
    "guild",
    {
      tags: async () =>
        [...STAGES, ...SOURCES].map((name) => ({ name, id: name })),
      create: async () => "New",
      post: async () => {},
      tagsFor: async () => [],
      setTags: async () => {},
    },
    () => {},
  );
  await core.setStage("New", "Applied", "applicant", "applied");
  assert.equal(stored.recruiting?.stage, "Trial");
  assert.deepEqual(notes.sort(), ["Applied", "Trial"]);
});
