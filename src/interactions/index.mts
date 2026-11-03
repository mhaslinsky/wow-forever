import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import type { Interaction, Ports } from "./core.mts";
import { clock, registry } from "./core.mts";
import type { HttpEvent } from "./http.mts";
import { createHttp } from "./http.mts";
import { createWorker } from "./worker.mts";

const ssm = new SSMClient({ maxAttempts: 1 });
const lambda = new LambdaClient({ maxAttempts: 1 });
const dynamo = new DynamoDBClient({ maxAttempts: 1 });
const secrets = new Map<string, string>();
export async function readSecret(name: string, signal: AbortSignal) {
  const cached = secrets.get(name);
  if (cached) return cached;
  const result = await ssm.send(
    new GetParameterCommand({ Name: name, WithDecryption: true }),
    { abortSignal: signal },
  );
  const value = result.Parameter?.Value;
  if (!value || value === "None") throw new Error("Secret unavailable");
  secrets.set(name, value);
  return value;
}
export function discordClient(http: typeof fetch = fetch): Ports["discord"] {
  return async (interaction, method, content, signal, ephemeral) => {
    const webhook = `https://discord.com/api/v10/webhooks/${encodeURIComponent(interaction.application_id)}/${encodeURIComponent(interaction.token)}`;
    const response = await http(
      method === "POST"
        ? `${webhook}?wait=true`
        : `${webhook}/messages/@original`,
      {
        method,
        signal,
        headers: { "content-type": "application/json" },
        body:
          method === "GET"
            ? undefined
            : JSON.stringify({
                content: content?.slice(0, 2000),
                allowed_mentions: { parse: [] },
                ...(method === "POST" && ephemeral ? { flags: 64 } : {}),
              }),
      },
    );
    await response.body?.cancel();
    return response.status;
  };
}
const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};
const ports: Ports = {
  clock,
  publicKey: (signal) => readSecret(required("PUBLIC_KEY_PARAM"), signal),
  async invoke(interaction, signal) {
    const result = await lambda.send(
      new InvokeCommand({
        FunctionName: required("AWS_LAMBDA_FUNCTION_NAME"),
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
          TableName: required("CLAIMS_TABLE"),
          Item: { pk: { S: key }, expiresAt: { N: String(expiresAt) } },
          ConditionExpression: "attribute_not_exists(pk) OR expiresAt < :now",
          ExpressionAttributeValues: {
            ":now": { N: String(Math.floor(clock.now() / 1000)) },
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
      throw new Error("Claims unavailable");
    }
  },
  discord: discordClient(),
  report() {
    console.error("Interaction failed");
    console.log(
      JSON.stringify({
        _aws: {
          Timestamp: clock.now(),
          CloudWatchMetrics: [
            {
              Namespace: "WowForever",
              Dimensions: [[]],
              Metrics: [{ Name: "InteractionErrors", Unit: "Count" }],
            },
          ],
        },
        InteractionErrors: 1,
      }),
    );
  },
};
export function createHandler(
  dependencies: Ports = ports,
  routes: readonly import("./core.mts").Route[] = registry,
) {
  const http = createHttp(dependencies, routes);
  const worker = createWorker(dependencies, routes);
  return async (
    event: HttpEvent | { __worker: true; interaction: Interaction },
    context: { getRemainingTimeInMillis(): number },
  ) => {
    if ("__worker" in event && event.__worker === true)
      return worker(event.interaction, () =>
        context.getRemainingTimeInMillis(),
      );
    return http(event as HttpEvent);
  };
}
export const handler = createHandler();
