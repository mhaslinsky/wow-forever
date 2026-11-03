import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { createPrincipalFactory } from "../src/auth/index.mts";
import {
  createDataAccess,
  type QueryCursor,
  type StoragePort,
} from "../src/data/index.mts";
import { type GuildRecord, recordKey } from "../src/data/records.mts";

export const principals = createPrincipalFactory({
  guildId: "guild",
  memberRoleId: "member-role",
  officerRoleId: "officer-role",
  jobs: { digest: ["raid"] },
});
export const principal = (roles: string[], userId = "asker") =>
  principals.fromVerifiedInteraction({
    guild_id: "guild",
    member: { user: { id: userId }, roles },
  });
const member = principal(["member-role"]);
const officer = principal(["officer-role"]);
export const candidate = {
  ...recordKey("candidate", "other", "entry"),
  kind: "candidate",
  ownerId: "other",
  name: "Synthetic",
} as const;

function fixture(items: unknown[], overrides: Partial<StoragePort> = {}) {
  const writes: GuildRecord[] = [];
  let invalid = 0;
  const storage: StoragePort = {
    get: async (key) =>
      items.find(
        (raw) =>
          raw &&
          typeof raw === "object" &&
          "pk" in raw &&
          "sk" in raw &&
          raw.pk === key.pk &&
          raw.sk === key.sk,
      ),
    query: async (_partition, _index, cursor) =>
      cursor
        ? { items: items.slice(1) }
        : {
            items: items.slice(0, 1),
            cursor: { pk: "page", sk: "next" } as unknown as QueryCursor,
          },
    batch: async () => items,
    put: async (item) => {
      writes.push(item);
    },
    ...overrides,
  };
  return {
    data: createDataAccess(storage, () => {
      invalid++;
    }),
    writes,
    invalid: () => invalid,
  };
}

function failing(name: string) {
  const fail = async (): Promise<never> => {
    throw Object.assign(new Error("private SDK item image"), { name });
  };
  return fixture([], { get: fail, put: fail }).data.forUser(officer);
}

test("member candidate reads equal missing; officer receives candidate; unknown kinds are denied", async () => {
  const { data, invalid } = fixture([
    candidate,
    { pk: "bad", sk: "bad", kind: "unknown" },
  ]);
  assert.deepEqual(await data.forUser(member).get(candidate), []);
  assert.deepEqual(
    await data.forUser(member).get({ pk: "missing", sk: "missing" }),
    [],
  );
  assert.deepEqual(await data.forUser(officer).get(candidate), [candidate]);
  assert.deepEqual(
    await data.forUser(officer).batch([candidate, { pk: "bad", sk: "bad" }]),
    [candidate],
  );
  assert.equal(invalid(), 1);
});

test("adversarial raw items never leak across Get, multi-page Query, GSI and BatchGet", async () => {
  const requiredRole = {
    candidate: "Officer",
    officerNote: "Officer",
    lootDecision: "Officer",
    member: "Member",
    character: "Member",
    raid: "Member",
    attendance: "Member",
    lootAward: "Member",
    wishlist: "Member",
    fact: "Owner",
  } as const;
  const fields = {
    candidate: ["name"],
    officerNote: ["text"],
    lootDecision: ["winner", "votes", "decidingOfficer", "reason"],
    member: ["name"],
    character: ["name"],
    raid: ["date"],
    attendance: ["raidId"],
    lootAward: ["item", "winner", "raidId", "date"],
    wishlist: ["item"],
    fact: ["text"],
  } as const;
  const prefixes = {
    candidate: "CANDIDATE",
    officerNote: "OFFICER_NOTE",
    lootDecision: "LOOT_DECISION",
    member: "MEMBER",
    character: "CHARACTER",
    raid: "RAID",
    attendance: "ATTENDANCE",
    lootAward: "LOOT_AWARD",
    wishlist: "WISHLIST",
    fact: "FACT",
  };
  const kindArbitrary = fc.constantFrom(
    ...(Object.keys(requiredRole) as (keyof typeof requiredRole)[]),
  );
  await fc.assert(
    fc.asyncProperty(
      fc.array(
        fc.record({
          kind: kindArbitrary,
          owner: fc.constantFrom("asker", "other"),
          defect: fc.constantFrom(
            "valid",
            "unknown",
            "prefix",
            "skPrefix",
            "emptyId",
            "missing",
            "malformed",
            "extra",
          ),
        }),
        { minLength: 1, maxLength: 20 },
      ),
      fc.subarray(["Member", "Officer"]),
      async (records, roles) => {
        const raw = records.map((record, index) => ({
          kind: record.kind,
          pk: `${prefixes[record.kind]}#${record.owner}`,
          sk: `${prefixes[record.kind]}#${index}`,
          ownerId: record.owner,
          ...Object.fromEntries(
            fields[record.kind].map((field) => [field, "synthetic"]),
          ),
          ...(record.defect === "unknown" ? { kind: "future" } : {}),
          ...(record.defect === "prefix" ? { pk: `MEMBER#disguised` } : {}),
          ...(record.defect === "skPrefix"
            ? {
                sk: `${record.kind === "member" ? "CANDIDATE" : "MEMBER"}#${index}`,
              }
            : {}),
          ...(record.defect === "emptyId"
            ? { sk: `${prefixes[record.kind]}#` }
            : {}),
          ...(record.defect === "missing" ? { ownerId: undefined } : {}),
          ...(record.defect === "malformed"
            ? { [fields[record.kind][0]]: 42 }
            : {}),
          ...(record.defect === "extra"
            ? { privateNote: "secret", reason: "secret", visibility: "Member" }
            : {}),
        }));
        const expected = raw.flatMap((item, index) => {
          const generated = records[index];
          if (!["valid", "extra"].includes(generated.defect)) return [];
          const role = requiredRole[generated.kind];
          const allowed =
            role === "Owner"
              ? item.ownerId === "asker" &&
                (roles.includes("Member") || roles.includes("Officer"))
              : roles.includes("Officer") ||
                (role === "Member" && roles.includes("Member"));
          if (!allowed) return [];
          return [
            {
              kind: generated.kind,
              pk: item.pk,
              sk: item.sk,
              ownerId: item.ownerId,
              ...Object.fromEntries(
                fields[generated.kind].map((field) => [
                  field,
                  Reflect.get(item, field),
                ]),
              ),
            },
          ];
        });
        const api = fixture(raw).data.forUser(
          principal(roles.map((role) => `${role.toLowerCase()}-role`)),
        );
        assert.deepEqual(await api.query("partition"), expected);
        assert.deepEqual(await api.lookup("index"), expected);
        assert.deepEqual(await api.batch(raw), expected);
        for (const item of raw) {
          assert.deepEqual(
            await api.get(item),
            expected.filter((result) => result.sk === item.sk),
          );
        }
      },
    ),
    { numRuns: 150 },
  );
});

