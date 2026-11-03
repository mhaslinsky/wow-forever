import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "discord.js";
import hcl from "hcl2-parser";
import {
  attachGateway,
  scheduleHeartbeat,
  tokenValue,
} from "../src/gateway/client.mts";

test("startup refuses missing, empty and placeholder tokens", () => {
  for (const value of [undefined, "", "  ", "None", " None "])
    assert.throws(() => tokenValue(value), /TOKEN_NOT_CONFIGURED/);
  assert.equal(tokenValue("configured"), "configured");
});

test("heartbeat follows shard readiness and records resumed and re-identified gaps", async () => {
  const client = new Client({ intents: [] });
  client.isReady = (() => true) as typeof client.isReady;
  let time = 0;
  const metrics: string[] = [];
  const logs: Record<string, unknown>[] = [];
  const tick = attachGateway(
    client,
    {},
    async (name) => {
      metrics.push(name);
    },
    (record) => logs.push(record),
    () => time,
  );
  await tick();
  assert.equal(metrics.length, 0);
  client.emit("shardReady", 0, new Set());
  time += 60_000;
  await tick();
  assert.deepEqual(metrics, ["Heartbeat"]);
  for (const outcome of ["resumed", "re-identified"]) {
    client.emit("shardReconnecting", 0);
    const start = time;
    for (let minute = 0; minute < 10; minute++) {
      time += 60_000;
      await tick();
    }
    assert.equal(metrics.length, outcome === "resumed" ? 1 : 2);
    if (outcome === "resumed") client.emit("shardResume", 0, 1);
    else client.emit("shardReady", 0, new Set());
    assert.deepEqual(logs.at(-1), {
      event: "gateway_gap",
      shard: 0,
      disconnectedAt: new Date(start).toISOString(),
      connectedAt: new Date(time).toISOString(),
      outcome,
    });
    await tick();
  }
  assert.equal(metrics.length, 3);
});

test("handler failure is reported and later events still run", async () => {
  const client = new Client({ intents: [] });
  const logs: Record<string, unknown>[] = [];
  let calls = 0;
  let reported!: () => void;
  const report = new Promise<void>((resolve) => {
    reported = resolve;
  });
  attachGateway(
    client,
    {
      shardReconnecting: async () => {
        calls++;
        if (calls === 1) throw new Error("private data");
      },
    },
    async (name) => {
      assert.equal(name, "HandlerError");
      reported();
    },
    (record) => logs.push(record),
  );
  client.emit("shardReconnecting", 0);
  await report;
  client.emit("shardReconnecting", 0);
  assert.equal(calls, 2);
  assert.ok(logs.some((record) => record.event === "handler_failed"));
  assert.ok(!JSON.stringify(logs).includes("private data"));
});

test("metric failures are visible and do not reject the heartbeat", async () => {
  const client = new Client({ intents: [] });
  client.isReady = (() => true) as typeof client.isReady;
  const logs: Record<string, unknown>[] = [];
  const tick = attachGateway(
    client,
    {},
    async () => {
      throw new Error("unavailable");
    },
    (record) => logs.push(record),
  );
  client.emit("shardReady", 0, new Set());
  await tick();
  assert.deepEqual(logs, [{ event: "metric_failed", metric: "Heartbeat" }]);
});

test("gateway bundle starts outside the repository and fails closed without credentials", () => {
  const directory = mkdtempSync(join(tmpdir(), "gateway-bundle-"));
  try {
    copyFileSync("build/gateway/index.mjs", join(directory, "index.mjs"));
    assert.throws(
      () =>
        execFileSync(process.execPath, [join(directory, "index.mjs")], {
          cwd: directory,
          env: {
            PATH: process.env.PATH,
            AWS_EC2_METADATA_DISABLED: "true",
            AWS_SHARED_CREDENTIALS_FILE: join(directory, "absent"),
            AWS_CONFIG_FILE: join(directory, "absent-config"),
          },
          stdio: "pipe",
        }),
      (error: unknown) => {
        const failure = error as { status: number; stdout: Buffer };
        assert.equal(failure.status, 1);
        assert.match(String(failure.stdout), /gateway_start_failed/);
        return true;
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("heartbeat is scheduled every sixty seconds", async (context) => {
  context.mock.timers.enable({ apis: ["setInterval"] });
  let calls = 0;
  const timer = scheduleHeartbeat(async () => {
    calls++;
  });
  context.mock.timers.tick(59_999);
  assert.equal(calls, 0);
  context.mock.timers.tick(1);
  assert.equal(calls, 1);
  context.mock.timers.tick(60_000);
  assert.equal(calls, 2);
  clearInterval(timer);
});

test("silence alarm requires ten missing minute periods and resets after heartbeat", () => {
  const [parsed, error] = hcl.parseToObject(
    readFileSync("infra/gateway.tf", "utf8"),
  );
  assert.equal(error, null);
  const alarm = parsed.resource.aws_cloudwatch_metric_alarm.gateway_silence[0];
  assert.equal(alarm.namespace, "wow-forever/gateway");
  assert.equal(alarm.metric_name, "Heartbeat");
  assert.deepEqual(alarm.dimensions, {
    InstanceId: `\${aws_instance.gateway.id}`,
  });
  assert.equal(alarm.period, 60);
  assert.equal(alarm.statistic, "Sum");
  assert.equal(alarm.threshold, 1);
  assert.equal(alarm.comparison_operator, "LessThanThreshold");
  assert.equal(alarm.treat_missing_data, "breaching");
  assert.equal(alarm.evaluation_periods, 10);
  assert.equal(alarm.datapoints_to_alarm, 10);
  const periods: boolean[] = [];
  const evaluate = (heartbeat?: number) => {
    periods.push(
      heartbeat === undefined
        ? alarm.treat_missing_data === "breaching"
        : heartbeat < alarm.threshold,
    );
    return (
      periods.slice(-alarm.evaluation_periods).filter(Boolean).length >=
      alarm.datapoints_to_alarm
    );
  };
  for (let minute = 1; minute < 10; minute++) assert.equal(evaluate(), false);
  assert.equal(evaluate(), true);
  assert.equal(evaluate(1), false);
});
