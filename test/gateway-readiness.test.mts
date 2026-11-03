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
