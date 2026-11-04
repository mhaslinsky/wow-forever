import assert from "node:assert/strict";
import test from "node:test";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { recordKey } from "../src/data/records.mts";
import type { Stage } from "../src/data/recruiting.mts";
import { createRetentionStorage } from "../src/data/retention.mts";
import type { Candidate } from "../src/recruiting/core.mts";
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
