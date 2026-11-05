import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import fc from "fast-check";
import {
  createPrincipalFactory,
  createSystemPrincipal,
} from "../src/auth/index.mts";
import {
  createDataAccess,
  createDynamoDataAccess,
  type StoragePort,
} from "../src/data/index.mts";
import { recordKey } from "../src/data/records.mts";
import type {
  SnapshotHistory,
  SnapshotLatest,
} from "../src/data/snapshots.mts";
import { encode } from "../src/guildos/fixtures/encode.mts";
import type { HttpEvent } from "../src/interactions/http.mts";
import { createSnapshotHttp } from "../src/snapshot-ingest/http.mts";

const sample = JSON.parse(
  readFileSync(
    new URL("../src/guildos/fixtures/snapshot.json", import.meta.url),
    "utf8",
  ),
);
const wire = (exportedAt = 100, overrides = {}) =>
  encode({
    ...sample,
    fmt: "GOSCOMP1",
    count: sample.members.length,
    exportedAt,
    ...overrides,
  });
const request = (value = wire(), writtenAt: unknown = 99) => ({
  headers: { Authorization: "Bearer synthetic-reader-token" },
  body: JSON.stringify({ wire: value, writtenAt }),
});
const principal = createSystemPrincipal([
  "guildSnapshot",
  "guildSnapshotLatest",
]);
const conflict = (Item?: SnapshotLatest) =>
  Object.assign(new Error("conditional write"), {
    name: "ConditionalCheckFailedException",
    Item,
  });

function fixture() {
  const history = new Map<string, SnapshotHistory>();
  let latest: SnapshotLatest | undefined;
  const storage: StoragePort = {
    get: async (key) =>
      key.pk.startsWith("SNAPSHOT_LATEST#") ? latest : history.get(key.sk),
    query: async () => ({ items: [...history.values()] }),
    batch: async () => [...history.values(), ...(latest ? [latest] : [])],
    put: async () => {
      throw new Error("Generic write used");
    },
    async insertSnapshot(item) {
      if (history.has(item.sk)) throw conflict();
      history.set(item.sk, structuredClone(item));
    },
    async advanceSnapshot(item) {
      if (latest && latest.exportedAt >= item.exportedAt)
        throw conflict(latest);
      assert.ok(
        [...history.values()].some(
          (entry) => entry.snapshotId === item.snapshotId,
        ),
      );
      latest = structuredClone(item);
    },
  };
  const logs: Record<string, string | number>[] = [];
  const state = { now: 100_000, token: "synthetic-reader-token" };
  const data = createDataAccess(storage).forSystem(principal);
  const options = {
    now: () => state.now,
    guildKey: sample.guildKey,
    readToken: async () => {
      return state.token;
    },
    ingest: data.ingestSnapshot,
    report: (fields: Record<string, string | number>) => {
      logs.push(fields);
    },
  };
  const handler = createSnapshotHttp(options);
  return {
    storage,
    data,
    history,
    latest: () => latest,
    logs,
    state,
    options,
    handler,
    status: async (event: HttpEvent) => (await handler(event)).statusCode,
  };
}
const outcome = (reply: { body: string }) => JSON.parse(reply.body).outcome;

test("unauthenticated uploads fail closed and token rotation expires within five minutes", async () => {
  const env = fixture();
  assert.equal(await env.status({ body: "invalid" }), 401);
  assert.equal(
    await env.status({
      ...request(),
      headers: { authorization: "Bearer wrong" },
    }),
    401,
  );
  assert.equal(env.history.size, 0);
  assert.equal(outcome(await env.handler(request())), "stored");
  env.state.token = "rotated-synthetic-token";
  env.state.now += 299_999;
  for (const headers of [
    request().headers,
    { authorization: "bearer synthetic-reader-token" },
  ])
    assert.equal(await env.status({ ...request(), headers }), 200);
  env.state.now++;
  assert.equal(await env.status(request()), 401);
  assert.equal(
    await env.status({
      ...request(),
      headers: { authorization: `Bearer ${env.state.token}` },
    }),
    200,
  );
  env.state.now += 300_000;
  env.state.token = "";
  assert.equal(await env.status(request()), 503);
  const unreadable = createSnapshotHttp({
    ...env.options,
    readToken: async () => {
      throw new Error("private SSM error");
    },
  });
  assert.equal((await unreadable(request())).statusCode, 503);
  assert.ok(!JSON.stringify(env.logs).includes("synthetic-reader-token"));
});

