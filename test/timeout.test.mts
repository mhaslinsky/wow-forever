import assert from "node:assert/strict";
import test from "node:test";
import { createMention } from "../src/assistant/mention.mts";

const signal = new AbortController().signal;
const event = {
  guildId: "guild",
  channelId: "channel",
  messageId: "message",
  authorId: "789",
};
const roles = ["Member", "Officer", "GM"].map((name) => ({ id: name, name }));
async function run(
  question: string,
  role = "Officer",
  targetRoles: string[] = [],
  bot = false,
  ambiguous = false,
  fail = false,
) {
  const patches: unknown[] = [],
    replies: string[] = [],
    reports: string[] = [];
  let models = 0;
  const target = {
    nick: "nickname!",
    user: { id: "123", username: "synthetic", bot },
    roles: targetRoles,
  };
  await createMention({
    guildId: "guild",
    now: () => 0,
    claim: async () => true,
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
          mentions: [{ id: "999" }],
          content: `<@999> ${question}`,
        };
      if (path === "/users/@me") return { id: "999" };
      if (path === "/guilds/guild") return { owner_id: "owner" };
      if (path.endsWith("/roles")) return roles;
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
  return { patches, replies, models };
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
