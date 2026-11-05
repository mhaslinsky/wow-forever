import assert from "node:assert/strict";
import test from "node:test";
import type { ConverseCommandInput } from "@aws-sdk/client-bedrock-runtime";
import { PermissionFlagsBits as flags } from "discord.js";
import {
  createChannelContext,
  interactionHistoryChannel,
} from "../src/assistant/context.mts";
import {
  COOLDOWN,
  createAssistant,
  createConverse,
  createRouting,
  createSearch,
  NOT_VERIFIED,
  REFUSAL,
  SEARCH_UNAVAILABLE,
} from "../src/assistant/core.mts";
import { createAskRoutes } from "../src/assistant/interactions.mts";
import { assistantPrincipal } from "../src/assistant/runtime.mts";
import { createSpend, PAUSED } from "../src/assistant/spend.mts";
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
function setup(
  routing = JSON.stringify({
    needsGuild: true,
    needsWeb: false,
    searchQuery: "",
  }),
  spend?: ReturnType<typeof createSpend>,
) {
  const routingRequests: ConverseCommandInput[] = [];
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
      query: async (partition) => {
        assert.ok(["MEMBER#ALL", "CHARACTER#ALL"].includes(partition));
        return {
          items:
            partition === "MEMBER#ALL"
              ? [
                  member,
                  {
                    ...member,
                    ...recordKey("member", "other", "guild"),
                    ownerId: "other",
                    name: "Other member sentinel",
                    roster: [
                      { ...member.roster[0], name: "Other character sentinel" },
                    ],
                  },
                ]
              : [],
        };
      },
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
  const sendRoute: Parameters<typeof createRouting>[0] = async (command) => {
    routingRequests.push(command.input);
    return {
      $metadata: {},
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      metrics: { latencyMs: 0 },
      stopReason: "end_turn",
      output: { message: { role: "assistant", content: [{ text: routing }] } },
    };
  };
  const route = createRouting(spend ? spend.bedrock(sendRoute) : sendRoute);
  const sendAnswer: Parameters<typeof createConverse>[0] = async (command) => {
    requests.push(command.input);
    return {
      $metadata: {},
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      metrics: { latencyMs: 0 },
      stopReason: "end_turn",
      output: { message: { role: "assistant", content: [{ text: output }] } },
    };
  };
  const converse = createConverse(
    spend ? spend.bedrock(sendAnswer) : sendAnswer,
  );
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
    routingRequests,
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
      checkSpend: spend?.check ?? (async () => {}),
      data,
      guildId: "guild",
      search: spend ? spend.search(search) : search,
      converse,
      route,
      privateTerms: async () => ["Server sentinel", "Extra private sentinel"],
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
    assert.equal(await setupState.ask(current, "Question", signal), REFUSAL);
  }
  await assert.rejects(
    assistantPrincipal("guild", "asker", async () => []),
    /ROLE_MISSING_OR_AMBIGUOUS/,
  );
  for (const principal of [actor("visitor"), actor("member", "elsewhere")]) {
    assert.equal(await setupState.ask(principal, "Question", signal), REFUSAL);
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
      await permitted.ask(current, "My roster?", signal),
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
  await state.ask(actor("officer"), "My roster?", signal);
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
test("answers replace every em dash with a comma", async () => {
  const state = setup();
  state.output("One\u2014two \u2014 three -- four");
  assert.equal(
    await state.ask(actor("member"), "Question", signal),
    "One, two, three, four",
  );
});
test("answer prompt requires plain uncertainty and no em dashes", async () => {
  const state = setup();
  await state.ask(actor("member"), "What does FAD mean?", signal);
  const prompt = String(state.requests[0].system?.[0].text);
  assert.ok(
    prompt.includes(
      "When the context, guild records and web results do not settle the answer, say you are not sure in one short sentence and stop; never invent a meaning and then walk it back.",
    ),
  );
  assert.ok(prompt.includes("Never use em dashes."));
  assert.ok(
    prompt.includes(
      "Answer any question, WoW or not, and play along with jokes and banter; never turn down a harmless question as off-topic.",
    ),
  );
});
test("bracketed names link to Wowhead pages from evidence or a search", async () => {
  const state = setup();
  const quest =
    "https://www.wowhead.com/forever/quest=96393/old-ironforge-incursion";
  const ask = async (output: string) => {
    state.output(output);
    const records = await state.data
      .forUser(actor("member"))
      .get(recordKey("member", "asker", "guild"));
    const results = [
      {
        url: "https://example.com/q",
        title: "Q",
        excerpts: [`[Quest](${quest}) ${quest}%20extra`],
      },
    ];
    return state.converse(
      {
        actor: actor("member"),
        records,
        question: "Q",
        guildId: "guild",
        evidence: { status: "found", results },
      },
      signal,
    );
  };
  assert.equal(
    await ask(
      "Do [[Old Ironforge Incursion]] and [[Thom's (Heirlooms)]] https://evil.example/x",
    ),
    `Do [Old Ironforge Incursion](<${quest}>) and [Thom's Heirlooms](<https://www.wowhead.com/forever/search?q=Thom's%20Heirlooms>)\nSources: <https://example.com/q>`,
  );
  assert.equal(
    (
      await ask(
        "[[Deadmines\\]] ht[[ ]]tps://evil.example HTTPS://evil.example run --help",
      )
    ).split("\n")[0],
    "[Deadmines](<https://www.wowhead.com/forever/search?q=Deadmines>)   run --help",
  );
  await assert.rejects(ask("[[ ]] [[***]]"), /ASSISTANT_GENERATION_FAILED/);
  assert.match(
    await ask("ht[[ ]]tps://x.example/[[Old Ironforge]]"),
    /^\[Old Ironforge\]\(<.*search\?q=Old%20Ironforge>\)/,
  );
  const long = await ask("[[Old Ironforge Incursion]] ".repeat(60));
  assert.ok(
    !long.includes("](<") && long.startsWith("Old Ironforge Incursion Old"),
  );
});
test("answers cap evidence at three links without previews", async () => {
  const state = setup();
  state.output("Answer");
  const records = await state.data
    .forUser(actor("member"))
    .get(recordKey("member", "asker", "guild"));
  const answer = await state.converse(
    {
      actor: actor("member"),
      records,
      question: "Question",
      guildId: "guild",
      evidence: {
        status: "found",
        results: Array.from({ length: 5 }, (_, index) => ({
          url: `https://example.com/${index}`,
          title: "Source",
          excerpts: ["Evidence"],
        })),
      },
    },
    signal,
  );
  assert.equal(
    answer,
    "Answer\nSources: <https://example.com/0> <https://example.com/1> <https://example.com/2>",
  );
});
test("replies omit the persona header and warn only for digits without search results", async () => {
  for (const output of ["Hello!", "The value is 42."]) {
    const state = setup();
    state.output(output);
    const answer = await state.ask(actor("member"), "Question", signal);
    assert.equal(
      answer,
      output.includes("42") ? `${output}\n${NOT_VERIFIED}` : output,
    );
  }
});
test("unverifiable game numbers get a code-appended disclosure; missing or malformed roster stays empty", async () => {
  for (const record of [
    undefined,
    { malformed: true },
    { ...member, roster: [] },
  ]) {
    const state = setup();
    state.stored(record);
    state.output("The value is 42.");
    assert.ok(
      (await state.ask(actor("member"), "What is the value?", signal)).endsWith(
        `${NOT_VERIFIED}`,
      ),
    );
    assert.match(
      String(state.requests[0].system?.[0].text),
      /number absent from those results is not verified/,
    );
  }
  const state = setup();
  state.output("oversize ".repeat(300));
  const response = await state.ask(actor("member"), "Question", signal);
  assert.ok(response.length < 1900);
  assert.ok(!response.includes(NOT_VERIFIED));
  state.advance(60000);
  state.output("");
  await assert.rejects(
    state.ask(actor("member"), "Question", signal),
    /ASSISTANT_GENERATION_FAILED/,
  );
  assert.equal(await state.ask(actor("member"), "Question", signal), COOLDOWN);
});
test("game facts route to web with a public query; roster routes to guild without search", async () => {
  const state = setup(
    JSON.stringify({
      needsGuild: false,
      needsWeb: true,
      searchQuery: "WoW Mage release date",
    }),
  );
  const route = createAskRoutes((_interaction, question, abortSignal) =>
    state.ask(actor("member"), question, abortSignal),
  )[0];
  assert.deepEqual(
    route.options?.map((option) => (option as { name: string }).name),
    ["question"],
  );
  const answer = await route.handler(
    {
      id: "interaction",
      type: 2,
      application_id: "application",
      token: "synthetic",
      data: {
        options: [
          {
            name: "question",
            value: "Character sentinel asks: Mage release date?",
          },
        ],
      },
    },
    signal,
  );
  assert.equal(answer.type, 4);
  if (answer.type === 4) assert.equal(answer.data.flags, 64 | 4);
  assert.deepEqual(state.searches, [
    {
      search_queries: ["WoW Mage release date"],
      mode: "fast",
      max_chars_total: 12000,
    },
  ]);
  assert.doesNotMatch(JSON.stringify(state.searches), /sentinel/i);
  assert.doesNotMatch(
    JSON.stringify(state.requests[0].messages),
    /Your roster record|Fire Mage/,
  );
  assert.equal(state.routingRequests.length, 1);
  const guild = setup();
  await guild.ask(actor("member"), "My roster?", signal);
  assert.equal(guild.searches.length, 0);
  assert.match(
    JSON.stringify(guild.requests[0].messages),
    /Character sentinel/,
  );
});
test("private or invalid routed queries never reach Parallel", async () => {
  for (const searchQuery of [
    "Roster sentinel Mage",
    "character SENTINEL Mage",
    "<@123> Mage",
    "123456789012345678 Mage",
    "Mage ".repeat(41),
    "Server sentinel Mage",
    "Extra private sentinel Mage",
    ...[
      "officer",
      "officers",
      "guild bank",
      "kicked",
      "drama",
      "loot council",
      "recruit",
      "applicant",
      "trial",
      "roster",
      "attendance",
    ].map((term) => `Mage ${term.toUpperCase()}`),
  ]) {
    const state = setup(
      JSON.stringify({ needsGuild: true, needsWeb: true, searchQuery }),
    );
    await state.ask(actor("member"), "Mage changes for my roster?", signal);
    assert.equal(state.searches.length, 0, searchQuery);
    assert.equal(state.requests.length, 1);
  }
  for (const routing of [
    "not JSON",
    "null",
    '{"needsGuild":true,"needsWeb":"yes","searchQuery":"Mage"}',
    '{"needsGuild":true,"needsWeb":false,"searchQuery":"Mage"}',
    '{"needsGuild":true,"needsWeb":true,"searchQuery":"Mage","extra":true}',
  ]) {
    const state = setup(routing);
    await state.ask(actor("member"), "My roster?", signal);
    assert.equal(state.searches.length, 0, routing);
  }
});
test("another member's name is blocked before Parallel and roster names stay local", async () => {
  const state = setup(
    JSON.stringify({
      needsGuild: false,
      needsWeb: true,
      searchQuery: "Other member sentinel Mage",
    }),
  );
  await state.ask(actor("member"), "Mage changes?", signal);
  assert.equal(state.searches.length, 0);
  assert.doesNotMatch(
    JSON.stringify([...state.requests, ...state.routingRequests]),
    /Other member sentinel|Other character sentinel/,
  );
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
    state.output("The value is 42.");
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
    assert.match(answer, /Heads up, I couldn't verify any game numbers here\./);
    assert.ok(!answer.includes("Turn on web for a checked answer."));
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
    state.ask(actor("member"), "Question", signal),
    state.ask(actor("member"), "Question", signal),
  ]);
  assert.equal(answers.filter((answer) => answer === COOLDOWN).length, 1);
  assert.equal(state.requests.length, 1);
  state.advance(14999);
  assert.equal(await state.ask(actor("member"), "Question", signal), COOLDOWN);
  state.advance(1);
  await state.ask(actor("member"), "Question", signal);
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

const contextWord = "CHANNEL_ONLY_SENTINEL";
const history = [
  {
    author: { username: "Synthetic author" },
    content: contextWord,
    timestamp: new Date().toISOString(),
  },
];
const askPayload = {
  channel_id: "channel",
  member: {
    permissions: String(flags.ViewChannel | flags.ReadMessageHistory),
  },
};
test("channel context reaches Converse, never the router or actual Parallel body, and logs counts only", async (context) => {
  const logs: unknown[][] = [];
  context.mock.method(console, "log", (...values: unknown[]) =>
    logs.push(values),
  );
  const state = setup(
    '{"needsGuild":true,"needsWeb":true,"searchQuery":"WoW Mage specs"}',
  );
  const channelContext = createChannelContext(
    {
      clock,
      get: async (path) => {
        assert.equal(path, "/channels/channel/messages?limit=20");
        return history;
      },
    },
    interactionHistoryChannel(askPayload),
  );
  await state.ask(actor("member"), "What is FAD?", signal, channelContext);
  assert.match(JSON.stringify(state.requests), /CHANNEL_ONLY_SENTINEL/);
  assert.equal(state.routingRequests.length, 1);
  assert.doesNotMatch(
    JSON.stringify(state.routingRequests),
    /CHANNEL_ONLY_SENTINEL/,
  );
  assert.deepEqual(state.searches, [
    {
      search_queries: ["WoW Mage specs"],
      mode: "fast",
      max_chars_total: 12000,
    },
  ]);
  assert.doesNotMatch(
    JSON.stringify(logs),
    /CHANNEL_ONLY_SENTINEL|Synthetic author/,
  );
  assert.equal(JSON.parse(String(logs[0][0])).ChannelContextMessages, 1);
});

test("askers without history permission get no context; missing and malformed permissions fail closed", async () => {
  for (const permissions of [
    String(flags.ViewChannel),
    undefined,
    "invalid",
    1024,
  ]) {
    const state = setup();
    let historyReads = 0;
    const payload = {
      ...askPayload,
      member: { permissions },
    } as Interaction;
    const channelContext = createChannelContext(
      {
        clock,
        get: async () => {
          historyReads++;
          return history;
        },
        report: () => {},
      },
      interactionHistoryChannel(payload),
    );
    await state.ask(actor("member"), "Question", signal, channelContext);
    assert.equal(historyReads, 0);
    assert.equal(state.requests.length, 1);
    assert.doesNotMatch(JSON.stringify(state.requests), /Recent messages/);
  }
  assert.equal(
    interactionHistoryChannel({ ...askPayload, channel_id: undefined }),
    undefined,
  );
  assert.equal(
    interactionHistoryChannel({
      ...askPayload,
      member: { permissions: String(flags.Administrator) },
    }),
    "channel",
  );
});

test("channel context includes 3-hour-old messages and excludes 13-hour-old messages", async () => {
  let now = 0;
  const channelContext = createChannelContext(
    {
      clock: { ...clock, now: () => now },
      get: async () => [
        {
          author: { username: "Author" },
          content: "Recent",
          timestamp: new Date(0).toISOString(),
        },
        {
          author: { username: "Author" },
          content: "Old",
          timestamp: new Date(-10 * 60 * 60 * 1000).toISOString(),
        },
      ],
      report: () => {},
    },
    "channel",
  );
  now += 3 * 60 * 60 * 1000;
  assert.deepEqual(await channelContext(signal), [
    { author: "Author", content: "Recent" },
  ]);
});

test("stalled history times out on a stepped clock and answers without context", async () => {
  const state = setup();
  let expire: () => void = () => assert.fail("Deadline not scheduled");
  let child: AbortSignal | undefined;
  let start: () => void = () => assert.fail("Request not started");
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  const channelContext = createChannelContext(
    {
      clock: {
        now: () => 0,
        schedule: (milliseconds, callback) => {
          assert.equal(milliseconds, 3000);
          expire = callback;
          return () => {};
        },
      },
      get: async (_path, abortSignal) => {
        child = abortSignal;
        start();
        return new Promise(() => {});
      },
      report: (reason) => assert.equal(reason, "timeout"),
    },
    "channel",
  );
  const pending = state.ask(actor("member"), "FAD?", signal, channelContext);
  await started;
  expire();
  await pending;
  assert.equal(child?.aborted, true);
  assert.equal(state.requests.length, 1);
  assert.doesNotMatch(JSON.stringify(state.requests), /Recent messages/);
});

test("history fetch failure gives an answer without context", async () => {
  const state = setup();
  const channelContext = createChannelContext(
    {
      clock,
      get: async () => {
        throw new Error(contextWord);
      },
      report: (reason, count) =>
        assert.deepEqual([reason, count], ["fetch", 0]),
    },
    "channel",
  );
  await state.ask(actor("member"), "Question", signal, channelContext);
  assert.equal(state.requests.length, 1);
  assert.doesNotMatch(JSON.stringify(state.requests), /Recent messages/);
});

function spendState(limitUsd: number | undefined) {
  let now = Date.UTC(2026, 10, 30, 23, 59);
  const rows = new Map<string, Record<string, { N: string }>>();
  const errors: string[] = [];
  const totals: number[] = [];
  let notices = 0;
  let failure = "";
  const spend = createSpend({
    table: "claims",
    guildId: "guild",
    limitUsd,
    inputPerMillionUsd: 3,
    outputPerMillionUsd: 15,
    searchUsd: 0.001,
    now: () => now,
    report: (reason) => errors.push(reason),
    total: (usd) => totals.push(usd),
    notify: async () => {
      notices++;
    },
    send: async (command) => {
      const input = command.input;
      if (
        "UpdateExpression" in input &&
        input.UpdateExpression?.includes("ADD")
      ) {
        if (failure === "write") throw new Error("Unavailable");
        assert.equal(input.ReturnValues, "ALL_NEW");
        const pk = input.Key?.pk.S ?? assert.fail("Missing key");
        const row = rows.get(pk) ?? {};
        row.costUnits = {
          N: String(
            Number(row.costUnits?.N ?? 0) +
              Number(input.ExpressionAttributeValues?.[":cost"].N),
          ),
        };
        row.expiresAt = {
          N: input.ExpressionAttributeValues?.[":ttl"].N ?? "",
        };
        rows.set(pk, row);
        return { Attributes: row };
      }
      if ("UpdateExpression" in input) {
        const pk = input.Key?.pk.S ?? assert.fail("Missing key");
        const row = rows.get(pk) ?? {};
        if (Number(row.noticeUntilMs?.N ?? 0) > now)
          throw Object.assign(new Error("Claimed"), {
            name: "ConditionalCheckFailedException",
          });
        row.noticeUntilMs = {
          N: input.ExpressionAttributeValues?.[":lease"].N ?? "",
        };
        rows.set(pk, row);
        return {};
      }
      if ("Item" in input) {
        const pk = input.Item?.pk.S ?? assert.fail("Missing marker");
        assert.equal(input.ConditionExpression, "attribute_not_exists(pk)");
        rows.set(pk, {});
        return {};
      }
      assert.ok(
        "Key" in input && "ConsistentRead" in input && input.ConsistentRead,
      );
      if (failure === "read") throw new Error("Unavailable");
      return { Item: rows.get(input.Key?.pk.S ?? "") };
    },
  });
  return {
    spend,
    errors,
    totals,
    rows,
    notices: () => notices,
    fail: (value: string) => {
      failure = value;
    },
    nextMonth: () => {
      now = Date.UTC(2026, 11, 1);
    },
  };
}

test("monthly cap pauses concurrent asks before cooldown, router, search or answer and notifies once", async () => {
  const state = spendState(0.001);
  const assistant = setup(undefined, state.spend);
  state.rows.set("assistant-spend#guild#2026-11", {
    costUnits: { N: "1000000" },
  });
  const replies = await Promise.all([
    assistant.ask(actor("member"), "Question", signal),
    assistant.ask(actor("member"), "Question", signal),
  ]);
  assert.deepEqual(replies, [PAUSED, PAUSED]);
  assert.equal(state.notices(), 1);
  assert.equal(
    assistant.routingRequests.length +
      assistant.requests.length +
      assistant.searches.length,
    0,
  );
  state.nextMonth();
  assert.match(
    await assistant.ask(actor("member"), "Question", signal),
    /Character sentinel/,
  );
  assert.equal(assistant.requests.length, 1);
  assert.equal(
    state.rows.get("assistant-spend#guild#2026-12")?.costUnits.N,
    "36000",
  );
  assert.deepEqual(state.totals, [0.000018, 0.000036]);
  assert.equal(
    state.rows.get("assistant-spend#guild#2026-12")?.expiresAt.N,
    String(Date.UTC(2027, 0, 8) / 1000),
  );
});

test("the router, Parallel and answer are metered and recheck the cap between calls", async () => {
  const state = spendState(0.001);
  const assistant = setup(
    '{"needsGuild":false,"needsWeb":true,"searchQuery":"WoW Mage specs"}',
    state.spend,
  );
  assert.equal(
    await assistant.ask(actor("member"), "Mage specs?", signal),
    PAUSED,
  );
  assert.equal(assistant.routingRequests.length, 1);
  assert.equal(assistant.searches.length, 1);
  assert.equal(assistant.requests.length, 0);
  assert.deepEqual(state.totals, [0.000018, 0.001018]);
});

test("an unset limit still meters and answers above the former threshold", async () => {
  const state = spendState(undefined);
  state.rows.set("assistant-spend#guild#2026-11", {
    costUnits: { N: "21000000000" },
  });
  const assistant = setup(undefined, state.spend);
  assert.match(
    await assistant.ask(actor("member"), "Question", signal),
    /Character sentinel/,
  );
  assert.equal(state.notices(), 0);
  assert.deepEqual(state.totals, [21.000018, 21.000036]);
  state.fail("write");
  assistant.advance(15000);
  assert.match(
    await assistant.ask(actor("member"), "Question", signal),
    /Character sentinel/,
  );
  assert.deepEqual(state.errors, ["write", "write"]);
});

test("enforced counter read and write failures refuse and emit errors", async () => {
  for (const mode of ["read", "write"]) {
    const state = spendState(0.001);
    state.fail(mode);
    const assistant = setup(undefined, state.spend);
    assert.equal(
      await assistant.ask(actor("member"), "Question", signal),
      "Couldn't come up with an answer, try again in a bit.",
    );
    assert.equal(assistant.requests.length, 0);
    assert.deepEqual(state.errors, [mode]);
  }
});