test("current Member-only evidence revokes a cached Officer; missing evidence fails closed", async () => {
  const data = fixture([candidate]).data;
  assert.equal((await data.forUser(officer).get(candidate)).length, 1);
  type GatewayEvent = Parameters<typeof principals.fromGateway>[0];
  const excludedRole: Exclude<"currentRoleIds", keyof GatewayEvent> =
    "currentRoleIds";
  assert.equal(excludedRole, "currentRoleIds");
  let fetches = 0;
  const event = {
    guildId: "guild",
    userId: "asker",
    currentRoleIds: ["officer-role"],
  };
  const current = await principals.fromGateway(
    event,
    async (guildId, userId) => {
      fetches++;
      assert.deepEqual([guildId, userId], ["guild", "asker"]);
      return { userId, roleIds: ["member-role"] };
    },
  );
  assert.equal(fetches, 1);
  assert.deepEqual(await data.forUser(current).get(candidate), []);
  for (const fetchMember of [
    async () => undefined,
    async () => {
      throw new Error("offline");
    },
  ]) {
    const missing = await principals.fromGateway(
      { guildId: "guild", userId: "asker" },
      fetchMember,
    );
    assert.deepEqual(await data.forUser(missing).get(candidate), []);
  }
  const fresh = await principals.fromGateway(
    { guildId: "guild", userId: "asker" },
    async () => ({ userId: "asker", roleIds: ["officer-role"] }),
  );
  assert.equal((await data.forUser(fresh).get(candidate)).length, 1);
});

test("paginated GSI queries preserve the exact opaque cursor", async () => {
  const cursor = {
    pk: "page",
    sk: "next",
    gsi1pk: "index",
    gsi1sk: "position",
  } as unknown as QueryCursor;
  const cursors: (QueryCursor | undefined)[] = [];
  const { data } = fixture([], {
    query: async (_partition, index, received) => {
      assert.equal(index, true);
      cursors.push(received);
      return received ? { items: [candidate] } : { items: [], cursor };
    },
  });
  assert.deepEqual(await data.forUser(officer).lookup("index"), [candidate]);
  assert.equal(cursors.length, 2);
  assert.equal(cursors[0], undefined);
  assert.equal(cursors[1], cursor);
});

test("write policy enforces officer recording, self ownership, fact stamping and declared jobs", async () => {
  const { data, writes } = fixture([]);
  const fact = {
    ...recordKey("fact", "asker", "memory"),
    kind: "fact",
    text: "Synthetic",
  } as const;
  await data.forUser(member).write(fact);
  assert.equal(writes[0].ownerId, "asker");
  await assert.rejects(
    data.forUser(member).write({ ...fact, ownerId: "other" }),
    /WRITE_DENIED/,
  );
  await assert.rejects(data.forUser(member).write(candidate), /WRITE_DENIED/);
  const raid = {
    ...recordKey("raid", "other", "event"),
    kind: "raid",
    ownerId: "other",
    date: "synthetic",
  } as const;
  await assert.rejects(data.forUser(member).write(raid), /WRITE_DENIED/);
  await data.forUser(officer).write(raid);
  const self = {
    ...recordKey("member", "asker", "profile"),
    kind: "member",
    ownerId: "asker",
    name: "Synthetic",
    reason: "secret",
  } as const;
  await data.forUser(member).write(self);
  assert.equal("reason" in writes[2], false);
  await assert.rejects(
    data.forUser(member).write({
      ...self,
      ownerId: "other",
      ...recordKey("member", "other", "profile"),
    }),
    /WRITE_DENIED/,
  );
  const job = data.forSystem(principals.systemPrincipal("digest"));
  await job.write(raid);
  await assert.rejects(job.write(candidate), /WRITE_DENIED/);
});

test("malformed records emit a metric; storage failures expose only fixed codes", async () => {
  const { data, invalid } = fixture([
    null,
    {},
    { ...candidate, sk: "MEMBER#bad" },
  ]);
  assert.deepEqual(await data.forUser(officer).query("partition"), []);
  assert.equal(invalid(), 3);
  const api = failing("Error");
  await assert.rejects(api.get(candidate), /^Error: DATA_UNAVAILABLE$/);
  await assert.rejects(api.write(candidate), /^Error: DATA_UNAVAILABLE$/);
});

test("conditional writes expose WRITE_CONFLICT without the SDK item image", async () => {
  const api = failing("ConditionalCheckFailedException");
  await assert.rejects(api.write(candidate), /^Error: WRITE_CONFLICT$/);
});