test("duplicate upload changes no history or pointer and snapshots are system-only writes with Officer reads", async () => {
  const env = fixture();
  assert.equal(outcome(await env.handler(request(wire(), 0))), "stored");
  const before = structuredClone([...env.history.values(), env.latest()]);
  assert.equal(outcome(await env.handler(request())), "duplicate");
  assert.deepEqual([...env.history.values(), env.latest()], before);
  const factory = createPrincipalFactory({
    guildId: "synthetic",
    memberRoleId: "member",
    officerRoleId: "officer",
    jobs: {},
  });
  const actor = (role: string) =>
    factory.fromVerifiedInteraction({
      guild_id: "synthetic",
      member: { user: { id: "synthetic" }, roles: [role] },
    });
  const data = createDataAccess(env.storage);
  assert.equal((await data.forUser(actor("member")).batch([])).length, 0);
  assert.equal((await data.forUser(actor("officer")).batch([])).length, 2);
  for (const item of [env.latest(), ...env.history.values()]) {
    assert.ok(item);
    await assert.rejects(
      data.forUser(actor("officer")).write(item),
      /WRITE_DENIED/,
    );
    await assert.rejects(env.data.write(item), /WRITE_DENIED/);
    await assert.rejects(env.data.insert(item), /WRITE_DENIED/);
  }
  await assert.rejects(
    data.forUser(actor("officer")).ingestSnapshot([...env.history.values()][0]),
    /WRITE_DENIED/,
  );
});

test("older snapshot is ignored with its reason logged", async () => {
  const env = fixture();
  await env.handler(request(wire(100)));
  assert.equal(outcome(await env.handler(request(wire(99)))), "stale");
  assert.equal(env.latest()?.exportedAt, 100);
  assert.equal(env.logs.at(-1)?.exportedAt, 99);
  assert.equal(env.logs.at(-1)?.currentExportedAt, 100);
});

test("retry repairs latest after history commits and pointer fails", async () => {
  const env = fixture();
  const advance = env.storage.advanceSnapshot;
  env.storage.advanceSnapshot = async () => {
    throw new Error("injected unavailable");
  };
  assert.equal(await env.status(request()), 503);
  assert.equal(env.history.size, 1);
  assert.equal(env.latest(), undefined);
  env.storage.advanceSnapshot = advance;
  env.state.now++;
  assert.equal(outcome(await env.handler(request())), "stored");
  assert.equal(env.latest()?.exportedAt, 100);
  assert.equal([...env.history.values()][0].receivedAt, 100_000);
});

test("committed pointer with a lost response becomes duplicate on retry", async () => {
  const env = fixture();
  const advance = env.storage.advanceSnapshot;
  env.storage.advanceSnapshot = async (item) => {
    await advance?.(item);
    throw new Error("response lost");
  };
  assert.equal(await env.status(request()), 503);
  env.storage.advanceSnapshot = advance;
  assert.equal(outcome(await env.handler(request())), "duplicate");
  assert.equal(env.history.size, 1);
});

test("equal timestamps with different identities retain latest and report conflict", async () => {
  const env = fixture();
  await env.handler(request());
  const first = env.latest();
  const other = request(wire(100, { exportedBy: "synthetic-other" }));
  assert.equal(outcome(await env.handler(other)), "conflict");
  assert.deepEqual(env.latest(), first);
  assert.equal(env.history.size, 2);
  assert.notEqual(
    env.logs.at(-1)?.snapshotId,
    env.logs.at(-1)?.currentSnapshotId,
  );
});

test("future skew rejects beyond fifteen minutes using server time", async () => {
  const env = fixture();
  assert.equal(
    JSON.parse((await env.handler(request(wire(1001)))).body).error,
    "FutureExportError",
  );
  assert.equal(env.history.size, 0);
  env.state.now += 1000;
  assert.equal(outcome(await env.handler(request(wire(1001)))), "stored");
});

test("wrong guild, malformed exports and bounded bodies never write", async () => {
  const env = fixture();
  for (const [value, error, writtenAt = 99] of [
    [wire(100, { guildKey: "synthetic-other" }), "WrongGuildError"],
    [wire(100, { game: "ANNIVERSARY" }), "UnsupportedGameError"],
    [wire(100, { addonVersion: "" }), "InvalidPayloadShapeError"],
    ["bad", "CompanionPrefixError"],
    [wire(), "InvalidPayloadShapeError", -1],
    [wire(), "InvalidPayloadShapeError", 0.5],
    [wire(), "InvalidPayloadShapeError", Number.MAX_SAFE_INTEGER + 1],
    [wire(), "InvalidPayloadShapeError", "99"],
    [wire(), "InvalidPayloadShapeError", null],
  ] as const) {
    const reply = await env.handler(request(value, writtenAt));
    assert.equal(reply.statusCode, 422);
    assert.equal(JSON.parse(reply.body).error, error);
  }
  for (const body of [
    "",
    "{}",
    "null",
    JSON.stringify({ wire: wire(), writtenAt: 99, extra: true }),
  ])
    assert.equal(await env.status({ ...request(), body }), 422);
  const body = " ".repeat(256 * 1024 + 1);
  assert.equal(await env.status({ ...request(), body }), 413);
  assert.equal(
    await env.status({
      ...request(),
      body: Buffer.from(body).toString("base64"),
      isBase64Encoded: true,
    }),
    413,
  );
  assert.equal(
    await env.status(request(wire(100, { guildName: "x".repeat(350 * 1024) }))),
    413,
  );
  assert.equal(env.history.size, 0);
});

