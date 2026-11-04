import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { createSystemPrincipal } from "../auth/index.mts";
import type { Candidate } from "../recruiting/core.mts";
import { createDynamoDataAccess } from "./index.mts";
import { type Key, recordKey } from "./records.mts";

export function createRetentionStorage(config: {
  tableName: string;
  region: string;
  guildId: string;
}) {
  const client = DynamoDBDocumentClient.from(
    new DynamoDBClient({ region: config.region }),
  );
  const data = createDynamoDataAccess(config).forSystem(
    createSystemPrincipal([]),
  );
  const candidateKey = (candidate: Candidate) => ({
    pk: candidate.pk,
    sk: candidate.sk,
  });
  return {
    async candidates(): Promise<Candidate[]> {
      const records = await data.query(
        recordKey("candidate", config.guildId, "unused").pk,
      );
      return records.filter(
        (record): record is Candidate => record.kind === "candidate",
      );
    },
    async purge(candidate: Candidate) {
      const state = candidate.recruiting;
      if (!state || (state.stage !== "Declined" && state.stage !== "Withdrawn"))
        throw new Error("INVALID_RETENTION_CANDIDATE");
      const retention = candidate.retention ?? {
        outcome: state.stage,
        threadId: state.threadId,
        archived: false,
      };
      if (!candidate.retention) {
        // Fence writers before deleting notes so a delayed submission cannot recreate them.
        await client.send(
          new UpdateCommand({
            TableName: config.tableName,
            Key: candidateKey(candidate),
            UpdateExpression: "SET retention = :retention",
            ConditionExpression:
              "attribute_not_exists(retention) AND recruiting.#stage = :stage AND recruiting.changedAt = :changedAt",
            ExpressionAttributeNames: { "#stage": "stage" },
            ExpressionAttributeValues: {
              ":retention": retention,
              ":stage": state.stage,
              ":changedAt": state.changedAt,
            },
          }),
        );
      }
      const fenced = {
        TableName: config.tableName,
        ConditionExpression: "retention = :retention",
        ExpressionAttributeValues: { ":retention": retention },
      };
      let cursor: Key | undefined;
      do {
        const page = await client.send(
          new QueryCommand({
            TableName: config.tableName,
            ConsistentRead: true,
            KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
            ExpressionAttributeValues: {
              ":pk": recordKey("officerNote", config.guildId, "unused").pk,
              ":prefix": `OFFICER_NOTE#${retention.threadId}#`,
            },
            ExclusiveStartKey: cursor,
          }),
        );
        const notes = page.Items ?? [];
        for (let offset = 0; offset < notes.length; offset += 99) {
          await client.send(
            new TransactWriteCommand({
              TransactItems: [
                { ConditionCheck: { ...fenced, Key: candidateKey(candidate) } },
                ...notes.slice(offset, offset + 99).map((note) => ({
                  Delete: {
                    TableName: config.tableName,
                    Key: { pk: note.pk, sk: note.sk },
                  },
                })),
              ],
            }),
          );
        }
        cursor = page.LastEvaluatedKey as Key | undefined;
      } while (cursor);
      await client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                ...fenced,
                Item: {
                  ...candidateKey(candidate),
                  kind: "candidate",
                  ownerId: config.guildId,
                  name: candidate.name,
                  retention,
                },
              },
            },
          ],
        }),
      );
    },
    async archived(candidate: Candidate) {
      const threadId =
        candidate.retention?.threadId ?? candidate.recruiting?.threadId;
      if (!threadId) throw new Error("CANDIDATE_THREAD_MISSING");
      await client.send(
        new UpdateCommand({
          TableName: config.tableName,
          Key: candidateKey(candidate),
          UpdateExpression: "SET retention.archived = :archived",
          ConditionExpression:
            "retention.threadId = :threadId AND attribute_not_exists(recruiting)",
          ExpressionAttributeValues: {
            ":archived": true,
            ":threadId": threadId,
          },
        }),
      );
    },
  };
}
