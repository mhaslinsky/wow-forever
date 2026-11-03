#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

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
  throw new Error("Gateway deployment failed");
console.log("Gateway deployed");