test("unconfigured ingest refuses after auth without parsing or writing", async () => {
  const env = fixture();
  const handler = createSnapshotHttp({ ...env.options, guildKey: undefined });
  const reply = await handler({ ...request(), body: "invalid" });
  assert.equal(reply.statusCode, 503);
  assert.equal(JSON.parse(reply.body).error, "IngestNotConfiguredError");
  assert.equal(env.history.size, 0);
});

test("interleaved uploads and retries preserve maximum time and first history receipt", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.scheduler(),
      fc.array(
        fc.record({
          time: fc.integer({ min: 1, max: 100 }),
          fail: fc.boolean(),
        }),
        { minLength: 1, maxLength: 12 },
      ),
      async (scheduler, entries) => {
        const env = fixture();
        const insert = env.storage.insertSnapshot;
        const advance = env.storage.advanceSnapshot;
        const failed = new Set<number>();
        const receipts = new Map<string, number>();
        env.storage.insertSnapshot = async (item) => {
          await scheduler.schedule(Promise.resolve(), "history");
          await insert?.(item);
          receipts.set(item.snapshotId, item.receivedAt);
        };
        env.storage.advanceSnapshot = async (item) => {
          await scheduler.schedule(Promise.resolve(), "pointer");
          if (
            entries.some(
              (entry) => entry.time === item.exportedAt && entry.fail,
            ) &&
            !failed.has(item.exportedAt)
          ) {
            failed.add(item.exportedAt);
            throw new Error("injected pointer failure");
          }
          await advance?.(item);
        };
        const uploads = entries.flatMap((entry) => [
          request(wire(entry.time)),
          request(wire(entry.time)),
        ]);
        await scheduler.waitFor(
          Promise.all(uploads.map((upload) => env.handler(upload))),
        );
        env.storage.insertSnapshot = insert;
        env.storage.advanceSnapshot = advance;
        for (const upload of uploads) {
          env.state.now++;
          assert.equal((await env.handler(upload)).statusCode, 200);
        }
        assert.equal(
          env.latest()?.exportedAt,
          Math.max(...entries.map((entry) => entry.time)),
        );
        assert.equal(
          env.history.size,
          new Set(entries.map((entry) => entry.time)).size,
        );
        for (const item of env.history.values())
          assert.equal(item.receivedAt, receipts.get(item.snapshotId));
      },
    ),
    { numRuns: 75 },
  );
});

const endpoint = process.env.DYNAMODB_LOCAL_ENDPOINT;
test(
  "DynamoDB Local handler rejects no-token and repairs a failed pointer through the real SDK",
  { skip: endpoint ? false : "DYNAMODB_LOCAL_ENDPOINT is unset" },
  async (context) => {
    const tableName = `per312-smoke-${process.pid}`;
    const client = new DynamoDBClient({
      endpoint,
      region: "us-east-1",
      credentials: { accessKeyId: "local", secretAccessKey: "local" },
    });
    await client.send(
      new CreateTableCommand({
        TableName: tableName,
        BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: [
          { AttributeName: "pk", AttributeType: "S" },
          { AttributeName: "sk", AttributeType: "S" },
        ],
        KeySchema: [
          { AttributeName: "pk", KeyType: "HASH" },
          { AttributeName: "sk", KeyType: "RANGE" },
        ],
      }),
    );
    try {
      const from = DynamoDBDocumentClient.from;
      const inject = context.mock.method(
        DynamoDBDocumentClient,
        "from",
        (...args: Parameters<typeof from>) => {
          const document = from(...args);
          let failPointer = true;
          document.middlewareStack.add(
            (next, command) => async (args) => {
              const key = (args.input as { Key?: { pk?: unknown } }).Key;
              if (
                failPointer &&
                command.commandName === "UpdateItemCommand" &&
                typeof key?.pk === "string" &&
                key.pk.startsWith("SNAPSHOT_LATEST#")
              ) {
                failPointer = false;
                throw new Error("injected pointer failure");
              }
              return next(args);
            },
            { step: "initialize", name: "failFirstLatestUpdate" },
          );
          return document;
        },
      );
      const data = createDynamoDataAccess({
        tableName,
        region: "us-east-1",
        endpoint,
        localCredentials: true,
      }).forSystem(principal);
      inject.mock.restore();
      const env = fixture();
      const handler = createSnapshotHttp({
        ...env.options,
        ingest: data.ingestSnapshot,
      });
      assert.equal((await handler({ body: "invalid" })).statusCode, 401);
      const key = recordKey("guildSnapshot", sample.guildKey, "unused");
      assert.equal((await data.query(key.pk)).length, 0);
      assert.equal((await handler(request())).statusCode, 503);
      assert.equal((await data.query(key.pk)).length, 1);
      assert.equal(outcome(await handler(request())), "stored");
      assert.equal(outcome(await handler(request())), "duplicate");
      console.log(
        "DynamoDB Local: no-token=401 history=0; pointer-failure=503 history=1; retry=stored; replay=duplicate",
      );
    } finally {
      await client.send(new DeleteTableCommand({ TableName: tableName }));
      client.destroy();
    }
  },
);
