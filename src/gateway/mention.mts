import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import type { Client } from "discord.js";
import type { Handlers } from "./client.mts";

export function mentionForwarder(
  client: Client,
  guildId: string,
): Handlers["messageCreate"] {
  const lambda = new LambdaClient({ region: "us-east-1", maxAttempts: 1 });
  return async (message) => {
    if (
      message.author.bot ||
      message.guildId !== guildId ||
      !client.user ||
      !message.mentions.users.has(client.user.id)
    )
      return;
    const result = await lambda.send(
      new InvokeCommand({
        FunctionName: "wow-forever-assistant-mention",
        InvocationType: "Event",
        Payload: Buffer.from(
          JSON.stringify({
            guildId,
            channelId: message.channelId,
            messageId: message.id,
            authorId: message.author.id,
          }),
        ),
      }),
    );
    if (result.StatusCode !== 202) throw new Error("MENTION_NOT_ACCEPTED");
  };
}
