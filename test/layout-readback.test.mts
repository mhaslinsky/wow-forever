import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  ChannelType,
  PermissionFlagsBits as flags,
  PermissionsBitField,
} from "discord.js";
import fc from "fast-check";
import {
  type Access,
  type Overwrite,
  parseLayout,
  plan,
  readback,
} from "../src/layout/index.mts";
import { model } from "./layout-model.mts";

function applied() {
  const layout = parseLayout(
    readFileSync(new URL("./fixtures/layout.yaml", import.meta.url), "utf8"),
  );
  layout.channels[0].access.member = {
    view: false,
    send: false,
    connect: false,
    manageThreads: false,
  };
  const server = model();
  const planned = plan(layout, server.snapshot, server.ids);
  assert.equal(planned.ok, true);
  planned.operations.forEach(server.apply);
  return { layout, ...server };
}

function oracle(base: bigint, overwrites: Overwrite[], roleId: string): bigint {
  if (base & flags.Administrator) return PermissionsBitField.All;
  let permissions = base;
  for (const target of new Set(["guild", roleId])) {
    const overwrite = overwrites.find(
      (entry) => entry.type === "role" && entry.id === target,
    );
    if (overwrite)
      permissions =
        (permissions & ~BigInt(overwrite.deny)) | BigInt(overwrite.allow);
  }
  return permissions & flags.ViewChannel ? permissions : 0n;
}

test("generated readback rows, including Administrator and above-app roles, agree with an independent oracle", () => {
  fc.assert(
    fc.property(
      fc.constantFrom("category", "text", "news", "forum", "voice"),
      fc.array(fc.nat(255), { minLength: 15, maxLength: 15 }),
      fc.array(fc.boolean(), { minLength: 4, maxLength: 4 }),
      (type, values, administrators) => {
        const { layout, snapshot, ids } = applied();
        const channel = layout.channels[0];
        channel.type = type;
        channel.tags = [];
        const live = snapshot.channels[0];
        live.type = {
          category: ChannelType.GuildCategory,
          text: ChannelType.GuildText,
          news: ChannelType.GuildAnnouncement,
          forum: ChannelType.GuildForum,
          voice: ChannelType.GuildVoice,
        }[type];
        layout.roles.push({
          ...layout.roles[2],
          key: "above",
          name: "Above",
          kind: "observed",
          permissions: {},
        });
        ids.roles.above = "above";
        snapshot.roles.push({
          ...snapshot.roles[2],
          id: "above",
          name: "Above",
          position: 200,
        });
        const bits = [
          flags.ViewChannel,
          flags.SendMessages,
          flags.SendMessagesInThreads,
          flags.CreatePublicThreads,
          flags.CreatePrivateThreads,
          flags.Connect,
          flags.Speak,
          flags.ManageThreads,
        ];
        const mask = (value: number) =>
          bits.reduce(
            (result, bit, index) =>
              value & (1 << index) ? result | bit : result,
            0n,
          );
        snapshot.roles.forEach((role, index) => {
          role.permissions = (
            mask(values[index]) |
            (administrators[index] ? flags.Administrator : 0n)
          ).toString();
          live.overwrites[index] = {
            id: role.id,
            type: "role",
            allow: mask(values[index + 4]).toString(),
            deny: mask(values[index + 8]).toString(),
          };
          const intent = values[index + 11];
          channel.access[layout.roles[index].key] = {
            view: Boolean(intent & 1),
            send: Boolean(intent & 1) && Boolean(intent & 2),
            connect:
              (type === "category" || type === "voice") &&
              Boolean(intent & 1) &&
              Boolean(intent & 4),
            manageThreads:
              type !== "voice" && Boolean(intent & 1) && Boolean(intent & 8),
          };
        });
        channel.access.operator = {
          view: true,
          send: true,
          connect: type === "category" || type === "voice",
          manageThreads: type !== "voice",
        };
        const before = structuredClone({ layout, snapshot, ids });
        const result = readback(layout, snapshot, ids);
        assert.equal(result.rows.length, layout.roles.length);
        for (const row of result.rows) {
          const role = snapshot.roles.find(
            (entry) => entry.id === ids.roles[row.roleKey],
          );
          assert.ok(role);
          const permissions = oracle(
            BigInt(snapshot.roles[0].permissions) | BigInt(role.permissions),
            live.overwrites,
            role.id,
          );
          const has = (required: bigint[]) =>
            required.every((bit) => Boolean(permissions & bit));
          assert.deepEqual(row.actual, {
            view: has([flags.ViewChannel]),
            send: has(
              type === "voice"
                ? [flags.SendMessages, flags.SendMessagesInThreads]
                : [
                    flags.SendMessages,
                    flags.SendMessagesInThreads,
                    flags.CreatePublicThreads,
                    flags.CreatePrivateThreads,
                  ],
            ),
            connect:
              (type === "voice" || type === "category") &&
              has([flags.Connect, flags.Speak]),
            manageThreads: type !== "voice" && has([flags.ManageThreads]),
          });
          assert.deepEqual(row.expected, channel.access[row.roleKey]);
        }
        const matches = result.rows.every((row) =>
          Object.keys(row.actual).every(
            (key) =>
              row.actual[key as keyof Access] ===
              row.expected[key as keyof Access],
          ),
        );
        const operatorMatches = administrators[1];
        assert.equal(result.ok, matches && operatorMatches);
        assert.deepEqual({ layout, snapshot, ids }, before);
      },
    ),
    { seed: 333, numRuns: 100 },
  );
});

