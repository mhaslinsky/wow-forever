import assert from "node:assert/strict";
import test from "node:test";
import { HTTPError } from "@discordjs/rest";
import { postClassNews } from "../src/class-news/core.mts";
import { classChannels } from "../src/class-news/discord.mts";
import { parseFeed } from "../src/class-news/feed.mts";

function fixture(
  category = "Forever",
  postError?: Error,
  releaseError?: Error,
) {
  const items = parseFeed(
    `<rss><channel><item><title>Druid news</title><link>https://www.wowhead.com/news=123</link><guid>news-123</guid><category>${category}</category></item></channel></rss>`,
  );
  const claims = new Set<string>();
  const messages: { channelId: string; body: unknown }[] = [];
  const discord = classChannels(
    {
      get: async () => [
        { id: "hall", name: "🏰 Class Hall", type: 4 },
        { id: "druid", name: "🌿-druid", type: 0, parent_id: "hall" },
        { id: "mage", name: "🔮-mage", type: 0, parent_id: "hall" },
        { id: "other", name: "🌿-druid", type: 0, parent_id: "elsewhere" },
      ],
      post: async (route, options) => {
        messages.push({ channelId: String(route), body: options?.body });
        if (postError) throw postError;
        return { id: "message" };
      },
    },
    "guild",
  );
  const run = async () =>
    postClassNews({
      items,
      channels: await discord.channels(),
      post: discord.post,
      store: {
        claim: async (guid, className) => {
          const key = `${guid}/${className}`;
          if (claims.has(key)) return false;
          claims.add(key);
          return true;
        },
        posted: async () => {},
        release: async (guid, className) => {
          if (releaseError) throw releaseError;
          claims.delete(`${guid}/${className}`);
        },
      },
    });
  return { run, messages };
}

test("an item naming one class posts only to that class channel", async () => {
  const setup = fixture();
  assert.equal((await setup.run()).posted, 1);
  assert.deepEqual(setup.messages, [
    {
      channelId: "/channels/druid/messages",
      body: {
        content: "Druid news\n<https://www.wowhead.com/news=123>",
        allowed_mentions: { parse: [] },
      },
    },
  ]);
});

test("an already-posted GUID is skipped", async () => {
  const setup = fixture();
  await setup.run();
  assert.equal((await setup.run()).posted, 0);
  assert.equal(setup.messages.length, 1);
});

test("a non-Forever item is ignored", async () => {
  const setup = fixture("Retail");
  assert.equal((await setup.run()).posted, 0);
  assert.equal(setup.messages.length, 0);
});

test("ambiguous post failures retain the claim while HTTP failures release it", async () => {
  const ambiguous = fixture("Forever", new Error("connection lost"));
  await assert.rejects(ambiguous.run());
  assert.equal((await ambiguous.run()).posted, 0);
  assert.equal(ambiguous.messages.length, 1);
  const rejected = fixture(
    "Forever",
    new HTTPError(503, "Unavailable", "POST", "https://discord.com", {}),
  );
  await assert.rejects(rejected.run());
  await assert.rejects(rejected.run());
  assert.equal(rejected.messages.length, 2);
});

test("release failures are logged without hiding the post error", async (context) => {
  const original = new HTTPError(
    503,
    "Unavailable",
    "POST",
    "https://discord.com",
    {},
  );
  const log = context.mock.method(console, "error", () => {});
  const setup = fixture("Forever", original, new Error("storage failed"));
  await assert.rejects(
    setup.run(),
    (error) => error instanceof AggregateError && error.errors[0] === original,
  );
  assert.equal(
    JSON.parse(log.mock.calls[0].arguments[0]).event,
    "NEWS_CLAIM_RELEASE_FAILED",
  );
});

test("a separate Discord error class releases a 403 claim; a timeout stays pending", async () => {
  class SeparateDiscordAPIError extends Error {
    status = 403;
    method = "POST";
    url = "https://discord.com/api/v10/channels/example/messages";
  }
  const rejected = fixture(
    "Forever",
    new SeparateDiscordAPIError("Missing Access"),
  );
  await assert.rejects(rejected.run());
  await assert.rejects(rejected.run());
  assert.equal(rejected.messages.length, 2);
  const timeout = fixture(
    "Forever",
    new DOMException("Timed out", "TimeoutError"),
  );
  await assert.rejects(timeout.run());
  assert.equal((await timeout.run()).posted, 0);
  assert.equal(timeout.messages.length, 1);
});
