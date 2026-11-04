import { createHash } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { authority, type Principal } from "../auth/index.mts";

export type NewsStore = {
  claim(guid: string, className: string): Promise<boolean>;
  posted(guid: string, className: string, messageId: string): Promise<void>;
  release(guid: string, className: string): Promise<void>;
};

export function createNewsStore(
  tableName: string,
  guildId: string,
  principal: Principal<"system">,
): NewsStore {
  const actor = authority(principal);
  if (actor.mode !== "system" || !actor.writableKinds.includes("classNews"))
    throw new Error("WRITE_DENIED");
  const client = DynamoDBDocumentClient.from(
    new DynamoDBClient({ maxAttempts: 1 }),
  );
  const key = (guid: string, className: string) => ({
    pk: `CLASS_NEWS#${guildId}`,
    sk: `CLASS_NEWS#${createHash("sha256").update(guid).digest("hex")}#${className}`,
  });
  return {
    async claim(guid, className) {
      const Key = key(guid, className);
      try {
        await client.send(
          new PutCommand({
            TableName: tableName,
            Item: {
              ...Key,
              kind: "classNews",
              ownerId: guildId,
              guid,
              className,
              claimedAt: Date.now(),
              status: "pending",
            },
            ConditionExpression: "attribute_not_exists(pk)",
          }),
        );
        return true;
      } catch (error) {
        if (
          !(error instanceof Error) ||
          error.name !== "ConditionalCheckFailedException"
        )
          throw error;
        const { Item } = await client.send(
          new GetCommand({ TableName: tableName, Key, ConsistentRead: true }),
        );
        if (!Item) throw new Error("NEWS_CLAIM_DISAPPEARED");
        if (
          Item.status === "pending" &&
          Date.now() - Item.claimedAt > 3_600_000
        )
          console.warn(JSON.stringify({ event: "NEWS_STALE_CLAIM", ...Key }));
        return false;
      }
    },
    async posted(guid, className, messageId) {
      await client.send(
        new UpdateCommand({
          TableName: tableName,
          Key: key(guid, className),
          UpdateExpression: "SET #status = :posted, messageId = :message",
          ConditionExpression: "#status = :pending",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":posted": "posted",
            ":pending": "pending",
            ":message": messageId,
          },
        }),
      );
    },
    async release(guid, className) {
      await client.send(
        new DeleteCommand({
          TableName: tableName,
          Key: key(guid, className),
          ConditionExpression: "#status = :pending",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":pending": "pending" },
        }),
      );
    },
  };
}
