import assert from "node:assert/strict";
import test from "node:test";
import { postClassNews } from "../src/class-news/core.mts";
import { classChannels } from "../src/class-news/discord.mts";
import { parseFeed } from "../src/class-news/feed.mts";

function fixture(category = "Forever") {
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
