import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ChannelType, PermissionFlagsBits as flags } from "discord.js";
import fc from "fast-check";
import type { Layout, Overwrite } from "../src/layout/index.mts";
import {
  adoptionCandidates,
  normalizeSnapshot,
  parseLayout,
  plan,
} from "../src/layout/index.mts";
import { model } from "./layout-model.mts";

const fixture = () =>
  parseLayout(
    readFileSync(new URL("./fixtures/layout.yaml", import.meta.url), "utf8"),
  );
function visible(overwrites: Overwrite[], roleId: string): boolean {
  let bits = flags.ViewChannel;
  for (const id of ["guild", roleId]) {
    const entry = overwrites.find(
      (overwrite) => overwrite.id === id && overwrite.type === "role",
    );
    if (entry) bits = (bits & ~BigInt(entry.deny)) | BigInt(entry.allow);
  }
  return Boolean(bits & flags.ViewChannel);
}
const applyLayout = (layout: Layout) => {
  const server = model();
  const result = plan(layout, server.snapshot, server.ids);
  assert.equal(result.ok, true, JSON.stringify(result));
  result.operations.forEach(server.apply);
  return server;
};

test("generated creates, field changes and reorders converge without mutating inputs", () => {
  fc.assert(
    fc.property(
      fc.array(fc.boolean(), { minLength: 4, maxLength: 4 }),
      fc.integer({ min: 1, max: 5 }),
      (values, count) => {
        const layout = fixture();
        layout.roles.push({
          ...structuredClone(layout.roles[2]),
          key: "scout",
          name: "Scout",
        });
        layout.channels[0].access.scout = {
          ...layout.channels[0].access.member,
        };
        layout.channels = Array.from({ length: count }, (_, index) => ({
          ...structuredClone(layout.channels[0]),
          key: `room-${index}`,
          name: `room-${index}`,
          access: {
            ...layout.channels[0].access,
            member: {
              view: values[0],
              send: values[0] && values[1],
              connect: false,
              manageThreads: values[0] && values[2],
            },
          },
        }));
        const server = model();
        const before = structuredClone({
          layout,
          snapshot: server.snapshot,
          ids: server.ids,
        });
        const first = plan(layout, server.snapshot, server.ids);
        assert.deepEqual(
          { layout, snapshot: server.snapshot, ids: server.ids },
          before,
        );
        assert.equal(first.ok, true);
        first.operations.forEach(server.apply);
        layout.channels.reverse();
        const memberRole = layout.roles.pop();
        assert.ok(memberRole);
        layout.roles.splice(2, 0, memberRole);
        layout.channels[0].name = "renamed";
        layout.roles[2].mentionable = values[3];
        const change = plan(layout, server.snapshot, server.ids);
        assert.ok(
          change.operations.some((entry) => entry.kind === "updateChannel"),
        );
        change.operations.forEach(server.apply);
        assert.deepEqual(
          plan(layout, server.snapshot, server.ids).operations,
          [],
        );
      },
    ),
    { numRuns: 80 },
  );
});

test("protective ordering keeps private synced children hidden throughout category changes and moves", () => {
  fc.assert(
    fc.property(
      fc.boolean(),
      fc.boolean(),
      fc.boolean(),
      (reparent, rename, newChild) => {
        const layout = fixture();
        const child = layout.channels[0];
        child.type = "text";
        child.tags = [];
        child.parent = "category";
        child.access.member = {
          view: false,
          send: false,
          connect: false,
          manageThreads: false,
        };
        const category = {
          ...structuredClone(child),
          key: "category",
          name: "category",
          type: "category" as const,
          parent: undefined,
        };
        layout.channels.unshift(category);
        const server = applyLayout(layout);
        const parentLive = server.snapshot.channels.find(
          (entry) => entry.id === server.ids.channels.category,
        );
        assert.ok(parentLive);
        const childLive = server.snapshot.channels.find(
          (entry) => entry.id === server.ids.channels.lobby,
        );
        assert.ok(childLive);
        childLive.overwrites = structuredClone(parentLive.overwrites);
        if (newChild) {
          parentLive.overwrites = parentLive.overwrites.map((entry) => ({
            ...entry,
            deny: (
              BigInt(entry.deny) & ~(flags.Connect | flags.Speak)
            ).toString(),
          }));
          server.snapshot.channels = server.snapshot.channels.filter(
            (entry) => entry !== childLive,
          );
          delete server.ids.channels.lobby;
        }
        if (rename) child.name = "renamed-private";
        category.access.member = {
          view: true,
          send: true,
          connect: true,
          manageThreads: true,
        };
        if (reparent) {
          if (!newChild) {
            const destinationId = "synthetic-destination";
            server.snapshot.channels.push({
              ...structuredClone(parentLive),
              id: destinationId,
              name: "destination",
              overwrites: structuredClone(childLive.overwrites),
            });
            server.ids.channels.destination = destinationId;
            parentLive.overwrites[0].deny = (
              BigInt(parentLive.overwrites[0].deny) | flags.Stream
            ).toString();
          }
          layout.channels.push({
            ...structuredClone(category),
            key: "destination",
            name: "destination",
          });
          child.parent = "destination";
        }
        const changes = plan(layout, server.snapshot, server.ids);
        assert.ok(
          changes.operations.some(
            (entry) =>
              entry.kind === (newChild ? "createChannel" : "protectOverwrites"),
          ),
        );
        for (const operation of changes.operations) {
          server.apply(operation);
          const live = server.snapshot.channels.find(
            (entry) => entry.id === server.ids.channels.lobby,
          );
          if (!live) continue;
          assert.equal(
            visible(live.overwrites, server.ids.roles.member),
            false,
            operation.kind,
          );
        }
        assert.deepEqual(
          plan(layout, server.snapshot, server.ids).operations,
          [],
        );
      },
    ),
    { seed: 332, numRuns: 20 },
  );
});

