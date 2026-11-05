import assert from "node:assert/strict";
import test from "node:test";
import { createChannelContext } from "../src/assistant/context.mts";
import { COOLDOWN, createAssistant } from "../src/assistant/core.mts";
import { createForgetRoutes } from "../src/assistant/interactions.mts";
import { createMemoryReplies } from "../src/assistant/memory-replies.mts";
import { createPrincipalFactory } from "../src/auth/index.mts";
import { createDataAccess } from "../src/data/index.mts";
import type { GuildRecord } from "../src/data/records.mts";
import { discordClient } from "../src/interactions/index.mts";

test("only explicit remember requests persist; forget removes all facts from later grounding", async () => {
  let now = 1000;
  let lateFact: GuildRecord | undefined;
  let forgetDuringAnswer = false;
  let forgetOnWrite = false;
  const rows = new Map<string, GuildRecord>();
  const data = createDataAccess({
    get: async (key) =>
      rows.get(key.sk)?.pk === key.pk ? rows.get(key.sk) : undefined,
    batch: async () => [],
    query: async (partition) => ({
      items: [...rows.values()].filter((row) => row.pk === partition),
    }),
    put: async (item, condition) => {
      if (
        forgetOnWrite &&
        item.kind === "fact" &&
        item.createdAt !== undefined
      ) {
        rows.set("FACT#forget", {
          ...item,
          sk: "FACT#forget",
          kind: "fact",
          text: "Forget cutoff",
          forgetAt: ++now,
        });
        forgetOnWrite = false;
      }
      if (condition?.memoryCutoff !== undefined) {
        const marker = rows.get("FACT#forget");
        if (
          (marker?.kind === "fact" ? (marker.forgetAt ?? 0) : 0) !==
          condition.memoryCutoff
        )
          throw Object.assign(new Error("cutoff changed"), {
            name: "ConditionalCheckFailedException",
          });
      }
      rows.set(item.sk, item);
    },
    removeFact: async (item) => {
      rows.delete(item.sk);
      if (lateFact) rows.set(lateFact.sk, lateFact);
    },
  });
  const factory = createPrincipalFactory({
    guildId: "guild",
    memberRoleId: "member",
    officerRoleId: "officer",
    jobs: {},
  });
  const actor = factory.fromVerifiedInteraction({
    guild_id: "guild",
    member: { user: { id: "synthetic" }, roles: ["member"] },
  });
  const prompts: string[] = [];
  const answer = createAssistant({
    data,
    now: () => now,
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
      prompts.push(
        JSON.stringify({ facts: input.facts, context: input.context }),
      );
      if (forgetDuringAnswer) await data.forUser(actor).forgetFacts(++now);
      return input.facts?.length ? "healing advice" : "Okay.";
    },
  });
  const signal = new AbortController().signal;
  for (const question of ["Remember:", "Please remember", "Remember that"]) {
    assert.equal(
      await answer(actor, question, signal),
      "Tell me what to remember.",
    );
    assert.equal(rows.size, 0);
    assert.equal(prompts.length, 0);
  }
  await answer(actor, "I play a healer", signal);
  await answer(actor, "Remember that I prefer healing", signal);
  await answer(actor, "Please remember: I raid on weekends", signal);
  assert.equal(rows.size, 2);
  await answer(actor, "What should I play?", signal);
  assert.match(String(prompts.at(-1)), /I prefer healing/);
  const memory = createMemoryReplies(data, () => now);
  const replyText = await answer(
    actor,
    "What should I play?",
    signal,
    undefined,
    undefined,
    () => memory.mark("synthetic", "source-A", 60000),
  );
  await discordClient(async () => Response.json({ id: "answer-A" }), memory)(
    {
      id: "source-A",
      application_id: "app",
      token: "synthetic",
      type: 2,
      data: { name: "ask" },
      member: { user: { id: "synthetic" } },
    },
    "POST",
    replyText,
    signal,
    true,
  );
  const other = factory.fromVerifiedInteraction({
    guild_id: "guild",
    member: { user: { id: "other" }, roles: ["member"] },
  });
  const otherHistory = createChannelContext(
    {
      clock: { now: () => now, schedule: () => () => {} },
      report: () => {},
      hiddenMessage: memory.hidden,
      get: async () => [
        {
          id: "answer-A",
          content: replyText,
          author: { id: "bot", username: "AutoGM", bot: true },
          timestamp: new Date(now).toISOString(),
          referenced_message: { author: { id: "synthetic" } },
        },
      ],
    },
    "channel",
  );
  await answer(other, "What should I play?", signal, otherHistory);
  assert.doesNotMatch(String(prompts.at(-1)), /healing/);
  const routes = createForgetRoutes(async () => {
    await data.forUser(actor).forgetFacts(++now);
    return "Forgot everything you asked me to remember.";
  });
  lateFact = {
    ...[...rows.values()][0],
    sk: "FACT#late",
    kind: "fact",
    createdAt: now,
    text: "late healing",
  } as GuildRecord;
  await routes[0].handler(
    { id: "request", application_id: "app", token: "synthetic", type: 2 },
    signal,
  );
  const history = createChannelContext(
    {
      clock: { now: () => now, schedule: () => () => {} },
      report: () => {},
      get: async () => [
        {
          author: { id: "synthetic", username: "Member" },
          content: "Remember healing",
          timestamp: new Date(1000).toISOString(),
        },
        {
          author: { id: "bot", username: "AutoGM", bot: true },
          content: "Remembered.",
          timestamp: new Date(1000).toISOString(),
        },
        {
          author: { id: "synthetic", username: "Member" },
          content: "old healing",
          timestamp: new Date(1000).toISOString(),
        },
        {
          author: { id: "bot", username: "AutoGM", bot: true },
          content: "healing advice",
          timestamp: new Date(1000).toISOString(),
          referenced_message: { author: { id: "synthetic" } },
        },
      ],
    },
    "channel",
  );
  assert.deepEqual(
    await history(signal).then((messages) =>
      messages.map((entry) => entry.content),
    ),
    ["old healing", "healing advice"],
  );
  await answer(actor, "What should I play?", signal, history);
  assert.doesNotMatch(String(prompts.at(-1)), /healing|weekends/);
  forgetDuringAnswer = true;
  assert.equal(await answer(actor, "What should I play?", signal), COOLDOWN);
  forgetDuringAnswer = false;
  now++;
  forgetOnWrite = true;
  assert.equal(await answer(actor, "Remember racing fact", signal), COOLDOWN);
  assert.ok(
    ![...rows.values()].some(
      (row) => row.kind === "fact" && row.text === "racing fact",
    ),
  );
});
