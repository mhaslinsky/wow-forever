import {
  ChannelType,
  DiscordAPIError,
  type Guild,
  HTTPError,
  Routes,
} from "discord.js";
import { createSystemPrincipal } from "../auth/index.mts";
import type { createDataAccess } from "../data/index.mts";
import { recordKey } from "../data/records.mts";
import { createNeeds } from "./core.mts";

const BOARD_TITLE = "What we're recruiting";
const lastPosted = new Map<string, string>();
export async function refreshNeedsBoard(
  guild: Guild,
  data: ReturnType<typeof createDataAccess>,
) {
  const name = process.env.NEEDS_CHANNEL_NAME ?? "apply-here";
  const cacheKey = `${guild.id}:${name}`;
  const boards = await createNeeds(data, guild.id).boards(
    createSystemPrincipal([]),
  );
  const content = [
    BOARD_TITLE,
    ...boards.map(
      (board) =>
        `${board.name}: ${board.gaps.map((gap) => `${gap.count} ${gap.name}`).join(", ") || "We're full up right now"}`,
    ),
  ].join("\n");
  if (content.length > 2000) throw new Error("NEEDS_BOARD_TOO_LONG");
  if (lastPosted.get(cacheKey) === content) return;
  const records = data.forSystem(createSystemPrincipal(["needsBoard"]));
  const key = recordKey("needsBoard", guild.id, "board");
  const stored = (await records.get(key))[0];
  if (stored?.kind === "needsBoard") {
    try {
      await guild.client.rest.patch(
        Routes.channelMessage(stored.channelId, stored.messageId),
        {
          body: { content, allowed_mentions: { parse: [] } },
        },
      );
      lastPosted.set(cacheKey, content);
      return;
    } catch (error) {
      const missing =
        (error instanceof DiscordAPIError &&
          (error.code === 10008 || error.status === 404)) ||
        (error instanceof HTTPError && error.status === 404);
      if (!missing) throw error;
    }
  }
  const matches = (await guild.channels.fetch()).filter(
    (channel) => channel?.name === name,
  );
  const channel = matches.first();
  if (matches.size !== 1 || channel?.type !== ChannelType.GuildText)
    throw new Error("NEEDS_CHANNEL_MISSING_OR_AMBIGUOUS");
  const created = await channel.send({
    content,
    allowedMentions: { parse: [] },
  });
  await created.pin();
  await records.write({
    ...key,
    kind: "needsBoard",
    ownerId: guild.id,
    channelId: channel.id,
    messageId: created.id,
  });
  lastPosted.set(cacheKey, content);
}