test("adoption binds parent, type and name, rejects ambiguity and blocks uncertain creates", () => {
  const layout = fixture(),
    server = applyLayout(layout);
  const empty = { roles: {}, channels: {}, tags: {} };
  assert.deepEqual(
    adoptionCandidates(layout, server.snapshot, empty),
    server.ids,
  );
  assert.equal(plan(layout, server.snapshot, empty).ok, false);
  server.snapshot.channels.push({
    ...server.snapshot.channels[0],
    id: "duplicate",
  });
  assert.throws(
    () => adoptionCandidates(layout, server.snapshot, empty),
    /Ambiguous/,
  );
  server.snapshot.channels[1].parent = "other-parent";
  assert.equal(
    adoptionCandidates(layout, server.snapshot, empty).channels.lobby,
    server.ids.channels.lobby,
  );
  server.snapshot.roles.push({
    ...server.snapshot.roles[2],
    id: "duplicate-role",
  });
  assert.throws(
    () => adoptionCandidates(layout, server.snapshot, empty),
    /Ambiguous/,
  );
});

test("replacement preserves ignored integration overwrites and untracked objects fail unless ignored", () => {
  const layout = fixture(),
    server = applyLayout(layout),
    live = server.snapshot.channels[0];
  const integration = {
    ...server.snapshot.roles[2],
    id: "integration",
    name: "Integration",
    managed: true,
  };
  server.snapshot.roles.push(integration);
  const overwrite: Overwrite = {
    id: integration.id,
    type: "role",
    allow: flags.ViewChannel.toString(),
    deny: "0",
  };
  live.overwrites.push(overwrite);
  assert.equal(plan(layout, server.snapshot, server.ids).ok, false);
  layout.ignore.overwrites.push("Integration");
  live.overwrites[0].deny = "0";
  const result = plan(layout, server.snapshot, server.ids);
  assert.equal(result.ok, true);
  const replace = result.operations.find(
    (entry) => entry.kind === "replaceOverwrites",
  );
  assert.ok(replace?.kind === "replaceOverwrites");
  assert.ok(
    replace.overwrites.some(
      (entry) =>
        entry.kind === "preserved" &&
        JSON.stringify(entry.overwrite) === JSON.stringify(overwrite),
    ),
  );
  result.operations.forEach(server.apply);
  assert.deepEqual(
    live.overwrites.find((entry) => entry.id === integration.id),
    overwrite,
  );
  assert.equal(Object.values(server.ids.roles).includes(integration.id), false);

  server.snapshot.channels.push({
    ...structuredClone(live),
    id: "unknown",
    name: "External",
  });
  assert.equal(plan(layout, server.snapshot, server.ids).ok, false);
  layout.ignore.channels.push("External");
  assert.equal(plan(layout, server.snapshot, server.ids).ok, true);
});

test("tag rename retains ID, destructive removals are ordered, and thread inventories are excluded", () => {
  const layout = fixture(),
    server = applyLayout(layout),
    tagId = server.ids.tags.lobby.new;
  layout.channels[0].tags[0].name = "Renamed";
  plan(layout, server.snapshot, server.ids).operations.forEach(server.apply);
  assert.equal(server.snapshot.channels[0].tags[0].id, tagId);
  assert.deepEqual(plan(layout, server.snapshot, server.ids).operations, []);
  layout.channels[0].tags = [];
  assert.equal(plan(layout, server.snapshot, server.ids).destructive, true);
  server.snapshot.channels.push({
    ...structuredClone(server.snapshot.channels[0]),
    id: "category",
    type: ChannelType.GuildCategory,
  });
  server.ids.channels.category = "category";
  layout.channels = [];
  layout.roles.pop();
  const removals = plan(layout, server.snapshot, server.ids);
  assert.deepEqual(
    removals.operations.map((entry) => entry.kind),
    ["deleteChannel", "deleteCategory", "deleteRole"],
  );
  for (const type of [
    ChannelType.AnnouncementThread,
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
  ])
    server.snapshot.channels.push({ ...server.snapshot.channels[0], type });
  assert.equal(normalizeSnapshot(server.snapshot).channels.length, 2);
});
