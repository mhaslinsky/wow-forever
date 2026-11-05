import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { encode } from "../guildos/fixtures/encode.mts";
import { decodeCompanion, parseSavedVariables } from "../guildos/index.mts";
import { createReader, type Snapshot, type Status } from "./reader.mts";

const sample = decodeCompanion(
  parseSavedVariables(
    readFileSync(
      new URL("../guildos/fixtures/guild.lua", import.meta.url),
      "utf8",
    ),
  ),
) as Record<string, unknown>;
const wire = encode({ ...sample, game: "FOREVER" });
function setup(results = [{ status: 200, outcome: "stored" }]) {
  let now = 0;
  const timers = new Map<number, { at: number; callback(): void }>();
  let sequence = 0;
  const uploads: Snapshot[] = [];
  let status: Status = {};
  let text = `GuildOSDB = { __companion = "${wire}" }`;
  const reader = createReader({
    clock: {
      now: () => now,
      schedule(callback, delay) {
        const id = ++sequence;
        timers.set(id, { at: now + delay, callback });
        return () => {
          timers.delete(id);
        };
      },
    },
    async read() {
      return { text, writtenAt: 123 };
    },
    async upload(snapshot) {
      uploads.push(snapshot);
      return results.shift() ?? { status: 200, outcome: "stored" };
    },
    save(value) {
      status = value;
    },
  });
  return {
    reader,
    uploads,
    status: () => status,
    text(value: string) {
      text = value;
    },
    async step(delay: number) {
      now += delay;
      for (const [id, timer] of timers)
        if (timer.at <= now) {
          timers.delete(id);
          timer.callback();
        }
      await new Promise<void>((done) => setImmediate(done));
    },
  };
}
test("file rewrite debounces to exactly one upload", async () => {
  const fixture = setup();
  fixture.reader.changed();
  await fixture.step(500);
  fixture.reader.changed();
  await fixture.step(999);
  assert.equal(fixture.uploads.length, 0);
  await fixture.step(1);
  assert.deepEqual(fixture.uploads, [{ wire, writtenAt: 123 }]);
  assert.equal(fixture.status().lastSuccess?.outcome, "stored");
});
test("failed upload retries with exponential backoff and replaces pending data", async () => {
  const fixture = setup([
    { status: 503, outcome: "notConfigured" },
    { status: 500, outcome: "serviceError" },
  ]);
  fixture.reader.changed();
  await fixture.step(1000);
  assert.equal(fixture.status().pendingRetryAt, 6000);
  await fixture.step(4999);
  assert.equal(fixture.uploads.length, 1);
  await fixture.step(1);
  assert.equal(fixture.status().pendingRetryAt, 16000);
  fixture.reader.changed();
  await fixture.step(1000);
  assert.equal(fixture.status().pendingRetryAt, undefined);
  await fixture.step(300000);
  assert.equal(fixture.uploads.length, 3);
});
test("status preserves named failures without retrying rejected files or requests", async () => {
  const fixture = setup([{ status: 401, outcome: "unauthorized" }]);
  fixture.reader.changed();
  await fixture.step(1000);
  assert.equal(fixture.status().lastFailure?.error, "unauthorized");
  await fixture.step(300000);
  assert.equal(fixture.uploads.length, 1);
  fixture.text("GuildOSDB = {}");
  fixture.reader.changed();
  await fixture.step(1000);
  assert.equal(fixture.status().lastFailure?.error, "CompanionPrefixError");
  assert.equal(fixture.status().pendingRetryAt, undefined);
});
