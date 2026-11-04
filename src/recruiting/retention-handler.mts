import { Client } from "discord.js";
import { createRetentionStorage } from "../data/retention.mts";
import { readSecret } from "../interactions/index.mts";
import { reportRecruitingFailure } from "./alarm.mts";
import { recruitingContext } from "./discord.mts";
import { createRetentionPurge } from "./retention.mts";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

export async function handler() {
  try {
    const guildId = required("GUILD_ID");
    const client = new Client({
      intents: [],
      rest: { timeout: 15_000, retries: 0 },
    });
    client.rest.setToken(
      await readSecret(
        "/wow-forever/discord_bot_token",
        AbortSignal.timeout(15_000),
      ),
    );
    const guild = await client.guilds.fetch(guildId);
    const { forum } = await recruitingContext(guild);
    return await createRetentionPurge({
      ...createRetentionStorage({
        guildId,
        tableName: required("GUILD_TABLE"),
        region: required("AWS_REGION"),
      }),
      retentionDays: Number(required("RETENTION_DAYS")),
      now: Date.now,
      async archive(threadId) {
        const thread = await forum.threads.fetch(threadId, { force: true });
        if (!thread || thread.parentId !== forum.id)
          throw new Error("CANDIDATE_THREAD_MISSING");
        await thread.edit({ archived: true, locked: true });
      },
    })();
  } catch {
    reportRecruitingFailure({ code: "RECRUITING_RETENTION_FAILED" });
    throw new Error("RECRUITING_RETENTION_FAILED");
  }
}
