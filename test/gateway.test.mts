import assert, { deepEqual as equal } from "node:assert/strict";
import childProcess, { spawnSync as run } from "node:child_process";
import filesystem, { globSync, readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
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
  equal(startupFailure(new Error("private-token")), {
    event: "gateway_start_failed",
    code: "STARTUP_FAILED",
  });
});
test("heartbeat gaps and handler failures preserve later events", async () => {
  const client = new Client({ intents: [] });
  client.isReady = (() => true) as typeof client.isReady;
  let time = 0,
    calls = 0;
  const metrics: string[] = [],
    logs: Record<string, unknown>[] = [];
  let reported!: () => void;
  const report = new Promise<void>((resolve) => {
    reported = resolve;
  });
  const tick = gateway.attachGateway(
    client,
    {
      warn: async () => void assert.notEqual(++calls, 1, "private data"),
    },
    async (name) => {
      metrics.push(name);
      if (name === "HandlerError") throw new Error("private metric");
    },
    (record) => {
      logs.push(record);
      if (record.event === "metric_failed") reported();
    },
    () => time,
  );
  await tick();
  assert.equal(metrics.length, 0);
  client.emit("shardReady", 0, new Set());
  await tick();
  for (const outcome of ["resumed", "re-identified"]) {
    client.emit("shardReconnecting", 0);
    const start = time;
    time += 600_000;
    await tick();
    assert.equal(metrics.length, outcome === "resumed" ? 1 : 2);
    if (outcome === "resumed") client.emit("shardResume", 0, 1);
    else client.emit("shardReady", 0, new Set());
    equal(
      JSON.stringify(logs.at(-1)),
      `{"event":"gateway_gap","shard":0,"disconnectedAt":"${new Date(start).toISOString()}","connectedAt":"${new Date(time).toISOString()}","outcome":"${outcome}"}`,
    );
    await tick();
  }
  equal(metrics, ["Heartbeat", "Heartbeat", "Heartbeat"]);
  client.emit("warn", "warning");
  await report;
  client.emit("warn", "warning");
  assert.equal(calls, 2);
  equal(metrics.at(-1), "HandlerError");
  const events = logs.slice(-2).map((record) => record.event);
  equal(events, ["handler_failed", "metric_failed"]);
  assert.ok(!JSON.stringify(logs).includes("private"));
});
test("gateway bundle fails closed outside the repository without credentials", () => {
  const result = run(process.execPath, [resolve("build/gateway/index.mjs")], {
    cwd: tmpdir(),
    ...JSON.parse(
      '{"encoding":"utf8","env":{"AWS_EC2_METADATA_DISABLED":"true","AWS_SHARED_CREDENTIALS_FILE":"/dev/null","AWS_CONFIG_FILE":"/dev/null"}}',
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
  for (const key of Object.keys(expected)) equal(alarm[key], expected[key]);
});
test("gateway IAM scope limits token reads, decryption and metric writes", () => {
  const role = parsed.resource.aws_iam_role.gateway[0];
  for (const field of ["managed_policy_arns", "inline_policy"])
    assert.equal(role[field], undefined);
  const targets = new Set([role.name, "wow-forever-gateway"]);
  for (const field of ["id", "name"])
    targets.add(`\${aws_iam_role.gateway.${field}}`);
  type Role = { role: string };
  const policies = (kind: string) =>
    (Object.values(parsed.resource[kind] ?? {}).flat() as Role[]).filter(
      (policy) => targets.has(policy.role),
    );
  const policy = "aws_iam_role_policy";
  for (const suffix of ["_attachment", "_attachments_exclusive"])
    equal(policies(policy + suffix), []);
  const expectedRole = JSON.parse(
    `[{"role":"\${aws_iam_role.gateway.id}","policy":"\${data.aws_iam_policy_document.gateway.json}"}]`,
  );
  expectedRole.push({
    name: "wow-forever-needs-roster-index",
    role: `\${aws_iam_role.gateway.id}`,
    policy: `\${data.aws_iam_policy_document.needs_roster_index.json}`,
  });
  equal(policies(policy), expectedRole);
  equal(parsed.data.aws_iam_policy_document.needs_roster_index[0].statement, [
    {
      actions: ["dynamodb:Query"],
      resources: [`\${aws_dynamodb_table.guild.arn}/index/gsi1`],
    },
  ]);
  const expected = JSON.parse(
    `[{"actions":["dynamodb:GetItem","dynamodb:Query","dynamodb:PutItem","dynamodb:UpdateItem","dynamodb:ConditionCheckItem"],"resources":["\${aws_dynamodb_table.guild.arn}"]},{"actions":["ssm:UpdateInstanceInformation","ssm:ListAssociations","ssm:ListInstanceAssociations","ssm:DescribeAssociation","ssm:GetDocument","ssm:DescribeDocument","ssm:UpdateAssociationStatus","ssm:UpdateInstanceAssociationStatus","ssm:PutInventory","ssm:GetDeployablePatchSnapshotForInstance","ec2messages:*","ssmmessages:*"],"resources":["*"]},{"actions":["ssm:GetParameter"],"resources":["\${aws_ssm_parameter.secrets[\\"discord_bot_token\\"].arn}"]},{"actions":["kms:Decrypt"],"resources":["\${data.aws_kms_key.ssm.arn}"],"condition":[{"test":"StringEquals","variable":"kms:ViaService","values":["ssm.us-east-1.amazonaws.com"]}]},{"actions":["cloudwatch:PutMetricData"],"resources":["*"],"condition":[{"test":"StringEquals","variable":"cloudwatch:namespace","values":["wow-forever/gateway"]}]},{"actions":["s3:ListBucket"],"resources":["\${aws_s3_bucket.gateway.arn}"]},{"actions":["s3:GetObject"],"resources":["\${aws_s3_bucket.gateway.arn}/artifacts/gateway/*"]},{"actions":["logs:CreateLogStream","logs:PutLogEvents","logs:DescribeLogStreams","logs:DescribeLogGroups"],"resources":["\${aws_cloudwatch_log_group.gateway.arn}","\${aws_cloudwatch_log_group.gateway.arn}:*"]}]`,
  );
  equal(parsed.data.aws_iam_policy_document.gateway[0].statement, expected);
});
for (const script of ["gateway-bootstrap", "deploy-gateway"]) {
  test(`${script} refuses a failed artifact deployment`, async ({ mock }) => {
    const argv = process.argv;
    const read = filesystem.readFileSync;
    mock.method(filesystem, "readFileSync", (path: string | URL) =>
      typeof path !== "string"
        ? read(path)
        : path.endsWith("instance-id")
          ? "i-ab"
          : JSON.stringify({ digest: "a".repeat(64) }),
    );
    for (const method of ["writeFileSync", "renameSync"] as const)
      mock.method(filesystem, method, () => {});
    mock.method(
      childProcess,
      "execFileSync",
      (_command: string, args: string[]) =>
        args.includes("send-command")
          ? '{"Command":{"CommandId":"command"}}'
          : '{"Status":"Failed","ResponseCode":0,"StandardErrorContent":"denied","StandardOutputContent":"2026-11-03T00:00:00Z"}',
    );
    try {
      process.argv = ["node", "script", "i-ab", "bucket"];
      syncBuiltinESMExports();
      await assert.rejects(
        import(`../scripts/${script}.mts`),
        script === "gateway-bootstrap"
          ? /Gateway artifact digest mismatch/
          : /Gateway SSM command failed: Failed: denied/,
      );
    } finally {
      process.argv = argv;
      mock.restoreAll();
      syncBuiltinESMExports();
    }
  });
}
