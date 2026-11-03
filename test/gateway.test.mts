import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { globSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { Client } from "discord.js";
import hcl from "hcl2-parser";
import * as gateway from "../src/gateway/client.mts";

const { StartupError, startupFailure } = gateway;
const [parsed, error] = hcl.parseToObject(
  globSync("infra/*.tf")
    .map((path) => readFileSync(path, "utf8"))
    .join("\n"),
);
assert.equal(error, null);
test("startup refuses unconfigured tokens and reports fixed failure codes", () => {
  for (const value of [undefined, "", "  ", "None", " None "])
    assert.throws(() => gateway.tokenValue(value), /TOKEN_NOT_CONFIGURED/);
  assert.equal(gateway.tokenValue("configured"), "configured");
  for (const code of ["SSM_READ_FAILED", "LOGIN_FAILED"] as const)
    assert.equal(startupFailure(new StartupError(code)).code, code);
  assert.deepEqual(startupFailure(new Error("private-token")), {
    event: "gateway_start_failed",
    code: "STARTUP_FAILED",
  });
});
test("heartbeat follows readiness and records resumed and re-identified gaps", async () => {
  const client = new Client({ intents: [] });
  client.isReady = (() => true) as typeof client.isReady;
  let time = 0;
  const metrics: string[] = [];
  const logs: Record<string, unknown>[] = [];
  const tick = gateway.attachGateway(
    client,
    {},
    async (name) => void metrics.push(name),
    (record) => logs.push(record),
    () => time,
  );
  await tick();
  assert.equal(metrics.length, 0);
  client.emit("shardReady", 0, new Set());
  await tick();
  assert.deepEqual(metrics, ["Heartbeat"]);
  for (const outcome of ["resumed", "re-identified"]) {
    client.emit("shardReconnecting", 0);
    const start = time;
    time += 600_000;
    await tick();
    assert.equal(metrics.length, outcome === "resumed" ? 1 : 2);
    if (outcome === "resumed") client.emit("shardResume", 0, 1);
    else client.emit("shardReady", 0, new Set());
    assert.deepEqual(
      logs.at(-1),
      JSON.parse(
        `{"event":"gateway_gap","shard":0,"disconnectedAt":"${new Date(start).toISOString()}","connectedAt":"${new Date(time).toISOString()}","outcome":"${outcome}"}`,
      ),
    );
    await tick();
  }
  assert.equal(metrics.length, 3);
});
test("handler and metric failures are reported without stopping later events", async () => {
  const client = new Client({ intents: [] });
  const logs: Record<string, unknown>[] = [];
  const metrics: string[] = [];
  let calls = 0;
  let reported!: () => void;
  const report = new Promise<void>((resolve) => {
    reported = resolve;
  });
  gateway.attachGateway(
    client,
    {
      shardReconnecting: async () => {
        if (++calls === 1) throw new Error("private data");
      },
    },
    async (name) => {
      metrics.push(name);
      throw new Error("private metric");
    },
    (record) => {
      logs.push(record);
      if (record.event === "metric_failed") reported();
    },
  );
  client.emit("shardReconnecting", 0);
  await report;
  assert.deepEqual(metrics, ["HandlerError"]);
  client.emit("shardReconnecting", 0);
  assert.equal(calls, 2);
  assert.ok(logs.some((record) => record.event === "handler_failed"));
  assert.ok(logs.some((record) => record.event === "metric_failed"));
  assert.ok(!JSON.stringify(logs).includes("private"));
});
test("gateway bundle fails closed outside the repository without credentials", () => {
  const bundle = resolve("build/gateway/index.mjs");
  const result = spawnSync(process.execPath, [bundle], {
    cwd: tmpdir(),
    encoding: "utf8",
    env: JSON.parse(
      `{"AWS_EC2_METADATA_DISABLED":"true","AWS_SHARED_CREDENTIALS_FILE":"/dev/null","AWS_CONFIG_FILE":"/dev/null"}`,
    ),
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /gateway_start_failed/);
});
test("silence alarm requires ten missing minute periods", () => {
  const alarm = parsed.resource.aws_cloudwatch_metric_alarm.gateway_silence[0];
  const expected = JSON.parse(
    `{"namespace":"wow-forever/gateway","metric_name":"Heartbeat","dimensions":{"InstanceId":"\${aws_instance.gateway.id}"},"period":60,"statistic":"Sum","threshold":1,"comparison_operator":"LessThanThreshold","treat_missing_data":"breaching","evaluation_periods":10,"datapoints_to_alarm":10}`,
  );
  for (const key of Object.keys(expected))
    assert.deepEqual(alarm[key], expected[key]);
});
test("gateway IAM scope limits token reads, decryption and metric writes", () => {
  const role = parsed.resource.aws_iam_role.gateway[0];
  assert.equal(role.managed_policy_arns, undefined);
  assert.equal(role.inline_policy, undefined);
  const targets = new Set([role.name, "wow-forever-gateway"]);
  for (const field of ["id", "name"])
    targets.add(`\${aws_iam_role.gateway.${field}}`);
  const policies = (kind: string) =>
    (
      Object.values(parsed.resource[kind] ?? {}).flat() as { role: string }[]
    ).filter((policy) => targets.has(policy.role));
  assert.deepEqual(policies("aws_iam_role_policy_attachment"), []);
  assert.deepEqual(policies("aws_iam_role_policy_attachments_exclusive"), []);
  assert.deepEqual(
    policies("aws_iam_role_policy"),
    JSON.parse(
      `[{"role":"\${aws_iam_role.gateway.id}","policy":"\${data.aws_iam_policy_document.gateway.json}"}]`,
    ),
  );
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
