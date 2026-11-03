import assert from "node:assert/strict";
import test from "node:test";
import { ChannelType, PermissionFlagsBits as flags } from "discord.js";
import {
  compilePermissions,
  plan,
  protectionTargets,
  validateLayout,
} from "../src/layout/index.mts";
import {
  access,
  applied,
  canView,
  category,
  fixture,
  model,
} from "./layout-model.mts";

test("ignored and unbound children matching any category state block changes", () => {
  const layout = fixture(),
    child = layout.channels[0];
  child.access.member = access();
  const parent = category(layout);
  child.parent = parent.key;
  layout.channels.push(parent);
  const server = applied(layout),
    { snapshot, ids } = server;
  const external = {
    ...structuredClone(server.live("category")),
    id: "external",
    name: "External",
    parent: ids.channels.category,
    type: server.live().type,
  };
  snapshot.channels.push(external);
  layout.ignore.channels.push(external.name);
  parent.access.member = access(true, true);
  const final = compilePermissions(layout, parent).map(
    ({ roleKey, ...entry }) => ({ ...entry, id: ids.roles[roleKey] }),
  );
  const select = () =>
    protectionTargets(layout, snapshot, ids, {
      touched: new Set([parent.key]),
      roleBitsChanged: false,
      recreated: new Set(),
      finalOverwrites: new Map([[parent.key, final]]),
    });
  const selection = select();
  assert.equal(plan(layout, snapshot, ids).ok, false);
  assert.match(selection.errors[0], /ignored channel External.*unsync/);
  const protectedParent = selection.channels.find(
    (target) => target.key === parent.key,
  );
  assert.ok(protectedParent);
  for (const state of [final, protectedParent.overwrites]) {
    external.overwrites = structuredClone(state);
    assert.equal(select().errors.length, 1);
  }
  layout.ignore.channels = [];
  assert.match(select().errors[0], /unbound channel External/);
  layout.ignore.channels.push(external.name);
  external.overwrites = [
    {
      id: "guild",
      type: "role",
      allow: "0",
      deny: flags.ManageMessages.toString(),
    },
  ];
  const before = structuredClone(external.overwrites);
  server.run();
  assert.deepEqual(external.overwrites, before);
});

test("undeclared Administrator blocks; explicit removal keeps Member hidden", () => {
  const layout = fixture();
  layout.channels[0].access.member = access();
  const server = applied(layout),
    { snapshot, ids } = server,
    member = snapshot.roles[2];
  member.permissions = (flags.Administrator | flags.ViewChannel).toString();
  server.live().overwrites = [
    {
      id: member.id,
      type: "role",
      allow: flags.ViewChannel.toString(),
      deny: "0",
    },
  ];
  const blocked = plan(layout, snapshot, ids);
  assert.equal(blocked.ok, false);
  assert.match(
    blocked.errors.join(),
    /member.*Administrator|Administrator.*member/,
  );
  layout.roles[2].permissions.Administrator = false;
  const result = plan(layout, snapshot, ids);
  assert.equal(result.ok, true);
  for (const operation of result.operations) {
    server.apply(operation);
    if (!(BigInt(member.permissions) & flags.Administrator))
      assert.equal(
        canView(snapshot, ids.channels.lobby, member.id),
        false,
        operation.kind,
      );
  }
  assert.equal(BigInt(member.permissions) & flags.Administrator, 0n);
});

test("operator capabilities survive removals and protection preserves visibility", () => {
  const layout = fixture(),
    server = model(),
    { snapshot, ids } = server;
  snapshot.roles[0].permissions = (
    flags.ManageRoles | flags.ManageChannels
  ).toString();
  snapshot.roles[1].permissions = flags.ViewChannel.toString();
  layout.roles[1].permissions = { ViewChannel: true };
  layout.roles[0].permissions = { ManageRoles: false, ManageChannels: false };
  const blocked = plan(layout, snapshot, ids);
  assert.equal(blocked.ok, false);
  assert.match(blocked.errors.join(), /Operator.*removals/);
  snapshot.roles[1].permissions = (
    flags.ViewChannel |
    flags.ManageRoles |
    flags.ManageChannels
  ).toString();
  for (const rename of [false, true]) {
    if (rename) layout.channels[0].name = "renamed";
    const result = plan(layout, snapshot, ids);
    assert.equal(result.ok, true);
    for (const operation of result.operations) {
      server.apply(operation);
      for (const channel of snapshot.channels)
        assert.equal(
          canView(snapshot, channel.id, ids.roles.operator),
          true,
          operation.kind,
        );
    }
  }
});

const shapes = [
  "root move",
  "dangling parent",
  "child before parent",
  "base grant",
  "new category",
] as const;
for (const shape of shapes)
  test(`private transitions: ${shape}`, () => {
    const layout = fixture();
    const child = layout.channels[0];
    child.access.member = access();
    const parent = category(layout);
    const server = model();
    if (shape !== "new category") {
      if (shape !== "base grant") layout.channels.push(parent);
      plan(layout, server.snapshot, server.ids).operations.forEach(
        server.apply,
      );
      const live = server.snapshot.channels.find(
        (entry) => entry.id === server.ids.channels.lobby,
      );
      assert.ok(live);
      if (shape === "base grant") {
        const member = server.snapshot.roles.find(
          (entry) => entry.id === server.ids.roles.member,
        );
        assert.ok(member);
        member.permissions = "0";
        live.overwrites = [];
      } else {
        const liveParent = server.snapshot.channels.find(
          (entry) => entry.id === server.ids.channels.category,
        );
        assert.ok(liveParent);
        liveParent.overwrites = structuredClone(live.overwrites);
        parent.access.member = access(true, true);
        child.parent = "category";
        if (shape === "dangling parent") live.parent = "deleted-category";
        if (shape === "child before parent") {
          server.snapshot.channels = server.snapshot.channels.filter(
            (entry) => entry !== live,
          );
          delete server.ids.channels.lobby;
        }
      }
    } else {
      layout.channels.push(parent);
      child.parent = "category";
    }
    const result = plan(validateLayout(layout), server.snapshot, server.ids);
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    for (const operation of result.operations) {
      server.apply(operation);
      assert.equal(
        canView(
          server.snapshot,
          server.ids.channels.lobby,
          server.ids.roles.member,
        ),
        false,
        `${shape}: ${operation.kind}`,
      );
      const live = server.snapshot.channels.find(
        (entry) => entry.id === server.ids.channels.lobby,
      );
      if (
        live?.parent &&
        (operation.kind === "createChannel" ||
          operation.kind === "updateChannel")
      )
        assert.ok(
          server.snapshot.channels.some(
            (entry) =>
              entry.id === live.parent &&
              entry.type === ChannelType.GuildCategory,
          ),
          `${shape}: missing parent`,
        );
    }
    assert.deepEqual(plan(layout, server.snapshot, server.ids).operations, []);
  });
