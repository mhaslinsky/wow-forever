import { deepEqual, equal, match, ok, throws } from "node:assert/strict";
import test from "node:test";
import { ChannelType, PermissionFlagsBits as flags } from "discord.js";
import fc from "fast-check";
import type { Layout } from "../src/layout/index.mts";
import {
  adoptionCandidates,
  channelTypes,
  compilePermissions,
  parseLayout,
  plan,
  protectionTargets,
  rolePermissions,
  validateLayout,
} from "../src/layout/index.mts";
import {
  access,
  applied,
  canView,
  category,
  fixture,
  model,
  overwrite,
} from "./layout-model.mts";

test("validation rejects malformed layouts and impossible access", () => {
  const invalid = (mutate: (layout: Layout) => void, message: RegExp) => {
    const layout = fixture();
    mutate(layout);
    throws(() => validateLayout(layout), message);
  };
  invalid((layout) => {
    layout.channels[0].access = {};
  }, /coverage/);
  invalid((layout) => {
    layout.channels[0].access.member.view = false;
  }, /view denied/);
  invalid((layout) => {
    layout.roles[2].permissions.Administrator = true;
  }, /operator role/);
  invalid((layout) => {
    layout.roles[2].permissions.UnnamedPermission = true;
  }, /unknown permission/);
  invalid((layout) => {
    layout.roles[2].key = "everyone";
  }, /duplicate keys/);
  invalid((layout) => {
    layout.channels[0].access.operator = access();
  }, /Administrator must/);
  for (const field of ["roles", "channels", "overwrites"] as const) {
    invalid((layout) => {
      layout.ignore[field] = ["External", "External"];
    }, /duplicate keys/);
    invalid((layout) => {
      layout.ignore[field] = [" "];
    }, /nonempty/);
  }
  for (const value of [null, {}, { roles: "bad" }])
    throws(() => validateLayout(value));
  throws(() => parseLayout("roles: []\nroles: []"), /Map keys must be unique/);
});
test("compiled access agrees with an independent effective-permission oracle", () => {
  fc.assert(
    fc.property(
      fc.constantFrom(...channelTypes),
      fc.array(fc.boolean(), { minLength: 8, maxLength: 8 }),
      fc.bigInt({ min: 0n, max: (1n << 53n) - 1n }),
      (type, values, base) => {
        const layout = fixture(),
          channel = layout.channels[0];
        channel.type = type;
        channel.tags = [];
        const cell = (values: boolean[]) => {
          const [view, send, connect, manageThreads] = values;
          return {
            view,
            send: view && send,
            connect: view && connect && ["voice", "category"].includes(type),
            manageThreads: view && manageThreads && type !== "voice",
          };
        };
        channel.access.everyone = cell(values.slice(0, 4));
        channel.access.member = cell(values.slice(4));
        channel.access.operator = {
          view: true,
          send: true,
          connect: ["voice", "category"].includes(type),
          manageThreads: type !== "voice",
        };
        const before = structuredClone(layout);
        const overwrites = compilePermissions(validateLayout(layout), channel);
        const masks = {
          view: flags.ViewChannel,
          send:
            flags.SendMessages |
            flags.SendMessagesInThreads |
            (type === "voice"
              ? 0n
              : flags.CreatePublicThreads | flags.CreatePrivateThreads),
          connect: ["voice", "category"].includes(type)
            ? flags.Connect | flags.Speak
            : 0n,
          manageThreads: type === "voice" ? 0n : flags.ManageThreads,
        };
        let actual = base & ~flags.Administrator;
        for (const roleKey of ["everyone", "member"]) {
          const entry = overwrites.find((entry) => entry.roleKey === roleKey);
          ok(entry);
          actual = (actual & ~BigInt(entry.deny)) | BigInt(entry.allow);
          for (const field of Object.keys(masks) as (keyof typeof masks)[])
            equal(
              actual & masks[field],
              channel.access[roleKey][field] ? masks[field] : 0n,
              `${roleKey}/${field}`,
            );
        }
        deepEqual(layout, before);
      },
    ),
    { numRuns: 300 },
  );
  const role = fixture().roles[2];
  role.permissions.SendMessages = false;
  deepEqual(rolePermissions(role), {
    allow: flags.ViewChannel,
    managed: flags.ViewChannel | flags.SendMessages,
  });
});
test("adoption requires consent and rejects ambiguous roles or channels", () => {
  const server = applied(),
    { layout, snapshot, ids } = server;
  const empty = { roles: {}, channels: {}, tags: {} };
  deepEqual(adoptionCandidates(layout, snapshot, empty), ids);
  equal(plan(layout, snapshot, empty).ok, false);
  snapshot.channels.push({ ...server.live(), id: "duplicate" });
  throws(() => adoptionCandidates(layout, snapshot, empty), /Ambiguous/);
  snapshot.channels[1].parent = "other-parent";
  equal(
    adoptionCandidates(layout, snapshot, empty).channels.lobby,
    ids.channels.lobby,
  );
  snapshot.roles.push({ ...snapshot.roles[2], id: "duplicate-role" });
  throws(() => adoptionCandidates(layout, snapshot, empty), /Ambiguous/);
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
  const integration = overwrite("integration", "1024");
  live.overwrites.push(integration);
  layout.ignore.channels.push(live.name);
  equal(plan(layout, snapshot, ids).ok, false);
  layout.ignore.overwrites.push("Integration");
  live.overwrites[0].deny = "0";
  ok(
    server.run().operations.some((entry) => entry.kind === "replaceOverwrites"),
  );
  deepEqual(
    live.overwrites.find((entry) => entry.id === "integration"),
    integration,
  );
  snapshot.channels.push({
    ...structuredClone(live),
    id: "unknown",
    name: "External",
  });
  equal(plan(layout, snapshot, ids).ok, false);
  layout.ignore.channels.push("External");
  equal(plan(layout, snapshot, ids).ok, true);
});

