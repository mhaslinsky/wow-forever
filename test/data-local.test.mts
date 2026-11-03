import assert from "node:assert/strict";
import test from "node:test";
import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { createPrincipalFactory } from "../src/auth/index.mts";
import { createDynamoDataAccess } from "../src/data/index.mts";
import { recordKey } from "../src/data/records.mts";

const endpoint = process.env.DYNAMODB_LOCAL_ENDPOINT;
test(
  "DynamoDB Local adapter smoke",
  { skip: endpoint ? false : "DYNAMODB_LOCAL_ENDPOINT is unset" },
  async () => {
    const tableName = `per298-smoke-${process.pid}`;
    const client = new DynamoDBClient({
      endpoint,
      region: "us-east-1",
      credentials: { accessKeyId: "local", secretAccessKey: "local" },
    });
    await client.send(
      new CreateTableCommand({
        TableName: tableName,
        BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: ["pk", "sk", "gsi1pk", "gsi1sk"].map(
          (AttributeName) => ({ AttributeName, AttributeType: "S" }),
        ),
        KeySchema: [
          { AttributeName: "pk", KeyType: "HASH" },
          { AttributeName: "sk", KeyType: "RANGE" },
        ],
        GlobalSecondaryIndexes: [
          {
            IndexName: "gsi1",
            KeySchema: [
              { AttributeName: "gsi1pk", KeyType: "HASH" },
              { AttributeName: "gsi1sk", KeyType: "RANGE" },
            ],
            Projection: { ProjectionType: "ALL" },
          },
        ],
      }),
    );
    try {
      const factory = createPrincipalFactory({
        guildId: "guild",
        memberRoleId: "member",
        officerRoleId: "officer",
        jobs: {},
      });
      const actor = (role: string) =>
        factory.fromVerifiedInteraction({
          guild_id: "guild",
          member: { user: { id: "synthetic" }, roles: [role] },
        });
      const data = createDynamoDataAccess({
        tableName,
        region: "us-east-1",
        endpoint,
        localCredentials: true,
      });
      const member = data.forUser(actor("member"));
      const officer = data.forUser(actor("officer"));
      const candidate = {
        ...recordKey("candidate", "synthetic", "entry"),
        kind: "candidate",
        ownerId: "synthetic",
        name: "Synthetic",
      } as const;
      const publicItem = {
        ...recordKey("member", "synthetic", "profile"),
        kind: "member",
        ownerId: "synthetic",
        name: "Synthetic",
      } as const;
      await officer.write(candidate);
      await member.write(publicItem);
      assert.deepEqual(await member.get(candidate), []);
      assert.deepEqual(await officer.get(candidate), [candidate]);
      assert.deepEqual(await member.query(candidate.pk), []);
      const deadline = Date.now() + 10_000;
      let indexed = await officer.lookup("CANDIDATE#ALL");
      while (indexed.length === 0 && Date.now() < deadline) {
        indexed = await officer.lookup("CANDIDATE#ALL");
      }
      assert.deepEqual(indexed, [candidate]);
      assert.deepEqual(await member.lookup("CANDIDATE#ALL"), []);
      assert.deepEqual(
        await member.batch([candidate, publicItem, publicItem]),
        [publicItem],
      );
      console.log(
        "DynamoDB Local: member candidate=0, officer candidate=1, public batch=1, GSI boundary passed",
      );
    } finally {
      await client.send(new DeleteTableCommand({ TableName: tableName }));
      client.destroy();
    }
  },
);
