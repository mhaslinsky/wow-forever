import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ChannelType } from "discord.js";
import fc from "fast-check";
import { parseLayout, plan, validateLayout } from "../src/layout/index.mts";
import { canView, model } from "./layout-model.mts";

const shapes = [
  "root move",
  "dangling parent",
  "child before parent",
  "base grant",
  "new category",
] as const;
for (const shape of shapes)
  test(`private transitions: ${shape}`, () => {
    fc.assert(
      fc.property(fc.constant(shape), (scenario) => {
        const layout = parseLayout(
          readFileSync(
            new URL("./fixtures/layout.yaml", import.meta.url),
            "utf8",
          ),
        );
        const child = layout.channels[0];
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
          tags: [],
        };
        category.access.operator.connect = true;
        const server = model();
        if (scenario !== "new category") {
          if (scenario !== "base grant") layout.channels.push(category);
          plan(layout, server.snapshot, server.ids).operations.forEach(
            server.apply,
          );
          const live = server.snapshot.channels.find(
            (entry) => entry.id === server.ids.channels.lobby,
          );
          assert.ok(live);
          if (scenario === "base grant") {
            const member = server.snapshot.roles.find(
              (entry) => entry.id === server.ids.roles.member,
            );
            assert.ok(member);
            member.permissions = "0";
            live.overwrites = [];
          } else {
            const parent = server.snapshot.channels.find(
              (entry) => entry.id === server.ids.channels.category,
            );
            assert.ok(parent);
            parent.overwrites = structuredClone(live.overwrites);
            category.access.member = {
              view: true,
              send: true,
              connect: true,
              manageThreads: true,
            };
            child.parent = "category";
            if (scenario === "dangling parent")
              live.parent = "deleted-category";
            if (scenario === "child before parent") {
              server.snapshot.channels = server.snapshot.channels.filter(
                (entry) => entry !== live,
              );
              delete server.ids.channels.lobby;
            }
          }
        } else {
          layout.channels.push(category);
          child.parent = "category";
        }
        const result = plan(
          validateLayout(layout),
          server.snapshot,
          server.ids,
        );
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
            `${scenario}: ${operation.kind}`,
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
              `${scenario}: missing parent`,
            );
        }
        assert.deepEqual(
          plan(layout, server.snapshot, server.ids).operations,
          [],
        );
      }),
      { seed: 332, numRuns: 1 },
    );
  });
