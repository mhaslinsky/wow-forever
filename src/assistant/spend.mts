import type {
  ConverseCommand,
  ConverseCommandOutput,
} from "@aws-sdk/client-bedrock-runtime";
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";

export const PAUSED = "AutoGM is out of juice for the month.";
export class SpendError extends Error {}
export class SpendPaused extends SpendError {}
const UNITS_PER_USD = 1_000_000_000;
const dynamo = new DynamoDBClient({ region: "us-east-1", maxAttempts: 1 });
type Send = (
  command: GetItemCommand | PutItemCommand | UpdateItemCommand,
  options: { abortSignal: AbortSignal },
) => Promise<{
  Item?: Record<string, import("@aws-sdk/client-dynamodb").AttributeValue>;
  Attributes?: Record<
    string,
    import("@aws-sdk/client-dynamodb").AttributeValue
  >;
}>;

export function spendMetric(reason: string) {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: "WowForever",
            Dimensions: [[]],
            Metrics: [{ Name: "AssistantSpendErrors", Unit: "Count" }],
          },
        ],
      },
      AssistantSpendErrors: 1,
      reason,
    }),
  );
}

export function spendTotalMetric(usd: number) {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: "WowForever",
            Dimensions: [[]],
            Metrics: [{ Name: "AssistantSpendUsd", Unit: "None" }],
          },
        ],
      },
      AssistantSpendUsd: usd,
    }),
  );
}

