import { ChannelType, type Guild } from "discord.js";
import { createSystemPrincipal } from "../auth/index.mts";
import type { createDataAccess } from "../data/index.mts";
import { createNeeds } from "./core.mts";

const BOARD_TITLE = "Raid recruiting needs";
export async function refreshNeedsBoard(
  guild: Guild,
  data: ReturnType<typeof createDataAccess>,
) {
  const name = process.env.NEEDS_CHANNEL_NAME;
  if (!name) throw new Error("NEEDS_CHANNEL_NAME_REQUIRED");
  const matches = (await guild.channels.fetch()).filter(
    (channel) => channel?.name === name,
  );
  const channel = matches.first();
  if (matches.size !== 1 || channel?.type !== ChannelType.GuildText)
    throw new Error("NEEDS_CHANNEL_MISSING_OR_AMBIGUOUS");
  const boards = await createNeeds(data, guild.id).boards(
    createSystemPrincipal([]),
  );
  const content = [
    BOARD_TITLE,
    ...boards.map(
      (board) =>
        `${board.name}: ${board.gaps.map((gap) => `${gap.count} ${gap.name}`).join(", ") || "No recruiting gaps"}`,
    ),
  ].join("\n");
  if (content.length > 2000) throw new Error("NEEDS_BOARD_TOO_LONG");
  const isBoard = (message: import("discord.js").Message) =>
    message.author.id === guild.client.user.id &&
    message.content.startsWith(`${BOARD_TITLE}\n`);
  const existing: import("discord.js").Message[] = [];
  let before: Date | undefined;
  while (true) {
    const pins = await channel.messages.fetchPins({ before, limit: 50 });
    existing.push(...pins.items.map((pin) => pin.message).filter(isBoard));
    if (!pins.hasMore) break;
    const last = pins.items.at(-1);
    if (!last || (before && last.pinnedTimestamp >= before.getTime()))
      throw new Error("NEEDS_PINS_INCOMPLETE");
    before = last.pinnedAt;
  }
  if (!existing.length) {
    const recent = await channel.messages.fetch({ limit: 100 });
    existing.push(...recent.filter(isBoard).values());
  }
  if (existing.length > 1) throw new Error("NEEDS_BOARD_AMBIGUOUS");
  const message = existing[0];
  if (message) {
    if (message.content !== content)
      await message.edit({ content, allowedMentions: { parse: [] } });
    if (!message.pinned) await message.pin();
  } else {
    const created = await channel.send({
      content,
      allowedMentions: { parse: [] },
    });
    await created.pin();
  }
}
