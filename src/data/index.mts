import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  BatchGetCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import {
  authority,
  type Principal,
  type SystemResult,
  type UserResult,
} from "../auth/index.mts";
import {
  decode,
  type GuildRecord,
  type Key,
  KIND_POLICY,
  type RecordInput,
} from "./records.mts";
import { ingestSnapshot, type SnapshotWrites } from "./snapshots.mts";

declare const cursorBrand: unique symbol;
export type QueryCursor = Readonly<Record<string, string>> & {
  readonly [cursorBrand]: true;
};
type OfficerNote = Extract<GuildRecord, { kind: "officerNote" }>;
export type WriteCondition = { candidateThreadId: string };
export type StoragePort = SnapshotWrites & {
  get(key: Key): Promise<unknown>;
  query(
    partition: string,
    index: boolean,
    cursor?: QueryCursor,
  ): Promise<{ items: unknown[]; cursor?: QueryCursor }>;
  batch(keys: readonly Key[]): Promise<unknown[]>;
  put(item: GuildRecord, condition?: WriteCondition): Promise<void>;
  removeNote?(item: OfficerNote): Promise<void>;
};
type Result<Mode extends "user" | "system"> = Mode extends "user"
  ? UserResult<GuildRecord>
  : SystemResult<GuildRecord>;

function canSee(principal: Principal, item: GuildRecord): boolean {
  const actor = authority(principal);
  if (actor.mode === "system") return true;
  const required = KIND_POLICY[item.kind];
  return required === "Owner"
    ? actor.roles.includes("Member") &&
        Boolean(actor.userId) &&
        item.ownerId === actor.userId
    : actor.roles.includes(required);
}

