import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Client } from "discord.js";
import hcl from "hcl2-parser";
import { attachGateway, tokenValue } from "../src/gateway/client.mts";

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

test("silence alarm requires ten missing minute periods", () => {
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
});
