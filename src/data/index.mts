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
import type { IntakeState } from "./intake.mts";
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
type Candidate = Extract<GuildRecord, { kind: "candidate" }>;
type Intake = Extract<GuildRecord, { kind: "recruitingIntake" }>;
export type WriteCondition = {
  candidatePrevious?: Candidate;
  releasedIntake?: Intake;
  council?: {
    guildId: string;
    voteId: string;
    revision?: string;
    nextRevision: string;
    close?: true;
  };
  ballotSelectionId?: string;
  departureSnapshotId?: string | null;
  departure?:
    | { claim: true; expiredBefore: number }
    | { requestId: string; state: string };
  preserveMeasuredAttendance?: true;
  candidateThreadId?: string;
  absent?: true;
  forgetAt?: number;
  memoryCutoff?: number;
  intake?: { state: IntakeState; attemptId: string; noticeSent?: boolean };
};
export type StoragePort = SnapshotWrites & {
  get(key: Key): Promise<unknown>;
  query(
    partition: string,
    index: boolean,
    cursor?: QueryCursor,
  ): Promise<{ items: unknown[]; cursor?: QueryCursor }>;
  batch(keys: readonly Key[]): Promise<unknown[]>;
  put(item: GuildRecord, condition?: WriteCondition): Promise<void>;
  releaseDeparture?(
    item: Extract<GuildRecord, { kind: "departure" }>,
  ): Promise<void>;
  confirmDeparture?(
    item: Extract<GuildRecord, { kind: "departure" }>,
  ): Promise<void>;
  removeIntake?(
    item: Extract<GuildRecord, { kind: "recruitingIntake" }>,
  ): Promise<void>;
  removeFact?(item: Extract<GuildRecord, { kind: "fact" }>): Promise<void>;
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

export function reportInvalidDataItem(count = 1): void {
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
      InvalidDataItem: count,
    }),
  );
}

