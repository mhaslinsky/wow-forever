import assert from "node:assert/strict";
import test from "node:test";
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
      if (command instanceof GetCommand) return { Item: stored };
      if (command instanceof PutCommand) {
        const expected =
          command.input.ExpressionAttributeValues?.[":changedAt"];
        if (
          command.input.ConditionExpression?.includes("recruiting.changedAt") &&
          stored.recruiting?.changedAt !== expected
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
      tagsFor: async () => [],
      setTags: async () => {},
    },
    () => {},
    async () => {
      stored = redacted;
    },
  );
  await assert.rejects(
    core.setStage("Declined", "Accepted", "officer", "event"),
    /CANDIDATE_WRITE_CONFLICT:Declined/,
  );
  assert.deepEqual(stored, redacted);
});
