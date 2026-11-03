import assert from "node:assert/strict";
import { test } from "node:test";
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
