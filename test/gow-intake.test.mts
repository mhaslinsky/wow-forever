import assert from "node:assert/strict";
import test from "node:test";
import { DynamoDBDocumentClient, type PutCommand } from "@aws-sdk/lib-dynamodb";
import { createSystemPrincipal } from "../src/auth/index.mts";
import {
  applicationRecord,
  createGowStore,
} from "../src/data/gow-applications.mts";
import { captureApplications } from "../src/gow-intake/core.mts";

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
