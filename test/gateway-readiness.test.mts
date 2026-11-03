import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import { test } from "node:test";
import hcl from "hcl2-parser";
import {
  gatewayDeployCommands,
  waitForGateway,
} from "../scripts/gateway-readiness.mts";

test("readiness requires thirty stable seconds and a fresh instance heartbeat", async () => {
  let time = 1;
  let samples = 0;
  await waitForGateway({
    restartedAt: time,
    now: () => time,
    pause: async () => {
      time += 5_000;
    },
    unit: async () => ({
      ActiveState: "active",
      SubState: "running",
      NRestarts: "0",
    }),
    heartbeat: async () => {
      samples++;
      assert.ok(time >= 30_001);
      return samples === 1 ? [1] : [time];
    },
  });
  assert.equal(samples, 2);
});

test("readiness rejects a crash-looping unit, inactive unit and missing heartbeat", async () => {
  for (const mode of ["crash-loop", "inactive", "no-heartbeat", "malformed"]) {
    let time = 1;
    let probes = 0;
    await assert.rejects(
      waitForGateway({
        restartedAt: time,
        now: () => time,
        pause: async () => {
          time += 5_000;
        },
        unit: async () => ({
          ActiveState: mode === "inactive" ? "inactive" : "active",
          SubState: "running",
          NRestarts:
            mode === "malformed"
              ? ""
              : String(mode === "crash-loop" ? probes++ : 0),
        }),
        heartbeat: async () => (mode === "no-heartbeat" ? [] : [time]),
      }),
      mode === "no-heartbeat"
        ? /No instance heartbeat/
        : /Gateway stopped or restarted/,
    );
  }
});

test("instance policies grant parameter reads only on the bot token", () => {
  const [parsed, error] = hcl.parseToObject(
    globSync("infra/*.tf")
      .map((path) => readFileSync(path, "utf8"))
      .join("\n"),
  );
  assert.equal(error, null);
  const role = parsed.resource.aws_iam_role.gateway[0];
  assert.equal(role.managed_policy_arns, undefined);
  assert.equal(role.inline_policy, undefined);
  assert.equal(parsed.resource.aws_iam_role_policy_attachment, undefined);
  const policies = Object.values(
    parsed.resource.aws_iam_role_policy,
  ).flat() as { role: string; policy: string }[];
  assert.deepEqual(
    policies.filter((policy) => policy.role === `\${aws_iam_role.gateway.id}`),
    [
      {
        role: `\${aws_iam_role.gateway.id}`,
        policy: `\${data.aws_iam_policy_document.gateway.json}`,
      },
    ],
  );
  const statements = parsed.data.aws_iam_policy_document.gateway[0]
    .statement as { actions: string[]; resources: string[] }[];
  assert.deepEqual(
    statements.filter((statement) =>
      statement.actions.includes("s3:ListBucket"),
    ),
    [
      {
        actions: ["s3:ListBucket"],
        resources: [`\${aws_s3_bucket.gateway.arn}`],
      },
    ],
  );
  assert.deepEqual(
    statements.filter((statement) =>
      statement.actions.includes("s3:GetObject"),
    ),
    [
      {
        actions: ["s3:GetObject"],
        resources: [`\${aws_s3_bucket.gateway.arn}/artifacts/gateway/*`],
      },
    ],
  );
  const parameterStatements = statements.filter((statement) =>
    statement.actions.some((action) =>
      ["ssm:GetParameter", "ssm:GetParameters"].some((permission) =>
        new RegExp(`^${action.replaceAll("*", ".*")}$`, "i").test(permission),
      ),
    ),
  );
  assert.deepEqual(parameterStatements, [
    {
      actions: ["ssm:GetParameter"],
      resources: [`\${aws_ssm_parameter.secrets["discord_bot_token"].arn}`],
    },
  ]);
});

test("deployment enables the unit before restarting it", () => {
  const commands = gatewayDeployCommands(
    "bucket",
    "artifacts/gateway/test.mjs",
    "digest",
  );
  assert.ok(commands.includes("systemctl enable wow-forever-gateway"));
  assert.ok(
    commands.indexOf("systemctl enable wow-forever-gateway") <
      commands.indexOf("systemctl restart wow-forever-gateway"),
  );
});
