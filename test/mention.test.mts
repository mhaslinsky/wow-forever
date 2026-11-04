import assert from "node:assert/strict";
import test from "node:test";
import type { ConverseCommandInput } from "@aws-sdk/client-bedrock-runtime";
import { PermissionFlagsBits as flags } from "discord.js";
import { createChannelContext } from "../src/assistant/context.mts";
import {
  createAssistant,
  createConverse,
  createRouting,
} from "../src/assistant/core.mts";
import {
  canView,
  createMention,
  type Mention,
} from "../src/assistant/mention.mts";
import { assistantPrincipal } from "../src/assistant/runtime.mts";
import { authority, capToMember } from "../src/auth/index.mts";
import { createDataAccess } from "../src/data/index.mts";
import { recordKey } from "../src/data/records.mts";
import { clock } from "../src/interactions/core.mts";
import { assistantClaim, deliveryClaim } from "../src/interactions/index.mts";

const signal = new AbortController().signal;
const event: Mention = {
  guildId: "guild",
  channelId: "channel",
  messageId: "message",
  authorId: "asker",
};
const overwrite = (id: string, allow = 0n, deny = 0n, type = 0) => ({
  id,
  type,
  allow: String(allow),
  deny: String(deny),
});
const roles = [
  { id: "guild", name: "@everyone", permissions: String(flags.ViewChannel) },
  ...["Member", "Officer", "GM", "Guest"].map((name) => ({
    id: name.toLowerCase(),
    name,
    permissions: "0",
  })),
];
function setup(role = "officer") {
  let now = 1000;
  const replies: string[] = [],
    reasons: string[] = [],
    routes: ConverseCommandInput[] = [],
    requests: ConverseCommandInput[] = [];
  let searches = 0,
    checks = 0;
  const humans: { user: { id: string; bot?: boolean }; roles: string[] }[] = [
    { user: { id: "asker" }, roles: [role] },
    { user: { id: "bot", bot: true }, roles: ["member"] },
  ];
  const parent = {
    id: "channel",
    guild_id: "guild",
    type: 0,
    permission_overwrites: [
      overwrite("guild", 0n, flags.ViewChannel),
      ...["member", "officer", "gm"].map((id) =>
        overwrite(id, flags.ViewChannel),
      ),
    ],
  };
  const thread = {
    id: "thread",
    guild_id: "guild",
    type: 12,
    parent_id: "channel",
  };
  let secondFails = false;
  let loseHistory = false;
  const get = async (path: string): Promise<unknown> => {
    if (path.endsWith("/messages?limit=20"))
      return [
        {
          author: { username: "Synthetic author" },
          content: "CHANNEL_ONLY_SENTINEL",
          timestamp: new Date().toISOString(),
        },
      ];
    if (path === "/users/@me") return { id: "bot" };
    if (path.includes("/messages/"))
      return {
        id: path.split("/").at(-1),
        channel_id: path.split("/")[2],
        author: { id: "asker" },
        mentions: [{ id: "bot" }],
        content: "<@bot> What is my roster?",
      };
    if (path === "/channels/channel") return parent;
    if (path === "/channels/thread") return thread;
    if (path === "/guilds/guild") return { id: "guild", owner_id: "asker" };
    if (path === "/guilds/guild/roles") return roles;
    if (path === "/guilds/guild/members/asker") return humans[0];
    if (path === "/guilds/guild/members?limit=1000") {
      checks++;
      if (secondFails && checks === 2) throw new Error("VERIFICATION_FAILED");
      return humans;
    }
    return assert.fail(`Unexpected GET ${path}`);
  };
  const claims = new Map<string, number>();
  const claim = deliveryClaim(
    "claims",
    () => now,
    async (command) => {
      assert.equal(
        command.input.ConditionExpression,
        "attribute_not_exists(pk) OR expiresAt < :now",
      );
      const key = String(command.input.Item?.pk.S);
      const until = claims.get(key);
      if (until !== undefined && until >= now / 1000)
        throw Object.assign(new Error(), {
          name: "ConditionalCheckFailedException",
        });
      const expiry = Number(command.input.Item?.expiresAt.N);
      assert.ok(key.startsWith("mention-message#"));
      assert.ok(expiry * 1000 - now >= 86400000);
      claims.set(key, expiry);
    },
  );
  const stored = [
    {
      ...recordKey("member", "asker", "guild"),
      kind: "member",
      ownerId: "asker",
      name: "Roster sentinel",
    },
    {
      ...recordKey("officerNote", "guild", "note"),
      kind: "officerNote",
      ownerId: "guild",
      text: "OFFICER_ONLY_SENTINEL",
    },
  ];
  const data = createDataAccess({
    get: async (key) =>
      stored.find((record) => record.pk === key.pk && record.sk === key.sk),
    query: async () => ({ items: [] }),
    batch: async () => [],
    put: async () => assert.fail("Unexpected write"),
  });
  let cooldown = 0;
  const userClaim = assistantClaim(
    "claims",
    () => now,
    async () => {
      if (now < cooldown)
        throw Object.assign(new Error(), {
          name: "ConditionalCheckFailedException",
        });
      cooldown = now + 60000;
    },
  );
  const ask = createAssistant({
    data,
    guildId: "guild",
    claim: (user, abort) => userClaim("guild", user, abort),
    privateTerms: async () => [],
    route: createRouting(async (command) => {
      routes.push(command.input);
      return {
        $metadata: {},
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        metrics: { latencyMs: 0 },
        stopReason: "end_turn",
        output: {
          message: {
            role: "assistant",
            content: [
              { text: '{"needsGuild":true,"needsWeb":false,"searchQuery":""}' },
            ],
          },
        },
      };
    }),
    search: async () => {
      searches++;
      return { status: "empty" };
    },
    converse: createConverse(async (command) => {
      requests.push(command.input);
      if (loseHistory)
        parent.permission_overwrites.push(
          overwrite("other", 0n, flags.ReadMessageHistory, 1),
        );
      return {
        $metadata: {},
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        metrics: { latencyMs: 0 },
        stopReason: "end_turn",
        output: {
          message: {
            role: "assistant",
            content: [
              { text: requests.length === 1 ? "Answer" : "Regenerated" },
            ],
          },
        },
      };
    }),
  });
  let capturedActor: ReturnType<typeof capToMember> | undefined;
  const mention = createMention({
    guildId: "guild",
    get,
    claim,
    now: () => now,
    context: (channelId, abort) =>
      createChannelContext({ clock, get, report: () => {} }, channelId)(abort),
    answer: async (actor, question, abort, context, audience) => {
      capturedActor = actor;
      return ask(actor, question, abort, context, audience);
    },
    reply: async (_event, content) => {
      replies.push(content);
    },
    report: (reason) => {
      reasons.push(reason);
    },
  });
  return {
    mention,
    get,
    parent,
    thread,
    humans,
    replies,
    reasons,
    routes,
    requests,
    data,
    ask,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    failSecond: () => {
      secondFails = true;
    },
    loseHistory: () => {
      loseHistory = true;
    },
    actor: () => {
      assert.ok(capturedActor);
      return capturedActor;
    },
    noModels: () => {
      assert.equal(routes.length, 0);
      assert.equal(requests.length, 0);
      assert.equal(searches, 0);
    },
  };
}

