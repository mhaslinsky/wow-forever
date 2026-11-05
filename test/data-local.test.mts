import assert from "node:assert/strict";
import test from "node:test";
import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import {
  createPrincipalFactory,
  createSystemPrincipal,
} from "../src/auth/index.mts";
import { createDynamoDataAccess } from "../src/data/index.mts";
import { type GuildRecord, recordKey } from "../src/data/records.mts";
import { createRetentionStorage } from "../src/data/retention.mts";
import { createRecruiting } from "../src/recruiting/core.mts";

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
    try {
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
          ...candidate,
          ...recordKey("member", "synthetic", "profile"),
          kind: "member",
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
        const intakes = data.forSystem(
          createSystemPrincipal(["recruitingIntake"]),
        );
        const intake: Extract<GuildRecord, { kind: "recruitingIntake" }> = {
          ...recordKey("recruitingIntake", "guild", "a".repeat(64)),
          kind: "recruitingIntake",
          ownerId: "guild",
          state: "pending",
          attemptId: "first",
          ref: "a".repeat(64),
          startedAt: "2030-01-01T00:00:00Z",
          payload: {
            name: "Synthetic",
            source: "Officer lead",
            actorId: "officer",
            changedAt: "2030-01-01T00:00:00Z",
            nextActionAt: "2030-01-02T00:00:00Z",
            content: "Synthetic",
            submission: "{}",
          },
        };
        await assert.rejects(officer.insert(intake), /WRITE_DENIED/);
        const attempts = await Promise.allSettled([
          intakes.insert(intake),
          intakes.insert(intake),
        ]);
        assert.equal(
          attempts.filter((result) => result.status === "fulfilled").length,
          1,
        );
        assert.equal(
          (
            attempts.find(
              (result) => result.status === "rejected",
            ) as PromiseRejectedResult
          ).reason.message,
          "WRITE_CONFLICT",
        );
        const uncertain = { ...intake, state: "uncertain" as const };
        await intakes.transitionIntake(uncertain, {
          state: "pending",
          attemptId: "first",
        });
        await assert.rejects(
          intakes.transitionIntake(intake, {
            state: "pending",
            attemptId: "first",
          }),
          /WRITE_CONFLICT/,
        );
        await assert.rejects(intakes.deleteIntake(intake), /WRITE_CONFLICT/);
        await intakes.deleteIntake(uncertain);
        assert.deepEqual(await intakes.get(intake), []);
        const blocked = {
          ...intake,
          state: "blocked" as const,
          noticeSent: true,
          outcome: "uncertain" as const,
        };
        await intakes.insert(blocked);
        const { payload: _payload, ...releasedFields } = intake;
        const released = {
          ...releasedFields,
          state: "released" as const,
          attemptId: "release",
        };
        await intakes.transitionIntake(released, {
          state: "blocked",
          attemptId: "first",
          noticeSent: true,
        });
        assert.deepEqual(await intakes.get(intake), [released]);
        const resolving = data.forSystem(
          createSystemPrincipal(["candidate", "recruitingIntake"]),
        );
        const original: Extract<GuildRecord, { kind: "candidate" }> = {
          ...recordKey("candidate", "guild", "cas"),
          kind: "candidate",
          ownerId: "guild",
          name: "CAS candidate",
        };
        await resolving.write(original);
        const edited = { ...original, name: "Officer edit" };
        await officer.write(edited);
        await assert.rejects(
          resolving.write(original, {
            candidatePrevious: original,
            releasedIntake: released,
          }),
          /WRITE_CONFLICT/,
        );
        assert.deepEqual(await resolving.get(original), [edited]);
        await resolving.write(edited, {
          candidatePrevious: edited,
          releasedIntake: released,
        });
        await assert.rejects(
          intakes.transitionIntake(blocked, {
            state: "blocked",
            attemptId: "first",
            noticeSent: true,
          }),
          /WRITE_CONFLICT/,
        );
        const claimed = {
          ...intake,
          attemptId: "claimed",
          released: true as const,
        };
        const claims = await Promise.allSettled(
          ["claimed", "loser"].map((attemptId) =>
            intakes.transitionIntake(
              { ...claimed, attemptId },
              { state: "released", attemptId: "release" },
            ),
          ),
        );
        assert.equal(
          claims.filter((result) => result.status === "fulfilled").length,
          1,
        );
        await assert.rejects(
          resolving.write(edited, {
            candidatePrevious: edited,
            releasedIntake: released,
          }),
          /WRITE_CONFLICT/,
        );
        assert.deepEqual(await resolving.get(original), [edited]);
        console.log(
          "DynamoDB Local: stale candidate snapshot rejected, current snapshot saved, consumed release cannot write candidate",
        );
        await intakes.deleteIntake(
          (await intakes.get(intake))[0] as typeof claimed,
        );
        console.log(
          "DynamoDB Local: release stripped payload, stale blocked write rejected, released generation claim=1 winner",
        );
        console.log(
          "DynamoDB Local: concurrent intake insert=1 winner, stale transition/delete rejected, conditional delete passed",
        );
        let created = 0;
        const core = createRecruiting(
          data,
          createSystemPrincipal([
            "candidate",
            "officerNote",
            "recruitingIntake",
          ]),
          "guild",
          {
            tags: async () =>
              ["New", "Declined", "Officer lead"].map((name) => ({
                id: name,
                name,
              })),
            create: async () => `thread-${++created}`,
            post: async () => {},
            tagsFor: async () => [],
            setTags: async () => {},
          },
        );
        const input = {
          name: "Synthetic",
          source: "Officer lead" as const,
          actorId: "officer",
        };
        const first = await core.create(input);
        const firstThreadId = first.recruiting?.threadId;
        assert.ok(firstThreadId);
        const [completed] = await intakes.query(intake.pk);
        const declined = await core.setStage(
          firstThreadId,
          "Declined",
          "officer",
          "declined",
        );
        const retention = createRetentionStorage({
          tableName,
          region: "us-east-1",
          guildId: "guild",
          endpoint,
          localCredentials: true,
        });
        await retention.purge(declined);
        assert.deepEqual(await intakes.get(completed), []);
        const fresh = await core.create(input);
        assert.notEqual(fresh.sk, first.sk);
        assert.equal(
          (await core.candidate(firstThreadId))?.recruiting,
          undefined,
        );
        assert.equal(created, 2);
        console.log(
          "DynamoDB Local: completed intake purged, identical reapplication created a fresh thread",
        );
        console.log(
          "DynamoDB Local: member candidate=0, officer candidate=1, public batch=1, GSI boundary passed",
        );
      } finally {
        await client.send(new DeleteTableCommand({ TableName: tableName }));
      }
    } finally {
      client.destroy();
    }
  },
);
