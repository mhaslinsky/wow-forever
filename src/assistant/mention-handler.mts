import { claimDelivery, readSecret } from "../interactions/index.mts";
import { createMention, type Mention } from "./mention.mts";
import { runtimeAssistant } from "./runtime.mts";

export async function handler(event: Mention) {
  const signal = AbortSignal.timeout(55000);
  const guildId = process.env.GUILD_ID;
  if (!guildId) throw new Error("GUILD_ID_REQUIRED");
  const token = await readSecret("/wow-forever/discord_bot_token", signal);
  const request = async (path: string, body?: unknown): Promise<unknown> => {
    const response = await fetch(`https://discord.com/api/v10${path}`, {
      method: body === undefined ? "GET" : "POST",
      signal,
      headers: {
        authorization: `Bot ${token}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`DISCORD_HTTP_${response.status}`);
    }
    return response.json();
  };
  return createMention({
    guildId,
    get: request,
    claim: claimDelivery,
    now: Date.now,
    answer: await runtimeAssistant(guildId, request),
    async reply(message, content) {
      await request(
        `/channels/${encodeURIComponent(message.channelId)}/messages`,
        {
          content,
          message_reference: {
            message_id: message.messageId,
            fail_if_not_exists: true,
          },
          allowed_mentions: { parse: [], replied_user: false },
        },
      );
    },
    report(reason) {
      console.log(
        JSON.stringify({
          _aws: {
            Timestamp: Date.now(),
            CloudWatchMetrics: [
              {
                Namespace: "WowForever",
                Dimensions: [[]],
                Metrics: [{ Name: "MentionFallback", Unit: "Count" }],
              },
            ],
          },
          MentionFallback: 1,
          reason,
        }),
      );
    },
  })(event, signal);
}
