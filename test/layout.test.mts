import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PermissionFlagsBits as flags, PermissionsBitField } from "discord.js";
import fc from "fast-check";
import type {
  Access,
  ChannelType,
  Layout,
  Overwrite,
} from "../src/layout/index.mts";
import {
  channelTypes,
  compilePermissions,
  normalizeBits,
  normalizeOverwrites,
  normalizeSnapshot,
  parseLayout,
  protectiveOverwrite,
  rolePermissions,
  validateLayout,
} from "../src/layout/index.mts";

const fixture = () =>
  parseLayout(
    readFileSync(new URL("./fixtures/layout.yaml", import.meta.url), "utf8"),
  );
const names = [
  "ViewChannel",
  "SendMessages",
  "SendMessagesInThreads",
  "Connect",
  "Speak",
  "ManageThreads",
  "CreateInstantInvite",
] as const;
const bits = (permissions: readonly string[]) =>
  permissions.reduce(
    (mask, name) => mask | flags[name as keyof typeof flags],
    0n,
  );
const maskArbitrary = fc.subarray([...names]).map(bits);
function effective(
  base: bigint,
  overwrites: Overwrite[],
  roleId: string,
): bigint {
  if ((base & flags.Administrator) !== 0n) return PermissionsBitField.All;
  let result = base;
  for (const id of roleId === "everyone"
    ? ["everyone"]
    : ["everyone", roleId]) {
    const overwrite = overwrites.find(
      (entry) => entry.type === "role" && entry.id === id,
    );
    if (overwrite)
      result = (result & ~BigInt(overwrite.deny)) | BigInt(overwrite.allow);
  }
  return (result & flags.ViewChannel) === 0n ? 0n : result;
}
function cell(type: ChannelType, values: boolean[]): Access {
  const [view, send, connect, manageThreads] = values;
  return {
    view,
    send: view && type !== "voice" && send,
    connect: view && (type === "voice" || type === "category") && connect,
    manageThreads: view && type !== "voice" && manageThreads,
  };
}

test("validation rejects empty coverage, impossible access, Administrator and duplicate identities", () => {
  const invalid = (mutate: (layout: Layout) => void, message: RegExp) => {
    const layout = fixture();
    mutate(layout);
    assert.throws(() => validateLayout(layout), message);
  };
  invalid((layout) => {
    layout.channels[0].access = {};
  }, /coverage/);
  invalid((layout) => {
    layout.channels[0].access.member.view = false;
  }, /view denied/);
  invalid((layout) => {
    layout.roles[2].permissions = { Administrator: true };
  }, /operator role/);
  invalid((layout) => {
    layout.roles[2].key = "everyone";
  }, /duplicate keys/);
  invalid((layout) => {
    layout.channels[0].access.operator.view = false;
    layout.channels[0].access.operator.send = false;
    layout.channels[0].access.operator.manageThreads = false;
  }, /Administrator must/);
  assert.throws(
    () => parseLayout("roles: []\nroles: []"),
    /Map keys must be unique/,
  );
  for (const value of [null, {}, { roles: "bad" }])
    assert.throws(() => validateLayout(value));
});

