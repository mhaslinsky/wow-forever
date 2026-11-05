import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createPrincipalFactory } from "../src/auth/index.mts";
import { createDataAccess } from "../src/data/index.mts";
import { type GuildRecord, recordKey } from "../src/data/records.mts";
import { ingestSnapshot } from "../src/data/snapshots.mts";
import { createDepartures } from "../src/roster/departures.mts";
import { parseCharacters } from "../src/roster/interactions.mts";
import { createDepartureSnapshotHandler } from "../src/roster/snapshot-handler.mts";

function fixture(failPosts = 0, failMemberWrite = false, failRelease = false) {
  const postError = new Error("POST_FAILED");
  const member: GuildRecord = {
    ...recordKey("member", "user", "guild"),
    kind: "member",
    ownerId: "user",
    name: "Example",
    roster: parseCharacters(
      "eXaMpLe-Firemaw,Mage,Fire,DPS",
      "AbsentAlt-Firemaw,Mage,Fire,DPS",
    ).map((character) => ({ ...character, confirmed: true })),
  };
  const items = new Map<string, GuildRecord>([[member.sk + member.pk, member]]);
  const conflict = () =>
    Object.assign(new Error("conflict"), {
      name: "ConditionalCheckFailedException",
    });
  const getFlag = () =>
    [...items.values()].find((item) => item.kind === "departure");
  const posts: { content: string; components: unknown[] }[] = [];
  const data = createDataAccess({
    get: async (key) => items.get(key.sk + key.pk),
    query: async () => ({ items: [...items.values()] }),
    batch: async () => [],
    releaseDeparture: async (flag) => {
      if (failRelease) throw new Error("RELEASE_FAILED");
      const previous = items.get(flag.sk + flag.pk);
      if (
        previous?.kind !== "departure" ||
        previous.requestId !== flag.requestId
      )
        throw new Error("STALE");
      items.delete(flag.sk + flag.pk);
    },
    confirmDeparture: async (flag) => {
      const previous = items.get(flag.sk + flag.pk);
      const member = items.get(`MEMBER#${flag.ownerId}MEMBER#${flag.memberId}`);
      if (
        previous?.kind !== "departure" ||
        previous.requestId !== flag.requestId ||
        previous.state !== "pending"
      )
        throw conflict();
      if (failMemberWrite || member?.kind !== "member")
        throw new Error("MEMBER_WRITE_FAILED");
      items.set(member.sk + member.pk, { ...member, active: false });
      items.set(flag.sk + flag.pk, flag);
    },
    put: async (item, condition) => {
      const previous = items.get(item.sk + item.pk);
      const expected = condition?.departure;
      const rejected =
        expected &&
        ("claim" in expected
          ? previous !== undefined &&
            (previous.kind !== "departure" ||
              (previous.state === "pending" &&
                (previous.messageId !== undefined ||
                  previous.claimedAt >= expected.expiredBefore)) ||
              (item.kind === "departure" &&
                previous.evidence === item.evidence &&
                previous.state !== "pending"))
          : previous?.kind !== "departure" ||
            previous.requestId !== expected.requestId ||
            previous.state !== expected.state);
      if (rejected) throw conflict();
      if (
        condition?.departureSnapshotId !== undefined &&
        (condition.departureSnapshotId === null
          ? previous !== undefined
          : previous?.kind !== "departureCheck" ||
            previous.snapshotId !== condition.departureSnapshotId)
      )
        throw conflict();
      items.set(item.sk + item.pk, item);
    },
  });
  const post: Parameters<typeof createDepartures>[2] = async (
    content,
    components,
  ) => {
    if (failPosts-- > 0) throw postError;
    posts.push({ content, components });
    return String(posts.length);
  };
  const core = createDepartures(data, "guild", post);
  const scheduled = createDepartureSnapshotHandler(
    data,
    "guild",
    "game-guild",
    post,
  );
  const actor = createPrincipalFactory({
    guildId: "guild",
    memberRoleId: "member",
    officerRoleId: "officer",
    jobs: {},
  }).fromVerifiedInteraction({
    guild_id: "guild",
    member: { user: { id: "officer-user" }, roles: ["officer"] },
  });
  const base = JSON.parse(
    readFileSync(
      new URL("../src/guildos/fixtures/snapshot.json", import.meta.url),
      "utf8",
    ),
  );
  const snapshot = async (exportedAt: number, present: boolean) => {
    const snapshotId = String(exportedAt).padStart(64, "0");
    const save = async (item: GuildRecord) => {
      items.set(item.sk + item.pk, item);
    };
    await ingestSnapshot(
      { insertSnapshot: save, advanceSnapshot: save },
      {
        snapshotId,
        receivedAt: 0,
        writtenAt: 0,
        snapshot: {
          ...base,
          guildKey: "game-guild",
          exportedAt,
          members: present ? [{ ...base.members[0], name: "Example" }] : [],
        },
      },
    );
    await scheduled();
  };
  return { core, posts, items, actor, snapshot, getFlag, postError };
}
test("member removal posts an officer confirmation request", async ({
  mock,
}) => {
  const { core, posts } = fixture();
  await Promise.all([
    core.memberRemoved({ id: "user", guild: { id: "guild" } }),
    core.memberRemoved({ id: "user", guild: { id: "guild" } }),
  ]);
  assert.equal(posts.length, 1);
  assert.match(JSON.stringify(posts[0]), /Confirm.*Keep/);
  const failures: string[] = [];
  mock.method(console, "error", (entry: string) => {
    failures.push(JSON.parse(entry).code);
  });
  const failure = fixture(1, false, true);
  await assert.rejects(
    failure.core.memberRemoved({ id: "user", guild: { id: "guild" } }),
    (error) => error === failure.postError,
  );
  assert.deepEqual(failures, ["DEPARTURE_CLAIM_RELEASE_FAILED"]);
});
test("one missing snapshot does not flag", async () => {
  const { posts, snapshot, core, items } = fixture();
  await snapshot(1, true);
  const check = [...items.values()].find(
    (item) => item.kind === "departureCheck",
  );
  assert.equal(check?.snapshotId, "1".padStart(64, "0"));
  const before = JSON.stringify([...items]);
  await core.checkSnapshot("game-guild");
  assert.equal(JSON.stringify([...items]), before);
  await snapshot(2, true);
  await snapshot(3, true);
  await snapshot(4, false);
  await snapshot(5, true);
  await snapshot(6, false);
  assert.equal(posts.length, 0);
});
test("two consecutive missing snapshots flag once", async () => {
  const { core, posts, snapshot } = fixture();
  await snapshot(1, true);
  await snapshot(2, false);
  await Promise.all([snapshot(3, false), core.checkSnapshot("game-guild")]);
  await core.checkSnapshot("game-guild");
  assert.equal(posts.length, 1);
  const retry = fixture(1);
  await retry.snapshot(1, false);
  await assert.rejects(retry.snapshot(2, false), /POST_FAILED/);
  const check = [...retry.items.values()].find(
    (item) => item.kind === "departureCheck",
  );
  assert.ok(check?.kind === "departureCheck");
  assert.equal(check.snapshotId, "2".padStart(64, "0"));
  assert.equal(
    [...retry.items.values()].some((item) => item.kind === "departure"),
    false,
  );
  await retry.core.checkSnapshot("game-guild");
  assert.equal(retry.posts.length, 1);
});
test("Keep clears the flag", async () => {
  const failure = fixture(0, true);
  await failure.core.memberRemoved({ id: "user", guild: { id: "guild" } });
  const request = failure.getFlag();
  assert.ok(request?.kind === "departure");
  await Promise.allSettled([
    failure.core.resolve(failure.actor, "user", "confirm", request.requestId),
  ]);
  assert.equal(failure.getFlag()?.state, "pending");
  for (const order of [
    ["confirm", "keep"],
    ["keep", "confirm"],
  ]) {
    const { core, items, actor, getFlag } = fixture();
    await core.memberRemoved({ id: "user", guild: { id: "guild" } });
    const request = getFlag();
    assert.ok(request?.kind === "departure");
    const results = await Promise.all(
      order.map((action) =>
        core.resolve(actor, "user", action, request.requestId),
      ),
    );
    assert.deepEqual(results, [true, false]);
    const member = [...items.values()].find((item) => item.kind === "member");
    assert.ok(member?.kind === "member");
    assert.equal(member.active, order[0] === "confirm" ? false : undefined);
    assert.equal(
      getFlag()?.state,
      order[0] === "confirm" ? "confirmed" : "kept",
    );
  }
});
