import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as discord from "discord.js";
import fc from "fast-check";
import type { Overwrite } from "../src/layout/index.mts";
import { parseLayout, plan, readback } from "../src/layout/index.mts";
import { model } from "./layout-model.mts";

const flags = discord.PermissionFlagsBits;

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
  let permissions = base;
  for (const target of new Set(["guild", roleId])) {
    const entry = overwrites.find(
      (entry) => entry.type === "role" && entry.id === target,
    );
    if (entry)
      permissions = (permissions & ~BigInt(entry.deny)) | BigInt(entry.allow);
  }
  return permissions & flags.ViewChannel ? permissions : 0n;
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

const view = flags.ViewChannel;
for (const [scenario, target, allow] of [
  ["clean", "", 0n],
  ["Member", "member", view],
  ["everyone", "everyone", view],
  ["overwrite", "", view],
  ["partial", "member", view | flags.SendMessages | flags.Connect],
  ["integration", "", view],
  ["live grant", "", view],
  ["stale", "", 0n],
] as const) {
  test(`readback: ${scenario}`, () => {
    const { layout, snapshot, ids } = applied();
    const live = snapshot.channels[0];
    if (target) {
      const overwrite = live.overwrites.find(
        (entry) => entry.id === ids.roles[target],
      );
      assert.ok(overwrite);
      overwrite.allow = allow.toString();
      overwrite.deny = "0";
    }
    if (scenario === "partial") {
      layout.channels[0].type = "category";
      live.type = discord.ChannelType.GuildCategory;
      layout.channels[0].access.operator.connect = true;
      layout.channels[0].access.member.view = true;
    }
    if (scenario === "integration") {
      snapshot.roles.push({
        ...snapshot.roles[2],
        id: scenario,
        managed: true,
      });
      layout.ignore.overwrites.push("Member");
    }
    if (scenario === "overwrite" || scenario === "integration")
      live.overwrites.push({
        id: scenario,
        type: scenario === "overwrite" ? "member" : "role",
        allow: allow.toString(),
        deny: "0",
      });
    if (scenario === "live grant") {
      layout.roles[2].permissions.ViewChannel = false;
      layout.ignore.channels.push(live.name);
    }
    if (scenario === "stale") ids.channels.stale = "external";
    if (scenario === "live grant" || scenario === "stale")
      snapshot.channels.push({ ...live, id: "external", overwrites: [] });
    const result = readback(layout, snapshot, ids);
    const errors = result.errors.join(" ");
    assert.equal(result.ok, scenario === "clean");
    if (scenario === "live grant")
      assert.equal(
        result.findings[0]?.reason,
        "ignored channel visible through a guild grant",
      );
    if (scenario === "integration")
      assert.match(errors, /undeclared role can view private channel/);
    if (scenario === "partial")
      assert.match(errors, /member\/send:.*member\/connect:/);
    if (scenario === "stale")
      assert.deepEqual(result.untracked, [{ kind: "channel", id: "external" }]);
  });
}
