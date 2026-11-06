import assert from "node:assert/strict";
import test from "node:test";
import { createMention } from "../src/assistant/mention.mts";
import {
  createTimeoutIntent,
  type TimeoutIntent,
} from "../src/assistant/timeout-intent.mts";

const signal = new AbortController().signal;
const event = {
  guildId: "guild",
  channelId: "channel",
  messageId: "message",
  authorId: "789",
};
const roles = ["Member", "Officer", "GM"].map((name) => ({
  id: name,
  name,
  permissions: "0",
}));
async function run(
  question: string,
  role = "Officer",
  targetRoles: string[] = [],
  bot = false,
  ambiguous = false,
  fail = false,
  intent?: TimeoutIntent,
) {
  const patches: unknown[] = [],
    replies: string[] = [],
    reports: string[] = [];
  let models = 0,
    classifications = 0;
  const target = {
    nick: "nickname!",
    user: { id: "123", username: "synthetic", bot },
    roles: targetRoles,
  };
  await createMention({
    guildId: "guild",
    now: () => 0,
    claim: async () => true,
    context: async () => [
      { author: "Synthetic", content: "timeout <@123> for 90 minutes" },
    ],
    classifyTimeout: createTimeoutIntent(async (command) => {
      classifications++;
      assert.equal(command.input.modelId, "us.anthropic.claude-sonnet-4-6");
      assert.doesNotMatch(
        JSON.stringify(command.input),
        /Officer|permissions|roles/,
      );
      assert.match(JSON.stringify(command.input), /90 minutes/);
      const text = intent ? JSON.stringify(intent) : "bad JSON";
      return {
        $metadata: {},
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        metrics: { latencyMs: 0 },
        stopReason: "end_turn",
        output: { message: { role: "assistant", content: [{ text }] } },
      };
    }),
    get: async (path) => {
      if (path === "/channels/channel")
        return {
          id: "channel",
          guild_id: "guild",
          type: 0,
          permission_overwrites: [],
        };
      if (path.includes("/messages/"))
        return {
          id: "message",
          channel_id: "channel",
          author: { id: "789" },
          mentions: [
            { id: "999" },
            ...[...question.matchAll(/<@!?(\d+)>/g)].map((match) => ({
              id: match[1],
            })),
          ],
          content: `<@999> ${question}`,
        };
      if (path === "/users/@me") return { id: "999" };
      if (path === "/guilds/guild") return { id: "guild", owner_id: "owner" };
      if (path.endsWith("/roles"))
        return [{ id: "guild", name: "@everyone", permissions: "0" }, ...roles];
      if (path.endsWith("/members/789"))
        return { user: { id: "789" }, roles: [role] };
      if (path.endsWith("/members/123")) return target;
      if (path.endsWith("/members?limit=1000"))
        return ambiguous
          ? [target, { ...target, user: { ...target.user, id: "456" } }]
          : [target];
      throw new Error(`Unexpected GET ${path}`);
    },
    patch: async (path, body) => {
      if (fail) throw new Error("DISCORD_HTTP_403");
      patches.push({ path, body });
    },
    answer: async () => {
      models++;
      return "Chat";
    },
    reply: async (_event, content) => {
      replies.push(content);
    },
    report: (reason) => {
      reports.push(reason);
    },
  })(event, signal);
  assert.deepEqual(reports, fail ? ["DISCORD_HTTP_403"] : []);
  return { patches, replies, models, classifications };
}

test("GM and officers timeout mentions before any model call; durations default and clamp", async () => {
  for (const [question, minutes] of [
    [", timeout\n<@123>\nfor 20 minutes", 10],
    ["timeout <@123> for 2 minutes", 2],
    ["timeout synthetic", 5],
    ["timeout nickname!", 5],
    ["timeout synthetic.", 5],
    ["timeout <@!123> for 90 minutes please", 10],
    ["time out <@123> for 0 minutes", 1],
  ] as const) {
    for (const role of ["Officer", "GM"]) {
      const result = await run(question, role);
      assert.equal(result.models, 0);
      assert.deepEqual(result.patches, [
        {
          path: "/guilds/guild/members/123",
          body: {
            communication_disabled_until: new Date(
              minutes * 60000,
            ).toISOString(),
          },
        },
      ]);
      assert.match(result.replies[0] ?? "", /quiet corner/);
    }
  }
});