test("stale bindings recreate objects and converge", () => {
  const server = applied(),
    { layout, snapshot, ids } = server;
  snapshot.channels = [];
  snapshot.roles = snapshot.roles.filter(
    (role) => role.id !== ids.roles.member,
  );
  const result = server.run();
  ok(result.operations.some((entry) => entry.kind === "createRole"));
  ok(result.operations.some((entry) => entry.kind === "createChannel"));
  deepEqual(result.staleBindings.map((entry) => entry.kind).sort(), [
    "channel",
    "role",
    "tag",
  ]);
  deepEqual(plan(layout, snapshot, ids).operations, []);
});

test("member overwrites are destructive removals and ignored bindings survive", () => {
  const server = applied(),
    { layout, snapshot, ids } = server,
    live = server.live();
  live.overwrites.push(overwrite("person", "1024", "0", "member"));
  equal(server.run().destructive, true);
  ok(live.overwrites.every((entry) => entry.type === "role"));
  layout.channels = [];
  layout.roles.pop();
  layout.ignore.channels.push(live.name);
  layout.ignore.roles.push("Member");
  deepEqual(plan(layout, snapshot, ids).operations, []);
});

test("role creation and reorder converge; deletion removes children before categories and roles", () => {
  const layout = fixture();
  layout.roles.push({
    ...structuredClone(layout.roles[2]),
    key: "scout",
    name: "Scout",
  });
  layout.channels[0].access.scout = { ...layout.channels[0].access.member };
  layout.channels.push(category(layout));
  layout.channels[0].parent = "category";
  const server = applied(layout);
  layout.roles.reverse();
  const changed = server.run();
  ok(changed.operations.some((entry) => entry.kind === "reorderRoles"));
  deepEqual(plan(layout, server.snapshot, server.ids).operations, []);
  layout.channels = [];
  layout.roles = layout.roles.filter((role) => role.kind !== "managed");
  const removed = server.run();
  deepEqual(
    removed.operations
      .filter((entry) => entry.kind.startsWith("delete"))
      .map((entry) => entry.kind),
    ["deleteChannel", "deleteCategory", "deleteRole", "deleteRole"],
  );
  equal(server.snapshot.channels.length, 0);
  equal(server.snapshot.roles.length, 2);
});

