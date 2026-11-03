import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createHandler } from "../src/alarm-forwarder/index.mts";

const webhook = "https://example.invalid/webhook?thread_id=123";
const event = (message = "plain notification") => ({
  Records: [{ Sns: { Message: message } }],
});
test("webhook delivery requests wait=true and preserves query", async () => {
  const handler = createHandler(
    async () => webhook,
    async (url, options) => {
      assert.equal(String(url), `${webhook}&wait=true`);
      assert.equal(options?.method, "POST");
      assert.match(String(options?.body), /plain notification/);
      return new Response(null, { status: 200 });
    },
  );
  assert.deepEqual(await handler(event()), { forwarded: 1 });
});
test("malformed webhook URL is never exposed", async () => {
  const secret = "bad URL secret-token";
  await assert.rejects(
    createHandler(async () => secret)(event()),
    (error: Error) => {
      assert.match(error.message, /Invalid webhook URL/);
      assert.ok(!error.message.includes(secret));
      return true;
    },
  );
});
test("failure guards reject invocations without exposing secrets", async () => {
  for (const value of [undefined, "None"])
    await assert.rejects(
      createHandler(async () => value)(event()),
      /Webhook not configured/,
    );
  await assert.rejects(
    createHandler(async () => {
      throw new Error(webhook);
    })(event()),
    /SSM webhook read failed$/,
  );
  const handler = createHandler(async () => webhook);
  await assert.rejects(handler({}), /no Records/);
  await assert.rejects(handler({ Records: [] }), /no Records/);
  await assert.rejects(handler({ Records: [{}] }), /no Sns.Message/);
  await assert.rejects(
    createHandler(
      async () => webhook,
      async () => {
        throw new Error(webhook);
      },
    )(event()),
    /Webhook transport failed$/,
  );
  await assert.rejects(
    createHandler(
      async () => webhook,
      async () => new Response(null, { status: 429 }),
    )(event()),
    /webhook returned 429$/,
  );
});
test("budget notification and long alarm content render within Discord limits", async () => {
  const messages: string[] = [];
  const handler = createHandler(
    async () => webhook,
    async (_url, options) => {
      messages.push(JSON.parse(String(options?.body)).content);
      return new Response(null, { status: 200 });
    },
  );
  await handler(
    event(
      "AWS Budget Notification\nNovember 02, 2026\nAWS Account 123456789012\n\nDear AWS Customer,\n\nYou requested that we alert you when the ACTUAL Cost associated with your Monthly budget is greater than $25.00 for the current month.\n\nBudget Name: Monthly\nBudget Type: Cost\nBudgeted Amount: $25.00\nAlert Type: ACTUAL\nAlert Threshold: > $25.00\nACTUAL Amount: $26.00",
    ),
  );
  assert.match(
    messages[0],
    /Monthly.*\nBudget: \$25.00\nActual spend: \$26.00/,
  );
  await handler(
    event(
      JSON.stringify({
        AlarmName: "Long",
        NewStateValue: "ALARM",
        NewStateReason: "x".repeat(2500),
      }),
    ),
  );
  assert.equal(messages[1].length, 2000);
  assert.match(messages[1], /truncated/);
});
test("built artifact imports without node_modules", () => {
  const directory = mkdtempSync(join(tmpdir(), "alarm-artifact-"));
  try {
    copyFileSync(
      "build/alarm-forwarder/index.mjs",
      join(directory, "index.mjs"),
    );
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import assert from "node:assert/strict"; const module = await import("./index.mjs"); assert.equal(typeof module.handler, "function");',
      ],
      { cwd: directory, env: { ...process.env, NODE_PATH: "" } },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
