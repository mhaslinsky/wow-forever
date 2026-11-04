import {
  type APIGuildChannel,
  type APIRole,
  ChannelType,
  type GuildChannelType,
  PermissionFlagsBits,
  PermissionsBitField,
  REST,
  Routes,
} from "discord.js";

export function discordAlerts(
  rest: Pick<REST, "get" | "post">,
  guildId: string,
) {
  return async (content: string) => {
    const channels = (await rest.get(
      Routes.guildChannels(guildId),
    )) as APIGuildChannel<GuildChannelType>[];
    const matches = channels.filter((channel) => channel.name === "alerts");
    const channel = matches[0];
    if (matches.length !== 1 || channel?.type !== ChannelType.GuildText)
      throw new Error("ALERTS_CHANNEL_MISSING_OR_AMBIGUOUS");
    const roles = (await rest.get(Routes.guildRoles(guildId))) as APIRole[];
    const everyone = roles.find((role) => role.id === guildId);
    const members = roles.filter((role) => role.name === "Member");
    if (!everyone || members.length !== 1)
      throw new Error("DIGEST_ROLES_MISSING_OR_AMBIGUOUS");
    const overwrites = channel.permission_overwrites;
    if (!overwrites) throw new Error("ALERTS_PERMISSIONS_MISSING");
    const canView = (role: APIRole) => {
      const permissions = new PermissionsBitField(
        BigInt(everyone.permissions) | BigInt(role.permissions),
      );
      if (permissions.has(PermissionFlagsBits.Administrator)) return true;
      for (const roleId of [...new Set([guildId, role.id])]) {
        const overwrite = overwrites.find(
          (entry) => entry.type === 0 && entry.id === roleId,
        );
        if (overwrite)
          permissions
            .remove(BigInt(overwrite.deny))
            .add(BigInt(overwrite.allow));
      }
      return permissions.has(PermissionFlagsBits.ViewChannel);
    };
    if (canView(everyone) || canView(members[0]))
      throw new Error("ALERTS_CHANNEL_PUBLIC");
    await rest.post(Routes.channelMessages(channel.id), {
      body: { content, allowed_mentions: { parse: [] } },
    });
  };
}

export function createDigestDiscord(token: string, guildId: string) {
  return discordAlerts(
    new REST({ version: "10", timeout: 15_000 }).setToken(token),
    guildId,
  );
}
