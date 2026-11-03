import { equal, match, ok, rejects } from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
import { emptyState, loadState, withStateLock } from "../src/layout/state.mts";
import type { DiscordPort } from "../src/layout/transport.mts";
import {
  fetchSnapshot,
  LayoutTransportError,
  wireOverwrites,
  wireTags,
} from "../src/layout/transport.mts";
import {
  access,
  canView,
  fixture as layoutFixture,
  model,
} from "./layout-model.mts";

async function fixture(context: TestContext, seeded = false) {
  const directory = fs.mkdtempSync(join(tmpdir(), "layout-executor-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const server = model();
  const layout = layoutFixture();
  if (seeded) server.run(layout);
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
  const io = {
    mutations: 0,
    rateLimited: false,
    loseResponse: false,
    failMutation: Infinity,
    identity: "app",
    guild: "guild",
  };
  options.port.request = async (method, route, body) => {
    if (method === "GET") {
      if (route === "/oauth2/applications/@me") return { id: io.identity };
      if (route === "/guilds/guild") return { id: io.guild };
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
          available_tags: wireTags(
            channel.tags.map((tag) => ({ ...tag, key: tag.id })),
          ),
        }));
      throw new Error(`Unexpected read: ${route}`);
    }
    io.mutations++;
    for (const entry of (body as { permission_overwrites?: object[] })
      ?.permission_overwrites ?? [])
      ok(!("kind" in entry));
    if (io.rateLimited)
      throw new LayoutTransportError("rate_limit", "Limited", 429, 51);
    if (io.mutations === io.failMutation)
      throw new Error("Interrupted request");
    const operation = operations.shift();
    ok(operation, "No unplanned mutation");
    if (
      operation.kind === "createChannel" ||
      operation.kind === "createCategory"
    ) {
      const overwrites = (
        body as { permission_overwrites: { id: string; deny: string }[] }
      ).permission_overwrites;
      ok(
        BigInt(overwrites.find((entry) => entry.id === "guild")?.deny ?? "0") &
          1024n,
      );
    }
    server.apply(operation);
    if (
      operation.kind === "reorderRoles" ||
      operation.kind === "reorderChannels"
    ) {
      const live =
        operation.kind === "reorderRoles"
          ? server.snapshot.roles
          : server.snapshot.channels;
      for (const entry of body as { id: string; position: number }[]) {
        const target = live.find((target) => target.id === entry.id);
        ok(target);
        target.position = entry.position;
      }
    }
    if (
      io.loseResponse &&
      (operation.kind === "createRole" ||
        operation.kind === "createChannel" ||
        operation.kind === "createCategory")
    )
      throw new Error("Lost create response");
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
      available_tags: channel
        ? wireTags(channel.tags.map((tag) => ({ ...tag, key: tag.id })))
        : undefined,
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
  await review();
  return { options, server, review, io };
}

for (const position of [1, 100])
  test(`role order checks operator ceiling ${position} before mutation`, async (context) => {
    const { server, options, review, io } = await fixture(context);
    server.snapshot.roles[1].position = position;
    options.layout.roles.push({
      ...options.layout.roles[2],
      key: "scout",
      name: "Scout",
    });
    options.layout.channels[0].access.scout =
      options.layout.channels[0].access.member;
    const planned = await review();
    const result = await applyLayout(options);
    if (position === 1) {
      equal(io.mutations, 0);
      match(result.error ?? "", /server owner.*drag.*Operator.*top/i);
    } else equal(result.ok, true, JSON.stringify(result));
    equal(planned.ok, position !== 1, JSON.stringify(planned));
  });