export function createDataAccess(
  storage: StoragePort,
  invalidItem: () => void = reportInvalidDataItem,
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
    function systemWrite(item: GuildRecord) {
      const actor = authority(principal);
      if (actor.mode !== "system" || !actor.writableKinds.includes(item.kind))
        throw new Error("WRITE_DENIED");
    }
    async function stored(work: () => Promise<void>) {
      try {
        await work();
      } catch (error) {
        if (
          error instanceof Error &&
          (error.name === "ConditionalCheckFailedException" ||
            (error.name === "TransactionCanceledException" &&
              "CancellationReasons" in error &&
              Array.isArray(error.CancellationReasons) &&
              error.CancellationReasons.some(
                (reason: { Code?: string }) =>
                  reason.Code === "ConditionalCheckFailed" ||
                  reason.Code === "TransactionConflict",
              )))
        )
          throw new Error("WRITE_CONFLICT");
        throw new Error("DATA_UNAVAILABLE");
      }
    }
    return {
      async releaseDeparture(
        input: Extract<GuildRecord, { kind: "departure" }>,
      ) {
        systemWrite(input);
        if (!decode(input)) throw new Error("INVALID_RECORD");
        const release = storage.releaseDeparture;
        if (!release) throw new Error("DEPARTURE_RELEASE_UNAVAILABLE");
        await stored(() => release(input));
      },
      async confirmDeparture(
        input: Extract<GuildRecord, { kind: "departure" }>,
      ) {
        systemWrite(input);
        const actor = authority(principal);
        if (actor.mode !== "system" || !actor.writableKinds.includes("member"))
          throw new Error("WRITE_DENIED");
        if (!decode(input) || input.state !== "confirmed")
          throw new Error("INVALID_RECORD");
        const confirm = storage.confirmDeparture;
        if (!confirm) throw new Error("DEPARTURE_CONFIRM_UNAVAILABLE");
        await stored(() => confirm(input));
      },
      async transitionDeparture(
        input: Extract<GuildRecord, { kind: "departure" }>,
        expected: NonNullable<WriteCondition["departure"]>,
      ) {
        systemWrite(input);
        if (!decode(input)) throw new Error("INVALID_RECORD");
        await stored(() => storage.put(input, { departure: expected }));
      },
      async advanceDepartureCheck(
        input: Extract<GuildRecord, { kind: "departureCheck" }>,
        previousSnapshotId: string | null,
      ) {
        systemWrite(input);
        if (!decode(input)) throw new Error("INVALID_RECORD");
        await stored(() =>
          storage.put(input, { departureSnapshotId: previousSnapshotId }),
        );
      },
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
      async insert(input: GuildRecord, candidateThreadId?: string) {
        if (
          input.kind === "guildSnapshot" ||
          input.kind === "guildSnapshotLatest" ||
          input.kind === "departureCheck" ||
          input.kind === "departure"
        )
          throw new Error("WRITE_DENIED");
        systemWrite(input);
        const item = decode(input);
        if (!item) throw new Error("INVALID_RECORD");
        if (
          item.kind === "officerNote" &&
          (!candidateThreadId ||
            !item.sk.startsWith(`OFFICER_NOTE#${candidateThreadId}#`))
        )
          throw new Error("NOTE_CANDIDATE_CONDITION_REQUIRED");
        await stored(() =>
          storage.put(item, { absent: true, candidateThreadId }),
        );
      },
      async transitionIntake(
        input: Extract<GuildRecord, { kind: "recruitingIntake" }>,
        expected: NonNullable<WriteCondition["intake"]>,
      ) {
        systemWrite(input);
        const item = decode(input);
        if (!item || item.kind !== "recruitingIntake")
          throw new Error("INVALID_RECORD");
        await stored(() =>
          storage.put(item, {
            intake: expected,
            candidateThreadId: item.threadId,
          }),
        );
      },
      async deleteIntake(
        item: Extract<GuildRecord, { kind: "recruitingIntake" }>,
      ) {
        systemWrite(item);
        if (!decode(item)) throw new Error("INVALID_RECORD");
        const remove = storage.removeIntake;
        if (!remove) throw new Error("INTAKE_REMOVAL_UNAVAILABLE");
        await stored(() => remove(item));
      },
      async forgetFacts(forgetAt = Date.now()) {
        const actor = authority(principal);
        if (
          actor.mode !== "user" ||
          !actor.roles.includes("Member") ||
          !actor.userId
        )
          throw new Error("WRITE_DENIED");
        const remove = storage.removeFact;
        if (!remove) throw new Error("FACT_REMOVAL_UNAVAILABLE");
        const marker = {
          pk: `FACT#${actor.userId}`,
          sk: "FACT#forget",
          kind: "fact" as const,
          ownerId: actor.userId,
          text: "Forget cutoff",
          forgetAt,
        };
        try {
          await stored(() => storage.put(marker, { forgetAt }));
        } catch (error) {
          if (!(error instanceof Error) || error.message !== "WRITE_CONFLICT")
            throw error;
        }
        const items = await query(`FACT#${actor.userId}`, false);
        for (const item of items) {
          if (item.kind !== "fact") throw new Error("INVALID_RECORD");
          if (item.forgetAt === undefined && (item.createdAt ?? 0) <= forgetAt)
            await stored(() => remove(item));
        }
      },
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
          input.kind === "guildSnapshotLatest" ||
          input.kind === "departureCheck" ||
          input.kind === "departure"
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
        if (
          condition?.candidatePrevious &&
          (item.kind !== "candidate" ||
            !decode(condition.candidatePrevious) ||
            condition.candidatePrevious.pk !== item.pk ||
            condition.candidatePrevious.sk !== item.sk)
        )
          throw new Error("INVALID_RECORD");
        if (condition?.releasedIntake) {
          const released = decode(condition.releasedIntake);
          if (
            !condition.candidatePrevious ||
            released?.kind !== "recruitingIntake" ||
            released.state !== "released" ||
            released.ownerId !== item.ownerId
          )
            throw new Error("INVALID_RECORD");
          systemWrite(released);
        }
        if (
          item.kind === "recruitingIntake" ||
          condition?.absent ||
          condition?.intake
        )
          throw new Error("INTAKE_CONDITIONAL_OPERATION_REQUIRED");
        if (
          item.kind === "lootBallot" &&
          (!/^[0-9]{20}$/.test(item.selectionId) ||
            condition?.ballotSelectionId !== item.selectionId ||
            !condition.council)
        )
          throw new Error("BALLOT_CONDITION_REQUIRED");
        const self = [
          "member",
          "character",
          "wishlist",
          "fact",
          "memoryReply",
        ].includes(item.kind);
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
        if (item.kind === "fact" && condition?.memoryCutoff === undefined)
          throw new Error("MEMORY_CONDITION_REQUIRED");
        await stored(() =>
          storage.put(
            item,
            item.kind === "attendance" && item.source === "voice"
              ? { ...condition, preserveMeasuredAttendance: true }
              : condition,
          ),
        );
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
    async removeFact(item) {
      await client.send(
        new DeleteCommand({
          TableName: config.tableName,
          Key: { pk: item.pk, sk: item.sk },
          ConditionExpression:
            "attribute_not_exists(pk) OR (#kind = :kind AND ownerId = :owner)",
          ExpressionAttributeNames: { "#kind": "kind" },
          ExpressionAttributeValues: {
            ":kind": "fact",
            ":owner": item.ownerId,
          },
        }),
      );
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
    async removeIntake(item) {
      await client.send(
        new DeleteCommand({
          TableName: config.tableName,
          Key: { pk: item.pk, sk: item.sk },
          ConditionExpression: "#state = :state AND attemptId = :attemptId",
          ExpressionAttributeNames: { "#state": "state" },
          ExpressionAttributeValues: {
            ":state": item.state,
            ":attemptId": item.attemptId,
          },
        }),
      );
    },
    async releaseDeparture(item) {
      await client.send(
        new DeleteCommand({
          TableName: config.tableName,
          Key: { pk: item.pk, sk: item.sk },
          ConditionExpression:
            "requestId = :request AND #state = :pending AND attribute_not_exists(messageId)",
          ExpressionAttributeNames: { "#state": "state" },
          ExpressionAttributeValues: {
            ":request": item.requestId,
            ":pending": "pending",
          },
        }),
      );
    },
    async confirmDeparture(item) {
      await client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: config.tableName,
                Item: {
                  ...item,
                  gsi1pk: "DEPARTURE#ALL",
                  gsi1sk: `${item.pk}#${item.sk}`,
                },
                ConditionExpression:
                  "requestId = :request AND #state = :pending",
                ExpressionAttributeNames: { "#state": "state" },
                ExpressionAttributeValues: {
                  ":request": item.requestId,
                  ":pending": "pending",
                },
              },
            },
            {
              Update: {
                TableName: config.tableName,
                Key: {
                  pk: `MEMBER#${item.memberId}`,
                  sk: `MEMBER#${item.ownerId}`,
                },
                UpdateExpression: "SET active = :inactive",
                ConditionExpression: "#kind = :member AND ownerId = :owner",
                ExpressionAttributeNames: { "#kind": "kind" },
                ExpressionAttributeValues: {
                  ":inactive": false,
                  ":member": "member",
                  ":owner": item.memberId,
                },
              },
            },
          ],
        }),
      );
    },
    async put(item, condition) {
      if (condition?.council) {
        const council = condition.council;
        await client.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Update: {
                  TableName: config.tableName,
                  Key: {
                    pk: `LOOT_VOTE#${council.guildId}`,
                    sk: `LOOT_VOTE#${council.voteId}`,
                  },
                  UpdateExpression: `SET revision = :next${council.close ? ", closed = :closed" : ""}`,
                  ConditionExpression:
                    "attribute_exists(pk) AND attribute_not_exists(closed) AND " +
                    (council.revision
                      ? "revision = :revision"
                      : "attribute_not_exists(revision)"),
                  ExpressionAttributeValues: {
                    ":next": council.nextRevision,
                    ...(council.revision
                      ? { ":revision": council.revision }
                      : {}),
                    ...(council.close ? { ":closed": true } : {}),
                  },
                },
              },
              {
                Put: {
                  TableName: config.tableName,
                  Item: {
                    ...item,
                    gsi1pk: `${item.pk.split("#")[0]}#ALL`,
                    gsi1sk: `${item.pk}#${item.sk}`,
                  },
                  ConditionExpression: council.close
                    ? "attribute_not_exists(pk)"
                    : "attribute_not_exists(selectionId) OR selectionId < :selection",
                  ...(!council.close
                    ? {
                        ExpressionAttributeValues: {
                          ":selection": condition.ballotSelectionId,
                        },
                      }
                    : {}),
                },
              },
            ],
          }),
        );
        return;
      }
      if (condition?.memoryCutoff !== undefined) {
        if (item.kind !== "fact" || item.forgetAt !== undefined)
          throw new Error("INVALID_MEMORY_WRITE");
        const cutoff = condition.memoryCutoff;
        await client.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                ConditionCheck: {
                  TableName: config.tableName,
                  Key: { pk: item.pk, sk: "FACT#forget" },
                  ConditionExpression:
                    cutoff === 0
                      ? "attribute_not_exists(pk)"
                      : "forgetAt = :cutoff",
                  ...(cutoff === 0
                    ? {}
                    : { ExpressionAttributeValues: { ":cutoff": cutoff } }),
                },
              },
              {
                Put: {
                  TableName: config.tableName,
                  Item: {
                    ...item,
                    gsi1pk: "FACT#ALL",
                    gsi1sk: `${item.pk}#${item.sk}`,
                  },
                  ConditionExpression: "attribute_not_exists(pk)",
                },
              },
            ],
          }),
        );
        return;
      }
      if (condition?.forgetAt !== undefined) {
        await client.send(
          new PutCommand({
            TableName: config.tableName,
            Item: item,
            ConditionExpression:
              "attribute_not_exists(forgetAt) OR forgetAt < :cutoff",
            ExpressionAttributeValues: { ":cutoff": condition.forgetAt },
          }),
        );
        return;
      }
      const departure = condition?.departure;
      const departureCondition =
        departure &&
        ("claim" in departure
          ? {
              ConditionExpression:
                "attribute_not_exists(pk) OR (#state IN (:kept, :confirmed) AND evidence <> :evidence) OR (#state = :pending AND attribute_not_exists(messageId) AND claimedAt < :expiredBefore)",
              ExpressionAttributeNames: { "#state": "state" },
              ExpressionAttributeValues: {
                ":pending": "pending",
                ":expiredBefore": departure.expiredBefore,
                ":kept": "kept",
                ":confirmed": "confirmed",
                ":evidence": item.kind === "departure" ? item.evidence : "",
              },
            }
          : {
              ConditionExpression: "requestId = :request AND #state = :state",
              ExpressionAttributeNames: { "#state": "state" },
              ExpressionAttributeValues: {
                ":request": departure.requestId,
                ":state": departure.state,
              },
            });
      const conditional =
        (condition?.ballotSelectionId
          ? {
              ConditionExpression:
                "attribute_not_exists(selectionId) OR selectionId < :selection",
              ExpressionAttributeValues: {
                ":selection": condition.ballotSelectionId,
              },
            }
          : undefined) ??
        departureCondition ??
        (condition?.departureSnapshotId !== undefined
          ? condition.departureSnapshotId === null
            ? { ConditionExpression: "attribute_not_exists(pk)" }
            : {
                ConditionExpression: "snapshotId = :previous",
                ExpressionAttributeValues: {
                  ":previous": condition.departureSnapshotId,
                },
              }
          : condition?.absent
            ? {
                ConditionExpression: "attribute_not_exists(pk)",
              }
            : condition?.intake
              ? {
                  ConditionExpression:
                    "#state = :state AND attemptId = :attemptId" +
                    (condition.intake.noticeSent === undefined
                      ? ""
                      : " AND noticeSent = :noticeSent"),
                  ExpressionAttributeNames: { "#state": "state" },
                  ExpressionAttributeValues: {
                    ":state": condition.intake.state,
                    ":attemptId": condition.intake.attemptId,
                    ...(condition.intake.noticeSent === undefined
                      ? {}
                      : { ":noticeSent": condition.intake.noticeSent }),
                  },
                }
              : undefined);
      const put = {
        TableName: config.tableName,
        Item: {
          ...item,
          gsi1pk: `${item.pk.split("#")[0]}#ALL`,
          gsi1sk: `${item.pk}#${item.sk}`,
        },
        ...conditional,
      };
      if (item.kind === "recruitingIntake" && !conditional)
        throw new Error("INTAKE_CONDITIONAL_OPERATION_REQUIRED");
      if (conditional && item.kind !== "officerNote") {
        if (item.kind === "recruitingIntake" && condition?.candidateThreadId) {
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
                { Put: put },
              ],
            }),
          );
        } else await client.send(new PutCommand(put));
        return;
      }
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
                  ...conditional,
                },
              },
            ],
          }),
        );
        return;
      }
      const previous = condition?.candidatePrevious;
      const fields = [
        "name",
        "discordUserId",
        "characters",
        "application",
        "recruiting",
      ] as const;
      const expected = previous
        ? fields
            .map((field) =>
              previous[field] === undefined
                ? `attribute_not_exists(#${field})`
                : `#${field} = :${field}`,
            )
            .join(" AND ")
        : "";
      const candidatePut = {
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
            : "") +
          (expected ? ` AND ${expected}` : "") +
          (condition?.preserveMeasuredAttendance
            ? " AND (attribute_not_exists(#source) OR #source <> :measured)"
            : ""),
        ...(previous || condition?.preserveMeasuredAttendance
          ? {
              ExpressionAttributeNames: {
                ...(previous
                  ? Object.fromEntries(
                      fields.map((field) => [`#${field}`, field]),
                    )
                  : {}),
                ...(condition?.preserveMeasuredAttendance
                  ? { "#source": "source" }
                  : {}),
              },
            }
          : {}),
        ExpressionAttributeValues: {
          ":kind": item.kind,
          ":owner": item.ownerId,
          ...(previous
            ? Object.fromEntries(
                fields
                  .filter((field) => previous[field] !== undefined)
                  .map((field) => [`:${field}`, previous[field]]),
              )
            : {}),
          ...(condition?.preserveMeasuredAttendance
            ? { ":measured": "guildos" }
            : {}),
        },
      };
      if (condition?.releasedIntake) {
        const released = condition.releasedIntake;
        // A no-op intake Put checks the release using existing PutItem grants.
        await client.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Put: {
                  TableName: config.tableName,
                  Item: {
                    ...released,
                    gsi1pk: `RECRUITING_INTAKE#ALL`,
                    gsi1sk: `${released.pk}#${released.sk}`,
                  },
                  ConditionExpression:
                    "#state = :state AND attemptId = :attemptId",
                  ExpressionAttributeNames: { "#state": "state" },
                  ExpressionAttributeValues: {
                    ":state": "released",
                    ":attemptId": released.attemptId,
                  },
                },
              },
              { Put: candidatePut },
            ],
          }),
        );
      } else await client.send(new PutCommand(candidatePut));
    },
  };
  return storage;
}
