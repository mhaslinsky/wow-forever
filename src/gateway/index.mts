import {
  CloudWatchClient,
  PutMetricDataCommand,
} from "@aws-sdk/client-cloudwatch";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { Client, GatewayIntentBits } from "discord.js";
import {
  attachGateway,
  handlers,
  scheduleHeartbeat,
  tokenValue,
} from "./client.mts";

const region = "us-east-1";
const ssm = new SSMClient({ region });
const cloudwatch = new CloudWatchClient({ region });
const log = (record: Readonly<Record<string, unknown>>) =>
  console.log(JSON.stringify(record));
async function main() {
  const result = await ssm.send(
    new GetParameterCommand({
      Name: "/wow-forever/discord_bot_token",
      WithDecryption: true,
    }),
  );
  const token = tokenValue(result.Parameter?.Value);
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
    handlers,
    async (name) => {
      await cloudwatch.send(
        new PutMetricDataCommand({
          Namespace: "wow-forever/gateway",
          MetricData: [{ MetricName: name, Value: 1, Unit: "Count" }],
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
    throw new Error("GATEWAY_LOGIN_FAILED");
  }
}
main().catch(() => {
  log({ event: "gateway_start_failed" });
  process.exitCode = 1;
});
