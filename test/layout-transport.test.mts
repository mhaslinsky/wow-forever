import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createServer, type RequestListener } from "node:http";
import { connect } from "node:net";
import { type TestContext, test } from "node:test";
import { inspect } from "node:util";
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import {
  discordTransport,
  fetchSnapshot,
  keychainToken,
  LayoutTransportError,
} from "../src/layout/transport.mts";

async function localHttp(context: TestContext, listener: RequestListener) {
  const server = createServer(listener);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const previous = getGlobalDispatcher();
  const agent = new Agent({
    connect(_options, callback) {
      const socket = connect(address.port, "127.0.0.1", () =>
        callback(null, socket),
      );
      socket.once("error", (error) => callback(error, null));
    },
  });
  setGlobalDispatcher(agent);
  context.after(async () => {
    setGlobalDispatcher(previous);
    await agent.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
}

test("Keychain token never enters argv or logs, including failed reads", (context) => {
  const token = "synthetic-keychain-secret";
  const logs: unknown[] = [];
  for (const method of ["log", "error", "warn", "info", "debug"] as const)
    context.mock.method(console, method, (...args: unknown[]) =>
      logs.push(args),
    );
  let output = ` ${token}\n`;
  let failRead = false;
  context.mock.method(childProcess, "execFileSync", (...args: unknown[]) => {
    assert.equal(args[0], "/usr/bin/security");
    assert.deepEqual(args[1], [
      "find-generic-password",
      "-s",
      "wow-forever-discord-operator-token",
      "-a",
      "wow-forever",
      "-w",
    ]);
    assert.deepEqual(args[2], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    });
    assert.equal(inspect(args).includes(token), false);
    if (failRead)
      throw Object.assign(new Error(token), {
        stdout: token,
        stderr: token,
        code: "ETIMEDOUT",
      });
    return output;
  });
  assert.equal(keychainToken(), token);
  for (const empty of ["", "  \n"]) {
    output = empty;
    assert.throws(
      keychainToken,
      (error: unknown) =>
        error instanceof LayoutTransportError && error.kind === "keychain",
    );
  }
  failRead = true;
  assert.throws(keychainToken, (error: unknown) => {
    assert.ok(error instanceof LayoutTransportError);
    assert.equal(error.kind, "keychain");
    assert.equal(inspect(error).includes(token), false);
    assert.equal(JSON.stringify(error).includes(token), false);
    return true;
  });
  assert.deepEqual(logs, []);
});

test("real REST client retains HTTP status and sanitizes undecodable failures", async (context) => {
  const token = "synthetic-http-secret";
  const cases = [
    [403, JSON.stringify({ code: 50013, message: token })],
    [403, "{"],
    [404, ""],
    [401, "null"],
  ] as const;
  let requests = 0;
  await localHttp(context, (request, response) => {
    assert.equal(request.headers.authorization, `Bot ${token}`);
    if (request.url?.endsWith("/network")) {
      request.socket.destroy();
      return;
    }
    const [status, body] = cases[requests++];
    response.writeHead(status, { "content-type": "application/json" });
    response.end(body);
  });
  for (const [status] of cases) {
    const transport = discordTransport(token);
    await assert.rejects(
      transport.request("POST", "/guilds/123/channels", { name: "private" }),
      (error: unknown) => {
        assert.ok(error instanceof LayoutTransportError);
        assert.equal(error.kind, "http");
        assert.equal(error.status, status);
        assert.equal(inspect(error).includes(token), false);
        assert.equal(JSON.stringify(error).includes(token), false);
        return true;
      },
    );
  }
  await assert.rejects(
    discordTransport(token).request("GET", "/network"),
    (error: unknown) =>
      error instanceof LayoutTransportError && error.kind === "network",
  );
  assert.equal(requests, cases.length);
});

test("POST rate limit rejects after exactly one real HTTP request", async (context) => {
  let requests = 0;
  await localHttp(context, (request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.headers.host, "discord.com");
    assert.equal(request.headers.authorization, "Bot synthetic-rate-token");
    assert.ok(request.url?.startsWith("/api/v10/"));
    requests++;
    response.writeHead(requests === 1 ? 429 : 200, {
      "content-type": "application/json",
      "retry-after": "0.001",
    });
    response.end(JSON.stringify(requests === 1 ? { retry_after: 0.001 } : {}));
  });
  for (const empty of ["", " "])
    assert.throws(() => discordTransport(empty), LayoutTransportError);
  const transport: ReturnType<typeof discordTransport> = Reflect.apply(
    discordTransport,
    undefined,
    [
      "synthetic-rate-token",
      {
        api: "https://wrong.invalid",
        authPrefix: "Bearer",
        makeRequest: () => {
          throw new Error("Unsafe override");
        },
        rejectOnRateLimit: () => false,
        retries: 1,
        version: "1",
      },
    ],
  );
  const error: unknown = await transport
    .request("POST", "/guilds/123/channels", { name: "private" })
    .then(
      () => undefined,
      (failure: unknown) => failure,
    );
  assert.equal(requests, 1);
  assert.ok(error instanceof LayoutTransportError);
  assert.equal(error.kind, "rate_limit");
  assert.equal(error.status, 429);
  assert.equal(error.retryAfterMs, 51);
});

test("snapshot refuses mismatched identities and missing inventories", async () => {
  for (const response of [{ id: "other" }, { id: "app" }]) {
    await assert.rejects(
      fetchSnapshot(
        { request: async () => response },
        { guildId: "guild", applicationId: "app" },
      ),
      (error: unknown) =>
        error instanceof LayoutTransportError && error.kind === "identity",
    );
  }
  await assert.rejects(
    fetchSnapshot(
      {
        request: async (_method, route) =>
          route === "/oauth2/applications/@me"
            ? { id: "app" }
            : route === "/guilds/guild"
              ? { id: "guild" }
              : undefined,
      },
      { guildId: "guild", applicationId: "app" },
    ),
    (error: unknown) =>
      error instanceof LayoutTransportError && error.kind === "snapshot",
  );
});

test("snapshot rejects missing channel lists and accepts explicit empty lists", async () => {
  for (const [type, permission_overwrites, available_tags, valid] of [
    [0, undefined, undefined, false],
    [15, [], undefined, false],
    [16, [], undefined, false],
    [0, [], undefined, true],
    [15, [], [], true],
    [16, [], [], true],
  ] as const) {
    const channel = {
      id: "channel",
      name: "channel",
      type,
      position: 0,
      permission_overwrites,
      available_tags,
    };
    const pending = fetchSnapshot(
      {
        request: async (_method, route) => {
          if (route === "/oauth2/applications/@me") return { id: "app" };
          if (route === "/guilds/guild") return { id: "guild" };
          return route.endsWith("/roles") ? [] : [channel];
        },
      },
      { guildId: "guild", applicationId: "app" },
    );
    if (valid) assert.equal((await pending).channels.length, 1);
    else
      await assert.rejects(
        pending,
        (error: unknown) =>
          error instanceof LayoutTransportError && error.kind === "snapshot",
      );
  }
});
