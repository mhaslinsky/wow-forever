import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ChannelType, PermissionFlagsBits as flags } from "discord.js";
import type { Layout } from "../src/layout/index.mts";
import {
  adoptionCandidates,
  parseLayout,
  plan,
  validateLayout,
} from "../src/layout/index.mts";
import { model } from "./layout-model.mts";

const fixture = () =>
  parseLayout(
    readFileSync(new URL("./fixtures/layout.yaml", import.meta.url), "utf8"),
  );
const applied = (layout = fixture()) => {
  const server = model();
  plan(validateLayout(layout), server.snapshot, server.ids).operations.forEach(
    server.apply,
  );
  return { layout, ...server };
};
const category = (layout: Layout, key: string) => {
  const result = {
    ...structuredClone(layout.channels[0]),
    key,
    name: key,
    type: "category" as const,
    tags: [],
  };
  result.access.operator.connect = true;
  return result;
};

test("public creates do not repeat an identical overwrite replacement", () => {
  const layout = fixture();
  layout.channels[0].access.everyone = { ...layout.channels[0].access.member };
  const server = model(),
    result = plan(layout, server.snapshot, server.ids);
  assert.equal(
    result.operations.filter((entry) => entry.kind === "replaceOverwrites")
      .length,
    0,
  );
  result.operations.forEach(server.apply);
  assert.deepEqual(plan(layout, server.snapshot, server.ids).operations, []);
});

test("member overwrites are executable destructive removals", () => {
  const server = applied(),
    channel = server.snapshot.channels[0];
  channel.overwrites.push({
    id: "synthetic-person",
    type: "member",
    allow: flags.ViewChannel.toString(),
    deny: "0",
  });
  const result = plan(server.layout, server.snapshot, server.ids);
  assert.equal(result.ok, true);
  assert.equal(result.destructive, true);
  assert.ok(
    result.operations.some((entry) => entry.kind === "removeOverwrite"),
  );
  result.operations.forEach(server.apply);
  assert.ok(channel.overwrites.every((entry) => entry.type === "role"));
  assert.deepEqual(
    plan(server.layout, server.snapshot, server.ids).operations,
    [],
  );
});

test("adoption inventory uses candidate IDs while requiring explicit adoption", () => {
  const server = applied(),
    empty = { roles: {}, channels: {}, tags: {} };
  const result = plan(server.layout, server.snapshot, empty);
  assert.deepEqual(result.untracked, []);
  assert.deepEqual(result.adoptionCandidates, server.ids);
  assert.equal(result.ok, false);
  assert.deepEqual(empty, { roles: {}, channels: {}, tags: {} });
});

test("stale roles, channels and tags are reported and recreated", () => {
  const server = applied();
  server.snapshot.channels = [];
  server.snapshot.roles = server.snapshot.roles.filter(
    (role) => role.id !== server.ids.roles.member,
  );
  const result = plan(server.layout, server.snapshot, server.ids);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.staleBindings.map((entry) => entry.kind).sort(), [
    "channel",
    "role",
    "tag",
  ]);
  assert.ok(result.operations.some((entry) => entry.kind === "createRole"));
  assert.ok(result.operations.some((entry) => entry.kind === "createChannel"));
  result.operations.forEach(server.apply);
  assert.deepEqual(
    plan(server.layout, server.snapshot, server.ids).operations,
    [],
  );
});

test("bound forum tags can be adopted while moving to an unbound category", () => {
  const server = applied(),
    tagId = server.ids.tags.lobby.new;
  server.layout.channels.push(category(server.layout, "destination"));
  server.layout.channels[0].parent = "destination";
  server.ids.tags = {};
  const candidates = adoptionCandidates(
    server.layout,
    server.snapshot,
    server.ids,
  );
  assert.equal(candidates.tags.lobby.new, tagId);
  Object.assign(server.ids, candidates);
  plan(server.layout, server.snapshot, server.ids).operations.forEach(
    server.apply,
  );
  assert.equal(
    server.snapshot.channels.find(
      (entry) => entry.id === server.ids.channels.lobby,
    )?.tags[0].id,
    tagId,
  );
  assert.deepEqual(
    plan(server.layout, server.snapshot, server.ids).operations,
    [],
  );
});