export function createSpend(ports: {
  table: string;
  guildId: string;
  limitUsd?: number;
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  searchUsd: number;
  now(): number;
  notify(content: string): Promise<unknown>;
  report(reason: string): void;
  total(usd: number): void;
  send?: Send;
}) {
  const send: Send =
    ports.send ??
    (async (command, options) => {
      if (command instanceof GetItemCommand)
        return dynamo.send(command, options);
      if (command instanceof PutItemCommand)
        return dynamo.send(command, options);
      return dynamo.send(command, options);
    });
  const valid =
    ports.table &&
    ports.guildId &&
    [
      ...(ports.limitUsd === undefined ? [] : [ports.limitUsd]),
      ports.inputPerMillionUsd,
      ports.outputPerMillionUsd,
      ports.searchUsd,
    ].every(
      (value) =>
        Number.isFinite(value) &&
        value >= 0 &&
        Number.isSafeInteger(Math.ceil(value * UNITS_PER_USD)),
    );
  function month() {
    const date = new Date(ports.now());
    const label = date.toISOString().slice(0, 7);
    return {
      pk: `assistant-spend#${ports.guildId}#${label}`,
      label,
      expiresAt: String(
        Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 8) / 1000,
      ),
    };
  }
  type Month = ReturnType<typeof month>;
  const key = (period: Month) => ({ pk: { S: period.pk } });
  const conditional = (error: unknown) =>
    error instanceof Error && error.name === "ConditionalCheckFailedException";
  async function notice(period: Month, signal: AbortSignal) {
    const marker = { pk: { S: `${period.pk}#notified` } };
    const lease = String(ports.now() + 120000);
    let acquired = false;
    try {
      if (
        (
          await send(
            new GetItemCommand({
              TableName: ports.table,
              Key: marker,
              ConsistentRead: true,
            }),
            { abortSignal: signal },
          )
        ).Item
      )
        return;
      await send(
        new UpdateItemCommand({
          TableName: ports.table,
          Key: key(period),
          UpdateExpression:
            "SET noticeUntilMs = :lease, expiresAt = :ttl, costUnits = if_not_exists(costUnits, :zero)",
          ConditionExpression:
            "attribute_not_exists(noticeUntilMs) OR noticeUntilMs <= :now",
          ExpressionAttributeValues: {
            ":ttl": { N: period.expiresAt },
            ":zero": { N: "0" },
            ":lease": { N: lease },
            ":now": { N: String(ports.now()) },
          },
        }),
        { abortSignal: signal },
      );
      acquired = true;
      if (
        (
          await send(
            new GetItemCommand({
              TableName: ports.table,
              Key: marker,
              ConsistentRead: true,
            }),
            { abortSignal: signal },
          )
        ).Item
      )
        return;
      await ports.notify(
        `AutoGM reached its $${ports.limitUsd} monthly limit (${period.label}, UTC).`,
      );
      await send(
        new PutItemCommand({
          TableName: ports.table,
          Item: { ...marker, expiresAt: { N: period.expiresAt } },
          ConditionExpression: "attribute_not_exists(pk)",
        }),
        { abortSignal: signal },
      );
    } catch (error) {
      if (!acquired && conditional(error)) return;
      ports.report("notice");
      if (acquired) {
        try {
          await send(
            new UpdateItemCommand({
              TableName: ports.table,
              Key: key(period),
              UpdateExpression: "REMOVE noticeUntilMs",
              ConditionExpression: "noticeUntilMs = :lease",
              ExpressionAttributeValues: { ":lease": { N: lease } },
            }),
            { abortSignal: signal },
          );
        } catch {
          ports.report("notice_lease");
        }
      }
    }
  }
  async function check(signal: AbortSignal) {
    const period = month();
    try {
      if (!valid) throw new Error("Invalid spend configuration");
      if (ports.limitUsd === undefined) return period;
      const result = await send(
        new GetItemCommand({
          TableName: ports.table,
          Key: key(period),
          ConsistentRead: true,
        }),
        { abortSignal: signal },
      );
      const units = result.Item ? Number(result.Item.costUnits?.N) : 0;
      if (!Number.isSafeInteger(units) || units < 0)
        throw new Error("Invalid spend counter");
      if (units < Math.ceil(ports.limitUsd * UNITS_PER_USD)) return period;
    } catch {
      ports.report("read");
      throw new SpendError("Spend unavailable");
    }
    await notice(period, signal);
    throw new SpendPaused(PAUSED);
  }
  async function charge(period: Month, usd: number) {
    try {
      const units = Math.ceil(usd * UNITS_PER_USD);
      if (!Number.isSafeInteger(units) || units < 0)
        throw new Error("Invalid usage");
      const result = await send(
        new UpdateItemCommand({
          TableName: ports.table,
          Key: key(period),
          ReturnValues: "ALL_NEW",
          UpdateExpression: "SET expiresAt = :ttl ADD costUnits :cost",
          ExpressionAttributeValues: {
            ":ttl": { N: period.expiresAt },
            ":cost": { N: String(units) },
          },
        }),
        { abortSignal: AbortSignal.timeout(5000) },
      );
      const total = Number(result.Attributes?.costUnits?.N);
      if (!Number.isSafeInteger(total) || total < 0)
        throw new Error("Missing spend total");
      ports.total(total / UNITS_PER_USD);
      if (
        ports.limitUsd !== undefined &&
        total >= Math.ceil(ports.limitUsd * UNITS_PER_USD)
      )
        await notice(period, AbortSignal.timeout(15000));
    } catch {
      ports.report("write");
      if (ports.limitUsd !== undefined)
        throw new SpendError("Spend unavailable");
    }
  }
  return {
    check,
    bedrock(
      sendModel: (
        command: ConverseCommand,
        options: { abortSignal: AbortSignal },
      ) => Promise<ConverseCommandOutput>,
    ) {
      return async (
        command: ConverseCommand,
        options: { abortSignal: AbortSignal },
      ) => {
        const period = await check(options.abortSignal);
        let result: ConverseCommandOutput;
        try {
          result = await sendModel(command, options);
        } catch (error) {
          ports.report("model_usage");
          if (ports.limitUsd !== undefined)
            throw new SpendError("Model usage unavailable");
          throw error;
        }
        const input = result.usage?.inputTokens;
        const output = result.usage?.outputTokens;
        if (
          typeof input !== "number" ||
          typeof output !== "number" ||
          !Number.isSafeInteger(input) ||
          !Number.isSafeInteger(output) ||
          input < 0 ||
          output < 0
        ) {
          ports.report("usage");
          if (ports.limitUsd !== undefined)
            throw new SpendError("Missing model usage");
          return result;
        }
        await charge(
          period,
          (input * ports.inputPerMillionUsd +
            output * ports.outputPerMillionUsd) /
            1_000_000,
        );
        return result;
      };
    },
    search<Result>(
      search: (question: string, signal: AbortSignal) => Promise<Result>,
    ) {
      return async (question: string, signal: AbortSignal) => {
        const period = await check(signal);
        try {
          return await search(question, signal);
        } finally {
          await charge(period, ports.searchUsd);
        }
      };
    },
  };
}
