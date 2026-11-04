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
  const observed = (candidate: Candidate) => {
    if (!candidate.recruiting) throw new Error("CANDIDATE_THREAD_MISSING");
    return {
      TableName: config.tableName,
      Key: candidateKey(candidate),
      ConditionExpression:
        "recruiting.#stage = :stage AND recruiting.changedAt = :changedAt",
      ExpressionAttributeNames: { "#stage": "stage" },
      ExpressionAttributeValues: {
        ":stage": candidate.recruiting.stage,
        ":changedAt": candidate.recruiting.changedAt,
      },
    };
  };
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
      if (!state || !["Declined", "Withdrawn"].includes(state.stage))
        throw new Error("INVALID_RETENTION_CANDIDATE");
      let cursor: Key | undefined;
      do {
        const page = await client.send(
          new QueryCommand({
            TableName: config.tableName,
            ConsistentRead: true,
            KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
            ExpressionAttributeValues: {
              ":pk": recordKey("officerNote", config.guildId, "unused").pk,
              ":prefix": `OFFICER_NOTE#${state.threadId}#`,
            },
            ExclusiveStartKey: cursor,
          }),
        );
        const notes = page.Items ?? [];
        // Recheck the stage in each transaction before deleting its notes.
        for (let offset = 0; offset < notes.length; offset += 99) {
          await client.send(
            new TransactWriteCommand({
              TransactItems: [
                { ConditionCheck: observed(candidate) },
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
      const { Key: _key, ...condition } = observed(candidate);
      await client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                ...condition,
                Item: {
                  ...candidateKey(candidate),
                  kind: "candidate",
                  ownerId: config.guildId,
                  name: candidate.name,
                  retention: {
                    outcome: state.stage,
                    threadId: state.threadId,
                    archived: false,
                  },
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
          ConditionExpression: "retention.threadId = :threadId",
          ExpressionAttributeValues: {
            ":archived": true,
            ":threadId": threadId,
          },
        }),
      );
    },
  };
}