test("reparents order children by their destination siblings", () => {
  const layout = fixture(),
    arrival = layout.channels[0];
  layout.channels.push(
    category(layout, "source"),
    category(layout, "destination"),
  );
  const resident = {
    ...structuredClone(arrival),
    key: "resident",
    name: "resident",
    parent: "destination",
  };
  arrival.parent = "source";
  layout.channels.push(resident);
  const server = applied(layout);
  const liveArrival = server.snapshot.channels.find(
    (entry) => entry.id === server.ids.channels.lobby,
  );
  const liveResident = server.snapshot.channels.find(
    (entry) => entry.id === server.ids.channels.resident,
  );
  assert.ok(liveArrival && liveResident);
  liveArrival.position = 0;
  liveResident.position = 10;
  arrival.parent = "destination";
  const result = plan(layout, server.snapshot, server.ids);
  assert.ok(
    result.operations.some(
      (entry) =>
        entry.kind === "reorderChannels" && entry.parentKey === "destination",
    ),
  );
  result.operations.forEach(server.apply);
  assert.ok(liveArrival.position < liveResident.position);
  assert.deepEqual(plan(layout, server.snapshot, server.ids).operations, []);
});

test("type replacements omit doomed member overwrites and move children to the replacement", () => {
  const layout = fixture();
  layout.channels.push(category(layout, "category"));
  layout.channels[0].parent = "category";
  layout.channels.push({
    ...structuredClone(layout.channels[0]),
    key: "retained",
    name: "retained",
  });
  const server = applied(layout),
    oldCategoryId = server.ids.channels.category;
  const parent = server.snapshot.channels.find(
    (entry) => entry.id === oldCategoryId,
  );
  assert.ok(parent);
  parent.type = ChannelType.GuildText;
  const child = server.snapshot.channels.find(
    (entry) => entry.id === server.ids.channels.lobby,
  );
  assert.ok(child);
  child.overwrites.push({
    type: "member",
    id: "synthetic-person",
    allow: "0",
    deny: "0",
  });
  layout.channels[0].type = "text";
  layout.channels[0].tags = [];
  const result = plan(layout, server.snapshot, server.ids);
  assert.equal(result.ok, true);
  assert.equal(result.destructive, true);
  assert.ok(
    result.operations.some(
      (entry) =>
        entry.kind === "updateChannel" && entry.channel.key === "retained",
    ),
  );
  const create = result.operations.find(
    (entry) => entry.kind === "createChannel",
  );
  assert.ok(create?.kind === "createChannel");
  assert.ok(create.overwrites.every((entry) => entry.type === "role"));
  result.operations.forEach(server.apply);
  assert.notEqual(server.ids.channels.category, oldCategoryId);
  assert.equal(
    server.snapshot.channels.find(
      (entry) => entry.id === server.ids.channels.retained,
    )?.parent,
    server.ids.channels.category,
  );
  assert.equal(
    server.snapshot.channels.find(
      (entry) => entry.id === server.ids.channels.lobby,
    )?.parent,
    server.ids.channels.category,
  );
  assert.deepEqual(plan(layout, server.snapshot, server.ids).operations, []);
});

test("mixed role permission changes remove before channel finals and grant afterward", () => {
  const layout = fixture();
  layout.channels[0].access.member = {
    view: false,
    send: false,
    connect: false,
    manageThreads: false,
  };
  const server = applied(layout);
  const member = server.snapshot.roles.find(
    (entry) => entry.id === server.ids.roles.member,
  );
  assert.ok(member);
  member.permissions = (flags.ViewChannel | flags.SendMessages).toString();
  layout.roles[2].permissions = {
    ViewChannel: false,
    SendMessages: false,
    ManageThreads: true,
  };
  const result = plan(layout, server.snapshot, server.ids);
  const roleUpdates = result.operations.flatMap((entry, index) =>
    entry.kind === "updateRole" ? [index] : [],
  );
  const overwriteFinals = result.operations.flatMap((entry, index) =>
    entry.kind === "replaceOverwrites" ? [index] : [],
  );
  assert.equal(result.operations[0].kind, "protectOverwrites");
  assert.equal(roleUpdates.length, 2);
  assert.ok(roleUpdates[0] < Math.min(...overwriteFinals));
  assert.ok(roleUpdates[1] > Math.max(...overwriteFinals));
  result.operations.forEach(server.apply);
  assert.equal(member.permissions, flags.ManageThreads.toString());
  assert.deepEqual(plan(layout, server.snapshot, server.ids).operations, []);
});