test("Guest-readable and public channels answer without guild records", async () => {
  for (const mode of ["public", "guest"]) {
    const state = setup();
    if (mode === "guest") {
      state.parent.permission_overwrites.push(
        overwrite("guest", flags.ViewChannel | flags.ReadMessageHistory),
      );
      state.humans.push({ user: { id: "visitor" }, roles: ["guest"] });
    } else
      state.parent.permission_overwrites = [
        overwrite("guild", flags.ReadMessageHistory),
      ];
    state.parent.permission_overwrites.push(
      overwrite("member", flags.ReadMessageHistory),
    );
    await state.mention(event, signal);
    assert.deepEqual(state.replies, ["Answer"]);
    assert.equal(state.requests.length, 1);
    assert.match(
      JSON.stringify(state.requests[0]),
      /Untrusted guild records:\\n\[\]/,
    );
    assert.doesNotMatch(JSON.stringify(state.requests[0]), /Roster sentinel/);
    assert.match(JSON.stringify(state.requests[0]), /CHANNEL_ONLY_SENTINEL/);
  }
});

test("Officer-only and GM-only mentions use Member authority and exclude officer records from Converse", async () => {
  for (const role of ["officer", "gm"]) {
    const state = setup(role);
    const uncapped = await assistantPrincipal("guild", "asker", state.get);
    const key = recordKey("officerNote", "guild", "note");
    assert.equal(
      (await state.data.forUser(uncapped).get(key))[0]?.kind,
      "officerNote",
    );
    await state.mention(event, signal);
    assert.deepEqual(authority(state.actor()).roles, ["Member"]);
    assert.equal(authority(state.actor()).userId, "asker");
    assert.deepEqual(await state.data.forUser(state.actor()).get(key), []);
    assert.equal(state.requests.length, 1);
    assert.match(JSON.stringify(state.requests[0]), /Roster sentinel/);
    assert.doesNotMatch(
      JSON.stringify(state.requests[0]),
      /OFFICER_ONLY_SENTINEL/,
    );
    assert.deepEqual(state.replies, ["Answer"]);
  }
  const outsider = setup("guest");
  const principal = await assistantPrincipal("guild", "asker", outsider.get);
  assert.deepEqual(authority(capToMember(principal)).roles, []);
  await outsider.mention(event, signal);
  assert.deepEqual(outsider.replies, []);
  outsider.noModels();
});

