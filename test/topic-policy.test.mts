import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import hcl from "hcl2-parser";

test("alerts topic policy statements carry unique non-empty sids", () => {
  const [parsed, error] = hcl.parseToObject(
    readFileSync("infra/budget.tf", "utf8"),
  );
  assert.equal(error, null);
  const statements =
    parsed.data.aws_iam_policy_document.budget_publish[0].statement;
  const sids = statements.map(
    (statement: { sid?: string }) => statement.sid ?? "",
  );
  assert.ok(sids.length >= 2);
  assert.ok(sids.every((sid: string) => sid.length > 0));
  assert.equal(new Set(sids).size, sids.length);
});