test("clean readback passes and detects Member, everyone-only, and preserved integration leaks", () => {
  const { layout, snapshot, ids } = applied();
  assert.equal(readback(layout, snapshot, ids).ok, true);
  for (const key of ["member", "everyone"]) {
    const altered = structuredClone(snapshot);
    const overwrite = altered.channels[0].overwrites.find(
      (entry) => entry.id === ids.roles[key],
    );
    assert.ok(overwrite);
    overwrite.allow = flags.ViewChannel.toString();
    overwrite.deny = "0";
    layout.ignore.overwrites.push(key === "member" ? "Member" : "@everyone");
    const result = readback(layout, altered, ids);
    assert.equal(result.ok, false);
    assert.ok(
      result.errors.some((error) => error.startsWith(`lobby/${key}/view`)),
    );
  }
  layout.roles[2].kind = "observed";
  snapshot.roles[2].managed = true;
  snapshot.roles[2].applicationId = "integration";
  const integrationOverwrite = snapshot.channels[0].overwrites.find(
    (entry) => entry.id === ids.roles.member,
  );
  assert.ok(integrationOverwrite);
  integrationOverwrite.allow = flags.ViewChannel.toString();
  assert.equal(readback(layout, snapshot, ids).ok, false);
});

test("private member overwrites, missing expectations and incomplete inventories fail closed", () => {
  const server = applied();
  for (const change of [
    () => {
      server.snapshot.channels[0].overwrites.push({
        id: "synthetic-user",
        type: "member",
        allow: "0",
        deny: "0",
      });
    },
    () => {
      server.snapshot.roles.push({
        ...server.snapshot.roles[1],
        id: "unlisted-admin",
        applicationId: "other-app",
      });
    },
    () => {
      server.snapshot.roles.push({
        ...server.snapshot.roles[2],
        id: "unlisted-above",
        position: 200,
      });
    },
    () => {
      server.snapshot.roles.pop();
    },
    () => {
      server.snapshot.roles.shift();
    },
    () => {
      server.snapshot.roles.splice(1, 1);
    },
    () => {
      server.snapshot.channels = [];
    },
    () => {
      server.snapshot.channels[0].overwrites = undefined as never;
    },
    () => {
      server.snapshot.roles[0].permissions = "malformed";
    },
    () => {
      server.snapshot.channels[0].overwrites[0].allow = "-1";
    },
    () => {
      server.snapshot.channels.push(
        structuredClone(server.snapshot.channels[0]),
      );
    },
    () => {
      server.ids.roles.member = server.ids.roles.operator;
    },
    () => {
      server.snapshot.roles = undefined as never;
    },
  ]) {
    const before = structuredClone({
      layout: server.layout,
      snapshot: server.snapshot,
      ids: server.ids,
    });
    change();
    const result = readback(server.layout, server.snapshot, server.ids);
    assert.equal(result.ok, false);
    assert.ok(result.errors.length > 0);
    Object.assign(server, before);
  }
});

test("ignored channels report guild-grant exposure separately from managed mismatches", () => {
  const { layout, snapshot, ids } = applied();
  const ignored = {
    ...structuredClone(snapshot.channels[0]),
    id: "external",
    name: "External",
    overwrites: [] as Overwrite[],
  };
  snapshot.channels.push(ignored);
  layout.ignore.channels.push(ignored.name);
  assert.deepEqual(readback(layout, snapshot, ids).findings, [
    {
      channelId: "external",
      roleKey: "member",
      reason: "ignored channel visible through a guild grant",
    },
  ]);
  assert.equal(readback(layout, snapshot, ids).ok, false);
  assert.deepEqual(readback(layout, snapshot, ids).errors, []);
  ignored.overwrites.push({
    id: ids.roles.member,
    type: "role",
    allow: "0",
    deny: flags.ViewChannel.toString(),
  });
  assert.equal(readback(layout, snapshot, ids).ok, true);
  ignored.overwrites[0].allow = flags.ViewChannel.toString();
  assert.deepEqual(readback(layout, snapshot, ids).findings, []);
});
