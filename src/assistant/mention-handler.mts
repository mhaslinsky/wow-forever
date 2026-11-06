import { clock } from "../interactions/core.mts";
import { claimDelivery, readSecret } from "../interactions/index.mts";
import { createChannelContext } from "./context.mts";
import { runtimeMemoryReplies } from "./memory-replies.mts";
import { createMention, type Mention } from "./mention.mts";
import { runtimeAssistant } from "./runtime.mts";

export async function handler(event: Mention) {
  const signal = AbortSignal.timeout(55000);
  const guildId = process.env.GUILD_ID;
  if (!guildId) throw new Error("GUILD_ID_REQUIRED");
  const token = await readSecret("/wow-forever/discord_bot_token", signal);
  const request = async (
    path: string,
    body?: unknown,
    abortSignal = signal,
    method = body === undefined ? "GET" : "POST",
  ): Promise<unknown> => {
    const response = await fetch(`https://discord.com/api/v10${path}`, {
      method,
      signal: abortSignal,
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
  const memory = runtimeMemoryReplies();
  const answer = await runtimeAssistant(guildId, request);
  return createMention({
    guildId,
    get: request,
    patch: (path, body, abortSignal) =>
      request(path, body, abortSignal, "PATCH"),
    classifyTimeout: answer.classifyTimeout,
    claim: claimDelivery,
    now: Date.now,
    context: (channelId, abortSignal) =>
      createChannelContext(
        {
          clock,
          get: (path, childSignal) => request(path, undefined, childSignal),
          hiddenMessage: memory.hidden,
        },
        channelId,
      )(abortSignal),
    answer: (actor, question, abortSignal, context, audience) =>
      answer(actor, question, abortSignal, context, audience, () =>
        // Mark the source first so history cannot read a reply before its ID is saved.
        memory.mark(event.authorId, event.messageId, 60000),
      ),
    async reply(message, content) {
      const reply = await request(
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
      if (await memory.hidden(event.authorId, event.messageId)) {
        if (
          !reply ||
          typeof reply !== "object" ||
          !("id" in reply) ||
          typeof reply.id !== "string"
        )
          throw new Error("INVALID_MEMORY_REPLY");
        await memory.mark(event.authorId, reply.id);
      }
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
