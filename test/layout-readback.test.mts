import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PermissionFlagsBits as flags, PermissionsBitField } from "discord.js";
import fc from "fast-check";
import type { Overwrite } from "../src/layout/index.mts";
import { parseLayout, plan, readback } from "../src/layout/index.mts";
import { model } from "./layout-model.mts";

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

test("generated readback rows agree with an independent oracle", () => {
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
      fc.array(fc.subarray(Object.values(flags)), {
        minLength: 9,
        maxLength: 9,
      }),
      fc.boolean(),
      (values, visible) => {
        const { layout, snapshot, ids } = applied();
        layout.channels[0].access.member.view = visible;
        const live = snapshot.channels[0];
        const mask = (index: number) =>
          values[index].reduce((bits, bit) => bits | bit, 0n);
        snapshot.roles.forEach((role, index) => {
          role.permissions = (
            mask(index) | (index === 1 ? flags.Administrator : 0n)
          ).toString();
          live.overwrites[index] = {
            id: role.id,
            type: "role",
            allow: mask(index + 3).toString(),
            deny: mask(index + 6).toString(),
          };
        });
        const result = readback(layout, snapshot, ids);
        assert.equal(result.rows.length, layout.roles.length);
        for (const row of result.rows) {
          const role = snapshot.roles.find(
            (entry) => entry.id === ids.roles[row.roleKey],
          );
          assert.ok(role);
          const bits = oracle(
            BigInt(snapshot.roles[0].permissions) | BigInt(role.permissions),
            live.overwrites,
            role.id,
          );
          for (const [name, required] of Object.entries(masks))
            assert.equal(
              row.actual[name as keyof typeof masks],
              (bits & required) === required,
            );
          assert.equal(row.actual.connect, false);
        }
      },
    ),
    { seed: 333, numRuns: 40 },
  );
});

for (const scenario of ["clean", "Member", "everyone", "overwrite", "grant"]) {
  test(`readback: ${scenario}`, () => {
    const { layout, snapshot, ids } = applied();
    const live = snapshot.channels[0];
    if (scenario === "Member" || scenario === "everyone") {
      const target =
        scenario === "Member" ? ids.roles.member : snapshot.guildId;
      const overwrite = live.overwrites.find((entry) => entry.id === target);
      assert.ok(overwrite);
      Object.assign(overwrite, {
        allow: flags.ViewChannel.toString(),
        deny: "0",
      });
    }
    if (scenario === "overwrite")
      live.overwrites.push({
        id: "synthetic-user",
        type: "member",
        allow: "0",
        deny: "0",
      });
    if (scenario === "grant") {
      layout.ignore.channels.push("External");
      snapshot.channels.push({
        ...live,
        id: "external",
        name: "External",
        overwrites: [],
      });
    }
    const result = readback(layout, snapshot, ids);
    assert.equal(result.ok, scenario === "clean");
    if (scenario === "grant") {
      assert.deepEqual(result.errors, []);
      assert.equal(
        result.findings[0]?.reason,
        "ignored channel visible through a guild grant",
      );
    } else if (scenario !== "clean") assert.ok(result.errors.length > 0);
  });
}