test("a repeated message stays claimed after the shared user cooldown expires", async () => {
  const state = setup();
  await state.mention(event, signal);
  const principal = await assistantPrincipal("guild", "asker", state.get);
  assert.equal(
    await state.ask(principal, "Question", signal),
    "Give it a minute and try again.",
  );
  await state.mention(event, signal);
  state.advance(60001);
  await state.mention(event, signal);
  state.advance(86339999);
  await state.mention(event, signal);
  assert.equal(state.routes.length, 1);
  assert.equal(state.requests.length, 1);
  assert.deepEqual(state.replies, ["Answer"]);
});

test("canView applies owner, Administrator, combined role overwrites and member overwrites", () => {
  const guild = { id: "guild", owner_id: "owner" };
  const member = { user: { id: "visitor" }, roles: ["guest", "denied"] };
  const channel = {
    permission_overwrites: [
      overwrite("guild", 0n, flags.ViewChannel),
      overwrite("denied", 0n, flags.ViewChannel),
      overwrite("guest", flags.ViewChannel),
    ],
  };
  assert.equal(canView(member, channel, roles, guild), true);
  channel.permission_overwrites = [overwrite("guest", 0n, flags.ViewChannel)];
  assert.equal(canView(member, channel, roles, guild), false);
  channel.permission_overwrites.push(
    overwrite("visitor", flags.ViewChannel, 0n, 1),
  );
  assert.equal(canView(member, channel, roles, guild), true);
  assert.equal(
    canView(
      { user: { id: "owner" }, roles: [] },
      { permission_overwrites: [] },
      [],
      guild,
    ),
    true,
  );
  assert.equal(
    canView(
      member,
      {
        permission_overwrites: [overwrite("visitor", 0n, flags.ViewChannel, 1)],
      },
      [...roles, { id: "denied", permissions: String(flags.Administrator) }],
      guild,
    ),
    true,
  );
});

test("every thread verifies its parent including unjoined ManageThreads humans", async () => {
  for (const type of [10, 11, 12]) {
    const state = setup();
    state.thread.type = type;
    state.parent.permission_overwrites.push(
      overwrite("guest", flags.ViewChannel | flags.ManageThreads),
    );
    state.humans.push({ user: { id: "moderator" }, roles: ["guest"] });
    await state.mention({ ...event, channelId: "thread" }, signal);
    assert.deepEqual(state.replies, ["Answer"]);
    assert.equal(state.requests.length, 1);
    assert.doesNotMatch(JSON.stringify(state.requests), /Roster sentinel/);
  }
});

test("failed second verification regenerates without guild records or context", async () => {
  const state = setup();
  state.parent.permission_overwrites.push(
    overwrite("member", flags.ReadMessageHistory),
  );
  state.failSecond();
  await state.mention(event, signal);
  assert.equal(state.requests.length, 2);
  assert.match(JSON.stringify(state.requests[0]), /Roster sentinel/);
  assert.match(JSON.stringify(state.requests[0]), /CHANNEL_ONLY_SENTINEL/);
  assert.doesNotMatch(
    JSON.stringify(state.requests[1]),
    /Roster sentinel|CHANNEL_ONLY_SENTINEL/,
  );
  assert.deepEqual(state.replies, ["Regenerated"]);
  assert.ok(state.reasons.includes("VERIFICATION_FAILED"));
});

test("a public, human or bot viewer without history withholds context while still answering", async () => {
  for (const bot of [undefined, false, true]) {
    const state = setup();
    state.parent.permission_overwrites = [];
    if (bot !== undefined) {
      state.parent.permission_overwrites.push(
        overwrite("guild", flags.ReadMessageHistory),
      );
      state.humans.push({ user: { id: "other", bot }, roles: ["member"] });
    }
    state.parent.permission_overwrites.push(
      overwrite("member", flags.ReadMessageHistory),
      overwrite("other", 0n, flags.ReadMessageHistory, 1),
    );
    await state.mention(event, signal);
    assert.equal(state.requests.length, 1);
    assert.doesNotMatch(
      JSON.stringify(state.requests),
      /CHANNEL_ONLY_SENTINEL|Roster sentinel/,
    );
    assert.deepEqual(state.replies, ["Answer"]);
  }
});

test("history lost before posting regenerates the answer without context", async () => {
  const state = setup();
  state.humans.push({ user: { id: "other", bot: true }, roles: ["member"] });
  state.parent.permission_overwrites.push(
    overwrite("member", flags.ReadMessageHistory),
  );
  state.loseHistory();
  await state.mention(event, signal);
  assert.equal(state.requests.length, 2);
  assert.match(JSON.stringify(state.requests[0]), /CHANNEL_ONLY_SENTINEL/);
  assert.doesNotMatch(
    JSON.stringify(state.requests[1]),
    /CHANNEL_ONLY_SENTINEL/,
  );
  assert.deepEqual(state.replies, ["Regenerated"]);
});
