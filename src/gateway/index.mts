import {
  CloudWatchClient,
  PutMetricDataCommand,
} from "@aws-sdk/client-cloudwatch";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { Client, GatewayIntentBits } from "discord.js";
import { createDynamoDataAccess } from "../data/index.mts";
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
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildVoiceStates,
    ],
  });
  const heartbeat = attachGateway(
    client,
    {
      ...handlers,
      voiceStateUpdate: createVoicePresenceHandler(
        createDynamoDataAccess({ tableName: "wow-forever", region }),
      ),
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
  const stop = () => {
    clearInterval(timer);
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
