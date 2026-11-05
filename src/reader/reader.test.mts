import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { encode } from "../guildos/fixtures/encode.mts";
import { decodeCompanion, parseSavedVariables } from "../guildos/index.mts";
import type { Snapshot, Status } from "./reader.mts";
import { createReader, errorName } from "./reader.mts";
import { uploadSnapshot } from "./transport.mts";

const fixturePath = new URL("../guildos/fixtures/guild.lua", import.meta.url);
const sample = decodeCompanion(
  parseSavedVariables(readFileSync(fixturePath, "utf8")),
) as object;
const wire = encode({ ...sample, game: "FOREVER" });
function setup(
  results = [{ status: 200, outcome: "stored" }],
  readError?: Error,
  bodyError?: Error,
  bodyStatus = 200,
) {
  let now = 0;
  const timers = new Map<number, { at: number; callback(): void }>();
  let sequence = 0;
  const uploads: Snapshot[] = [];
  let status: Status = {};
  const saved: string[] = [];
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
      if (readError) {
        const error = readError;
        readError = undefined;
        throw error;
      }
      return { text, writtenAt: 123 };
    },
    async upload(snapshot) {
      uploads.push(snapshot);
      if (bodyError) {
        const error = bodyError;
        bodyError = undefined;
        return uploadSnapshot(
          new URL("https://example.invalid"),
          "placeholder",
          snapshot,
          async () =>
            new Response(
              new ReadableStream({ pull: () => Promise.reject(error) }),
              { status: bodyStatus },
            ),
        );
      }
      return results.shift() ?? { status: 200, outcome: "stored" };
    },
    save(value) {
      status = value;
      saved.push(JSON.stringify(value));
    },
  });
  return {
    reader,
    async change() {
      reader.changed();
      await this.step(1000);
    },
    uploads,
    saved,
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
});
test("failed upload retries with exponential backoff and replaces pending data", async () => {
  for (const boundary of ["read", "body", "401"]) {
    const code = boundary === "read" ? "EBUSY" : "ECONNRESET";
    const error = Object.assign(new Error(), { code });
    const fixture = setup(
      undefined,
      boundary === "read" ? error : undefined,
      boundary !== "read" ? error : undefined,
      boundary === "401" ? 401 : 200,
    );
    await fixture.change();
    assert.equal(
      fixture.status().pendingRetryAt,
      boundary === "401" ? undefined : 6000,
      boundary,
    );
    await fixture.step(5000);
    assert.equal(fixture.uploads.length, boundary === "body" ? 2 : 1, boundary);
  }
  const fixture = setup([
    { status: 503, outcome: "notConfigured" },
    { status: 500, outcome: "serviceError" },
  ]);
  await fixture.change();
  assert.equal(fixture.status().pendingRetryAt, 6000);
  await fixture.step(4999);
  await fixture.step(1);
  assert.equal(fixture.status().pendingRetryAt, 16000);
  await fixture.change();
  await fixture.step(300000);
  assert.equal(fixture.uploads.length, 3);
});
test("status preserves named failures without retrying rejected files or requests", async () => {
  const cause = { code: "ECONNREFUSED" };
  assert.equal(errorName(new TypeError("fetch failed", { cause })), cause.code);
  const secret = "private-token-placeholder";
  const safe = setup(undefined, new Error(secret));
  await safe.change();
  assert.equal(safe.saved.join("").includes(secret), false);
  const conflict = setup([{ status: 200, outcome: "conflict" }]);
  await conflict.change();
  assert.equal(conflict.status().lastSuccess?.outcome, "conflict");
  assert.equal(conflict.status().lastFailure, undefined);
  const fixture = setup();
  fixture.text("GuildOSDB = {}");
  await fixture.change();
  assert.equal(fixture.status().lastFailure?.error, "CompanionPrefixError");
  assert.equal(fixture.status().pendingRetryAt, undefined);
});
