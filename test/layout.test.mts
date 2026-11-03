import assert from "node:assert/strict";
import test from "node:test";
import {
  ChannelType as DiscordType,
  PermissionFlagsBits as flags,
} from "discord.js";
import fc from "fast-check";
import type { Layout, Overwrite } from "../src/layout/index.mts";
import {
  channelTypes,
  compilePermissions,
  normalizeBits,
  normalizeOverwrites,
  normalizeSnapshot,
  parseLayout,
  rolePermissions,
  validateLayout,
} from "../src/layout/index.mts";
import { access, applied, fixture } from "./layout-model.mts";

test("validation rejects malformed layouts and impossible access", () => {
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
    layout.roles[2].permissions.Administrator = true;
  }, /operator role/);
  invalid((layout) => {
    layout.roles[2].key = "everyone";
  }, /duplicate keys/);
  invalid((layout) => {
    layout.channels[0].access.operator = access();
  }, /Administrator must/);
  for (const field of ["roles", "channels", "overwrites"] as const) {
    invalid((layout) => {
      layout.ignore[field] = ["External", "External"];
    }, /duplicate keys/);
    invalid((layout) => {
      layout.ignore[field] = [" "];
    }, /nonempty/);
  }
  for (const value of [null, {}, { roles: "bad" }])
    assert.throws(() => validateLayout(value));
  assert.throws(
    () => parseLayout("roles: []\nroles: []"),
    /Map keys must be unique/,
  );
});

test("compiled access agrees with an independent effective-permission oracle", () => {
  fc.assert(
    fc.property(
      fc.constantFrom(...channelTypes),
      fc.tuple(fc.boolean(), fc.boolean(), fc.boolean(), fc.boolean()),
      fc.bigInt({ min: 0n, max: (1n << 53n) - 1n }),
      (type, values, base) => {
        const layout = fixture(),
          channel = layout.channels[0];
        channel.type = type;
        channel.tags = [];
        const [view, send, connect, manageThreads] = values;
        channel.access.member = {
          view,
          send: view && send,
          connect: view && connect && ["voice", "category"].includes(type),
          manageThreads: view && manageThreads && type !== "voice",
        };
        channel.access.operator = {
          view: true,
          send: true,
          connect: ["voice", "category"].includes(type),
          manageThreads: type !== "voice",
        };
        const before = structuredClone(layout);
        const overwrites = compilePermissions(validateLayout(layout), channel);
        let actual = base & ~flags.Administrator;
        for (const roleKey of ["everyone", "member"]) {
          const entry = overwrites.find((entry) => entry.roleKey === roleKey);
          assert.ok(entry);
          actual = (actual & ~BigInt(entry.deny)) | BigInt(entry.allow);
        }
        const masks = {
          view: flags.ViewChannel,
          send:
            flags.SendMessages |
            flags.SendMessagesInThreads |
            (type === "voice"
              ? 0n
              : flags.CreatePublicThreads | flags.CreatePrivateThreads),
          connect: ["voice", "category"].includes(type)
            ? flags.Connect | flags.Speak
            : 0n,
          manageThreads: type === "voice" ? 0n : flags.ManageThreads,
        };
        for (const field of [
          "view",
          "send",
          "connect",
          "manageThreads",
        ] as const)
          assert.equal(
            actual & masks[field],
            channel.access.member[field] ? masks[field] : 0n,
            field,
          );
        assert.deepEqual(layout, before);
      },
    ),
    { numRuns: 300 },
  );
  const role = fixture().roles[2];
  role.permissions.SendMessages = false;
  assert.deepEqual(rolePermissions(role), {
    allow: flags.ViewChannel,
    managed: flags.ViewChannel | flags.SendMessages,
  });
});

test("normalization preserves drift bits, defaults and rejects malformed bitfields", () => {
  const overwrite: Overwrite = {
    id: "guild",
    type: "role",
    allow: "0001",
    deny: "0",
  };
  const server = applied();
  const snapshot = normalizeSnapshot({
    ...server.snapshot,
    roles: [{ ...server.snapshot.roles[0], hoist: undefined }],
    channels: [
      {
        ...server.live(),
        topic: undefined,
        type: DiscordType.GuildStageVoice,
        overwrites: [overwrite],
      },
    ],
  });
  assert.equal(snapshot.channels[0].topic, "");
  assert.equal(snapshot.channels[0].type, DiscordType.GuildStageVoice);
  assert.equal(snapshot.channels[0].overwrites[0].allow, "1");
  assert.equal(snapshot.roles[0].hoist, false);
  for (const malformed of ["", "-1", "garbage", Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => normalizeBits(malformed));
  assert.throws(
    () => normalizeOverwrites([overwrite, overwrite]),
    /Duplicate overwrite/,
  );
});
