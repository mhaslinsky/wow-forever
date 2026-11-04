import {
  type APIGuildChannel,
  ChannelType,
  type GuildChannelType,
  REST,
  Routes,
} from "discord.js";

export function classChannels(
  rest: Pick<REST, "get" | "post">,
  guildId: string,
) {
  return {
    async channels() {
      const channels = (await rest.get(
        Routes.guildChannels(guildId),
      )) as APIGuildChannel<GuildChannelType>[];
      const halls = channels.filter(
        (channel) =>
          channel.type === ChannelType.GuildCategory &&
          channel.name.toLowerCase().includes("class hall"),
      );
      if (halls.length !== 1)
        throw new Error("CLASS_HALL_MISSING_OR_AMBIGUOUS");
      return channels
        .filter(
          (channel) =>
            channel.type === ChannelType.GuildText &&
            channel.parent_id === halls[0].id,
        )
        .map((channel) => ({ id: channel.id, name: channel.name }));
    },
    async post(channelId: string, content: string) {
      const message = (await rest.post(Routes.channelMessages(channelId), {
        body: { content, allowed_mentions: { parse: [] } },
      })) as { id?: string };
      if (!message.id) throw new Error("NEWS_POST_EMPTY");
      return message.id;
    },
  };
}

export function createNewsDiscord(token: string, guildId: string) {
  return classChannels(
    new REST({ version: "10", timeout: 15_000, retries: 0 }).setToken(token),
    guildId,
  );
}
