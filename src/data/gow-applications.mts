import { createHash } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { authority, type Principal } from "../auth/index.mts";
import { type GuildRecord, recordKey } from "./records.mts";

type CapturedApplication = Extract<GuildRecord, { kind: "gowApplication" }>;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("GOW_INVALID_JSON");
  return encoded;
}

export function applicationRecord(
  guildId: string,
  recruit: unknown,
): CapturedApplication {
  const id =
    recruit !== null && typeof recruit === "object" && "id" in recruit
      ? recruit.id
      : undefined;
  const identity =
    (typeof id === "string" && id.trim()) ||
    (typeof id === "number" && Number.isFinite(id))
      ? `id:${id}`
      : `json:${canonical(recruit)}`;
  return {
    ...recordKey(
      "gowApplication",
      guildId,
      createHash("sha256").update(identity).digest("hex"),
    ),
    kind: "gowApplication",
    ownerId: guildId,
    payload: JSON.stringify(recruit),
  };
}

export function createGowStore(
  tableName: string,
  principal: Principal<"system">,
) {
  const actor = authority(principal);
  if (
    actor.mode !== "system" ||
    !actor.writableKinds.includes("gowApplication")
  )
    throw new Error("WRITE_DENIED");
  const client = DynamoDBDocumentClient.from(
    new DynamoDBClient({ maxAttempts: 1 }),
  );
  return async (record: CapturedApplication): Promise<boolean> => {
    try {
      await client.send(
        new PutCommand({
          TableName: tableName,
          Item: record,
          ConditionExpression: "attribute_not_exists(pk)",
        }),
      );
      return true;
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === "ConditionalCheckFailedException"
      )
        return false;
      throw new Error("GOW_CAPTURE_STORE_FAILED");
    }
  };
}