test("compiled access agrees with an independent effective-permission oracle", () => {
  fc.assert(
    fc.property(
      fc.constantFrom(...channelTypes),
      fc.array(fc.boolean(), { minLength: 8, maxLength: 8 }),
      fc.subarray([...names]),
      fc.subarray([...names]),
      (type, values, everyonePermissions, memberPermissions) => {
        const layout = fixture();
        const channel = layout.channels[0];
        layout.roles[0].permissions = Object.fromEntries(
          everyonePermissions.map((name) => [name, true]),
        );
        layout.roles[2].permissions = Object.fromEntries(
          memberPermissions.map((name) => [name, true]),
        );
        channel.type = type;
        channel.tags = [];
        channel.access.everyone = cell(type, values.slice(0, 4));
        channel.access.member = cell(type, values.slice(4));
        channel.access.operator = cell(type, [true, true, true, true]);
        validateLayout(layout);
        const before = structuredClone(layout);
        const overwrites = compilePermissions(layout, channel).map(
          ({ roleKey, ...overwrite }) => ({ ...overwrite, id: roleKey }),
        );
        const checks: [keyof Access, bigint][] = [["view", flags.ViewChannel]];
        if (type !== "voice")
          checks.push(
            ["send", flags.SendMessages],
            ["manageThreads", flags.ManageThreads],
          );
        if (type === "forum" || type === "category")
          checks.push(["send", flags.SendMessagesInThreads]);
        if (type === "voice" || type === "category")
          checks.push(["connect", flags.Connect], ["connect", flags.Speak]);
        for (const role of layout.roles) {
          const actual = effective(
            bits(names) |
              bits(everyonePermissions) |
              bits(
                Object.keys(role.permissions).filter(
                  (name) => role.permissions[name],
                ),
              ),
            overwrites,
            role.key,
          );
          for (const [access, bit] of checks)
            assert.equal(
              (actual & bit) !== 0n,
              channel.access[role.key][access],
            );
        }
        assert.deepEqual(layout, before);
      },
    ),
    { numRuns: 300 },
  );
});

test("protective overwrites never widen access and always differ from a synced category", () => {
  fc.assert(
    fc.property(
      maskArbitrary,
      maskArbitrary,
      maskArbitrary,
      maskArbitrary,
      maskArbitrary,
      (everyoneAllow, everyoneDeny, memberAllow, memberDeny, base) => {
        const overwrites: Overwrite[] = [
          {
            id: "everyone",
            type: "role",
            allow: everyoneAllow.toString(),
            deny: everyoneDeny.toString(),
          },
          {
            id: "member",
            type: "role",
            allow: memberAllow.toString(),
            deny: memberDeny.toString(),
          },
        ];
        const original = structuredClone(overwrites);
        const protectedList = protectiveOverwrite(
          { everyoneId: "everyone", overwrites },
          { overwrites },
        );
        assert.notDeepEqual(protectedList, overwrites);
        for (const roleId of ["everyone", "member"]) {
          assert.equal(
            effective(base, protectedList, roleId) &
              ~effective(base, overwrites, roleId),
            0n,
          );
          const previous = overwrites.find((entry) => entry.id === roleId);
          const current = protectedList.find((entry) => entry.id === roleId);
          assert.ok(previous && current);
          assert.equal(BigInt(current.allow) & ~BigInt(previous.allow), 0n);
        }
        assert.deepEqual(overwrites, original);
      },
    ),
    { numRuns: 300 },
  );
  assert.equal(
    protectiveOverwrite(
      { everyoneId: "everyone", overwrites: [] },
      { overwrites: [] },
    )[0].allow,
    "0",
  );
});

test("normalization preserves drift bits and defaults missing topic and flags", () => {
  const snapshot = normalizeSnapshot({
    guildId: "synthetic",
    applicationId: "synthetic-app",
    roles: [
      { id: "everyone", name: "@everyone", permissions: 0n, position: 0 },
    ],
    channels: [
      {
        id: "lobby",
        name: "lobby",
        type: "text",
        position: 0,
        overwrites: [
          { id: "everyone", type: "role", allow: "0001", deny: "0" },
        ],
      },
    ],
  });
  assert.equal(snapshot.channels[0].topic, "");
  assert.equal(snapshot.channels[0].overwrites[0].allow, "1");
  assert.equal(snapshot.roles[0].hoist, false);
  const role = fixture().roles[2];
  role.permissions.SendMessages = false;
  assert.deepEqual(rolePermissions(role), {
    allow: flags.ViewChannel,
    managed: flags.ViewChannel | flags.SendMessages,
  });
  for (const malformed of ["", "-1", "garbage", Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => normalizeBits(malformed));
  const overwrite = snapshot.channels[0].overwrites[0];
  assert.throws(
    () => normalizeOverwrites([overwrite, overwrite]),
    /Duplicate overwrite/,
  );
});
