import type { NewsStore } from "../data/class-news.mts";
import { classNews, type NewsItem } from "./feed.mts";

export async function postClassNews(input: {
  items: NewsItem[];
  channels: { id: string; name: string }[];
  store: NewsStore;
  post(channelId: string, content: string): Promise<string>;
}) {
  let posted = 0;
  const failures: unknown[] = [];
  for (const item of classNews(input.items)) {
    for (const className of item.classes) {
      try {
        const matches = input.channels.filter(
          (channel) =>
            channel.name.split("-").at(-1)?.toLowerCase() ===
            className.toLowerCase(),
        );
        if (matches.length !== 1)
          throw new Error(`NEWS_CHANNEL_MISSING_OR_AMBIGUOUS:${className}`);
        if (!(await input.store.claim(item.guid, className))) continue;
        let messageId: string;
        try {
          const title = item.title
            .replace(/[\r\n]/g, " ")
            .replace(/[\\*_~`|<>[\]]/g, "")
            .slice(0, 300);
          messageId = await input.post(
            matches[0].id,
            `${title}\n<${item.link}>`,
          );
        } catch (error) {
          await input.store.release(item.guid, className);
          throw error;
        }
        await input.store.posted(item.guid, className, messageId);
        posted++;
      } catch (error) {
        failures.push(error);
      }
    }
  }
  if (failures.length) throw new AggregateError(failures, "CLASS_NEWS_FAILED");
  return { posted };
}