export function createDataAccess(
  storage: StoragePort,
  invalidItem: () => void = () =>
    console.error(
      JSON.stringify({
        _aws: {
          Timestamp: Date.now(),
          CloudWatchMetrics: [
            {
              Namespace: "WowForever",
              Dimensions: [[]],
              Metrics: [{ Name: "InvalidDataItem", Unit: "Count" }],
            },
          ],
        },
        InvalidDataItem: 1,
      }),
    ),
) {
  function bind<Mode extends "user" | "system">(
    principal: Principal<Mode>,
    mode: Mode,
  ) {
    if (authority(principal).mode !== mode)
      throw new Error("INVALID_PRINCIPAL");
    function filter(items: unknown[]): Result<Mode> {
      const visible: GuildRecord[] = [];
      for (const raw of items) {
        if (raw === undefined) continue;
        const item = decode(raw);
        if (!item) {
          invalidItem();
          continue;
        }
        if (canSee(principal, item)) visible.push(Object.freeze(item));
      }
      return Object.freeze(visible) as unknown as Result<Mode>;
    }
    async function read(operation: () => Promise<unknown[]>) {
      let items: unknown[];
      try {
        items = await operation();
      } catch {
        throw new Error("DATA_UNAVAILABLE");
      }
      return filter(items);
    }
    async function query(partition: string, index: boolean) {
      return read(async () => {
        const items: unknown[] = [];
        let cursor: QueryCursor | undefined;
        do {
          const page = await storage.query(partition, index, cursor);
          items.push(...page.items);
          cursor = page.cursor;
        } while (cursor);
        return items;
      });
    }
    return {
      async ingestSnapshot(input: Parameters<typeof ingestSnapshot>[1]) {
        const actor = authority(principal);
        if (
          actor.mode !== "system" ||
          !["guildSnapshot", "guildSnapshotLatest"].every((kind) =>
            actor.writableKinds.includes(
              kind as "guildSnapshot" | "guildSnapshotLatest",
            ),
          )
        )
          throw new Error("WRITE_DENIED");
        return ingestSnapshot(storage, input);
      },
      get: (key: Key) => read(async () => [await storage.get(key)]),
      query: (partition: string) => query(partition, false),
      lookup: (partition: string) => query(partition, true),
      batch: (keys: readonly Key[]) => read(() => storage.batch(keys)),
      async removeOfficerNote(input: OfficerNote): Promise<void> {
        const item = decode(input);
        if (!item || item.kind !== "officerNote")
          throw new Error("INVALID_RECORD");
        const actor = authority(principal);
        const allowed =
          actor.mode === "system"
            ? actor.writableKinds.includes("officerNote")
            : actor.roles.includes("Officer");
        if (!allowed) throw new Error("WRITE_DENIED");
        if (!storage.removeNote) throw new Error("NOTE_REMOVAL_UNAVAILABLE");
        try {
          await storage.removeNote(item);
        } catch {
          throw new Error("NOTE_REMOVAL_FAILED");
        }
      },
      async write(
        input: RecordInput,
        condition?: WriteCondition,
      ): Promise<void> {
        const actor = authority(principal);
        if (
          input.kind === "guildSnapshot" ||
          input.kind === "guildSnapshotLatest"
        )
          throw new Error("WRITE_DENIED");
        let raw: RecordInput = input;
        if (input.kind === "fact") {
          if (
            !actor.userId ||
            ("ownerId" in input && input.ownerId !== actor.userId)
          )
            throw new Error("WRITE_DENIED");
          raw = { ...input, ownerId: actor.userId };
        }
        const item = decode(raw);
        if (!item) throw new Error("INVALID_RECORD");
        const self = ["member", "character", "wishlist", "fact"].includes(
          item.kind,
        );
        const allowed =
          actor.mode === "system"
            ? actor.writableKinds.includes(item.kind)
            : self
              ? actor.roles.includes("Member") && actor.userId === item.ownerId
              : actor.roles.includes("Officer");
        if (!allowed) throw new Error("WRITE_DENIED");
        if (
          item.kind === "officerNote" &&
          (!condition?.candidateThreadId ||
            !item.sk.startsWith(`OFFICER_NOTE#${condition.candidateThreadId}#`))
        )
          throw new Error("NOTE_CANDIDATE_CONDITION_REQUIRED");
        try {
          await storage.put(item, condition);
        } catch (error) {
          if (
            error instanceof Error &&
            (error.name === "ConditionalCheckFailedException" ||
              (error.name === "TransactionCanceledException" &&
                "CancellationReasons" in error &&
                Array.isArray(error.CancellationReasons) &&
                error.CancellationReasons.some(
                  (reason: { Code?: string }) =>
                    reason.Code === "ConditionalCheckFailed",
                )))
          )
            throw new Error("WRITE_CONFLICT");
          throw new Error("DATA_UNAVAILABLE");
        }
      },
    };
  }
  return {
    forUser: (principal: Principal<"user">) => bind(principal, "user"),
    forSystem: (principal: Principal<"system">) => bind(principal, "system"),
  };
}

export function createDynamoDataAccess(config: {
  tableName: string;
  region: string;
  endpoint?: string;
  localCredentials?: boolean;
}) {
  return createDataAccess(createDynamoStorage(config));
}

