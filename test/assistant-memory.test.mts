import assert from "node:assert/strict";
import test from "node:test";
import { createAssistant } from "../src/assistant/core.mts";
import { createForgetRoutes } from "../src/assistant/interactions.mts";
import { createPrincipalFactory } from "../src/auth/index.mts";
import { createDataAccess } from "../src/data/index.mts";
import type { GuildRecord } from "../src/data/records.mts";

test("only explicit remember requests persist; forget removes all facts from later grounding", async () => {
  const rows = new Map<string, GuildRecord>();
  const data = createDataAccess({
    get: async () => undefined,
    batch: async () => [],
    query: async (partition) => ({
      items: [...rows.values()].filter((row) => row.pk === partition),
    }),
    put: async (item) => void rows.set(item.sk, item),
    removeFact: async (item) => void rows.delete(item.sk),
  });
  const actor = createPrincipalFactory({
    guildId: "guild",
    memberRoleId: "member",
    officerRoleId: "officer",
    jobs: {},
  }).fromVerifiedInteraction({
    guild_id: "guild",
    member: { user: { id: "synthetic" }, roles: ["member"] },
  });
  const prompts: string[] = [];
  const answer = createAssistant({
    data,
    guildId: "guild",
    checkSpend: async () => {},
    claim: async () => true,
    route: async () => ({
      needsGuild: false,
      needsWeb: false,
      searchQuery: "",
    }),
    privateTerms: async () => [],
    search: async () => ({ status: "skipped" }),
    converse: async (input) => {
      prompts.push(JSON.stringify(input.facts));
      return "Okay.";
    },
  });
  const signal = new AbortController().signal;
  await answer(actor, "I play a healer", signal);
  assert.equal(rows.size, 0);
  await answer(actor, "Remember that I prefer healing", signal);
  await answer(actor, "Please remember: I raid on weekends", signal);
  assert.equal(rows.size, 2);
  await answer(actor, "What should I play?", signal);
  assert.match(String(prompts.at(-1)), /I prefer healing/);
  const routes = createForgetRoutes(async () => {
    await data.forUser(actor).forgetFacts();
    return "Forgot your saved facts.";
  });
  await routes[0].handler(
    { id: "request", application_id: "app", token: "synthetic", type: 2 },
    signal,
  );
  await answer(actor, "What should I play?", signal);
  assert.doesNotMatch(String(prompts.at(-1)), /healing|weekends/);
});
