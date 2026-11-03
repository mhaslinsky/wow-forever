#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
import { type UnitStatus, waitForGateway } from "./gateway-readiness.mts";

const [instance, bucket, profile = "aidb-personal"] = process.argv.slice(2);
if (
  !instance ||
  !/^i-[a-f0-9]+$/.test(instance) ||
  !bucket ||
  !/^[a-z0-9.-]+$/.test(bucket)
)
  throw new Error("Usage: deploy-gateway.mts INSTANCE BUCKET [PROFILE]");
const bundle = "build/gateway/index.mjs";
const digest = createHash("sha256").update(readFileSync(bundle)).digest("hex");
const key = `artifacts/gateway/${digest}.mjs`;
function aws(...args: string[]) {
  return execFileSync(
    "aws",
    [
      ...args,
      "--region",
      "us-east-1",
      "--profile",
      profile,
      "--output",
      "json",
    ],
    { encoding: "utf8" },
  );
}
aws("s3", "cp", bundle, `s3://${bucket}/${key}`);
const commands = [
  "set -eu",
  `aws s3 cp s3://${bucket}/${key} /opt/wow-forever-gateway/next.mjs --region us-east-1`,
  `echo '${digest}  /opt/wow-forever-gateway/next.mjs' | sha256sum -c -`,
  "mv /opt/wow-forever-gateway/next.mjs /opt/wow-forever-gateway/index.mjs",
  "chmod 0644 /opt/wow-forever-gateway/index.mjs",
  "systemctl restart wow-forever-gateway",
  "systemctl is-active --quiet wow-forever-gateway",
];
function runCommand(commands: string[]): string {
  const sent = JSON.parse(
    aws(
      "ssm",
      "send-command",
      "--instance-ids",
      instance,
      "--document-name",
      "AWS-RunShellScript",
      "--parameters",
      JSON.stringify({ commands }),
    ),
  );
  const commandId: unknown = sent.Command?.CommandId;
  if (typeof commandId !== "string" || !commandId)
    throw new Error("SSM returned no command ID");
  aws(
    "ssm",
    "wait",
    "command-executed",
    "--command-id",
    commandId,
    "--instance-id",
    instance,
  );
  const result = JSON.parse(
    aws(
      "ssm",
      "get-command-invocation",
      "--command-id",
      commandId,
      "--instance-id",
      instance,
    ),
  );
  if (result.Status !== "Success" || result.ResponseCode !== 0)
    throw new Error(
      `Gateway SSM command failed: ${result.Status}: ${result.StandardErrorContent}`,
    );
  if (typeof result.StandardOutputContent !== "string")
    throw new Error("SSM returned no command output");
  return result.StandardOutputContent;
}
const restartTime = runCommand([...commands, "date -u +%Y-%m-%dT%H:%M:%S.%3NZ"])
  .trim()
  .split("\n")
  .at(-1);
if (!restartTime) throw new Error("Instance returned no restart timestamp");
const restartedAt = Date.parse(restartTime);
if (!Number.isFinite(restartedAt))
  throw new Error("Instance returned invalid restart timestamp");
await waitForGateway({
  restartedAt,
  unit: async () =>
    Object.fromEntries(
      runCommand([
        "systemctl show wow-forever-gateway --property=ActiveState,SubState,NRestarts",
      ])
        .trim()
        .split("\n")
        .map((line) => line.split("=")),
    ) as UnitStatus,
  heartbeat: async () => {
    const result = JSON.parse(
      aws(
        "cloudwatch",
        "get-metric-statistics",
        "--namespace",
        "wow-forever/gateway",
        "--metric-name",
        "Heartbeat",
        "--dimensions",
        `Name=InstanceId,Value=${instance}`,
        "--start-time",
        new Date(restartedAt).toISOString(),
        "--end-time",
        new Date().toISOString(),
        "--period",
        "60",
        "--statistics",
        "Sum",
      ),
    );
    if (!Array.isArray(result.Datapoints))
      throw new Error("CloudWatch returned no datapoint list");
    return result.Datapoints.filter(
      (point: { Sum?: number }) =>
        typeof point.Sum === "number" && point.Sum >= 1,
    ).map((point: { Timestamp: string }) => Date.parse(point.Timestamp));
  },
  now: Date.now,
  pause: () => setTimeout(5_000),
});
execFileSync(
  "aws",
  [
    "s3",
    "cp",
    "-",
    `s3://${bucket}/artifacts/gateway/latest.json`,
    "--region",
    "us-east-1",
    "--profile",
    profile,
  ],
  { input: JSON.stringify({ digest }), stdio: ["pipe", "inherit", "inherit"] },
);
console.log("Gateway deployed");
