import assert from "node:assert/strict";
import test from "node:test";
import { adoptionCandidates, plan } from "../src/layout/index.mts";
import { applied } from "./layout-model.mts";

test("adoption requires consent and rejects ambiguous roles or channels", () => {
  const server = applied(),
    { layout, snapshot, ids } = server;
  const empty = { roles: {}, channels: {}, tags: {} };
  assert.deepEqual(adoptionCandidates(layout, snapshot, empty), ids);
  assert.equal(plan(layout, snapshot, empty).ok, false);
  snapshot.channels.push({ ...server.live(), id: "duplicate" });
  assert.throws(() => adoptionCandidates(layout, snapshot, empty), /Ambiguous/);
  snapshot.channels[1].parent = "other-parent";
  assert.equal(
    adoptionCandidates(layout, snapshot, empty).channels.lobby,
    ids.channels.lobby,
  );
  snapshot.roles.push({ ...snapshot.roles[2], id: "duplicate-role" });
  assert.throws(() => adoptionCandidates(layout, snapshot, empty), /Ambiguous/);
});

test("unknown overwrites and channels block plans until ignored", () => {
  const server = applied(),
    { layout, snapshot, ids } = server,
    live = server.live();
  snapshot.roles.push({
    ...snapshot.roles[2],
    id: "integration",
    name: "Integration",
    managed: true,
  });
  const overwrite = {
    id: "integration",
    type: "role" as const,
    allow: "1024",
    deny: "0",
  };
  live.overwrites.push(overwrite);
  layout.ignore.channels.push(live.name);
  assert.equal(plan(layout, snapshot, ids).ok, false);
  layout.ignore.overwrites.push("Integration");
  live.overwrites[0].deny = "0";
  server.run();
  assert.deepEqual(
    live.overwrites.find((entry) => entry.id === "integration"),
    overwrite,
  );
  snapshot.channels.push({
    ...structuredClone(live),
    id: "unknown",
    name: "External",
  });
  assert.equal(plan(layout, snapshot, ids).ok, false);
  layout.ignore.channels.push("External");
  assert.equal(plan(layout, snapshot, ids).ok, true);
});

test("stale bindings recreate objects and converge", () => {
  const server = applied(),
    { layout, snapshot, ids } = server;
  snapshot.channels = [];
  snapshot.roles = snapshot.roles.filter(
    (role) => role.id !== ids.roles.member,
  );
  const result = server.run();
  assert.deepEqual(result.staleBindings.map((entry) => entry.kind).sort(), [
    "channel",
    "role",
    "tag",
  ]);
  assert.deepEqual(plan(layout, snapshot, ids).operations, []);
});

test("member overwrites are destructive removals and ignored bindings survive", () => {
  const server = applied(),
    { layout, snapshot, ids } = server,
    live = server.live();
  live.overwrites.push({
    id: "person",
    type: "member",
    allow: "1024",
    deny: "0",
  });
  assert.equal(server.run().destructive, true);
  assert.ok(live.overwrites.every((entry) => entry.type === "role"));
  layout.channels = [];
  layout.roles.pop();
  layout.ignore.channels.push(live.name);
  layout.ignore.roles.push("Member");
  assert.deepEqual(plan(layout, snapshot, ids).operations, []);
});
