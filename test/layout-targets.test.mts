import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PermissionFlagsBits as flags } from "discord.js";
import {
  compilePermissions,
  parseLayout,
  plan,
  protectionTargets,
  validateLayout,
} from "../src/layout/index.mts";
import { canView, model } from "./layout-model.mts";

const fixture = () => {
  const layout = parseLayout(
    readFileSync(new URL("./fixtures/layout.yaml", import.meta.url), "utf8"),
  );
  layout.channels[0].access.member = {
    view: false,
    send: false,
    connect: false,
    manageThreads: false,
  };
  return layout;
};

test("protection target safety: ignored synced child blocks its category change", () => {
  const layout = fixture(),
    child = layout.channels[0],
    server = model();
  const category = {
    ...structuredClone(child),
    key: "category",
    name: "category",
    type: "category" as const,
    tags: [],
  };
  category.access.operator.connect = true;
  child.parent = "category";
  layout.channels.push(category);
  plan(validateLayout(layout), server.snapshot, server.ids).operations.forEach(
    server.apply,
  );
  const parent = server.snapshot.channels.find(
    (entry) => entry.id === server.ids.channels.category,
  );
  assert.ok(parent);
  server.snapshot.channels.push({
    ...structuredClone(parent),
    id: "ignored-child",
    type: server.snapshot.channels[0].type,
    name: "External",
    parent: parent.id,
  });
  layout.ignore.channels.push("External");
  category.access.member = {
    view: true,
    send: true,
    connect: true,
    manageThreads: true,
  };
  const result = plan(layout, server.snapshot, server.ids);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some(
      (error) =>
        error.includes("External") &&
        error.includes("category") &&
        error.includes("unsync"),
    ),
  );
  const final = compilePermissions(layout, category).map(
    ({ roleKey, ...entry }) => ({ ...entry, id: server.ids.roles[roleKey] }),
  );
  const select = () =>
    protectionTargets(layout, server.snapshot, server.ids, {
      touched: new Set([category.key]),
      roleBitsChanged: false,
      recreated: new Set<string>(),
      finalOverwrites: new Map([[category.key, final]]),
    });
  const selection = select();
  assert.equal(
    selection.channels.find((target) => target.live?.id === "ignored-child")
      ?.writable,
    false,
  );
  assert.equal(selection.errors.length, 1);
  const external = server.snapshot.channels.find(
    (channel) => channel.id === "ignored-child",
  );
  assert.ok(external);
  external.overwrites = structuredClone(final);
  assert.equal(select().errors.length, 1, "matches a later category state");
  const protectedCategory = selection.channels.find(
    (target) => target.key === category.key,
  );
  assert.ok(protectedCategory);
  external.overwrites = structuredClone(protectedCategory.overwrites);
  assert.equal(select().errors.length, 1, "matches category protection");
  layout.ignore.channels = [];
  assert.match(select().errors[0], /unbound channel External/);
  layout.ignore.channels.push("External");
  external.overwrites = [
    {
      id: "guild",
      type: "role",
      allow: "0",
      deny: flags.ManageMessages.toString(),
    },
  ];
  const unsynced = plan(layout, server.snapshot, server.ids);
  assert.equal(unsynced.ok, true, JSON.stringify(unsynced.errors));
  unsynced.operations.forEach(server.apply);
  assert.deepEqual(external.overwrites, [
    {
      id: "guild",
      type: "role",
      allow: "0",
      deny: flags.ManageMessages.toString(),
    },
  ]);
});

test("protection target safety: Member stays hidden after Administrator removal", () => {
  const layout = fixture(),
    server = model();
  layout.roles[2].permissions.Administrator = false;
  plan(validateLayout(layout), server.snapshot, server.ids).operations.forEach(
    server.apply,
  );
  const member = server.snapshot.roles.find(
    (role) => role.id === server.ids.roles.member,
  );
  const child = server.snapshot.channels.find(
    (entry) => entry.id === server.ids.channels.lobby,
  );
  assert.ok(member && child);
  member.permissions = (flags.Administrator | flags.ViewChannel).toString();
  child.overwrites = [
    {
      id: member.id,
      type: "role",
      allow: flags.ViewChannel.toString(),
      deny: "0",
    },
  ];
  const selection = protectionTargets(layout, server.snapshot, server.ids, {
    touched: new Set<string>(),
    roleBitsChanged: true,
    recreated: new Set<string>(),
    finalOverwrites: new Map(),
  });
  assert.ok(
    selection.channels
      .find((target) => target.live?.id === child.id)
      ?.roleIds.includes(member.id),
  );
  const result = plan(layout, server.snapshot, server.ids);
  assert.equal(result.ok, true);
  let removed = false;
  for (const operation of result.operations) {
    server.apply(operation);
    if (!(BigInt(member.permissions) & flags.Administrator)) {
      removed = true;
      assert.equal(
        canView(server.snapshot, child.id, member.id),
        false,
        operation.kind,
      );
    }
  }
  assert.equal(removed, true);
});

test("protection target safety: non-Administrator operator can see every written channel", () => {
  const layout = fixture(),
    server = model();
  const permissions =
    flags.ViewChannel | flags.ManageChannels | flags.ManageRoles;
  server.snapshot.roles[1].permissions = permissions.toString();
  layout.roles[1].permissions = {
    Administrator: false,
    ViewChannel: true,
    ManageChannels: true,
    ManageRoles: true,
  };
  const apply = () => {
    const result = plan(validateLayout(layout), server.snapshot, server.ids);
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    for (const operation of result.operations) {
      server.apply(operation);
      for (const channel of server.snapshot.channels)
        assert.equal(
          canView(server.snapshot, channel.id, server.ids.roles.operator),
          true,
          operation.kind,
        );
    }
  };
  apply();
  layout.channels[0].name = "renamed";
  const selection = protectionTargets(layout, server.snapshot, server.ids, {
    touched: new Set(["lobby"]),
    roleBitsChanged: false,
    recreated: new Set<string>(),
    finalOverwrites: new Map(),
  });
  assert.equal(selection.channels.length, 1);
  assert.ok(
    selection.channels.every(
      (target) => !target.roleIds.includes(server.ids.roles.operator),
    ),
  );
  apply();
});