test("live unnamed permission bits adopt, converge and survive writes", async (context) => {
  const setup = await fixture(context, true);
  const unknown = 1n << 47n;
  setup.server.snapshot.roles[0].permissions = unknown.toString();
  const overwrite = setup.server.live().overwrites[0];
  overwrite.allow = (BigInt(overwrite.allow) | unknown).toString();
  overwrite.deny = (BigInt(overwrite.deny) | (1n << 63n)).toString();
  const snapshot = await fetchSnapshot(setup.options.port, setup.options);
  const state = adopt(setup.options.layout, snapshot, emptyState("guild"));
  const initial = inspectPlan(setup.options.layout, snapshot, state);
  equal(initial.ok, true, JSON.stringify(initial));
  equal(initial.operations.length, 0);
  setup.options.layout.roles[0].permissions.ManageMessages = true;
  setup.options.layout.channels[0].name = "renamed";
  let roleWrite: string | undefined;
  const request = setup.options.port.request;
  context.mock.method(
    setup.options.port,
    "request",
    async (...args: Parameters<DiscordPort["request"]>) => {
      const [method, route, body] = args;
      if (method === "PATCH" && route.endsWith("/roles/guild"))
        roleWrite = (body as { permissions: string }).permissions;
      return request(method, route, body);
    },
  );
  await setup.review();
  const result = await applyLayout(setup.options);
  equal(result.ok, true, JSON.stringify(result));
  ok(roleWrite);
  equal(BigInt(roleWrite) & unknown, unknown);
  equal(BigInt(setup.server.live().overwrites[0].allow) & unknown, unknown);
  equal(
    BigInt(setup.server.live().overwrites[0].deny) & (1n << 63n),
    1n << 63n,
  );
});

for (const failure of ["lost response", "state write"])
  test(`${failure} requires adoption without a duplicate create`, async (context) => {
    const setup = await fixture(context);
    if (failure === "lost response") setup.io.loseResponse = true;
    const result = await withStateLock(setup.options.statePath, (locked) =>
      applyLocked(setup.options, {
        ...locked,
        write(state) {
          if (failure === "state write" && setup.io.mutations > 0)
            throw new Error("Disk write failed");
          locked.write(state);
        },
      }),
    );
    ok(result.readback);
    const state = loadState(setup.options.statePath);
    equal(state.uncertainCreates.length, 1);
    const retry = await applyLayout(setup.options);
    equal(retry.ok, false);
    equal(setup.io.mutations, 1);
    const adopted = adopt(setup.options.layout, setup.server.snapshot, state);
    equal(adopted.ids.roles.member, setup.server.ids.roles.member);
    equal(adopted.uncertainCreates.length, 0);
  });

for (const mismatch of ["application", "guild"])
  test(`preflight refuses a different ${mismatch}`, async (context) => {
    const setup = await fixture(context);
    if (mismatch === "application") setup.io.identity = "other";
    else setup.io.guild = "other";
    const result = await applyLayout(setup.options);
    match(result.error ?? "", /differs/);
    ok(result.readbackError);
    equal(setup.io.mutations, 0);
  });

test("apply saves tag IDs and interrupted permissions retain protection", async (context) => {
  const setup = await fixture(context);
  equal((await applyLayout(setup.options)).ok, true);
  ok(loadState(setup.options.statePath).ids.tags.lobby.new);
  const channel = setup.server.snapshot.channels[0];
  const before = setup.io.mutations;
  setup.options.layout.channels[0].access.member = access();
  await setup.review();
  setup.io.failMutation = before + 2;
  const result = await applyLayout(setup.options);
  equal(result.ok, false);
  equal(result.completed[0].kind, "protectOverwrites");
  equal(
    canView(setup.server.snapshot, channel.id, setup.server.ids.roles.member),
    false,
  );
  equal(setup.io.mutations, before + 2);
  ok(result.readback);
});

test("saved plan refuses drift and held state lock refuses concurrent apply", async (context) => {
  const setup = await fixture(context);
  setup.options.layout.roles[2].name = "Renamed";
  equal((await applyLayout(setup.options)).ok, false);
  await withStateLock(setup.options.statePath, async () => {
    await rejects(applyLayout(setup.options), /State lock active/);
  });
  equal(setup.io.mutations, 0);
});

