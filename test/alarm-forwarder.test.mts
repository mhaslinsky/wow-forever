import assert from "node:assert/strict";
import { test } from "node:test";
import { createHandler } from "../src/alarm-forwarder/index.mts";

const event = {
  Records: [
    {
      Sns: {
        Message: JSON.stringify({
          AlarmName: "Monthly cost",
          NewStateValue: "ALARM",
          NewStateReason: "Budget exceeded",
        }),
      },
    },
  ],
};
test("forwarder posts an alarm to the configured webhook", async () => {
  const handler = createHandler(
    async () => "https://example.invalid/webhook",
    async (url, options) => {
      assert.equal(url, "https://example.invalid/webhook");
      assert.equal(options?.method, "POST");
      assert.match(String(options?.body), /Monthly cost/);
      assert.match(String(options?.body), /Budget exceeded/);
      return new Response(null, { status: 204 });
    },
  );
  assert.deepEqual(await handler(event), { forwarded: 1 });
});
test("forwarder reports webhook rejection", async () => {
  const handler = createHandler(
    async () => "https://example.invalid/webhook",
    async () => new Response(null, { status: 429 }),
  );
  await assert.rejects(
    handler(event),
    /1 of 1 alarm\(s\) NOT delivered: webhook returned 429/,
  );
});
