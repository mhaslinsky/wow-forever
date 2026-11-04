import { createSystemPrincipal } from "../auth/index.mts";
import { createDynamoDataAccess } from "../data/index.mts";
import { readSecret } from "../interactions/index.mts";
import { reportRecruitingFailure } from "./alarm.mts";
import { createDigestDiscord } from "./alerts.mts";
import { createOverdueDigest } from "./digest.mts";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

export async function handler() {
  try {
    const guildId = required("GUILD_ID");
    const data = createDynamoDataAccess({
      tableName: required("GUILD_TABLE"),
      region: required("AWS_REGION"),
    }).forSystem(createSystemPrincipal([]));
    const token = await readSecret(
      "/wow-forever/discord_bot_token",
      AbortSignal.timeout(15_000),
    );
    return await createOverdueDigest({
      guildId,
      data,
      now: Date.now,
      post: createDigestDiscord(token, guildId),
    })();
  } catch {
    reportRecruitingFailure({ code: "RECRUITING_DIGEST_FAILED" });
    throw new Error("RECRUITING_DIGEST_FAILED");
  }
}
