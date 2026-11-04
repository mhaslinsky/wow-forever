import assert from "node:assert/strict";
import test from "node:test";
import type { ConverseCommandInput } from "@aws-sdk/client-bedrock-runtime";
import {
  COOLDOWN,
  createAssistant,
  createConverse,
  createSearch,
  NOT_VERIFIED,
  REFUSAL,
  SEARCH_UNAVAILABLE,
} from "../src/assistant/core.mts";
import { createAskRoutes } from "../src/assistant/interactions.mts";
import { assistantPrincipal } from "../src/assistant/runtime.mts";
import {
  createPrincipalFactory,
  createSystemPrincipal,
  type Principal,
  type UserResult,
} from "../src/auth/index.mts";
import { createDataAccess } from "../src/data/index.mts";
import { type GuildRecord, recordKey } from "../src/data/records.mts";
import { clock, type Interaction } from "../src/interactions/core.mts";
import { assistantClaim } from "../src/interactions/index.mts";

const signal = new AbortController().signal;
const factory = createPrincipalFactory({
  guildId: "guild",
  memberRoleId: "member",
  officerRoleId: "officer",
  officerRoleIds: ["gm"],
  jobs: {},
});
const actor = (role: string, guild = "guild") =>
  factory.fromVerifiedInteraction({
    guild_id: guild,
    member: { user: { id: "asker" }, roles: [role] },
  });
