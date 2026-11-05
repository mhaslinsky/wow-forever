import assert from "node:assert/strict";
import test from "node:test";
import { createPrincipalFactory } from "../src/auth/index.mts";
import { createDataAccess } from "../src/data/index.mts";
import { type GuildRecord, recordKey } from "../src/data/records.mts";
import { normalize } from "../src/guildos/index.mts";
import { createLootCouncil } from "../src/loot-council/core.mts";
import { createLootCouncilRoutes } from "../src/loot-council/interactions.mts";

function fixture(evidence = true) {
  const time = 1_800_000_000_000;
  const start = time / 1000 - 3600;
  const records: GuildRecord[] = [];
  function add(
    kind: GuildRecord["kind"],
    ownerId: string,
    id: string,
    fields: object,
  ) {
    records.push({
      ...recordKey(kind, ownerId, id),
      kind,
      ownerId,
      ...fields,
    } as GuildRecord);
  }
  add("signup", "guild", "raid", {
    raidId: "raid",
    startTime: String(start),
    signUps: "[]",
    polledAt: "synthetic",
  });
  for (const owner of ["first", "second"]) {
    add("member", owner, "guild", {
      name: owner,
      roster: evidence
        ? [
            {
              name: owner,
              class: "Priest",
              spec: "Holy",
              raidRole: "Healer",
              main: true,
              confirmed: true,
            },
          ]
        : [],
    });
    add("wishlist", owner, `guild:revision`, {
      item: JSON.stringify({
        savedAt: time - 172_800_000,
        items: owner === "first" ? ["Sword"] : ["Ring", "Sword"],
      }),
    });
  }
  if (evidence) {
    add("attendance", "guild", "past", {
      raidId: "past",
      source: "voice",
      attendees: JSON.stringify([{ memberId: "first", source: "voice" }]),
    });
    const snapshot = normalize({
      fmt: "GOSCOMP1",
      v: 14,
      game: "FOREVER",
      guildKey: "example",
      guildName: "Example",
      realm: "Example",
      exportedAt: time / 1000,
      exportedBy: "synthetic",
      addonVersion: "synthetic",
      count: 0,
      members: [],
      loot: [
        {
          playerKey: "first-example",
          player: "first",
          itemId: 1,
          itemName: "Old Ring",
          quality: 4,
          timestamp: time / 1000 - 60,
          raid: "past",
        },
      ],
    });
    add(
      "guildSnapshot",
      snapshot.guildKey,
      `${String(snapshot.exportedAt).padStart(16, "0")}#${"a".repeat(64)}`,
      {
        snapshotId: "a".repeat(64),
        addonVersion: snapshot.addonVersion,
        exportedAt: snapshot.exportedAt,
        receivedAt: time,
        writtenAt: time,
        snapshotVersion: 1,
        snapshot,
      },
    );
  }
  const data = createDataAccess({
    get: async (key) =>
      records.find((entry) => entry.pk === key.pk && entry.sk === key.sk),
    batch: async () => [],
    query: async (partition, index) => ({
      items: records.filter((entry) =>
        index
          ? `${entry.pk.split("#")[0]}#ALL` === partition
          : entry.pk === partition,
      ),
    }),
    put: async (record) => {
      const previous = records.findIndex(
        (entry) => entry.pk === record.pk && entry.sk === record.sk,
      );
      if (previous >= 0) records[previous] = record;
      else records.push(record);
    },
  });
  const factory = createPrincipalFactory({
    guildId: "guild",
    memberRoleId: "member",
    officerRoleId: "officer",
    jobs: {},
  });
  const actor = (id: string, role = "officer") =>
    factory.fromVerifiedInteraction({
      guild_id: "guild",
      member: { user: { id }, roles: [role] },
    });
  const core = createLootCouncil(data, {
    guildId: "guild",
    guildKey: evidence
      ? records.find((entry) => entry.kind === "guildSnapshot")?.ownerId
      : undefined,
    lockMinutes: 60,
    now: () => time,
  });
  return { core, records, actor, start };
}