function createDynamoStorage(config: {
  tableName: string;
  region: string;
  endpoint?: string;
  localCredentials?: boolean;
}): StoragePort {
  const client = DynamoDBDocumentClient.from(
    new DynamoDBClient({
      region: config.region,
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      ...(config.localCredentials === true
        ? { credentials: { accessKeyId: "local", secretAccessKey: "local" } }
        : {}),
    }),
  );
  const storage: StoragePort = {
    async insertSnapshot(item) {
      await client.send(
        new PutCommand({
          TableName: config.tableName,
          Item: item,
          ConditionExpression: "attribute_not_exists(pk)",
        }),
      );
    },
    async advanceSnapshot(item) {
      try {
        await client.send(
          new UpdateCommand({
            TableName: config.tableName,
            Key: { pk: item.pk, sk: item.sk },
            UpdateExpression:
              "SET #kind = :kind, ownerId = :owner, snapshotId = :id, exportedAt = :exportedAt",
            ConditionExpression:
              "attribute_not_exists(pk) OR exportedAt < :exportedAt",
            ExpressionAttributeNames: { "#kind": "kind" },
            ExpressionAttributeValues: {
              ":kind": item.kind,
              ":owner": item.ownerId,
              ":id": item.snapshotId,
              ":exportedAt": item.exportedAt,
            },
            ReturnValuesOnConditionCheckFailure: "ALL_OLD",
          }),
        );
      } catch (error) {
        // DocumentClient leaves failed-condition images in DynamoDB's wire format.
        if (
          error instanceof Error &&
          error.name === "ConditionalCheckFailedException" &&
          "Item" in error &&
          error.Item
        ) {
          error.Item = unmarshall(
            error.Item as Parameters<typeof unmarshall>[0],
          );
        }
        throw error;
      }
    },
    async get(key) {
      const result = await client.send(
        new GetCommand({
          TableName: config.tableName,
          Key: { pk: key.pk, sk: key.sk },
          ConsistentRead: true,
        }),
      );
      return result.Item;
    },
    async query(partition, index, cursor) {
      const field = index ? "gsi1pk" : "pk";
      const result = await client.send(
        new QueryCommand({
          TableName: config.tableName,
          ...(index ? { IndexName: "gsi1" } : {}),
          ConsistentRead: !index,
          KeyConditionExpression: "#partition = :partition",
          ExpressionAttributeNames: { "#partition": field },
          ExpressionAttributeValues: { ":partition": partition },
          ExclusiveStartKey: cursor,
        }),
      );
      return {
        items: result.Items ?? [],
        cursor: result.LastEvaluatedKey as QueryCursor | undefined,
      };
    },
    async batch(keys) {
      const items: unknown[] = [];
      const unique = [
        ...new Map(
          keys.map((key) => [
            JSON.stringify([key.pk, key.sk]),
            { pk: key.pk, sk: key.sk },
          ]),
        ).values(),
      ];
      for (let offset = 0; offset < unique.length; offset += 100) {
        let pending = unique.slice(offset, offset + 100);
        for (let attempt = 0; pending.length && attempt < 5; attempt++) {
          const result = await client.send(
            new BatchGetCommand({
              RequestItems: {
                [config.tableName]: { Keys: pending, ConsistentRead: true },
              },
            }),
          );
          items.push(...(result.Responses?.[config.tableName] ?? []));
          pending = (result.UnprocessedKeys?.[config.tableName]?.Keys ??
            []) as Key[];
        }
        if (pending.length) throw new Error("BATCH_INCOMPLETE");
      }
      return items;
    },
    async removeNote(item) {
      await client.send(
        new DeleteCommand({
          TableName: config.tableName,
          Key: { pk: item.pk, sk: item.sk },
          ConditionExpression:
            "attribute_not_exists(pk) OR (kind = :kind AND ownerId = :owner)",
          ExpressionAttributeValues: {
            ":kind": "officerNote",
            ":owner": item.ownerId,
          },
        }),
      );
    },
    async put(item, condition) {
      if (item.kind === "officerNote") {
        if (!condition?.candidateThreadId)
          throw new Error("NOTE_CANDIDATE_CONDITION_REQUIRED");
        await client.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                ConditionCheck: {
                  TableName: config.tableName,
                  Key: {
                    pk: `CANDIDATE#${item.ownerId}`,
                    sk: `CANDIDATE#${condition.candidateThreadId}`,
                  },
                  ConditionExpression: "attribute_not_exists(retention)",
                },
              },
              {
                Put: {
                  TableName: config.tableName,
                  Item: {
                    ...item,
                    gsi1pk: "OFFICER_NOTE#ALL",
                    gsi1sk: `${item.pk}#${item.sk}`,
                  },
                },
              },
            ],
          }),
        );
        return;
      }
      await client.send(
        new PutCommand({
          TableName: config.tableName,
          Item: {
            ...item,
            gsi1pk: `${item.pk.split("#")[0]}#ALL`,
            gsi1sk: `${item.pk}#${item.sk}`,
          },
          ConditionExpression:
            "(attribute_not_exists(pk) OR (kind = :kind AND ownerId = :owner))" +
            (item.kind === "candidate"
              ? " AND attribute_not_exists(retention)"
              : ""),
          ExpressionAttributeValues: {
            ":kind": item.kind,
            ":owner": item.ownerId,
          },
        }),
      );
    },
  };
  return storage;
}