test("ignored and unbound children matching any category state block changes", () => {
  const layout = fixture(),
    child = layout.channels[0];
  child.access.member = access();
  const parent = category(layout);
  child.parent = parent.key;
  layout.channels.push(parent);
  const server = applied(layout),
    { snapshot, ids } = server;
  const external = {
    ...structuredClone(server.live("category")),
    id: "external",
    name: "External",
    parent: ids.channels.category,
    type: server.live().type,
  };
  snapshot.channels.push(external);
  layout.ignore.channels.push(external.name);
  parent.access.member = access(true, true);
  const final = compilePermissions(layout, parent).map(
    ({ roleKey, ...entry }) => ({ ...entry, id: ids.roles[roleKey] }),
  );
  const select = () =>
    protectionTargets(layout, snapshot, ids, {
      touched: new Set([parent.key]),
      roleBitsChanged: false,
      recreated: new Set(),
      finalOverwrites: new Map([[parent.key, final]]),
    });
  const selection = select();
  equal(plan(layout, snapshot, ids).ok, false);
  match(selection.errors[0], /ignored channel External.*unsync/);
  const protectedParent = selection.channels.find(
    (target) => target.key === parent.key,
  );
  ok(protectedParent);
  for (const state of [final, protectedParent.overwrites]) {
    external.overwrites = structuredClone(state);
    equal(select().errors.length, 1);
  }
  layout.ignore.channels = [];
  match(select().errors[0], /unbound channel External/);
  layout.ignore.channels.push(external.name);
  external.overwrites = [
    overwrite("guild", "0", flags.ManageMessages.toString()),
  ];
  const before = structuredClone(external.overwrites);
  server.run();
  deepEqual(external.overwrites, before);
});