test("non-officers receive normal chat without moderation", async () => {
  const result = await run("timeout <@123>", "Member");
  assert.equal(result.models, 1);
  assert.deepEqual(result.patches, []);
  assert.deepEqual(result.replies, ["Chat"]);
});

test("ambiguous, missing and malformed targets ask for a mention", async () => {
  for (const question of [
    "timeout synthetic",
    "timeout missing",
    "timeout",
    "timeout <@123> for bananas minutes",
  ]) {
    const result = await run(question, "Officer", [], false, true);
    assert.deepEqual(result.patches, []);
    assert.equal(result.models, 0);
    assert.match(result.replies[0] ?? "", /@mention/);
  }
});

test("officers, GM, bots and requester cannot be targeted", async () => {
  for (const [question, targetRoles, bot] of [
    [". timeout\n<@123>\nfor 20 minutes", ["Officer"], false],
    ["timeout <@123>", ["GM"], false],
    ["timeout <@123>", [], true],
    ["timeout <@789>", [], false],
  ] as const) {
    const result = await run(question, "Officer", [...targetRoles], bot);
    assert.deepEqual(result.patches, []);
    assert.equal(result.models, 0);
    assert.match(result.replies[0] ?? "", /off limits/);
  }
});

test("Discord refusal never confirms a timeout", async () => {
  const result = await run("timeout <@123>", "Officer", [], false, false, true);
  assert.deepEqual(result.patches, []);
  assert.match(result.replies[0] ?? "", /Couldn't land/);
});

test("loose timeout follow-ups classify only officers and preserve protections", async () => {
  for (const role of ["Officer", "GM", "Member"]) {
    const result = await run(
      "take care of <@123>",
      role,
      [],
      false,
      false,
      false,
      { timeout: true, minutes: 90 },
    );
    assert.equal(result.classifications, Number(role !== "Member"));
    assert.equal(result.models, Number(role === "Member"));
    assert.deepEqual(
      result.patches,
      role === "Member"
        ? []
        : [
            {
              path: "/guilds/guild/members/123",
              body: {
                communication_disabled_until: new Date(600000).toISOString(),
              },
            },
          ],
    );
  }
  const protectedTarget = await run(
    "take care of <@123>",
    "Officer",
    ["Officer"],
    false,
    false,
    false,
    { timeout: true },
  );
  assert.deepEqual(protectedTarget.patches, []);
  assert.match(protectedTarget.replies[0] ?? "", /off limits/);
});

test("normal questions and malformed classification chat; moderation gets a hint", async () => {
  for (const intent of [undefined, { timeout: false }]) {
    const result = await run(
      "how is <@123> doing?",
      "Officer",
      [],
      false,
      false,
      false,
      intent,
    );
    assert.equal(result.classifications, 1);
    assert.deepEqual(result.replies, ["Chat"]);
    assert.deepEqual(result.patches, []);
  }
  const hint = await run(
    "take care of <@123>",
    "Officer",
    [],
    false,
    false,
    false,
    { timeout: false },
  );
  assert.match(hint.replies[0] ?? "", /timeout @name for 5 minutes/);
  assert.equal(hint.models, 0);
});

test("classification requires exactly one mentioned target", async () => {
  for (const question of [
    "take care of them",
    "take care of <@123> and <@456>",
  ]) {
    const result = await run(question);
    assert.equal(result.classifications, 0);
    assert.deepEqual(result.replies, ["Chat"]);
  }
});

test("only the real GM role permits timing out an officer", async () => {
  for (const role of ["GM", "Officer"]) {
    const result = await run("timeout <@123> for 5 minutes", role, ["Officer"]);
    assert.equal(result.patches.length, Number(role === "GM"));
    assert.match(
      result.replies[0] ?? "",
      role === "GM" ? /quiet corner/ : /off limits/,
    );
  }
});
