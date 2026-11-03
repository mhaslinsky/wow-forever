import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { Client } from "discord.js";
import hcl from "hcl2-parser";
import { attachGateway, tokenValue } from "../src/gateway/client.mts";

test("startup refuses missing, empty and placeholder tokens", () => {
  for (const value of [undefined, "", "  ", "None", " None "])
    assert.throws(() => tokenValue(value), /TOKEN_NOT_CONFIGURED/);
  assert.equal(tokenValue("configured"), "configured");
});

test("heartbeat follows shard readiness and records resumed and re-identified gaps", async () => {
  const client = new Client({ intents: [] });
  client.isReady = (() => true) as typeof client.isReady;
  let time = 0;
  const metrics: string[] = [];
  const logs: Record<string, unknown>[] = [];
  const tick = attachGateway(
    client,
    {},
    async (name) => {
      metrics.push(name);
    },
    (record) => logs.push(record),
    () => time,
  );
  await tick();
  assert.equal(metrics.length, 0);
  client.emit("shardReady", 0, new Set());
  time += 60_000;
  await tick();
  assert.deepEqual(metrics, ["Heartbeat"]);
  for (const outcome of ["resumed", "re-identified"]) {
    client.emit("shardReconnecting", 0);
    const start = time;
    for (let minute = 0; minute < 10; minute++) {
      time += 60_000;
      await tick();
    }
    assert.equal(metrics.length, outcome === "resumed" ? 1 : 2);
    if (outcome === "resumed") client.emit("shardResume", 0, 1);
    else client.emit("shardReady", 0, new Set());
    assert.deepEqual(logs.at(-1), {
      event: "gateway_gap",
      shard: 0,
      disconnectedAt: new Date(start).toISOString(),
      connectedAt: new Date(time).toISOString(),
      outcome,
    });
    await tick();
  }
  assert.equal(metrics.length, 3);
});

test("handler failure is reported and later events still run", async () => {
  const client = new Client({ intents: [] });
  const logs: Record<string, unknown>[] = [];
  let calls = 0;
  let reported!: () => void;
  const report = new Promise<void>((resolve) => {
    reported = resolve;
  });
  attachGateway(
    client,
    {
      shardReconnecting: async () => {
        calls++;
        if (calls === 1) throw new Error("private data");
      },
    },
    async (name) => {
      assert.equal(name, "HandlerError");
      reported();
    },
    (record) => logs.push(record),
  );
  client.emit("shardReconnecting", 0);
  await report;
  client.emit("shardReconnecting", 0);
  assert.equal(calls, 2);
  assert.ok(logs.some((record) => record.event === "handler_failed"));
  assert.ok(!JSON.stringify(logs).includes("private data"));
});

test("silence alarm requires ten missing minute periods", () => {
  const [parsed, error] = hcl.parseToObject(
    readFileSync("infra/gateway.tf", "utf8"),
  );
  assert.equal(error, null);
  const alarm = parsed.resource.aws_cloudwatch_metric_alarm.gateway_silence[0];
  assert.equal(alarm.namespace, "wow-forever/gateway");
  assert.equal(alarm.metric_name, "Heartbeat");
  assert.deepEqual(alarm.dimensions, {
    InstanceId: `\${aws_instance.gateway.id}`,
  });
  assert.equal(alarm.period, 60);
  assert.equal(alarm.statistic, "Sum");
  assert.equal(alarm.threshold, 1);
  assert.equal(alarm.comparison_operator, "LessThanThreshold");
  assert.equal(alarm.treat_missing_data, "breaching");
  assert.equal(alarm.evaluation_periods, 10);
  assert.equal(alarm.datapoints_to_alarm, 10);
});

test("gateway IAM scope limits token reads, decryption and metric writes", () => {
  const [parsed, error] = hcl.parseToObject(
    globSync("infra/*.tf")
      .map((path) => readFileSync(path, "utf8"))
      .join("\n"),
  );
  assert.equal(error, null);
  const role = parsed.resource.aws_iam_role.gateway[0];
  assert.equal(role.managed_policy_arns, undefined);
  assert.equal(role.inline_policy, undefined);
  const targets = new Set([
    `\${aws_iam_role.gateway.id}`,
    `\${aws_iam_role.gateway.name}`,
    role.name,
    "wow-forever-gateway",
  ]);
  const policies = (kind: string) =>
    (
      Object.values(parsed.resource[kind] ?? {}).flat() as { role: string }[]
    ).filter((policy) => targets.has(policy.role));
  assert.deepEqual(policies("aws_iam_role_policy_attachment"), []);
  assert.deepEqual(policies("aws_iam_role_policy_attachments_exclusive"), []);
  assert.deepEqual(policies("aws_iam_role_policy"), [
    {
      role: `\${aws_iam_role.gateway.id}`,
      policy: `\${data.aws_iam_policy_document.gateway.json}`,
    },
  ]);
  const expected = JSON.parse(`[
{"actions":["ssm:UpdateInstanceInformation","ssm:ListAssociations","ssm:ListInstanceAssociations","ssm:DescribeAssociation","ssm:GetDocument","ssm:DescribeDocument","ssm:UpdateAssociationStatus","ssm:UpdateInstanceAssociationStatus","ssm:PutInventory","ssm:GetDeployablePatchSnapshotForInstance","ec2messages:*","ssmmessages:*"],"resources":["*"]},
{"actions":["ssm:GetParameter"],"resources":["\${aws_ssm_parameter.secrets[\\"discord_bot_token\\"].arn}"]},
{"actions":["kms:Decrypt"],"resources":["\${data.aws_kms_key.ssm.arn}"],"condition":[{"test":"StringEquals","variable":"kms:ViaService","values":["ssm.us-east-1.amazonaws.com"]}]},
{"actions":["cloudwatch:PutMetricData"],"resources":["*"],"condition":[{"test":"StringEquals","variable":"cloudwatch:namespace","values":["wow-forever/gateway"]}]},
{"actions":["s3:ListBucket"],"resources":["\${aws_s3_bucket.gateway.arn}"]},
{"actions":["s3:GetObject"],"resources":["\${aws_s3_bucket.gateway.arn}/artifacts/gateway/*"]},
{"actions":["logs:CreateLogStream","logs:PutLogEvents","logs:DescribeLogStreams","logs:DescribeLogGroups"],"resources":["\${aws_cloudwatch_log_group.gateway.arn}","\${aws_cloudwatch_log_group.gateway.arn}:*"]}
]`);
  assert.deepEqual(
    parsed.data.aws_iam_policy_document.gateway[0].statement,
    expected,
  );
});
