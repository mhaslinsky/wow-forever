import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, sign, verify } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import fc from "fast-check";
import type {
  Clock,
  Interaction,
  Ports,
  Route,
} from "../src/interactions/core.mts";
import {
  commandDefinitions,
  message,
  signatureValid,
  timestampFresh,
} from "../src/interactions/core.mts";
import { createHttp } from "../src/interactions/http.mts";
import { discordClient } from "../src/interactions/index.mts";
import { createWorker } from "../src/interactions/worker.mts";
import { fixtures } from "./interactions-fixtures.mts";

const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey
  .export({ format: "der", type: "spki" })
  .subarray(-32)
  .toString("hex");
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
class SteppedClock implements Clock {
  value = 1_800_000_000_000;
  timers = new Map<() => void, number>();
  now = () => this.value;
  schedule = (milliseconds: number, callback: () => void) => {
    this.timers.set(callback, this.value + milliseconds);
    return () => {
      this.timers.delete(callback);
    };
  };
  async advance(milliseconds: number) {
    const end = this.value + milliseconds;
    for (;;) {
      const next = [...this.timers]
        .filter(([, due]) => due <= end)
        .sort((left, right) => left[1] - right[1])[0];
      if (!next) break;
      this.value = next[1];
      this.timers.delete(next[0]);
      next[0]();
      await flush();
    }
    this.value = end;
    await flush();
  }
}
const interaction = (
  type: Interaction["type"] = 2,
  name = "fixture-slow",
): Interaction => ({
  id: "synthetic-interaction",
  application_id: "synthetic-app",
  token: "synthetic-token",
  type,
  data: { name, custom_id: `${name}:synthetic` },
  user: { id: "synthetic-user" },
});
function harness() {
  const clock = new SteppedClock();
  const calls: string[] = [];
  const replies: { method: string; content?: string }[] = [];
  const claims = new Set<string>();
  const ports: Ports = {
    clock,
    publicKey: async () => publicKey,
    invoke: async () => {
      calls.push("invoke");
    },
    claim: async (key) => {
      calls.push(key);
      if (claims.has(key)) return false;
      claims.add(key);
      return true;
    },
    discord: async (_interaction, method, content) => {
      calls.push(method);
      if (method !== "GET") replies.push({ method, content });
      return 200;
    },
    report: () => {
      calls.push("reported");
    },
  };
  const event = (
    body = JSON.stringify(interaction()),
    timestamp = String(clock.now() / 1000),
  ) => ({
    body,
    headers: {
      "x-signature-timestamp": timestamp,
      "x-signature-ed25519": sign(
        null,
        Buffer.from(timestamp + body),
        keys.privateKey,
      ).toString("hex"),
    },
  });
  const worker = (routes: readonly Route[] = fixtures) =>
    createWorker(ports, routes)(
      interaction(),
      () => 60_000 - (clock.now() - 1_800_000_000_000),
    );
  return { clock, calls, replies, ports, event, worker };
}
test("cryptographic acceptance equals the independent Ed25519 oracle", () => {
  fc.assert(
    fc.property(
      fc.uint8Array(),
      fc.string(),
      fc.boolean(),
      (bytes, timestamp, tamper) => {
        const body = Buffer.from(bytes);
        const payload = Buffer.concat([Buffer.from(timestamp), body]);
        const signature = sign(null, payload, keys.privateKey);
        if (tamper) signature[0] ^= 1;
        assert.equal(
          signatureValid(body, signature.toString("hex"), timestamp, publicKey),
          verify(null, payload, keys.publicKey, signature),
        );
      },
    ),
  );
});
test("endpoint acceptance requires a valid signature and a fresh timestamp", async () => {
  const setup = harness();
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: -1000, max: 1000 }),
      fc.string(),
      fc.boolean(),
      async (offset, padding, tamper) => {
        const event = setup.event(
          JSON.stringify({ type: 1, padding }),
          String(setup.clock.now() / 1000 + offset),
        );
        if (tamper) event.body += " ";
        const response = await createHttp(setup.ports, fixtures)(event);
        assert.equal(
          response.statusCode,
          !tamper && Math.abs(offset) <= 300 ? 200 : 401,
        );
      },
    ),
  );
  for (const timestamp of [
    "",
    "invalid",
    "NaN",
    "1e9",
    "1800000000.5",
    " 1800000000",
    "-1",
    "9007199254740992",
  ]) {
    assert.equal(
      (
        await createHttp(
          setup.ports,
          fixtures,
        )(setup.event(undefined, timestamp))
      ).statusCode,
      401,
    );
  }
  for (const offset of [-301, -300, 300, 301])
    assert.equal(
      timestampFresh(
        String(setup.clock.now() / 1000 + offset),
        setup.clock.now(),
      ),
      Math.abs(offset) <= 300,
    );
});
test("missing or malformed signatures do no work; raw base64 and header casing are preserved", async () => {
  const setup = harness();
  const http = createHttp(setup.ports, fixtures);
  for (const signature of [undefined, "", "ab", "g".repeat(128)]) {
    const event = setup.event();
    assert.equal(
      (
        await http({
          ...event,
          headers: { ...event.headers, "x-signature-ed25519": signature },
        })
      ).statusCode,
      401,
    );
  }
  assert.equal(
    signatureValid(Buffer.from("{}"), "00".repeat(64), "1", "bad"),
    false,
  );
  assert.equal(
    signatureValid(Buffer.from("{}"), "00".repeat(64), "1", publicKey),
    false,
  );
  assert.deepEqual(setup.calls, []);
  const event = setup.event(' { "type": 1 } ');
  assert.equal(
    JSON.parse(
      (
        await http({
          body: Buffer.from(event.body).toString("base64"),
          isBase64Encoded: true,
          headers: {
            "X-Signature-Timestamp": event.headers["x-signature-timestamp"],
            "X-Signature-Ed25519": event.headers["x-signature-ed25519"],
          },
        })
      ).body,
    ).type,
    1,
  );
  assert.equal((await http(setup.event("null"))).statusCode, 400);
  assert.equal((await http(setup.event("{"))).statusCode, 400);
});
test("router covers inline, deferred, component, modal and autocomplete responses", async () => {
  const setup = harness();
  const http = createHttp(setup.ports, fixtures);
  for (const [type, name, expected] of [
    [2, "fixture-fast", 4],
    [2, "fixture-slow", 5],
    [3, "fixture-component", 6],
    [5, "fixture-modal", 4],
    [3, "fixture-open-modal", 9],
    [4, "fixture-fast", 8],
  ] as const) {
    assert.equal(
      JSON.parse(
        (await http(setup.event(JSON.stringify(interaction(type, name))))).body,
      ).type,
      expected,
    );
  }
  assert.equal(
    JSON.parse(
      (await http(setup.event(JSON.stringify(interaction(2, "unknown"))))).body,
    ).data.content,
    "Unknown command",
  );
  assert.equal(commandDefinitions(fixtures).length, 2);
  setup.ports.invoke = async () => {
    throw new Error("Unavailable");
  };
  assert.equal(JSON.parse((await http(setup.event())).body).type, 4);
});
test("SSM and invoke deadlines cancel requests within the HTTP budget", async () => {
  for (const dependency of ["publicKey", "invoke"] as const) {
    const setup = harness();
    let signal: AbortSignal | undefined;
    setup.ports[dependency] = async (...args: unknown[]) => {
      signal = args.at(-1) as AbortSignal;
      return new Promise<never>(() => {});
    };
    const request = createHttp(setup.ports, fixtures)(setup.event());
    await flush();
    await setup.clock.advance(1000);
    assert.equal(
      (await request).statusCode,
      dependency === "publicKey" ? 503 : 200,
    );
    assert.equal(signal?.aborted, true);
  }
});
test("worker claims cooldown before work, edits completion and deduplicates", async () => {
  const setup = harness();
  const routes = fixtures.map((route) =>
    route.name === "fixture-slow"
      ? {
          ...route,
          handler: async () => {
            setup.calls.push("paid");
            return message("Completed");
          },
        }
      : route,
  );
  await setup.worker(routes);
  await setup.worker(routes);
  assert.deepEqual(setup.calls, [
    "interaction#synthetic-interaction",
    "user#synthetic-user#fixture-slow",
    "paid",
    "GET",
    "PATCH",
    "interaction#synthetic-interaction",
  ]);
  assert.deepEqual(setup.replies, [{ method: "PATCH", content: "Completed" }]);
});
test("cooldown denial and unavailable store prevent paid work", async () => {
  for (const down of [false, true]) {
    const setup = harness();
    const claim = setup.ports.claim;
    setup.ports.claim = async (key, ...rest) => {
      if (key.startsWith("user#")) {
        if (down) throw new Error("Down");
        return false;
      }
      return claim(key, ...rest);
    };
    await setup.worker([
      {
        ...fixtures[1],
        handler: async () => {
          setup.calls.push("paid");
          return message("Completed");
        },
      },
    ]);
    assert.ok(!setup.calls.includes("paid"));
    assert.equal(
      setup.replies[0]?.content,
      down ? "Request failed" : "Try again in 10 s",
    );
  }
});
test("worker waits for acknowledgement, then uses a follow-up when absent", async () => {
  for (const absent of [false, true]) {
    const setup = harness();
    const discord = setup.ports.discord;
    let gets = 0;
    setup.ports.discord = async (...args) =>
      args[1] === "GET" && (absent || gets++ === 0) ? 404 : discord(...args);
    const work = setup.worker();
    await flush();
    assert.equal(setup.replies.length, 0);
    await setup.clock.advance(absent ? 3000 : 250);
    await work;
    assert.equal(setup.replies[0]?.method, absent ? "POST" : "PATCH");
  }
});
test("watchdog aborts unfinished work and drops late completion", async () => {
  const setup = harness();
  let finish: (value: ReturnType<typeof message>) => void = () => {};
  let signal: AbortSignal | undefined;
  const work = setup.worker([
    {
      ...fixtures[1],
      handler: async (_interaction, requestSignal) => {
        signal = requestSignal;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    },
  ]);
  await flush();
  await setup.clock.advance(56_000);
  await work;
  assert.equal(signal?.aborted, true);
  finish(message("Late"));
  await flush();
  assert.deepEqual(setup.replies, [
    { method: "PATCH", content: "Request timed out" },
  ]);
});
test("completion racing watchdog and an already pending edit have one winner", async () => {
  for (const pendingEdit of [false, true]) {
    const setup = harness();
    let release: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const discord = setup.ports.discord;
    setup.ports.discord = async (...args) => {
      const status = await discord(...args);
      if (pendingEdit && args[1] === "PATCH") await ready;
      return status;
    };
    const routes = [
      {
        ...fixtures[1],
        handler: async () => {
          if (pendingEdit)
            await new Promise<void>((resolve) =>
              setup.clock.schedule(55_000, resolve),
            );
          else await ready;
          return message("Completed");
        },
      },
    ];
    const work = setup.worker(routes);
    await flush();
    if (pendingEdit) {
      await setup.clock.advance(56_000);
      assert.equal(setup.replies.length, 1);
      release();
    } else {
      await setup.clock.advance(56_000);
      release();
    }
    await work;
    await flush();
    assert.equal(setup.replies.length, 1);
    assert.equal(
      setup.replies[0].content,
      pendingEdit ? "Completed" : "Request timed out",
    );
  }
});
test("failed final edit reports an error without retrying", async () => {
  const setup = harness();
  const discord = setup.ports.discord;
  setup.ports.discord = async (...args) =>
    args[1] === "PATCH" ? 500 : discord(...args);
  await setup.worker();
  assert.equal(setup.calls.filter((call) => call === "reported").length, 1);
});
test("Discord client crosses real HTTP with cancellation and safe follow-ups", async () => {
  const { createServer } = await import("node:http");
  const server = createServer((request, response) => {
    request.resume();
    response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const client = discordClient(async (url, options) => {
      assert.match(String(url), /\?wait=true$/);
      const body = JSON.parse(String(options?.body));
      assert.equal(body.flags, 64);
      assert.deepEqual(body.allowed_mentions.parse, []);
      return fetch(`http://127.0.0.1:${address.port}`, options);
    });
    assert.equal(
      await client(
        interaction(),
        "POST",
        "Completed",
        new AbortController().signal,
        true,
      ),
      200,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
test("production bundle imports in isolation and excludes all fixture commands", () => {
  const directory = mkdtempSync(join(tmpdir(), "interactions-artifact-"));
  try {
    const bundle = readFileSync("build/interactions/index.mjs", "utf8");
    for (const fixture of fixtures) assert.ok(!bundle.includes(fixture.name));
    copyFileSync("build/interactions/index.mjs", join(directory, "index.mjs"));
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