test("tied role positions converge in one apply", async (context) => {
  const setup = await fixture(context, true),
    { server, options } = setup;
  const member = server.snapshot.roles.find(
    (role) => role.id === server.ids.roles.member,
  );
  ok(member);
  const previous = member.id;
  member.id = server.ids.roles.member = "9";
  for (const channel of server.snapshot.channels)
    for (const entry of channel.overwrites)
      if (entry.id === previous) entry.id = "9";
  options.layout.roles.push({
    ...options.layout.roles[2],
    key: "scout",
    name: "Scout",
  });
  server.ids.roles.scout = "10";
  server.snapshot.roles.push(
    { ...member, id: "10", name: "Scout" },
    { ...member, id: "fixed", name: "Integration", position: 2, managed: true },
  );
  for (const channel of options.layout.channels)
    channel.access.scout = { ...channel.access.member };
  await withStateLock(options.statePath, (locked) =>
    locked.write({ ...locked.read(), ids: server.ids }),
  );
  await setup.review();
  equal((await applyLayout(options)).ok, true);
  equal(
    server.snapshot.roles.find((entry) => entry.id === "fixed")?.position,
    2,
  );
  const before = setup.io.mutations;
  await setup.review();
  equal((await applyLayout(options)).ok, true);
  equal(setup.io.mutations, before);
});

for (const [command, path] of [
  ["plan", "plan.json"],
  ["apply", "plan.json"],
  ["plan", "..notes/plan.json"],
  ["plan", "symlink"],
])
  test(`${command} refuses repository plan path ${path}`, async (context) => {
    const setup = await fixture(context);
    const directory = fs.mkdtempSync(
      join(process.cwd(), path.startsWith("..") ? "..notes-" : "plan-"),
    );
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const planPath = join(directory, "plan.json");
    if (path === "symlink") fs.symlinkSync(setup.options.planPath, planPath);
    const result = spawnSync(
      process.execPath,
      [
        "scripts/layout.mts",
        command,
        "--guild=guild",
        "--application=app",
        `--state=${setup.options.statePath}`,
        `--plan=${planPath}`,
      ],
      { encoding: "utf8" },
    );
    equal(result.status, 1);
    match(result.stderr, /Plan must be outside the repository/);
  });

test("lost replacement response adopts the replacement without another create", async (context) => {
  const setup = await fixture(context, true),
    { server, options } = setup;
  const doomed = server.ids.channels.lobby;
  options.layout.channels[0].type = "text";
  options.layout.channels[0].tags = [];
  options.allowDelete = true;
  await setup.review();
  setup.io.loseResponse = true;
  equal((await applyLayout(options)).ok, false);
  const adopted = adopt(
    options.layout,
    server.snapshot,
    loadState(options.statePath),
  );
  equal(adopted.ids.channels.lobby, server.ids.channels.lobby);
  const fresh = inspectPlan(options.layout, server.snapshot, adopted);
  equal(fresh.ok, true);
  ok(!fresh.operations.some((entry) => entry.kind === "createChannel"));
  ok(
    fresh.operations.some(
      (entry) => entry.kind === "deleteChannel" && entry.id === doomed,
    ),
  );
});

test("channel recreation excludes member overwrites with unnamed bits", async (context) => {
  const { server, options, review } = await fixture(context, true);
  server.live().overwrites.push({
    id: "synthetic-member",
    type: "member",
    allow: (1n << 47n).toString(),
    deny: "0",
  });
  options.layout.channels[0].type = "text";
  options.layout.channels[0].tags = [];
  options.allowDelete = true;
  await review();
  const result = await applyLayout(options);
  equal(result.readback?.ok, true, result.readback?.errors.join("; "));
  equal(result.ok, true);
  equal(result.remaining?.operations.length, 0);
});

test("rate limit stops apply after one mutation attempt and still runs readback", async (context) => {
  const setup = await fixture(context);
  setup.io.rateLimited = true;
  const result = await applyLayout(setup.options);
  equal(result.ok, false);
  equal(result.errorKind, "rate_limit");
  equal(result.retryAfterMs, 51);
  equal(setup.io.mutations, 1);
  ok(result.readback);
});
