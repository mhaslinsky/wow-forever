import assert from "node:assert/strict";
import test from "node:test";
import { createPrincipalFactory } from "../src/auth/index.mts";
import { createDataAccess } from "../src/data/index.mts";
import { type GuildRecord, recordKey } from "../src/data/records.mts";
import {
  createRaidHelper,
  createSignUpPoller,
} from "../src/signups/poller.mts";

function fixture() {
  const items = new Map<string, GuildRecord>();
  const errors: string[] = [];
  let fail = false;
  let signUps = [
    { userId: "synthetic-user", className: "Mage", status: "primary" },
  ];
  const principal = createPrincipalFactory({
    guildId: "guild",
    memberRoleId: "member",
    officerRoleId: "officer",
    jobs: { poll: ["signup"] },
  });
  const data = createDataAccess({
    get: async (key) => items.get(key.sk),
    query: async () => ({ items: [...items.values()] }),
    batch: async () => [...items.values()],
    put: async (item) => {
      items.set(item.sk, item);
    },
  }).forSystem(principal.systemPrincipal("poll"));
  const api = createRaidHelper({
    guildId: "guild",
    apiKey: async () => "fake-key",
    http: async (input, init) => {
      if (fail) return new Response("unavailable", { status: 503 });
      const url = String(input);
      if (url.includes("/servers/")) {
        const page = Number((init?.headers as Record<string, string>).Page);
        return Response.json({
          pages: 2,
          currentPage: page,
          postedEvents: [{ id: `raid-${page}` }],
        });
      }
      return Response.json({
        id: url.split("/").at(-1),
        startTime: 1800000000,
        signUps,
      });
    },
  });
  return {
    data,
    errors,
    poll: createSignUpPoller({
      guildId: "guild",
      api,
      data,
      report: (code) => errors.push(code),
      now: () => 1800000000000,
    }),
    change: () => {
      signUps = [];
    },
    fail: () => {
      fail = true;
    },
  };
}
test("sign-up changes are stored per raid", async () => {
  const setup = fixture();
  assert.deepEqual(await setup.poll(), { raids: 2 });
  const before = await setup.data.get(recordKey("signup", "guild", "raid-1"));
  assert.ok(
    before[0].kind === "signup" && before[0].signUps.includes("synthetic-user"),
  );
  assert.equal(
    (await setup.data.get(recordKey("signup", "guild", "raid-2"))).length,
    1,
  );
  setup.change();
  await setup.poll();
  const [record] = await setup.data.get(recordKey("signup", "guild", "raid-1"));
  if (record.kind !== "signup") assert.fail("missing signup");
  assert.deepEqual(JSON.parse(record.signUps), []);
});
test("API failure keeps the last good record and reports the error", async () => {
  const setup = fixture();
  await setup.poll();
  const key = recordKey("signup", "guild", "raid-1");
  const previous = await setup.data.get(key);
  setup.fail();
  await assert.rejects(setup.poll(), /SIGNUP_POLL_FAILED/);
  assert.deepEqual(await setup.data.get(key), previous);
  assert.deepEqual(setup.errors, ["SIGNUP_POLL_FAILED"]);
});
