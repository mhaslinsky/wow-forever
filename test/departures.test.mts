import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createPrincipalFactory } from "../src/auth/index.mts";
import { createDataAccess } from "../src/data/index.mts";
import { type GuildRecord, recordKey } from "../src/data/records.mts";

import { createDepartures } from "../src/roster/departures.mts";

function fixture(failPosts = 0) {
  const member: GuildRecord = {
    ...recordKey("member", "user", "guild"),
    kind: "member",
    ownerId: "user",
    name: "Example",
    roster: [
      {
        name: "eXaMpLe-Firemaw",
        class: "Mage",
        spec: "Fire",
        raidRole: "Damage",
        main: true,
        confirmed: true,
      },
    ],
  };
  member.roster?.push({
    ...member.roster[0],
    name: "AbsentAlt-Firemaw",
    main: false,
  });
  const items = new Map<string, GuildRecord>([[member.sk + member.pk, member]]);
  const posts: { content: string; components: unknown[] }[] = [];
  const data = createDataAccess({
    get: async (key) => items.get(key.sk + key.pk),
    query: async () => ({ items: [...items.values()] }),
    batch: async () => [],
    put: async (item, condition) => {
      const previous = items.get(item.sk + item.pk);
      const expected = condition?.departure;
      const rejected =
        expected &&
        ("claim" in expected
          ? previous !== undefined &&
            (previous.kind !== "departure" ||
              previous.state === "pending" ||
              (item.kind === "departure" &&
                previous.evidence === item.evidence))
          : previous?.kind !== "departure" ||
            previous.requestId !== expected.requestId ||
            previous.state !== expected.state ||
            (expected.delivery !== undefined &&
              previous.delivery !== expected.delivery));
      if (rejected)
        throw Object.assign(new Error("conflict"), {
          name: "ConditionalCheckFailedException",
        });
      if (
        condition?.departureSnapshotId !== undefined &&
        (condition.departureSnapshotId === null
          ? previous !== undefined
          : previous?.kind !== "departureCheck" ||
            previous.snapshotId !== condition.departureSnapshotId)
      )
        throw Object.assign(new Error("conflict"), {
          name: "ConditionalCheckFailedException",
        });
      items.set(item.sk + item.pk, item);
    },
  });
  const core = createDepartures(data, "guild", async (content, components) => {
    if (failPosts-- > 0) throw new Error("POST_FAILED");
    posts.push({ content, components });
  });
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
    const pointer: GuildRecord = {
      ...recordKey("guildSnapshotLatest", "game-guild", "latest"),
      kind: "guildSnapshotLatest",
      ownerId: "game-guild",
      snapshotId,
      exportedAt,
    };
    const history: GuildRecord = {
      ...recordKey(
        "guildSnapshot",
        "game-guild",
        `${String(exportedAt).padStart(16, "0")}#${snapshotId}`,
      ),
      kind: "guildSnapshot",
      ownerId: "game-guild",
      snapshotId,
      exportedAt,
      receivedAt: 0,
      writtenAt: 0,
      addonVersion: base.addonVersion,
      snapshotVersion: 1,
      snapshot: {
        ...base,
        guildKey: "game-guild",
        exportedAt,
        members: present ? [{ ...base.members[0], name: "Example" }] : [],
      },
    };
    for (const item of [pointer, history]) items.set(item.sk + item.pk, item);
    await core.checkSnapshot("game-guild");
  };
  return { core, posts, items, actor, snapshot };
}
test("member removal posts an officer confirmation request", async () => {
  const { core, posts } = fixture();
  await Promise.all([
    core.memberRemoved({ id: "user", guild: { id: "guild" } }),
    core.memberRemoved({ id: "user", guild: { id: "guild" } }),
  ]);
  assert.equal(posts.length, 1);
  assert.match(JSON.stringify(posts[0]), /Confirm.*Keep/);
});
test("one missing snapshot does not flag", async () => {
  const { posts, snapshot } = fixture();
  await snapshot(1, true);
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
  await retry.core.checkSnapshot("game-guild");
  assert.equal(retry.posts.length, 1);
});
test("Keep clears the flag", async () => {
  const { core, items, actor } = fixture();
  await core.memberRemoved({ id: "user", guild: { id: "guild" } });
  const pending = [...items.values()].find((item) => item.kind === "departure");
  assert.ok(pending?.kind === "departure");
  await core.resolve(actor, "user", "keep", pending.requestId);
  assert.equal(
    [...items.values()].find((item) => item.kind === "departure")?.state,
    "kept",
  );
  for (const order of [
    ["confirm", "keep"],
    ["keep", "confirm"],
  ]) {
    await core.memberRemoved({ id: "user", guild: { id: "guild" } });
    const request = [...items.values()].find(
      (item) => item.kind === "departure",
    );
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
    items.set(member.sk + member.pk, { ...member, active: undefined });
  }
});
