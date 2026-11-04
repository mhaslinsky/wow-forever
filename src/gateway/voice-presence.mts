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

export function createVoicePresenceHandler(
  data: DataAccess,
  guildId: string,
  now = Date.now,
) {
  if (!guildId.trim()) throw new Error("GUILD_ID_REQUIRED");
  const startupTime = new Date(now()).toISOString();
  const store = data.forSystem(createSystemPrincipal(["voicePresence"]));
  const current = new Set<string>();
  let pending = Promise.resolve();
  function enqueue(work: () => Promise<void>) {
    const operation = pending.then(work);
    // The gateway reports failed writes; later events still run.
    pending = operation.catch(() => {});
    return operation;
  }
  async function open(memberId: string, channelId: string, joinedAt: string) {
    const key = recordKey("voicePresence", guildId, randomUUID());
    await store.write({
      ...key,
      kind: "voicePresence",
      ownerId: guildId,
      guildId,
      memberId,
      channelId,
      joinedAt,
    });
    current.add(key.sk);
  }
  const partition = recordKey("voicePresence", guildId, "unused").pk;
  const handle = (
    before: PresenceState,
    after: PresenceState,
  ): Promise<void> => {
    // Discord mutates cached voice states while queued writes wait.
    const eventGuildId = after.guild.id;
    const memberId = after.id;
    const oldChannelId = before.channelId;
    const newChannelId = after.channelId;
    if (
      eventGuildId !== guildId ||
      before.guild.id !== guildId ||
      oldChannelId === newChannelId
    )
      return Promise.resolve();
    const departed = raidChannel(before);
    const arrived = raidChannel(after);
    if (!departed && !arrived) return Promise.resolve();
    const timestamp = new Date(now()).toISOString();
    return enqueue(async () => {
      const records = await store.query(partition);
      const active = records.filter(
        (record) =>
          record.kind === "voicePresence" &&
          record.memberId === memberId &&
          current.has(record.sk) &&
          !record.leftAt,
      );
      if (departed) {
        for (const record of active) {
          if (
            record.kind === "voicePresence" &&
            record.channelId === oldChannelId
          ) {
            await store.write({ ...record, leftAt: timestamp });
            current.delete(record.sk);
          }
        }
      }
      if (
        arrived &&
        newChannelId &&
        !active.some(
          (record) =>
            record.kind === "voicePresence" &&
            record.channelId === newChannelId,
        )
      )
        await open(memberId, newChannelId, timestamp);
    });
  };
  return Object.assign(handle, {
    ready(states: Iterable<PresenceState>): Promise<void> {
      const timestamp = new Date(now()).toISOString();
      const occupants = [...states]
        .filter((state) => state.guild.id === guildId && raidChannel(state))
        .map((state) => ({ memberId: state.id, channelId: state.channelId }));
      return enqueue(async () => {
        const records = await store.query(partition);
        for (const record of records) {
          if (record.kind === "voicePresence" && !record.leftAt)
            await store.write({
              ...record,
              leftAt: startupTime,
              endUnknown: true,
            });
        }
        current.clear();
        for (const occupant of occupants) {
          if (occupant.channelId)
            await open(occupant.memberId, occupant.channelId, timestamp);
        }
      });
    },
  });
}