const member = {
  ...recordKey("member", "asker", "guild"),
  kind: "member",
  ownerId: "asker",
  name: "Roster sentinel",
  roster: [
    {
      name: "Character sentinel",
      class: "Mage",
      spec: "Fire",
      raidRole: "Damage",
      main: true,
      confirmed: true,
    },
  ],
} as const;
function setup() {
  const requests: ConverseCommandInput[] = [];
  const searches: unknown[] = [];
  let stored: unknown = member;
  let output = "Your roster lists Character sentinel as a Fire Mage.";
  let now = 1000;
  let until = 0;
  const data = createDataAccess(
    {
      get: async (key) => {
        assert.deepEqual(key, recordKey("member", "asker", "guild"));
        return stored;
      },
      query: async () => assert.fail("Unexpected query"),
      batch: async () => assert.fail("Unexpected batch"),
      put: async () => assert.fail("Unexpected write"),
    },
    () => {},
  );
  const search = createSearch({
    clock,
    secret: async () => "synthetic-key",
    http: async (_url, options) => {
      searches.push(JSON.parse(String(options?.body)));
      return Response.json({
        results: [
          {
            url: "https://example.com/patch",
            title: "Patch",
            excerpts: ["No requested number here."],
          },
        ],
      });
    },
  });
  const converse = createConverse(async (command) => {
    requests.push(command.input);
    return {
      $metadata: {},
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      metrics: { latencyMs: 0 },
      stopReason: "end_turn",
      output: { message: { role: "assistant", content: [{ text: output }] } },
    };
  });
  const claim = assistantClaim(
    "claims",
    () => now,
    async (command) => {
      assert.equal(
        command.input.ConditionExpression,
        "attribute_not_exists(pk) OR cooldownUntilMs <= :now",
      );
      assert.equal(command.input.Item?.pk.S, "assistant#guild#asker");
      const requestedNow = Number(
        command.input.ExpressionAttributeValues?.[":now"].N,
      );
      if (until > requestedNow)
        throw Object.assign(new Error("Conditional failure"), {
          name: "ConditionalCheckFailedException",
        });
      until = Number(command.input.Item?.cooldownUntilMs.N);
    },
  );
  return {
    requests,
    searches,
    data,
    converse,
    stored: (record: unknown) => {
      stored = record;
    },
    output: (text: string) => {
      output = text;
    },
    advance: (value: number) => {
      now += value;
    },
    ask: createAssistant({
      data,
      guildId: "guild",
      search,
      converse,
      claim: (userId, abortSignal) => claim("guild", userId, abortSignal),
    }),
  };
}
test("non-member refuses without search or inference; Member, Officer and GM pass", async () => {
  const setupState = setup();
  const roles = ["Member", "Officer", "GM"].map((name) => ({
    name,
    id: name.toLowerCase(),
  }));
  for (const member of [
    { user: { id: "asker" }, roles: [] },
    undefined,
    { user: { id: "other" }, roles: ["member"] },
  ]) {
    const current = await assistantPrincipal("guild", "asker", async (path) =>
      path.endsWith("/roles") ? roles : member,
    );
    assert.equal(
      await setupState.ask(current, "Question", true, signal),
      REFUSAL,
    );
  }
  await assert.rejects(
    assistantPrincipal("guild", "asker", async () => []),
    /ROLE_MISSING_OR_AMBIGUOUS/,
  );
  for (const principal of [actor("visitor"), actor("member", "elsewhere")]) {
    assert.equal(
      await setupState.ask(principal, "Question", true, signal),
      REFUSAL,
    );
  }
  assert.equal(setupState.requests.length, 0);
  assert.equal(setupState.searches.length, 0);
  for (const role of ["member", "officer", "gm"]) {
    const permitted = setup();
    const current = await assistantPrincipal("guild", "asker", async (path) =>
      path.endsWith("/roles")
        ? roles
        : { user: { id: "asker" }, roles: [role] },
    );
    assert.match(
      await permitted.ask(current, "My roster?", false, signal),
      /Character sentinel/,
    );
    assert.equal(permitted.requests.length, 1);
  }
});
test("Officer Converse request contains only selected own-roster fields (C1)", async () => {
  const state = setup();
  state.stored({
    ...member,
    unfiltered: "UNFILTERED_SENTINEL",
    officerNote: "OFFICER_SENTINEL",
    roster: member.roster.map((character) => ({
      ...character,
      system: "SYSTEM_SENTINEL",
    })),
  });
  await state.ask(actor("officer"), "My roster?", false, signal);
  const outgoing = JSON.stringify(state.requests[0]);
  assert.match(outgoing, /Character sentinel/);
  assert.doesNotMatch(
    outgoing,
    /UNFILTERED_SENTINEL|OFFICER_SENTINEL|SYSTEM_SENTINEL/,
  );
  assert.equal(state.requests[0].modelId, "us.anthropic.claude-sonnet-4-6");
  assert.deepEqual(state.requests[0].additionalModelRequestFields, {
    output_config: { effort: "low" },
  });
  const records = await state.data
    .forUser(actor("officer"))
    .get(recordKey("member", "asker", "guild"));
  const input = {
    actor: actor("officer"),
    records,
    question: "My roster?",
    evidence: { status: "skipped" } as const,
    guildId: "guild",
  };
  for (const record of [
    {
      ...member,
      ...recordKey("member", "other", "guild"),
      ownerId: "other",
      name: "OTHER_OWNER_SENTINEL",
    },
    {
      ...recordKey("officerNote", "asker", "guild"),
      ownerId: "asker",
      kind: "officerNote",
      text: "OFFICER_SENTINEL",
    },
  ]) {
    await assert.rejects(
      state.converse(
        { ...input, records: [record] as unknown as UserResult<GuildRecord> },
        signal,
      ),
      /INVALID_ASSISTANT_RECORD/,
    );
  }
  await assert.rejects(
    state.converse(
      {
        ...input,
        actor: createSystemPrincipal([]) as unknown as Principal<"user">,
      },
      signal,
    ),
    /INVALID_ASSISTANT_PRINCIPAL/,
  );
  assert.equal(state.requests.length, 1);
});
test("unverifiable game numbers get a code-appended disclosure; missing or malformed roster stays empty", async () => {
  for (const record of [
    undefined,
    { malformed: true },
    { ...member, roster: [] },
  ]) {
    const state = setup();
    state.stored(record);
    state.output("The value is not verified.");
    assert.ok(
      (
        await state.ask(actor("member"), "What is the value?", false, signal)
      ).endsWith(NOT_VERIFIED),
    );
    assert.match(
      String(state.requests[0].system?.[0].text),
      /number absent from those results is not verified/,
    );
  }
  const state = setup();
  state.output("oversize ".repeat(300));
  const response = await state.ask(actor("member"), "Question", false, signal);
  assert.ok(response.length < 1900);
  assert.ok(response.endsWith(NOT_VERIFIED));
  state.advance(60000);
  state.output("");
  await assert.rejects(
    state.ask(actor("member"), "Question", false, signal),
    /ASSISTANT_GENERATION_FAILED/,
  );
  assert.equal(
    await state.ask(actor("member"), "Question", false, signal),
    COOLDOWN,
  );
});
test("web defaults false with zero Parallel requests; opt-in sends only question text", async () => {
  const state = setup();
  const route = createAskRoutes((_interaction, question, web, abortSignal) =>
    state.ask(actor("member"), question, web, abortSignal),
  )[0];
  const interaction: Interaction = {
    id: "interaction",
    type: 2,
    application_id: "application",
    token: "synthetic",
    data: { options: [{ name: "question", value: "Current patch?" }] },
  };
  const answer = await route.handler(interaction, signal);
  assert.equal(route.visibility, "ephemeral");
  assert.equal(route.mode, "slow");
  assert.equal(state.searches.length, 0);
  assert.equal(answer.type, 4);
  if (answer.type === 4) assert.equal(answer.data.flags, 64);
  state.advance(60000);
  await state.ask(actor("member"), "<@123> Current patch?", true, signal);
  assert.deepEqual(state.searches, [
    {
      search_queries: ["Current patch?"],
      mode: "fast",
      max_chars_total: 12000,
    },
  ]);
  assert.doesNotMatch(JSON.stringify(state.searches), /sentinel/);
});
test("search failures and empty results disclose unverified numbers; deadline covers body parsing", async () => {
  for (const http of [
    async () => new Response(null, { status: 401 }),
    async () => Response.json({ invalid: true }),
    async () => Response.json({ results: [] }),
  ]) {
    const evidence = await createSearch({
      clock,
      secret: async () => "synthetic",
      http,
    })("Question", signal);
    const state = setup();
    const records = await state.data
      .forUser(actor("member"))
      .get(recordKey("member", "asker", "guild"));
    const answer = await state.converse(
      {
        actor: actor("member"),
        records,
        question: "Question",
        evidence,
        guildId: "guild",
      },
      signal,
    );
    assert.match(answer, /Game numbers are not verified/);
    if (evidence.status === "unavailable")
      assert.ok(answer.includes(SEARCH_UNAVAILABLE));
  }
  let expire: (() => void) | undefined;
  let bodyStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    bodyStarted = resolve;
  });
  const search = createSearch({
    clock: {
      now: () => 0,
      schedule: (milliseconds, callback) => {
        assert.equal(milliseconds, 8000);
        expire = callback;
        return () => {};
      },
    },
    secret: async () => "synthetic",
    http: async () =>
      ({
        ok: true,
        json: () => {
          bodyStarted?.();
          return new Promise(() => {});
        },
      }) as unknown as Response,
  });
  const pending = search("Question", signal);
  await started;
  assert.ok(expire);
  expire();
  assert.equal((await pending).status, "unavailable");
});
test("cooldown admits one concurrent question and permits the exact expiry boundary", async () => {
  const state = setup();
  const answers = await Promise.all([
    state.ask(actor("member"), "Question", false, signal),
    state.ask(actor("member"), "Question", false, signal),
  ]);
  assert.equal(answers.filter((answer) => answer === COOLDOWN).length, 1);
  assert.equal(state.requests.length, 1);
  state.advance(59999);
  assert.equal(
    await state.ask(actor("member"), "Question", false, signal),
    COOLDOWN,
  );
  state.advance(1);
  await state.ask(actor("member"), "Question", false, signal);
  assert.equal(state.requests.length, 2);
  const broken = assistantClaim(
    "claims",
    () => 0,
    async () => {
      throw new Error("Unavailable");
    },
  );
  await assert.rejects(broken("guild", "asker", signal), /Claims unavailable/);
});
