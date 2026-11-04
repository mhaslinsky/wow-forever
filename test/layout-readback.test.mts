import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as discord from "discord.js";
import fc from "fast-check";
import type { Overwrite } from "../src/layout/index.mts";
import { parseLayout, plan, readback } from "../src/layout/index.mts";
import { model } from "./layout-model.mts";

const flags = discord.PermissionFlagsBits;
const view = flags.ViewChannel;
const partial = view | flags.SendMessages | flags.Connect;
test("ignored public channel has no guild-grant findings", () => {
  const { layout, snapshot, ids } = applied();
  snapshot.roles[0].permissions = view.toString();
  layout.ignore.channels.push("public");
  snapshot.channels.push({
    ...snapshot.channels[0],
    id: "external",
    name: "public",
    overwrites: [],
  });
  assert.deepEqual(readback(layout, snapshot, ids).findings, []);
});
test("ignored channel exposed by a layout role still has a finding", () => {
  const { layout, snapshot, ids } = applied();
  layout.ignore.channels.push("private");
  snapshot.channels.push({
    ...snapshot.channels[0],
    id: "external",
    name: "private",
    overwrites: [],
  });
  assert.deepEqual(readback(layout, snapshot, ids).findings, [
    {
      channelId: "external",
      roleKey: "member",
      reason: "ignored channel visible through a guild grant",
    },
  ]);
});
function applied() {
  const layout = parseLayout(
    readFileSync(new URL("./fixtures/layout.yaml", import.meta.url), "utf8"),
  );
  layout.channels[0].access.member.view = false;
  layout.channels[0].access.member.send = false;
  const server = model();
  plan(layout, server.snapshot, server.ids).operations.forEach(server.apply);
  return { layout, ...server };
}
function oracle(base: bigint, overwrites: Overwrite[], roleId: string): bigint {
  if (base & flags.Administrator) return discord.PermissionsBitField.All;
  let bits = base;
  for (const target of new Set(["guild", roleId])) {
    const entry = overwrites.find(
      (entry) => entry.type === "role" && entry.id === target,
    );
    if (entry) bits = (bits & ~BigInt(entry.deny)) | BigInt(entry.allow);
  }
  return bits & flags.ViewChannel ? bits : 0n;
}
test("generated readback rows agree with an independent oracle", () => {
  const permission = fc
    .subarray(Object.values(flags))
    .map((parts) => parts.reduce((bits, bit) => bits | bit, 0n));
  const masks = {
    view: flags.ViewChannel,
    send:
      flags.SendMessages |
      flags.SendMessagesInThreads |
      flags.CreatePublicThreads |
      flags.CreatePrivateThreads,
    manageThreads: flags.ManageThreads,
  };
  fc.assert(
    fc.property(
      fc.tuple(permission, permission, permission),
      fc.boolean(),
      ([base, allow, deny], visible) => {
        const { layout, snapshot, ids } = applied();
        const expected = layout.channels[0].access.member;
        Object.assign(expected, { view: visible, send: visible });
        const live = snapshot.channels[0];
        snapshot.roles[2].permissions = base.toString();
        live.overwrites[1].allow = allow.toString();
        live.overwrites[1].deny = deny.toString();
        const result = readback(layout, snapshot, ids);
        assert.equal(result.rows.length, layout.roles.length);
        const bits = oracle(base, live.overwrites, ids.roles.member);
        for (const [name, required] of Object.entries(masks)) {
          const prefix = `lobby/member/${name}:`;
          const wanted = expected[name as keyof typeof masks] ? required : 0n;
          assert.equal(
            result.errors.some((error) => error.startsWith(prefix)),
            (bits & required) !== wanted,
          );
        }
      },
    ),
    { seed: 333, numRuns: 40 },
  );
});
for (const [scenario, target, allow, reason, inventory] of [
  ["clean", "", 0n],
  ["Member", "member", view],
  ["everyone", "everyone", view],
  ["overwrite", "", view],
  ["partial", "member", partial, /member\/send:.*member\/connect:/],
  ["integration", "", view, /undeclared role can view private channel/],
  ["live grant", "", view, /ignored channel visible through a guild grant/],
  ["stale", "", 0n, undefined, "channel"],
  ["role", "", 0n, undefined, "role,overwrite"],
  ["ignored", "", 0n],
] as const) {
  test(`readback: ${scenario}`, () => {
    const { layout, snapshot, ids } = applied();
    const live = snapshot.channels[0];
    if (target)
      Object.assign(live.overwrites[target === "member" ? 1 : 0], {
        allow: allow.toString(),
        deny: "0",
      });
    if (scenario === "partial") {
      layout.channels[0].type = "category";
      live.type = discord.ChannelType.GuildCategory;
      layout.channels[0].access.operator.connect = true;
      layout.channels[0].access.member.view = true;
    }
    const extraRole = ["integration", "role", "ignored"].includes(scenario);
    const ignored = scenario === "ignored";
    if (extraRole) {
      snapshot.roles.push({
        ...snapshot.roles[2],
        id: scenario,
        permissions: allow.toString(),
        managed: scenario === "integration",
      });
      if (scenario !== "integration") ids.roles.stale = scenario;
      else layout.ignore.overwrites.push("Member");
    }
    if (scenario === "overwrite" || extraRole)
      live.overwrites.push({
        id: scenario,
        type: scenario === "overwrite" ? "member" : "role",
        allow: allow.toString(),
        deny: "0",
      });
    if (scenario === "live grant")
      layout.roles[2].permissions.ViewChannel = false;
    if (scenario === "live grant" || ignored)
      layout.ignore.channels.push(live.name);
    if (ignored)
      for (const kind of ["roles", "overwrites"] as const)
        layout.ignore[kind].push("Member");
    if (scenario === "stale" || ignored) {
      ids.channels.stale = "external";
      snapshot.channels.push({ ...live, id: "external" });
    }
    if (scenario === "live grant")
      snapshot.channels.push({ ...live, id: "external", overwrites: [] });
    const result = readback(layout, snapshot, ids);
    if (reason) assert.match(JSON.stringify(result), reason);
    assert.equal(result.ok, scenario === "clean" || ignored);
    assert.equal(
      result.untracked.map((entry) => entry.kind).join(),
      inventory ?? "",
    );
  });
}
