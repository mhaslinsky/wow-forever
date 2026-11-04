import { XMLParser, XMLValidator } from "fast-xml-parser";
import { classes } from "../data/application.mts";

export const FEED_URL = "https://www.wowhead.com/news/rss/all";
export type NewsItem = {
  guid: string;
  title: string;
  link: string;
  categories: string[];
};

export function parseFeed(xml: string): NewsItem[] {
  if (XMLValidator.validate(xml) !== true) throw new Error("NEWS_XML_INVALID");
  const parsed = new XMLParser({
    parseTagValue: false,
    isArray: (name) => name === "item" || name === "category",
  }).parse(xml);
  const channel = parsed?.rss?.channel;
  if (!channel || !Array.isArray(channel.item) || !channel.item.length)
    throw new Error("NEWS_FEED_EMPTY_OR_INVALID");
  return channel.item.map((raw: Record<string, unknown>) => {
    const { guid, title, link, category } = raw;
    if (
      typeof guid !== "string" ||
      !guid.trim() ||
      typeof title !== "string" ||
      !title.trim() ||
      typeof link !== "string" ||
      !Array.isArray(category) ||
      !category.every((value) => typeof value === "string")
    )
      throw new Error("NEWS_ITEM_INVALID");
    const url = new URL(link);
    if (url.protocol !== "https:" || url.hostname !== "www.wowhead.com")
      throw new Error("NEWS_LINK_INVALID");
    return { guid, title, link: url.href, categories: category };
  });
}

export function classNews(items: NewsItem[]) {
  const category = items.some((item) => item.categories.includes("Forever"))
    ? "Forever"
    : "Classic Era";
  return items
    .filter((item) => item.categories.includes(category))
    .map((item) => ({
      ...item,
      classes: Object.keys(classes).filter((name) =>
        new RegExp(`\\b${name}s?\\b`, "i").test(
          [item.title, ...item.categories].join(" "),
        ),
      ),
    }));
}

export async function fetchFeed(http: typeof fetch = fetch) {
  const response = await http(FEED_URL, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`NEWS_FEED_HTTP_${response.status}`);
  return parseFeed(await response.text());
}
