import assert from "node:assert/strict";
import { test } from "node:test";
import * as gateway from "../scripts/gateway-readiness.mts";

test("readiness rejects inactive, crash-looping, malformed and missing-heartbeat units", async () => {
  const modes = "inactive stopped crash-loop malformed no-heartbeat ready";
  for (const mode of modes.split(" ")) {
    let time = 1;
    let probes = 0;
    let samples = 0;
    const check = gateway.waitForGateway({
      restartedAt: time,
      now: () => time,
      pause: async () => {
        time += 5_000;
      },
      unit: async () =>
        JSON.parse(
          `{"ActiveState":"${mode === "inactive" ? "inactive" : "active"}","SubState":"${mode === "stopped" ? "dead" : "running"}","NRestarts":"${mode === "malformed" ? "" : mode === "crash-loop" ? probes++ : 0}"}`,
        ),
      heartbeat: async () => {
        assert.ok(time >= 30_001);
        return mode === "no-heartbeat" ? [] : ++samples === 1 ? [1] : [time];
      },
    });
    const failure = mode === "no-heartbeat" ? /No instance/ : /Gateway stopped/;
    await (mode === "ready" ? check : assert.rejects(check, failure));
    if (mode === "ready") assert.equal(samples, 2);
    if (mode === "no-heartbeat") assert.equal(time, 210_001);
  }
});
test("deployment enables the unit before restarting it", () => {
  const commands = gateway.gatewayDeployCommands("bucket", "key", "digest");
  const enable = "systemctl enable wow-forever-gateway";
  assert.ok(commands.includes(enable));
  const restart = commands.indexOf("systemctl restart wow-forever-gateway");
  assert.ok(commands.indexOf(enable) < restart);
});
