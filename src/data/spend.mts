import {
  type AttributeValue,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";

export type SpendPeriod = { pk: string; label: string; expiresAt: string };
export type SpendStore = {
  read(period: SpendPeriod, signal: AbortSignal): Promise<number>;
  add(period: SpendPeriod, units: number, signal: AbortSignal): Promise<number>;
  notified(period: SpendPeriod, signal: AbortSignal): Promise<boolean>;
  claimNotice(
    period: SpendPeriod,
    claim: string,
    signal: AbortSignal,
  ): Promise<boolean>;
  markNotified(period: SpendPeriod, signal: AbortSignal): Promise<void>;
  releaseNotice(
    period: SpendPeriod,
    claim: string,
    signal: AbortSignal,
  ): Promise<void>;
};
type Send = (
  command: GetItemCommand | PutItemCommand | UpdateItemCommand,
  options: { abortSignal: AbortSignal },
) => Promise<{
  Item?: Record<string, AttributeValue>;
  Attributes?: Record<string, AttributeValue>;
}>;
const conditional = (error: unknown) =>
  error instanceof Error && error.name === "ConditionalCheckFailedException";
function units(value: AttributeValue | undefined): number {
  const number = Number(value?.N);
  if (!Number.isSafeInteger(number) || number < 0)
    throw new Error("Invalid spend counter");
  return number;
}

export function createSpendStore(table: string, injected?: Send): SpendStore {
  if (!table) throw new Error("Missing claims table");
  const client = injected
    ? undefined
    : new DynamoDBClient({ region: "us-east-1", maxAttempts: 1 });
  const send: Send =
    injected ??
    (async (command, options) => {
      if (!client) throw new Error("Missing spend client");
      if (command instanceof GetItemCommand)
        return client.send(command, options);
      if (command instanceof PutItemCommand)
        return client.send(command, options);
      return client.send(command, options);
    });
  const key = (period: SpendPeriod) => ({ pk: { S: period.pk } });
  const marker = (period: SpendPeriod) => ({
    pk: { S: `${period.pk}#notified` },
  });
  return {
    async read(period, signal) {
      const result = await send(
        new GetItemCommand({
          TableName: table,
          Key: key(period),
          ConsistentRead: true,
        }),
        { abortSignal: signal },
      );
      return result.Item ? units(result.Item.costUnits) : 0;
    },
    async add(period, amount, signal) {
      const result = await send(
        new UpdateItemCommand({
          TableName: table,
          Key: key(period),
          ReturnValues: "ALL_NEW",
          UpdateExpression: "SET expiresAt = :ttl ADD costUnits :cost",
          ExpressionAttributeValues: {
            ":ttl": { N: period.expiresAt },
            ":cost": { N: String(amount) },
          },
        }),
        { abortSignal: signal },
      );
      return units(result.Attributes?.costUnits);
    },
    async notified(period, signal) {
      return Boolean(
        (
          await send(
            new GetItemCommand({
              TableName: table,
              Key: marker(period),
              ConsistentRead: true,
            }),
            { abortSignal: signal },
          )
        ).Item,
      );
    },
    async claimNotice(period, claim, signal) {
      try {
        await send(
          new UpdateItemCommand({
            TableName: table,
            Key: key(period),
            UpdateExpression:
              "SET noticeClaim = :claim, expiresAt = :ttl, costUnits = if_not_exists(costUnits, :zero)",
            ConditionExpression: "attribute_not_exists(noticeClaim)",
            ExpressionAttributeValues: {
              ":claim": { S: claim },
              ":ttl": { N: period.expiresAt },
              ":zero": { N: "0" },
            },
          }),
          { abortSignal: signal },
        );
        return true;
      } catch (error) {
        if (conditional(error)) return false;
        throw error;
      }
    },
    async markNotified(period, signal) {
      try {
        await send(
          new PutItemCommand({
            TableName: table,
            Item: { ...marker(period), expiresAt: { N: period.expiresAt } },
            ConditionExpression: "attribute_not_exists(pk)",
          }),
          { abortSignal: signal },
        );
      } catch (error) {
        if (!conditional(error)) throw error;
      }
    },
    async releaseNotice(period, claim, signal) {
      await send(
        new UpdateItemCommand({
          TableName: table,
          Key: key(period),
          UpdateExpression: "REMOVE noticeClaim",
          ConditionExpression: "noticeClaim = :claim",
          ExpressionAttributeValues: { ":claim": { S: claim } },
        }),
        { abortSignal: signal },
      );
    },
  };
}
