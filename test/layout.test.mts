import {
  deepEqual,
  equal,
  match,
  notEqual,
  ok,
  throws,
} from "node:assert/strict";
import test from "node:test";
import {
  ChannelType,
  Collection,
  PermissionFlagsBits as flags,
  GuildChannel,
  PermissionsBitField,
} from "discord.js";
import fc from "fast-check";
import type { Layout, Overwrite } from "../src/layout/index.mts";
import {
  adoptionCandidates,
  channelTypes,
  compilePermissions,
  normalizeBits,
  normalizeOverwrites,
  normalizeSnapshot,
  parseLayout,
  plan,
  protectionTargets,
  protectiveOverwrite,
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
test("normalization preserves drift bits, defaults and rejects malformed bitfields", () => {
  const entry = overwrite("guild", "0001");
  const server = applied();
  const snapshot = normalizeSnapshot({
    ...server.snapshot,
    roles: [{ ...server.snapshot.roles[0], hoist: undefined }],
    channels: [
      {
        ...server.live(),
        topic: undefined,
        type: ChannelType.GuildStageVoice,
        overwrites: [entry],
      },
      { ...server.live(), id: "missing-tags", tags: undefined },
    ],
  });
  equal(snapshot.channels[0].topic, "");
  deepEqual(snapshot.channels[1].tags, []);
  equal(snapshot.channels[0].type, ChannelType.GuildStageVoice);
  equal(snapshot.channels[0].overwrites[0].allow, "1");
  equal(snapshot.roles[0].hoist, false);
  for (const malformed of ["", "-1", "garbage", Number.MAX_SAFE_INTEGER + 1])
    throws(() => normalizeBits(malformed));
  throws(() => normalizeOverwrites([entry, entry]), /Duplicate overwrite/);
  const ordered = normalizeOverwrites([overwrite("a"), overwrite("Z")]);
  deepEqual(
    ordered.map((entry) => entry.id),
    ["Z", "a"],
  );
  deepEqual(Object.keys(ordered[0]), ["type", "id", "allow", "deny"]);
});
test("protective overwrites add no allow bits", () => {
  fc.assert(
    fc.property(
      fc.constantFrom(...channelTypes),
      fc.bigInt({ min: 0n, max: 65535n }),
      fc.bigInt({ min: 0n, max: 65535n }),
      fc.constantFrom("none", "child", "category"),
      (type, allow, deny, emptyMode) => {
        const entries: Overwrite[] = [
          overwrite(
            "guild",
            emptyMode === "none" ? allow.toString() : "0",
            emptyMode === "none" ? deny.toString() : "0",
          ),
          overwrite("member", deny.toString(), allow.toString()),
        ];
        const parent = structuredClone(entries).reverse();
        if (emptyMode === "child") entries.shift();
        if (emptyMode === "category") parent.pop();
        const before = structuredClone(entries);
        equal(locked(entries, parent), true);
        const result = protectiveOverwrite(
          { type, everyoneId: "guild", overwrites: entries },
          { overwrites: parent },
        );
        equal(locked(result, parent), false);
        for (const entry of result) {
          const previous = before.find(
            (before) => before.id === entry.id && before.type === entry.type,
          );
          equal(BigInt(entry.allow) & ~BigInt(previous?.allow ?? "0"), 0n);
        }
        deepEqual(entries, before);
      },
    ),
  );
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

test("type replacements omit doomed overwrites and move retained children", () => {
  const layout = fixture(),
    child = layout.channels[0];
  layout.channels.push(category(layout));
  child.parent = "category";
  layout.channels.push({
    ...structuredClone(child),
    key: "retained",
    name: "retained",
  });
  const server = applied(layout),
    oldParent = server.live("category").id;
  server.live("category").type = ChannelType.GuildText;
  server.live().overwrites.push(overwrite("person", "0", "0", "member"));
  child.type = "text";
  child.tags = [];
  const result = server.run();
  const create = result.operations.find(
    (entry) => entry.kind === "createChannel",
  );
  ok(create?.kind === "createChannel");
  ok(create.overwrites.every((entry) => entry.type === "role"));
  equal(result.destructive, true);
  notEqual(server.ids.channels.category, oldParent);
  for (const key of ["lobby", "retained"])
    equal(server.live(key).parent, server.ids.channels.category);
  deepEqual(plan(layout, server.snapshot, server.ids).operations, []);
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

function locked(child: Overwrite[], parent: Overwrite[]) {
  const getter = Object.getOwnPropertyDescriptor(
    GuildChannel.prototype,
    "permissionsLocked",
  )?.get;
  ok(getter);
  const cache = (entries: Overwrite[]) =>
    new Collection(
      entries.map((entry) => [
        entry.id,
        {
          allow: new PermissionsBitField(BigInt(entry.allow)),
          deny: new PermissionsBitField(BigInt(entry.deny)),
        },
      ]),
    );
  return getter.call({
    guildId: "guild",
    permissionOverwrites: { cache: cache(child) },
    parent: { permissionOverwrites: { cache: cache(parent) } },
  });
}

test("protection falls back to text and voice flags after common denies", () => {
  const common =
    flags.ViewChannel |
    flags.ReadMessageHistory |
    flags.SendMessages |
    flags.SendMessagesInThreads;
  for (const type of channelTypes) {
    const entries = [overwrite("guild", "0", common.toString())];
    const result = protectiveOverwrite(
      { type, everyoneId: "guild", overwrites: entries },
      { overwrites: entries },
    );
    equal(
      BigInt(result[0].deny) & ~common,
      type === "voice" ? flags.Connect : flags.CreatePublicThreads,
    );
  }
});

test("omitted voice send defaults to deny", () => {
  const layout = fixture(),
    channel = layout.channels[0];
  channel.type = "voice";
  channel.tags = [];
  channel.access = Object.fromEntries(
    layout.roles.map((role) => [
      role.key,
      { ...access(true, true), manageThreads: false },
    ]),
  );
  Reflect.deleteProperty(channel.access.member, "send");
  const checked = validateLayout(layout);
  equal(checked.channels[0].access.member.send, false);
  const member = compilePermissions(checked, checked.channels[0]).find(
    (entry) => entry.roleKey === "member",
  );
  ok(member);
  const text = flags.SendMessages | flags.SendMessagesInThreads;
  equal(BigInt(member.deny) & text, text);
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

test("reparent reorders against destination siblings", () => {
  const layout = fixture(),
    child = layout.channels[0];
  layout.channels.push(
    category(layout, "source"),
    category(layout, "destination"),
  );
  child.parent = "source";
  layout.channels.push({
    ...structuredClone(child),
    key: "resident",
    name: "resident",
    parent: "destination",
  });
  const server = applied(layout),
    arrival = server.live(),
    resident = server.live("resident");
  arrival.position = 0;
  resident.position = 10;
  child.parent = "destination";
  const result = server.run();
  ok(
    result.operations.some(
      (entry) =>
        entry.kind === "reorderChannels" && entry.parentKey === "destination",
    ),
  );
  ok(arrival.position < resident.position);
  deepEqual(plan(layout, server.snapshot, server.ids).operations, []);
});

test("normalization excludes every thread type", () => {
  const server = applied();
  for (const type of [
    ChannelType.AnnouncementThread,
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
  ])
    server.snapshot.channels.push({ ...server.live(), type });
  equal(normalizeSnapshot(server.snapshot).channels.length, 1);
});

test("public creates skip redundant overwrite replacement", () => {
  const layout = fixture();
  layout.channels[0].access.everyone = { ...layout.channels[0].access.member };
  const server = model(),
    result = server.run(layout);
  equal(
    result.operations.filter((entry) => entry.kind === "replaceOverwrites")
      .length,
    0,
  );
  deepEqual(plan(layout, server.snapshot, server.ids).operations, []);
  layout.channels[0].name = "renamed";
  deepEqual(
    server.run(layout).operations.map((entry) => entry.kind),
    ["updateChannel"],
  );
});

test("channel metadata and role fields are applied without changing owned permissions", () => {
  for (const field of ["name", "topic"] as const) {
    const server = applied();
    server.layout.channels[0][field] = "changed";
    equal(validateLayout(server.layout).channels[0][field], "changed");
    ok(server.run().operations.some((entry) => entry.kind === "updateChannel"));
    equal(server.live()[field], "changed");
  }
  const server = applied();
  server.layout.roles[2].mentionable = true;
  const permissions = server.snapshot.roles[2].permissions;
  server.run();
  equal(server.snapshot.roles[2].mentionable, true);
  equal(server.snapshot.roles[2].permissions, permissions);
  deepEqual(plan(server.layout, server.snapshot, server.ids).operations, []);
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

test("category metadata and deletion preserve synced ignored children", () => {
  for (const change of ["rename", "topic", "reorder", "delete"]) {
    const layout = fixture(),
      child = layout.channels[0];
    for (const key of Object.keys(child.access))
      child.access[key] = access(true);
    const parent = category(layout);
    parent.access.everyone = parent.access.member = access();
    layout.channels.push(parent, category(layout, "other"));
    child.parent = "category";
    const server = applied(layout);
    const external = {
      ...structuredClone(server.live("category")),
      id: "external",
      name: "External",
      type: ChannelType.GuildText,
      parent: server.ids.channels.category,
    };
    external.overwrites.reverse();
    server.snapshot.channels.push(external);
    layout.ignore.channels.push(external.name);
    const before = structuredClone(external.overwrites);
    if (change === "rename") parent.name = "renamed";
    if (change === "topic") parent.topic = "changed";
    if (change === "reorder") layout.channels.reverse();
    if (change === "delete") {
      layout.channels = layout.channels.filter((entry) => entry !== parent);
      delete child.parent;
    }
    const result = server.run();
    ok(result.operations.length > 0);
    ok(
      result.operations.every(
        (entry) =>
          !["protectOverwrites", "replaceOverwrites"].includes(entry.kind),
      ),
    );
    deepEqual(external.overwrites, before);
  }
});

for (const reparent of [false, true])
  for (const rename of [false, true])
    for (const newChild of [false, true])
      test(`synced private child: move=${reparent}, rename=${rename}, create=${newChild}`, () => {
        const layout = fixture(),
          child = layout.channels[0];
        child.type = "text";
        child.tags = [];
        child.access.member = access();
        const parent = category(layout);
        child.parent = "category";
        layout.channels.unshift(parent);
        const server = applied(layout),
          liveParent = server.live("category"),
          liveChild = server.live();
        liveChild.overwrites = structuredClone(liveParent.overwrites);
        if (newChild) {
          for (const entry of liveParent.overwrites)
            entry.deny = (
              BigInt(entry.deny) & ~(flags.Connect | flags.Speak)
            ).toString();
          server.snapshot.channels = server.snapshot.channels.filter(
            (entry) => entry !== liveChild,
          );
          delete server.ids.channels.lobby;
        }
        if (rename) child.name = "renamed-private";
        parent.access.member = access(true, true);
        if (reparent) {
          if (!newChild) {
            server.snapshot.channels.push({
              ...structuredClone(liveParent),
              id: "destination",
              name: "destination",
              overwrites: structuredClone(liveChild.overwrites),
            });
            server.ids.channels.destination = "destination";
            liveParent.overwrites[0].deny = (
              BigInt(liveParent.overwrites[0].deny) | flags.Stream
            ).toString();
          }
          layout.channels.push({
            ...structuredClone(parent),
            key: "destination",
            name: "destination",
          });
          child.parent = "destination";
        }
        const { snapshot, ids } = server;
        const result = plan(layout, snapshot, ids);
        equal(result.ok, true, JSON.stringify(result.errors));
        ok(
          result.operations.some(
            (entry) =>
              entry.kind === (newChild ? "createChannel" : "protectOverwrites"),
          ),
        );
        for (const operation of result.operations) {
          server.apply(operation);
          equal(
            canView(snapshot, ids.channels.lobby, ids.roles.member),
            false,
            operation.kind,
          );
        }
        deepEqual(plan(layout, snapshot, ids).operations, []);
      });

test("bound forum tags adopt while moving to an unbound category", () => {
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
  equal(candidates.tags.lobby.new, tagId);
  Object.assign(server.ids, candidates);
  server.run();
  equal(server.live().tags[0].id, tagId);
  deepEqual(plan(server.layout, server.snapshot, server.ids).operations, []);
});
