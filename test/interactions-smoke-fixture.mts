import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import type { Interaction, Ports, Route } from "../src/interactions/core.mts";
import { clock } from "../src/interactions/core.mts";
import type { HttpEvent } from "../src/interactions/http.mts";
import { createHandler } from "../src/interactions/index.mts";

const dynamo = new DynamoDBClient({ maxAttempts: 1 });
const lambda = new LambdaClient({ maxAttempts: 1 });
const table = () => {
  const name = process.env.CLAIMS_TABLE;
  if (!name) throw new Error("Missing CLAIMS_TABLE");
  return name;
};
async function observe(runId: string, counter: string, content?: string) {
  await dynamo.send(
    new UpdateItemCommand({
      TableName: table(),
      Key: { pk: { S: `smoke#${runId}` } },
      UpdateExpression: `SET expiresAt = :ttl${content === undefined ? "" : ", #content = :content"} ADD #counter :one`,
      ExpressionAttributeNames: {
        "#counter": counter,
        ...(content === undefined ? {} : { "#content": "content" }),
      },
      ExpressionAttributeValues: {
        ":ttl": { N: String(Math.floor(Date.now() / 1000) + 3600) },
        ":one": { N: "1" },
        ...(content === undefined ? {} : { ":content": { S: content } }),
      },
    }),
  );
}
function dependencies(publicKey: string): Ports {
  return {
    clock,
    publicKey: async () => publicKey,
    async invoke(interaction, signal) {
      const result = await lambda.send(
        new InvokeCommand({
          FunctionName: process.env.AWS_LAMBDA_FUNCTION_NAME,
          InvocationType: "Event",
          Payload: Buffer.from(JSON.stringify({ __worker: true, interaction })),
        }),
        { abortSignal: signal },
      );
      if (result.StatusCode !== 202) throw new Error("Worker not accepted");
    },
    async claim(key, expiresAt, signal) {
      try {
        await dynamo.send(
          new PutItemCommand({
            TableName: table(),
            Item: { pk: { S: key }, expiresAt: { N: String(expiresAt) } },
            ConditionExpression: "attribute_not_exists(pk) OR expiresAt < :now",
            ExpressionAttributeValues: {
              ":now": { N: String(Math.floor(Date.now() / 1000)) },
            },
          }),
          { abortSignal: signal },
        );
        return true;
      } catch (error) {
        if (
          error instanceof Error &&
          error.name === "ConditionalCheckFailedException"
        )
          return false;
        throw error;
      }
    },
    async discord(interaction, method, content) {
      if (method !== "GET") await observe(interaction.id, "replies", content);
      return 200;
    },
    report() {
      console.error("Fixture interaction failed");
    },
  };
}
const routes: Route[] = ["slow", "watchdog", "duplicate"].map((scenario) => ({
  type: 2,
  name: `smoke-${scenario}`,
  mode: "slow",
  visibility: "ephemeral",
  async handler(interaction, signal) {
    await observe(interaction.id, "work");
    if (scenario === "watchdog")
      await new Promise<never>((_resolve, reject) => {
        const abort = () => reject(new Error("Watchdog cancelled work"));
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
    return { type: 4, data: { content: "Completed" } };
  },
}));
type FixtureEvent =
  | { smoke: "start"; scenario: string; request: HttpEvent; publicKey: string }
  | { smoke: "status"; runId: string }
  | { __worker: true; interaction: Interaction };
export async function handler(
  event: FixtureEvent,
  context: { getRemainingTimeInMillis(): number },
) {
  if ("__worker" in event) {
    await createHandler(dependencies(""), routes)(event, context);
    await observe(event.interaction.id, "completed");
    return;
  }
  if (event.smoke === "status") {
    const { Item } = await dynamo.send(
      new GetItemCommand({
        TableName: table(),
        Key: { pk: { S: `smoke#${event.runId}` } },
        ConsistentRead: true,
      }),
    );
    return {
      completed: Number(Item?.completed?.N ?? 0),
      work: Number(Item?.work?.N ?? 0),
      replies: Number(Item?.replies?.N ?? 0),
      content: Item?.content?.S,
    };
  }
  if (!["slow", "watchdog", "duplicate"].includes(event.scenario))
    throw new Error("Unknown fixture scenario");
  const runId: string = JSON.parse(event.request.body ?? "").id;
  if (!runId) throw new Error("Missing fixture id");
  const http = createHandler(dependencies(event.publicKey), routes);
  const replies = await Promise.all(
    Array.from({ length: event.scenario === "duplicate" ? 2 : 1 }, () =>
      http(event.request, context),
    ),
  );
  return {
    runId,
    deferred: replies.every(
      (reply) =>
        reply &&
        "statusCode" in reply &&
        reply.statusCode === 200 &&
        JSON.parse(reply.body).type === 5,
    ),
  };
}
