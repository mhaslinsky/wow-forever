import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import {
  adopt,
  applyLayout,
  applyLocked,
  inspectPlan,
  planBinding,
} from "../src/layout/executor.mts";
import { comparePosition } from "../src/layout/ordering.mts";
import { parseLayout } from "../src/layout/schema.mts";
import { emptyState, loadState, withStateLock } from "../src/layout/state.mts";
import type { DiscordPort } from "../src/layout/transport.mts";
import {
  LayoutTransportError,
  wireOverwrites,
} from "../src/layout/transport.mts";
import { canView, model } from "./layout-model.mts";

async function fixture(context: TestContext) {
  const directory = fs.mkdtempSync(join(tmpdir(), "layout-executor-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const server = model();
  const layout = parseLayout(
    fs.readFileSync(new URL("fixtures/layout.yaml", import.meta.url), "utf8"),
  );
  const options = {
    guildId: "guild",
    applicationId: "app",
    layout,
    statePath: join(directory, "state.json"),
    planPath: join(directory, "plan.json"),
    allowDelete: false,
    port: {} as DiscordPort,
  };
  let operations: ReturnType<typeof inspectPlan>["operations"] = [];
  let mutations = 0,
    reads = 0;
  let rateLimited = false;
  let loseResponse = false,
    failMutation = Infinity,
    identity = "app",
    guild = "guild";
  const payloads: unknown[] = [];
  options.port.request = async (method, route, body) => {
    if (method === "GET") {
      reads++;
      if (route === "/oauth2/applications/@me") return { id: identity };
      if (route === "/guilds/guild") return { id: guild };
      if (route.endsWith("/roles"))
        return server.snapshot.roles.map((role) => ({
          ...role,
          tags: role.applicationId ? { bot_id: role.applicationId } : {},
        }));
      if (route.endsWith("/channels"))
        return server.snapshot.channels.map((channel) => ({
          ...channel,
          parent_id: channel.parent,
          permission_overwrites: wireOverwrites(channel.overwrites),
          available_tags: channel.tags.map((tag) => ({
            ...tag,
            emoji_id: null,
            emoji_name: tag.emoji ?? null,
          })),
        }));
      throw new Error(`Unexpected read: ${route}`);
    }
    mutations++;
    payloads.push(body);
    if (rateLimited)
      throw new LayoutTransportError(
        "rate_limit",
        "Discord rate limited",
        429,
        51,
      );
    if (mutations === failMutation) throw new Error("Interrupted request");
    const operation = operations.shift();
    assert.ok(operation, "No unplanned mutation");
    if (
      operation.kind === "createChannel" ||
      operation.kind === "createCategory"
    ) {
      const overwrites = (
        body as { permission_overwrites: { id: string; deny: string }[] }
      ).permission_overwrites;
      assert.ok(
        BigInt(overwrites.find((entry) => entry.id === "guild")?.deny ?? "0") &
          1024n,
      );
    }
    server.apply(operation);
    if (loseResponse) throw new Error("Lost create response");
    if ("role" in operation)
      return { id: server.ids.roles[operation.role.key] };
    const key =
      "channel" in operation
        ? operation.channel.key
        : "channelKey" in operation
          ? operation.channelKey
          : undefined;
    const channel = server.snapshot.channels.find(
      (entry) => entry.id === server.ids.channels[key ?? ""],
    );
    return {
      id: channel?.id,
      available_tags: channel?.tags.map((tag) => ({
        ...tag,
        emoji_id: null,
        emoji_name: tag.emoji ?? null,
      })),
    };
  };
  await withStateLock(options.statePath, (locked) =>
    locked.write({ ...emptyState("guild"), ids: structuredClone(server.ids) }),
  );
  const review = async () =>
    withStateLock(options.statePath, (locked) => {
      const state = locked.read();
      const result = inspectPlan(layout, server.snapshot, state);
      operations = [...result.operations];
      locked.savePlan(
        options.planPath,
        planBinding(layout, state, result),
        result,
      );
      return result;
    });
  return {
    options,
    server,
    review,
    payloads,
    get mutations() {
      return mutations;
    },
    get reads() {
      return reads;
    },
    limit() {
      rateLimited = true;
    },
    lose() {
      loseResponse = true;
    },
    interrupt(at: number) {
      failMutation = at;
    },
    wrongApplication() {
      identity = "other";
    },
    wrongGuild() {
      guild = "other";
    },
  };
}

for (const failure of ["lost response", "state write"])
  test(`${failure} requires adoption without a duplicate create`, async (context) => {
    const setup = await fixture(context);
    await setup.review();
    if (failure === "lost response") setup.lose();
    const result = await withStateLock(setup.options.statePath, (locked) =>
      applyLocked(setup.options, {
        ...locked,
        write(state) {
          if (failure === "state write" && setup.mutations > 0)
            throw new Error("Disk write failed");
          locked.write(state);
        },
      }),
    );
    assert.equal(result.ok, false);
    assert.equal(setup.mutations, 1);
    assert.ok(result.readback);
    const state = loadState(setup.options.statePath);
    assert.equal(state.uncertainCreates.length, 1);
    assert.ok(
      inspectPlan(
        setup.options.layout,
        setup.server.snapshot,
        state,
      ).errors.some((error) => error.includes("Adoption required")),
    );
    const retry = await applyLayout(setup.options);
    assert.equal(retry.ok, false);
    assert.equal(setup.mutations, 1);
    const adopted = adopt(setup.options.layout, setup.server.snapshot, state);
    assert.equal(adopted.ids.roles.member, setup.server.ids.roles.member);
    assert.deepEqual(adopted.uncertainCreates, []);
  });

for (const mismatch of ["application", "guild"])
  test(`preflight refuses a different ${mismatch}`, async (context) => {
    const setup = await fixture(context);
    await setup.review();
    if (mismatch === "application") setup.wrongApplication();
    else setup.wrongGuild();
    const result = await applyLayout(setup.options);
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /differs/);
    assert.ok(result.readbackError);
    assert.equal(setup.mutations, 0);
    assert.ok(setup.reads >= 2);
  });

test("apply converges, saves tag IDs, and makes no second-apply mutations", async (context) => {
  const setup = await fixture(context);
  await setup.review();
  assert.equal((await applyLayout(setup.options)).ok, true);
  assert.ok(loadState(setup.options.statePath).ids.tags.lobby.new);
  const before = setup.mutations;
  await setup.review();
  assert.equal((await applyLayout(setup.options)).ok, true);
  assert.equal(setup.mutations, before);
});

test("interrupted permission updates retain protection and stop mutation", async (context) => {
  const setup = await fixture(context);
  await setup.review();
  assert.equal((await applyLayout(setup.options)).ok, true);
  const channel = setup.server.snapshot.channels[0];
  const before = setup.mutations;
  setup.options.layout.channels[0].access.member = {
    view: false,
    send: false,
    connect: false,
    manageThreads: false,
  };
  await setup.review();
  setup.interrupt(before + 2);
  const result = await applyLayout(setup.options);
  assert.equal(result.ok, false);
  assert.equal(result.completed[0].kind, "protectOverwrites");
  assert.equal(
    canView(setup.server.snapshot, channel.id, setup.server.ids.roles.member),
    false,
  );
  assert.equal(setup.mutations, before + 2);
  assert.ok(result.readback);
});

test("saved plan refuses drift and held state lock refuses concurrent apply", async (context) => {
  const setup = await fixture(context);
  await setup.review();
  setup.options.layout.roles[2].name = "Renamed";
  assert.equal((await applyLayout(setup.options)).ok, false);
  await withStateLock(setup.options.statePath, async () => {
    await assert.rejects(applyLayout(setup.options), /State lock active/);
  });
  assert.equal(setup.mutations, 0);
});

test("Discord position ties use numeric channel IDs and reverse role IDs", () => {
  assert.ok(
    comparePosition(
      { id: "9", position: 1 },
      { id: "10", position: 1 },
      "channel",
    ) < 0,
  );
  assert.ok(
    comparePosition(
      { id: "9", position: 1 },
      { id: "10", position: 1 },
      "role",
    ) > 0,
  );
});

test("rate limit stops apply after one mutation attempt and still runs readback", async (context) => {
  const setup = await fixture(context);
  await setup.review();
  setup.limit();
  const result = await applyLayout(setup.options);
  assert.equal(result.ok, false);
  assert.equal(result.errorKind, "rate_limit");
  assert.equal(result.retryAfterMs, 51);
  assert.equal(setup.mutations, 1);
  assert.deepEqual(result.completed, []);
  assert.ok(result.readback);
});
