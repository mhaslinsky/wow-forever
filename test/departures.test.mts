import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createPrincipalFactory } from "../src/auth/index.mts";
import { createDataAccess } from "../src/data/index.mts";
import { type GuildRecord, recordKey } from "../src/data/records.mts";
import type { SnapshotHistory } from "../src/data/snapshots.mts";
import { createDepartures } from "../src/roster/departures.mts";

function fixture() {
  const member: GuildRecord = {
    ...recordKey("member", "user", "guild"),
    kind: "member",
    ownerId: "user",
    name: "Example",
    roster: [
      {
        name: "Example",
        class: "Mage",
        spec: "Fire",
        raidRole: "Damage",
        main: true,
        confirmed: true,
      },
    ],
  };
  const items = new Map<string, GuildRecord>([[member.sk + member.pk, member]]);
  const posts: { content: string; components: unknown[] }[] = [];
  const data = createDataAccess({
    get: async (key) => items.get(key.sk + key.pk),
    query: async () => ({ items: [...items.values()] }),
    batch: async () => [],
    put: async (item) => {
      items.set(item.sk + item.pk, item);
    },
  });
  const core = createDepartures(data, "guild", async (content, components) => {
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
  const snapshot = (exportedAt: number, present: boolean): SnapshotHistory => ({
    ...recordKey("guildSnapshot", "game-guild", String(exportedAt)),
    kind: "guildSnapshot",
    ownerId: "game-guild",
    snapshotId: String(exportedAt).padStart(64, "0"),
    exportedAt,
    receivedAt: 0,
    writtenAt: 0,
    addonVersion: "fixture",
    snapshotVersion: 1,
    snapshot: { ...base, members: present ? [{ name: "Example" }] : [] },
  });
  return { core, posts, items, actor, snapshot };
}
test("member removal posts an officer confirmation request", async () => {
  const { core, posts } = fixture();
  await core.memberRemoved({ id: "user", guild: { id: "guild" } });
  assert.equal(posts.length, 1);
  assert.match(JSON.stringify(posts[0]), /Confirm.*Keep/);
});
test("one missing snapshot does not flag", async () => {
  const { core, posts, snapshot } = fixture();
  await core.compareSnapshots([snapshot(1, true), snapshot(2, false)]);
  assert.equal(posts.length, 0);
});
test("two consecutive missing snapshots flag once", async () => {
  const { core, posts, snapshot } = fixture();
  const history = [snapshot(1, true), snapshot(2, false), snapshot(3, false)];
  await core.compareSnapshots(history);
  await core.compareSnapshots(history);
  assert.equal(posts.length, 1);
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
});
