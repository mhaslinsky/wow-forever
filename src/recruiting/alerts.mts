import {
  type APIGuildChannel,
  type APIGuildMember,
  type APIRole,
  type APIUser,
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
    const privileged = (role: APIRole) =>
      role.name === "Officer" ||
      role.name === "GM" ||
      new PermissionsBitField(BigInt(role.permissions)).has(
        PermissionFlagsBits.Administrator,
      );
    const canView = (assigned: APIRole[], memberId?: string) => {
      const permissions = new PermissionsBitField(BigInt(everyone.permissions));
      for (const role of assigned) permissions.add(BigInt(role.permissions));
      if (permissions.has(PermissionFlagsBits.Administrator)) return true;
      const apply = (deny: bigint, allow: bigint) =>
        permissions.remove(deny).add(allow);
      const base = overwrites.find(
        (entry) => entry.type === 0 && entry.id === guildId,
      );
      if (base) apply(BigInt(base.deny), BigInt(base.allow));
      let deny = 0n;
      let allow = 0n;
      for (const entry of overwrites) {
        if (
          entry.type === 0 &&
          entry.id !== guildId &&
          assigned.some((role) => role.id === entry.id)
        ) {
          deny |= BigInt(entry.deny);
          allow |= BigInt(entry.allow);
        }
      }
      apply(deny, allow);
      const member = overwrites.find(
        (entry) => entry.type === 1 && entry.id === memberId,
      );
      if (member) apply(BigInt(member.deny), BigInt(member.allow));
      return permissions.has(PermissionFlagsBits.ViewChannel);
    };
    if (roles.some((role) => !privileged(role) && canView([role])))
      throw new Error("ALERTS_CHANNEL_PUBLIC");
    const bot = (await rest.get(Routes.user())) as APIUser;
    for (const entry of overwrites) {
      if (entry.type === 0) {
        if (!roles.some((role) => role.id === entry.id))
          throw new Error("ALERTS_ROLE_UNKNOWN");
        continue;
      }
      if (entry.id === bot.id) continue;
      const member = (await rest.get(
        Routes.guildMember(guildId, entry.id),
      )) as APIGuildMember;
      const assigned = member.roles.map((roleId) => {
        const role = roles.find((value) => value.id === roleId);
        if (!role) throw new Error("ALERTS_ROLE_UNKNOWN");
        return role;
      });
      if (!assigned.some(privileged) && canView(assigned, entry.id))
        throw new Error("ALERTS_CHANNEL_PUBLIC");
    }
    await rest.post(Routes.channelMessages(channel.id), {
      body: { content, allowed_mentions: { parse: [] } },
    });
  };
}

export function createDigestDiscord(token: string, guildId: string) {
  return discordAlerts(
    new REST({ version: "10", timeout: 15_000, retries: 0 }).setToken(token),
    guildId,
  );
}