test("vote posts both contenders with locked rank, attendance source, recent loot and raid role", async () => {
  const setup = fixture();
  const post = await setup.core.start(setup.actor("officer"), "vote", "Sword");
  assert.equal(post.embeds[0].fields.length, 2);
  assert.equal(post.components[0].components[0].options.length, 2);
  assert.match(
    post.embeds[0].fields[0].value,
    /<@first>\nWishlist: 1\nAttendance: 100% \(voice\)\nRecent loot: Old Ring\nRole: Healer/,
  );
  assert.match(
    post.embeds[0].fields[1].value,
    /<@second>\nWishlist: 2\nAttendance: 0% \(voice\)\nRecent loot: no data/,
  );
  const sparse = fixture(false);
  sparse.records.splice(
    sparse.records.findIndex(
      (entry) => entry.kind === "member" && entry.ownerId === "first",
    ),
    1,
  );
  const pages = await sparse.core.start(
    sparse.actor("officer"),
    "empty",
    "Sword",
  );
  assert.equal(pages.embeds[0].fields.length, 2);
  assert.match(
    pages.embeds[0].fields[0].value,
    /Attendance: no data\nRecent loot: no data\nRole: no data/,
  );
  const revision = sparse.records.find((entry) => entry.kind === "wishlist");
  assert.ok(revision?.kind === "wishlist");
  for (let index = 0; index < 25; index++) {
    const ownerId = `extra-${index}`;
    sparse.records.push({
      ...revision,
      ...recordKey("wishlist", ownerId, "guild:revision"),
      ownerId,
    });
  }
  const capped = await sparse.core.start(
    sparse.actor("officer"),
    "large",
    "Sword",
  );
  assert.equal(capped.embeds[0].fields.length, 25);
  assert.equal(capped.components[0].components[0].options.length, 25);
  assert.equal(capped.content, "2 contenders left out");
  assert.ok(capped.embeds[0].fields.every((field) => field.name !== "second"));
});

test("each officer has one persistent changeable ballot and members cannot start or vote", async () => {
  const { core, records, actor } = fixture(false);
  await core.start(actor("officer"), "vote", "Sword");
  await core.vote(actor("officer"), "vote", "first");
  await core.vote(actor("other"), "vote", "first");
  const [, select] = createLootCouncilRoutes(async () => ({
    actor: actor("officer"),
    core,
    post: async () => {},
  }));
  await select.handler(
    {
      id: "change",
      application_id: "app",
      token: "synthetic",
      type: 3,
      data: { custom_id: "lc-vote:vote", values: ["second"] },
    },
    new AbortController().signal,
  );
  assert.deepEqual(
    records
      .filter((entry) => entry.kind === "lootBallot")
      .map((entry) => [entry.sk, entry.contenderId]),
    [
      ["LOOT_BALLOT#officer", "second"],
      ["LOOT_BALLOT#other", "first"],
    ],
  );
  await assert.rejects(
    core.vote(actor("member", "member"), "vote", "first"),
    /OFFICER_REQUIRED/,
  );
  await assert.rejects(
    core.start(actor("member", "member"), "denied", "Sword"),
    /OFFICER_REQUIRED/,
  );
});

test("raid selection rejects missing or malformed values and accepts an explicit stored raid", async () => {
  const { core, records, actor, start } = fixture(false);
  await assert.rejects(
    core.start(actor("officer"), "bad", "Sword", "invalid"),
    /RAID_NOT_FOUND/,
  );
  const signup = records.find((entry) => entry.kind === "signup");
  assert.ok(signup?.kind === "signup");
  signup.startTime = String(start - 86_400);
  await assert.rejects(
    core.start(actor("officer"), "missing", "Sword"),
    /RAID_NOT_FOUND/,
  );
  assert.equal(
    (await core.start(actor("officer"), "chosen", "Sword", signup.startTime))
      .embeds[0].fields.length,
    2,
  );
});
