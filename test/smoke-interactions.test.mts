import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import hcl from "hcl2-parser";
import { runSmoke } from "../scripts/smoke-interactions.mts";

const options = {
  url: "https://example.invalid/",
  functionName: "test",
  skipDiscord: true,
  skipFixtures: true,
};
const statements = ["FunctionUrl", "Function"].map((suffix) => ({
  Effect: "Allow",
  Principal: "*",
  Action: `lambda:Invoke${suffix}`,
  Resource: "arn:aws:lambda:us-east-1:000000000000:function:test",
  Condition:
    suffix === "FunctionUrl"
      ? { StringEquals: { "lambda:FunctionUrlAuthType": "NONE" } }
      : { Bool: { "lambda:InvokedViaFunctionUrl": "true" } },
}));
const aws = async () => ({ Policy: JSON.stringify({ Statement: statements }) });
const http = async () => new Response(null, { status: 401 });
const statuses = (results: Awaited<ReturnType<typeof runSmoke>>) =>
  results.map((result) => result.status).join(",");
test("smoke fails when an endpoint accepts an unsigned request", async () => {
  const results = await runSmoke(options, {
    http: async () => new Response(null, { status: 200 }),
    aws,
  });
  assert.equal(results[0].status, "failed");
  assert.match(results[0].detail, /Expected 401, received 200/);
});
test("smoke fails when either public URL policy statement is missing", async () => {
  for (const retained of [[], statements.slice(0, 1), statements.slice(1)]) {
    const results = await runSmoke(options, {
      http,
      aws: async () => ({ Policy: JSON.stringify({ Statement: retained }) }),
    });
    assert.equal(results[2].status, "failed");
  }
});
test("explicit skips stay skipped and missing prerequisites fail", async () => {
  assert.equal(
    statuses(await runSmoke(options, { http, aws })),
    "passed,passed,passed,skipped,skipped,skipped,skipped",
  );
  assert.equal(
    statuses(
      await runSmoke(
        { ...options, skipDiscord: false, skipFixtures: false },
        { http, aws },
      ),
    ),
    "passed,passed,passed,failed,failed,failed,failed",
  );
});
test("production claims policy allows PutItem only, never GetItem or UpdateItem", () => {
  const [parsed, error] = hcl.parseToObject(
    readFileSync("infra/interactions.tf", "utf8"),
  );
  assert.equal(error, null);
  const statements = parsed.data.aws_iam_policy_document.interactions[0]
    .statement as { actions: string[]; resources: string[] }[];
  assert.deepEqual(
    statements.flatMap((statement) => statement.actions).sort(),
    [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "ssm:GetParameter",
      "kms:Decrypt",
      "lambda:InvokeFunction",
      "dynamodb:PutItem",
    ].sort(),
  );
  assert.deepEqual(statements.at(-1)?.resources, [
    `\${aws_dynamodb_table.claims.arn}`,
  ]);
  assert.deepEqual(parsed.resource.aws_iam_role_policy.interactions, [
    {
      role: `\${aws_iam_role.interactions.id}`,
      policy: `\${data.aws_iam_policy_document.interactions.json}`,
    },
  ]);
});
