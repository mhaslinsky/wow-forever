import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createServer } from "node:http";
import { test } from "node:test";
import { inspect } from "node:util";
import {
  discordTransport,
  fetchSnapshot,
  keychainToken,
  LayoutTransportError,
} from "../src/layout/transport.mts";

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
    });
    assert.equal(inspect(args).includes(token), false);
    if (failRead)
      throw Object.assign(new Error(token), { stdout: token, stderr: token });
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

test("real REST client maps a token-bearing HTTP failure to a typed sanitized error", async (context) => {
  const token = "synthetic-http-secret";
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    assert.equal(request.headers.authorization, `Bot ${token}`);
    if (request.url?.endsWith("/network")) {
      request.socket.destroy();
      return;
    }
    response.writeHead(403, { "content-type": "application/json" });
    response.end(JSON.stringify({ code: 50013, message: token }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const transport = discordTransport(token, {
    api: `http://127.0.0.1:${address.port}`,
  });
  await assert.rejects(
    transport.request("POST", "/guilds/123/channels", { name: "private" }),
    (error: unknown) => {
      assert.ok(error instanceof LayoutTransportError);
      assert.equal(error.kind, "http");
      assert.equal(error.status, 403);
      assert.equal(inspect(error).includes(token), false);
      assert.equal(JSON.stringify(error).includes(token), false);
      return true;
    },
  );
  await assert.rejects(
    transport.request("GET", "/network"),
    (error: unknown) =>
      error instanceof LayoutTransportError && error.kind === "network",
  );
  assert.equal(requests, 2);
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