test("undeclared Administrator blocks; explicit removal keeps Member hidden", () => {
  const layout = fixture();
  layout.channels[0].access.member = access();
  const server = applied(layout),
    { snapshot, ids } = server,
    member = snapshot.roles[2];
  member.permissions = (flags.Administrator | flags.ViewChannel).toString();
  server.live().overwrites = [
    overwrite(member.id, flags.ViewChannel.toString()),
  ];
  const blocked = plan(layout, snapshot, ids);
  equal(blocked.ok, false);
  match(blocked.errors.join(), /member.*Administrator|Administrator.*member/);
  layout.roles[2].permissions.Administrator = false;
  const result = plan(layout, snapshot, ids);
  equal(result.ok, true);
  for (const operation of result.operations) {
    server.apply(operation);
    if (!(BigInt(member.permissions) & flags.Administrator))
      equal(
        canView(snapshot, ids.channels.lobby, member.id),
        false,
        operation.kind,
      );
  }
  equal(BigInt(member.permissions) & flags.Administrator, 0n);
});
test("operator capabilities survive removals and protection preserves visibility", () => {
  const layout = fixture(),
    server = model(),
    { snapshot, ids } = server;
  snapshot.roles[0].permissions = (
    flags.ManageRoles | flags.ManageChannels
  ).toString();
  snapshot.roles[1].permissions = flags.ViewChannel.toString();
  layout.roles[1].permissions = { ViewChannel: true };
  layout.roles[0].permissions = { ManageRoles: false, ManageChannels: false };
  const blocked = plan(layout, snapshot, ids);
  equal(blocked.ok, false);
  match(blocked.errors.join(), /Operator.*removals/);
  snapshot.roles[1].permissions = (
    flags.ViewChannel |
    flags.ManageRoles |
    flags.ManageChannels
  ).toString();
  for (const rename of [false, true]) {
    if (rename) layout.channels[0].name = "renamed";
    if (rename) {
      const selection = protectionTargets(layout, snapshot, ids, {
        touched: new Set(["lobby"]),
        roleBitsChanged: false,
        recreated: new Set(),
        finalOverwrites: new Map(),
      });
      equal(selection.channels.length, 1);
      ok(
        selection.channels.every(
          (target) => !target.roleIds.includes(ids.roles.operator),
        ),
      );
    }
    const result = plan(layout, snapshot, ids);
    equal(result.ok, true);
    for (const operation of result.operations) {
      server.apply(operation);
      for (const channel of snapshot.channels)
        equal(
          canView(snapshot, channel.id, ids.roles.operator),
          true,
          operation.kind,
        );
    }
  }
});
const shapes = [
  "root move",
  "dangling parent",
  "child before parent",
  "base grant",
  "new category",
] as const;
for (const shape of shapes)
  test(`private transitions: ${shape}`, () => {
    const layout = fixture();
    const child = layout.channels[0];
    child.access.member = access();
    const parent = category(layout);
    const server = model(),
      { snapshot, ids } = server;
    if (shape !== "new category") {
      if (shape !== "base grant") layout.channels.push(parent);
      server.run(layout);
      const live = server.live();
      if (shape === "base grant") {
        const member = snapshot.roles.find(
          (entry) => entry.id === ids.roles.member,
        );
        ok(member);
        member.permissions = "0";
        live.overwrites = [];
      } else {
        server.live("category").overwrites = structuredClone(live.overwrites);
        parent.access.member = access(true, true);
        child.parent = "category";
        if (shape === "dangling parent") live.parent = "deleted-category";
        if (shape === "child before parent") {
          snapshot.channels = snapshot.channels.filter(
            (entry) => entry !== live,
          );
          delete ids.channels.lobby;
        }
      }
    } else {
      layout.channels.push(parent);
      child.parent = "category";
    }
    const result = plan(validateLayout(layout), snapshot, ids);
    equal(result.ok, true, JSON.stringify(result.errors));
    for (const operation of result.operations) {
      server.apply(operation);
      equal(
        canView(snapshot, ids.channels.lobby, ids.roles.member),
        false,
        `${shape}: ${operation.kind}`,
      );
      const live = snapshot.channels.find(
        (entry) => entry.id === ids.channels.lobby,
      );
      if (
        live?.parent &&
        (operation.kind === "createChannel" ||
          operation.kind === "updateChannel")
      )
        ok(
          snapshot.channels.some(
            (entry) =>
              entry.id === live.parent &&
              entry.type === ChannelType.GuildCategory,
          ),
          `${shape}: missing parent`,
        );
    }
    deepEqual(plan(layout, snapshot, ids).operations, []);
  });

test("forum tag rename retains ID and tag removal is destructive", () => {
  const server = applied(),
    tagId = server.ids.tags.lobby.new;
  server.layout.channels[0].tags[0].name = "Renamed";
  server.run();
  equal(server.live().tags[0].id, tagId);
  deepEqual(plan(server.layout, server.snapshot, server.ids).operations, []);
  server.layout.channels[0].tags = [];
  equal(server.run().destructive, true);
});

test("mixed role changes protect before removals and grant after overwrite finals", () => {
  const layout = fixture();
  layout.channels[0].access.member = access();
  const server = applied(layout),
    member = server.snapshot.roles[2];
  member.permissions = (flags.ViewChannel | flags.SendMessages).toString();
  layout.roles[2].permissions = {
    ViewChannel: false,
    SendMessages: false,
    ManageThreads: true,
  };
  const result = server.run();
  const roleUpdates = result.operations.flatMap((entry, index) =>
    entry.kind === "updateRole" ? [index] : [],
  );
  const finals = result.operations.flatMap((entry, index) =>
    entry.kind === "replaceOverwrites" ? [index] : [],
  );
  equal(result.operations[0].kind, "protectOverwrites");
  equal(roleUpdates.length, 2);
  ok(roleUpdates[0] < Math.min(...finals));
  ok(roleUpdates[1] > Math.max(...finals));
  equal(member.permissions, flags.ManageThreads.toString());
  deepEqual(plan(layout, server.snapshot, server.ids).operations, []);
});
