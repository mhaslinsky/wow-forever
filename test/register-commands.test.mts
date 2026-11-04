import assert from "node:assert/strict";
import { test } from "node:test";
import { registerCommands } from "../scripts/register-commands.mts";
import * as router from "../src/interactions/core.mts";

const command: router.Route = {
  type: 2,
  name: "sample",
  description: "Sample command",
  mode: "fast",
  visibility: "ephemeral",
  handler: async () => router.message("Done"),
};
const routes: router.Route[] = [command, { ...command, type: 3 }];
const config = {
  application: "100",
  guild: "200",
  tokenParameter: "/test/token",
};
const payloads: unknown[] = [];
const ports = {
  secret: async () => "synthetic-token",
  async replace(token: string, path: string, body: unknown) {
    assert.equal(token, "synthetic-token");
    assert.equal(path, "/applications/100/guilds/200/commands");
    payloads.push(body);
    return body;
  },
};
test("registration payload matches the router's command list", async () => {
  assert.equal(await registerCommands(config, ports, routes), 1);
  assert.deepEqual(payloads.at(-1), router.commandDefinitions(routes));
});
test("rerun with no changes sends an identical payload", async () => {
  await registerCommands(config, ports, routes);
  const first = JSON.stringify(payloads.at(-1));
  await registerCommands(config, ports, routes);
  assert.equal(JSON.stringify(payloads.at(-1)), first);
});
test("empty registry refuses before any request", async () => {
  const unexpected = async () => assert.fail("Unexpected request");
  await assert.rejects(
    registerCommands(config, { secret: unexpected, replace: unexpected }, []),
    { message: "No commands to register" },
  );
});
