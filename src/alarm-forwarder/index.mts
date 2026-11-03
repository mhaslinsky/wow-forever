import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";

const REGION = process.env.AWS_REGION || "us-east-1";

const ssm = new SSMClient({ region: REGION });

const DISCORD_CONTENT_LIMIT = 2000;

function clampForDiscord(content: string) {
  if (content.length <= DISCORD_CONTENT_LIMIT) return content;
  const suffix = "\n... (truncated)";
  return content.slice(0, DISCORD_CONTENT_LIMIT - suffix.length) + suffix;
}

function formatAlarm(rawMessage: string, subject?: string) {
  const budgetName = rawMessage.match(/^Budget Name:\s*(.+)$/m)?.[1];
  const budgetLimit = rawMessage.match(/^Budgeted Amount:\s*(.+)$/m)?.[1];
  const actualSpend = rawMessage.match(/^ACTUAL Amount:\s*(.+)$/m)?.[1];
  if (budgetName && budgetLimit && actualSpend) {
    return `:bell: **${budgetName}**\nBudget: ${budgetLimit}\nActual spend: ${actualSpend}`;
  }
  let alarm: {
    AlarmName?: string;
    NewStateValue?: string;
    AlarmDescription?: string;
    NewStateReason?: string;
  };
  try {
    alarm = JSON.parse(rawMessage);
  } catch {
    return `:bell: **AWS notification**${subject ? ` - ${subject}` : ""}\n\`\`\`\n${rawMessage.slice(0, 1500)}\n\`\`\``;
  }
  if (!alarm || typeof alarm !== "object" || !alarm.AlarmName) {
    return `:bell: **AWS notification**${subject ? ` - ${subject}` : ""}\n\`\`\`\n${rawMessage.slice(0, 1500)}\n\`\`\``;
  }

  const state = alarm.NewStateValue;
  const icon =
    state === "ALARM"
      ? ":rotating_light:"
      : state === "OK"
        ? ":white_check_mark:"
        : ":grey_question:";
  const headline =
    state === "ALARM"
      ? `${icon} **${alarm.AlarmName}** is in ALARM`
      : state === "OK"
        ? `${icon} **${alarm.AlarmName}** recovered`
        : `${icon} **${alarm.AlarmName}** is ${state || "in an unknown state"}`;

  const parts = [headline];
  if (alarm.AlarmDescription) parts.push(alarm.AlarmDescription);
  if (alarm.NewStateReason) parts.push(`\`${alarm.NewStateReason}\``);
  return parts.join("\n");
}

export function createHandler(
  readWebhook: () => Promise<string | undefined>,
  post: typeof fetch = fetch,
) {
  async function postToDiscord(content: string) {
    let value: string | undefined;
    try {
      value = await readWebhook();
    } catch {
      throw new Error("SSM webhook read failed");
    }
    if (!value || value === "None") throw new Error("Webhook not configured");
    let url: URL;
    try {
      url = new URL(value);
      if (url.protocol !== "https:") throw new Error();
    } catch {
      throw new Error("Invalid webhook URL");
    }
    url.searchParams.set("wait", "true");
    let response: Response;
    try {
      response = await post(url.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: clampForDiscord(content) }),
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      throw new Error("Webhook transport failed");
    }
    // Fetch resolves HTTP errors, so rejection must fail the invocation for retries.
    if (!response.ok) throw new Error(`webhook returned ${response.status}`);
  }

  return async (event: {
    Records?: { Sns?: { Message?: string; Subject?: string } }[];
  }) => {
    const records = event?.Records ?? [];
    if (records.length === 0) {
      throw new Error("SNS event contained no Records - nothing was forwarded");
    }

    const failures = [];
    for (const record of records) {
      const message = record?.Sns?.Message;
      if (typeof message !== "string") {
        failures.push("record had no Sns.Message string");
        continue;
      }
      try {
        await postToDiscord(formatAlarm(message, record?.Sns?.Subject));
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }

    if (failures.length > 0) {
      throw new Error(
        `${failures.length} of ${records.length} alarm(s) NOT delivered: ${failures.join("; ")}`,
      );
    }
    console.log(`forwarded ${records.length} alarm notification(s) to Discord`);
    return { forwarded: records.length };
  };
}

export const handler = createHandler(async () => {
  const parameterName = process.env.ALARM_WEBHOOK_PARAM;
  if (!parameterName) throw new Error("ALARM_WEBHOOK_PARAM not set");
  // Read at invocation time so webhook rotation needs no deployment.
  const result = await ssm.send(
    new GetParameterCommand({ Name: parameterName, WithDecryption: true }),
  );
  return result.Parameter?.Value;
});
