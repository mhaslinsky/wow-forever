import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  Collection,
  ChannelType as DiscordChannelType,
  PermissionFlagsBits as flags,
  GuildChannel,
  PermissionsBitField,
} from "discord.js";
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
  "CreatePublicThreads",
  "CreatePrivateThreads",
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
const expectedBits: [
  keyof typeof flags,
  keyof Access,
  readonly ChannelType[],
][] = [
  ["ViewChannel", "view", ["text", "news", "forum", "category", "voice"]],
  ["SendMessages", "send", ["text", "news", "forum", "category", "voice"]],
  [
    "SendMessagesInThreads",
    "send",
    ["text", "news", "forum", "category", "voice"],
  ],
  ["CreatePublicThreads", "send", ["text", "news", "forum", "category"]],
  ["CreatePrivateThreads", "send", ["text", "news", "forum", "category"]],
  ["Connect", "connect", ["voice", "category"]],
  ["Speak", "connect", ["voice", "category"]],
  ["ManageThreads", "manageThreads", ["text", "news", "forum", "category"]],
];
function locked(child: Overwrite[], category: Overwrite[]): boolean {
  const cache = (entries: Overwrite[]) =>
    new Collection(
      entries.map((entry) => [
        entry.id,
        {
          allow: new PermissionsBitField(BigInt(entry.allow)),
          deny: new PermissionsBitField(BigInt(entry.deny)),
        },
      ]),
    );
  const getter = Object.getOwnPropertyDescriptor(
    GuildChannel.prototype,
    "permissionsLocked",
  )?.get;
  assert.ok(getter);
  return getter.call({
    guildId: "everyone",
    permissionOverwrites: { cache: cache(child) },
    parent: { permissionOverwrites: { cache: cache(category) } },
  });
}

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
    send: view && send,
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
        const checks = expectedBits.filter(([, , types]) =>
          types.includes(type),
        );
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
          for (const [permission, access] of checks)
            assert.equal(
              (actual & flags[permission]) !== 0n,
              channel.access[role.key][access],
            );
        }
        assert.deepEqual(layout, before);
      },
    ),
    { numRuns: 300 },
  );
});

test("protective overwrites unsync equivalent inputs without widening access", () => {
  fc.assert(
    fc.property(
      fc.constantFrom(...channelTypes),
      maskArbitrary,
      maskArbitrary,
      maskArbitrary,
      maskArbitrary,
      maskArbitrary,
      fc.constantFrom("none", "child", "category"),
      (
        type,
        everyoneAllow,
        everyoneDeny,
        memberAllow,
        memberDeny,
        base,
        emptyMode,
      ) => {
        let overwrites: Overwrite[] = [
          {
            id: "everyone",
            type: "role",
            allow: emptyMode === "none" ? everyoneAllow.toString() : "0",
            deny: emptyMode === "none" ? everyoneDeny.toString() : "0",
          },
          {
            id: "member",
            type: "role",
            allow: memberAllow.toString(),
            deny: memberDeny.toString(),
          },
        ];
        let category = [...overwrites]
          .reverse()
          .map(({ allow, deny, id, type }) => ({ deny, allow, id, type }));
        if (emptyMode === "child")
          overwrites = overwrites.filter((entry) => entry.id !== "everyone");
        if (emptyMode === "category")
          category = category.filter((entry) => entry.id !== "everyone");
        const original = structuredClone(overwrites);
        assert.equal(locked(overwrites, category), true);
        const protectedList = protectiveOverwrite(
          { type, everyoneId: "everyone", overwrites },
          { overwrites: category },
        );
        assert.equal(locked(protectedList, category), false);
        for (const roleId of ["everyone", "member"]) {
          assert.equal(
            effective(base, protectedList, roleId) &
              ~effective(base, overwrites, roleId),
            0n,
          );
          const previous = overwrites.find((entry) => entry.id === roleId);
          const current = protectedList.find((entry) => entry.id === roleId);
          assert.equal(
            BigInt(current?.allow ?? "0") & ~BigInt(previous?.allow ?? "0"),
            0n,
          );
        }
        assert.deepEqual(overwrites, original);
      },
    ),
    { numRuns: 300 },
  );
  for (const type of channelTypes) {
    const overwrites = [
      { id: "everyone", type: "role" as const, allow: "0", deny: "0" },
    ];
    const result = protectiveOverwrite(
      { type, everyoneId: "everyone", overwrites },
      { overwrites },
    );
    assert.equal(result[0].deny, flags.ViewChannel.toString());
    const common =
      flags.ViewChannel |
      flags.ReadMessageHistory |
      flags.SendMessages |
      flags.SendMessagesInThreads;
    overwrites[0].deny = common.toString();
    assert.equal(
      BigInt(
        protectiveOverwrite(
          { type, everyoneId: "everyone", overwrites },
          { overwrites },
        )[0].deny,
      ) & ~common,
      type === "voice" ? flags.Connect : flags.CreatePublicThreads,
    );
  }
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
        type: DiscordChannelType.GuildStageVoice,
        position: 0,
        overwrites: [
          { id: "everyone", type: "role", allow: "0001", deny: "0" },
        ],
      },
    ],
  });
  assert.equal(snapshot.channels[0].topic, "");
  assert.equal(snapshot.channels[0].type, DiscordChannelType.GuildStageVoice);
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

test("ignore names are nonempty and unique; omitted voice send denies text", () => {
  const layout = fixture();
  for (const field of ["roles", "channels", "overwrites"] as const) {
    layout.ignore[field] = ["External"];
    assert.deepEqual(validateLayout(layout).ignore[field], ["External"]);
    layout.ignore[field] = ["External", "External"];
    assert.throws(() => validateLayout(layout), /duplicate keys/);
    layout.ignore[field] = [" "];
    assert.throws(() => validateLayout(layout), /nonempty/);
    layout.ignore[field] = [];
  }
  const channel = layout.channels[0];
  channel.type = "voice";
  channel.tags = [];
  channel.access = Object.fromEntries(
    layout.roles.map((role) => [
      role.key,
      cell("voice", [true, true, true, true]),
    ]),
  );
  Reflect.deleteProperty(channel.access.member, "send");
  const validated = validateLayout(layout);
  assert.equal(validated.channels[0].access.member.send, false);
  const member = compilePermissions(validated, validated.channels[0]).find(
    (entry) => entry.roleKey === "member",
  );
  assert.ok(member);
  assert.equal(
    BigInt(member.deny) & (flags.SendMessages | flags.SendMessagesInThreads),
    flags.SendMessages | flags.SendMessagesInThreads,
  );
  const unordered = [
    { deny: "0", id: "a", allow: "0", type: "role" as const },
    { id: "Z", type: "role" as const, allow: "0", deny: "0" },
  ];
  assert.deepEqual(
    normalizeOverwrites(unordered).map((entry) => entry.id),
    ["Z", "a"],
  );
  assert.deepEqual(Object.keys(normalizeOverwrites(unordered)[0]), [
    "type",
    "id",
    "allow",
    "deny",
  ]);
});
