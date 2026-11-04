import { createSystemPrincipal } from "../auth/index.mts";
import { createNewsStore } from "../data/class-news.mts";
import { readSecret } from "../interactions/index.mts";
import { postClassNews } from "./core.mts";
import { createNewsDiscord } from "./discord.mts";
import { fetchFeed } from "./feed.mts";

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

export async function handler() {
  const guildId = required("GUILD_ID");
  const items = await fetchFeed();
  const token = await readSecret(
    "/wow-forever/discord_bot_token",
    AbortSignal.timeout(15_000),
  );
  const discord = createNewsDiscord(token, guildId);
  try {
    return await postClassNews({
      items,
      channels: await discord.channels(),
      store: createNewsStore(
        required("GUILD_TABLE"),
        guildId,
        createSystemPrincipal(["classNews"]),
      ),
      post: discord.post,
    });
  } catch (error) {
    if (error instanceof AggregateError) {
      for (const failure of error.errors) {
        console.error(
          JSON.stringify({
            event: "NEWS_POST_FAILED",
            message:
              failure instanceof Error ? failure.message : String(failure),
            status:
              typeof failure === "object" &&
              failure !== null &&
              "status" in failure &&
              typeof failure.status === "number"
                ? failure.status
                : null,
          }),
        );
      }
    }
    throw error;
  }
}
