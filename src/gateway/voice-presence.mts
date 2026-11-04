import { randomUUID } from "node:crypto";
import { ChannelType, type VoiceState } from "discord.js";
import { createSystemPrincipal } from "../auth/index.mts";
import type { createDataAccess } from "../data/index.mts";
import { recordKey } from "../data/records.mts";

type DataAccess = ReturnType<typeof createDataAccess>;
type PresenceState = Pick<VoiceState, "id" | "guild" | "channelId" | "channel">;

function raidChannel(state: PresenceState): boolean {
  return (
    state.channel?.type === ChannelType.GuildVoice &&
    state.channel.name === "Raid" &&
    state.channel.parent?.name === "Forever"
  );
}

export function createVoicePresenceHandler(data: DataAccess, now = Date.now) {
  const store = data.forSystem(createSystemPrincipal(["voicePresence"]));
  let pending = Promise.resolve();
  return (before: PresenceState, after: PresenceState): Promise<void> => {
    if (before.channelId === after.channelId) return Promise.resolve();
    const departed = raidChannel(before);
    const arrived = raidChannel(after);
    if (!departed && !arrived) return Promise.resolve();
    const timestamp = new Date(now()).toISOString();
    const operation = pending.then(async () => {
      const records = await store.query(
        recordKey("voicePresence", after.id, "unused").pk,
      );
      const open = records.filter(
        (record) =>
          record.kind === "voicePresence" &&
          record.guildId === after.guild.id &&
          !record.leftAt,
      );
      if (departed) {
        for (const record of open) {
          if (
            record.kind === "voicePresence" &&
            record.channelId === before.channelId
          )
            await store.write({ ...record, leftAt: timestamp });
        }
      }
      if (
        arrived &&
        !open.some(
          (record) =>
            record.kind === "voicePresence" &&
            record.channelId === after.channelId,
        )
      ) {
        await store.write({
          ...recordKey("voicePresence", after.id, randomUUID()),
          kind: "voicePresence",
          ownerId: after.id,
          guildId: after.guild.id,
          channelId: after.channelId as string,
          joinedAt: timestamp,
        });
      }
    });
    // A failed write is reported by the gateway; later events still need to run.
    pending = operation.catch(() => {});
    return operation;
  };
}
