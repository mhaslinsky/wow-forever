import {
  CloudWatchClient,
  PutMetricDataCommand,
} from "@aws-sdk/client-cloudwatch";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { Client, GatewayIntentBits } from "discord.js";
import { createSystemPrincipal } from "../auth/index.mts";
import { createDynamoDataAccess } from "../data/index.mts";
import { refreshNeedsBoard } from "../needs/discord.mts";
import {
  checkRecruitingAuditAccess,
  recruitingHandlers,
} from "../recruiting/discord.mts";
import {
  attachGateway,
  handlers,
  StartupError,
  scheduleHeartbeat,
  startupFailure,
  tokenValue,
} from "./client.mts";
import { createVoicePresenceHandler } from "./voice-presence.mts";

const region = "us-east-1";
const ssm = new SSMClient({ region });
const cloudwatch = new CloudWatchClient({ region });
const log = (record: Readonly<Record<string, unknown>>) =>
  console.log(JSON.stringify(record));
async function main() {
  const guildId = process.env.GUILD_ID?.trim();
  if (!guildId) throw new StartupError("GUILD_ID_REQUIRED");
  const result = await ssm
    .send(
      new GetParameterCommand({
        Name: "/wow-forever/discord_bot_token",
        WithDecryption: true,
      }),
    )
    .catch(() => {
      throw new StartupError("SSM_READ_FAILED");
    });
  const token = tokenValue(result.Parameter?.Value);
  const instance = process.env.GATEWAY_INSTANCE_ID;
  if (!instance || !/^i-[a-f0-9]+$/.test(instance))
    throw new Error("INSTANCE_NOT_CONFIGURED");
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildModeration,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildVoiceStates,
    ],
  });
  const voicePresence = createVoicePresenceHandler(
    createDynamoDataAccess({ tableName: "wow-forever", region }),
    guildId,
  );
  const needsData = createDynamoDataAccess({
    tableName: "wow-forever",
    region,
  });
  let needsPending = false;
  async function refreshNeeds() {
    if (needsPending || !client.isReady()) return;
    needsPending = true;
    try {
      const guild = client.guilds.cache.get(guildId as string);
      if (!guild) throw new Error("GUILD_NOT_AVAILABLE");
      await refreshNeedsBoard(guild, needsData);
    } catch {
      log({ event: "needs_board_refresh_failed" });
      await cloudwatch
        .send(
          new PutMetricDataCommand({
            Namespace: "wow-forever/gateway",
            MetricData: [
              {
                MetricName: "HandlerError",
                Value: 1,
                Unit: "Count",
                Dimensions: [{ Name: "InstanceId", Value: instance as string }],
              },
            ],
          }),
        )
        .catch(() => log({ event: "metric_failed", metric: "HandlerError" }));
    } finally {
      needsPending = false;
    }
  }
  const heartbeat = attachGateway(
    client,
    {
      ...handlers,
      ...recruitingHandlers(
        client,
        createDynamoDataAccess({ tableName: "wow-forever", region }),
        createSystemPrincipal(["candidate", "officerNote"]),
        guildId,
      ),
      voiceStateUpdate: voicePresence,
      clientReady: async (readyClient) => {
        const guild = readyClient.guilds.cache.get(guildId);
        if (!guild) throw new Error("GUILD_NOT_AVAILABLE");
        await refreshNeeds();
        await checkRecruitingAuditAccess(guild);
        await voicePresence.ready(guild.voiceStates.cache.values());
      },
    },
    async (name) => {
      await cloudwatch.send(
        new PutMetricDataCommand({
          Namespace: "wow-forever/gateway",
          MetricData: [
            {
              MetricName: name,
              Value: 1,
              Unit: "Count",
              Timestamp: new Date(),
              Dimensions: [{ Name: "InstanceId", Value: instance }],
            },
          ],
        }),
      );
    },
    log,
  );
  const timer = scheduleHeartbeat(heartbeat);
  const needsTimer = setInterval(() => {
    void refreshNeeds();
  }, 60_000);
  const stop = () => {
    clearInterval(timer);
    clearInterval(needsTimer);
    client.destroy();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    await client.login(token);
  } catch {
    stop();
    throw new StartupError("LOGIN_FAILED");
  }
}
main().catch((error: unknown) => {
  log(startupFailure(error));
  process.exitCode = 1;
});
