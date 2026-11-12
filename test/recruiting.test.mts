import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";
import {
  GuildAuditLogsEntry as AuditEntry,
  Client,
  Collection,
  type ForumChannel,
  type Guild,
} from "discord.js";
import fc from "fast-check";
import {
  createPrincipalFactory,
  createSystemPrincipal,
} from "../src/auth/index.mts";
import { applicationRecord } from "../src/data/gow-applications.mts";
import { createDataAccess, type StoragePort } from "../src/data/index.mts";
import type { GuildRecord } from "../src/data/records.mts";
import { decode, recordKey } from "../src/data/records.mts";
import { SOURCES, STAGES } from "../src/data/recruiting.mts";
import { mapApplications } from "../src/gow-intake/mapping.mts";
import type { RecruitingFailure } from "../src/recruiting/alarm.mts";
import {
  type Candidate,
  type CreateCandidateInput,
  createRecruiting,
  type ForumPort,
} from "../src/recruiting/core.mts";
import {
  checkRecruitingAuditAccess,
  discordForum,
  recruitingHandlers,
} from "../src/recruiting/discord.mts";

const threadId = "THREAD_ID";
function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((ready) => {
    resolve = ready;
  });
  return { promise, resolve };
}

async function seed(
  setup: ReturnType<typeof fixture>,
  source: (typeof SOURCES)[number] = "Apply form",
) {
  return setup.core.create({ name: "Synthetic", source, actorId: "officer" });
}

function fixture(
  accepted: (candidate: Candidate) => Promise<void> = async () => {},
  guildId = "guild",
) {
  const items = new Map<string, GuildRecord>();
  const failures: RecruitingFailure[] = [];
  let failWrites: GuildRecord["kind"] | undefined;
  const storage: StoragePort = {
    get: async (key) => items.get(`${key.pk}/${key.sk}`),
    query: async () => ({ items: [...items.values()] }),
    batch: async () => [],
    removeNote: async (item) => {
      items.delete(`${item.pk}/${item.sk}`);
    },
    put: async (item, condition) => {
      if (failWrites === item.kind) throw new Error("storage unavailable");
      const previous = items.get(`${item.pk}/${item.sk}`);
      const released = condition?.releasedIntake;
      const intake = released && items.get(`${released.pk}/${released.sk}`);
      if (
        (condition?.absent && previous) ||
        (condition?.candidatePrevious &&
          !isDeepStrictEqual(previous, condition.candidatePrevious)) ||
        (released &&
          (intake?.kind !== "recruitingIntake" ||
            intake.state !== "released" ||
            intake.attemptId !== released.attemptId)) ||
        (condition?.intake &&
          (previous?.kind !== "recruitingIntake" ||
            previous.state !== condition.intake.state ||
            previous.attemptId !== condition.intake.attemptId ||
            (condition.intake.noticeSent !== undefined &&
              previous.noticeSent !== condition.intake.noticeSent)))
      )
        throw Object.assign(new Error("condition failed"), {
          name: "ConditionalCheckFailedException",
        });
      items.set(`${item.pk}/${item.sk}`, item);
    },
    removeIntake: async (item) => {
      items.delete(`${item.pk}/${item.sk}`);
    },
  };
  const data = createDataAccess(storage);
  const tags = [...STAGES, ...SOURCES].map((name) => ({
    name,
    id: `TAG_${name.toUpperCase()}_ID`,
  }));
  let applied: string[] = [];
  let created = 0;
  const posts: string[] = [];
  const notices: string[] = [];
  const port: ForumPort = {
    tags: async () => tags,
    create: async (input) => {
      created++;
      applied = input.tags;
      return created === 1 ? threadId : `${threadId}-${created}`;
    },
    post: async (_threadId, content) => {
      posts.push(content);
    },
    tagsFor: async () => applied,
    setTags: async (_threadId, next) => {
      applied = next;
    },
  };
  const actor = createPrincipalFactory({
    guildId,
    memberRoleId: "member",
    officerRoleId: "officer",
    jobs: {},
  }).fromVerifiedInteraction({
    guild_id: guildId,
    member: { user: { id: "officer" }, roles: ["officer"] },
  });
  const principal = createSystemPrincipal([
    "candidate",
    "officerNote",
    "recruitingIntake",
  ]);
  const core = createRecruiting(
    data,
    principal,
    guildId,
    port,
    (failure) => failures.push(failure),
    accepted,
    async (content) => {
      notices.push(content);
    },
  );
  return {
    core,
    actor,
    failures,
    failWrites: (kind?: GuildRecord["kind"]) => {
      failWrites = kind;
    },
    data,
    storage,
    principal,
    items,
    tags,
    port,
    applied: () => applied,
    created: () => created,
    posts,
    notices,
  };
}

test("new candidate creates one thread with the New tag", async () => {
  const setup = fixture();
  await seed(setup, "Officer lead");
  assert.equal(setup.created(), 1);
  assert.deepEqual(setup.applied(), ["TAG_NEW_ID", "TAG_OFFICER LEAD_ID"]);
});

test("candidate or note write failure resumes one thread before dedupe", async () => {
  for (const kind of ["candidate", "officerNote"] as const) {
    const setup = fixture();
    setup.failWrites(kind);
    await assert.rejects(seed(setup), /CANDIDATE_SAVE_FAILED/);
    setup.failWrites();
    const record = await seed(setup);
    assert.equal((await seed(setup)).sk, record.sk);
    assert.equal(setup.created(), 1);
    assert.deepEqual(setup.posts, []);
    assert.equal(
      [...setup.items.values()].filter((item) => item.kind === "officerNote")
        .length,
      1,
    );
    const intake = [...setup.items.values()].find(
      (item) => item.kind === "recruitingIntake",
    );
    assert.equal(intake?.state, "done");
    assert.equal(intake?.payload, undefined);
  }
});

test("concurrent intake insert has one creator and a retryable loser", async () => {
  const setup = fixture();
  const entered = deferred();
  const release = deferred();
  const create = setup.port.create;
  setup.port.create = async (input) => {
    entered.resolve();
    await release.promise;
    return create(input);
  };
  const first = seed(setup);
  await entered.promise;
  await assert.rejects(seed(setup), /CANDIDATE_INTAKE_IN_PROGRESS/);
  release.resolve();
  await first;
  assert.equal(setup.created(), 1);
});

test("expired pending blocks once without another forum create", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: 1_900_000_000_000 });
  const setup = fixture();
  const entered = deferred();
  const release = deferred();
  setup.port.create = async () => {
    entered.resolve();
    await release.promise;
    return threadId;
  };
  const first = seed(setup);
  await entered.promise;
  context.mock.timers.tick(360_000);
  await assert.rejects(seed(setup), /CANDIDATE_INTAKE_BLOCKED/);
  release.resolve();
  await assert.rejects(first, /CANDIDATE_INTAKE_BLOCKED/);
  await assert.rejects(seed(setup), /CANDIDATE_INTAKE_BLOCKED/);
  assert.equal(setup.notices.length, 1);
  assert.equal(setup.created(), 0);
  assert.match(
    setup.notices[0],
    /Recruiting intake for Synthetic \(Apply form\) is on hold, ref [a-f0-9]{64}\. Check #recruiting for a thread with that ref before re-adding them\./,
  );
});

test("4xx releases the intake; unknown outcomes block and retry unsent notices", async () => {
  for (const status of [400, 500, undefined]) {
    const setup = fixture();
    const create = setup.port.create;
    setup.port.create = async () => {
      throw Object.assign(new Error("Discord failed"), { status });
    };
    await assert.rejects(seed(setup), /Discord failed/);
    setup.port.create = create;
    if (status === 400) {
      await seed(setup);
      assert.equal(setup.created(), 1);
    } else {
      const failing = createRecruiting(
        setup.data,
        setup.principal,
        "guild",
        setup.port,
        () => {},
        undefined,
        async () => {
          throw new Error("alert unavailable");
        },
      );
      await assert.rejects(
        failing.create({
          name: "Synthetic",
          source: "Apply form",
          actorId: "officer",
        }),
        /alert unavailable/,
      );
      await assert.rejects(seed(setup), /CANDIDATE_INTAKE_BLOCKED/);
      await assert.rejects(seed(setup), /CANDIDATE_INTAKE_BLOCKED/);
      assert.equal(setup.notices.length, 1);
      assert.equal(setup.created(), 0);
    }
  }
});

test("intake reservation failure makes no forum call", async () => {
  const setup = fixture();
  setup.failWrites("recruitingIntake");
  await assert.rejects(seed(setup), /DATA_UNAVAILABLE/);
  assert.equal(setup.created(), 0);
});

test("created replay preserves officer edits and retention", async () => {
  for (const retained of [false, true]) {
    const setup = fixture();
    setup.failWrites("candidate");
    await assert.rejects(seed(setup), /CANDIDATE_SAVE_FAILED/);
    setup.failWrites();
    const record: Candidate = {
      pk: "CANDIDATE#guild",
      sk: `CANDIDATE#${threadId}`,
      kind: "candidate",
      ownerId: "guild",
      name: "Officer edit",
      ...(retained
        ? {
            retention: {
              outcome: "Declined",
              threadId,
              archived: true,
            } as const,
          }
        : {}),
    };
    setup.items.set(`${record.pk}/${record.sk}`, record);
    if (retained) await assert.rejects(seed(setup), /CANDIDATE_SAVE_FAILED/);
    else assert.equal((await seed(setup)).name, "Officer edit");
    const completed = await setup.core.candidate(threadId);
    if (retained) assert.deepEqual(completed, record);
    else {
      assert.equal(completed?.name, record.name);
      assert.equal(completed?.recruiting?.threadId, threadId);
    }
    assert.equal(setup.created(), 1);
    assert.deepEqual(setup.posts, []);
  }
});

test("officer tag change updates the stored stage with actor", async (context) => {
  const setup = fixture();
  await seed(setup, "Officer lead");
  const roles = new Collection(
    ["Member", "Officer", "GM", "@everyone"].map((name) => [
      name,
      { id: name, name },
    ]),
  );
  const forum = {
    id: "forum",
    name: "recruiting",
    type: 15,
    permissionsFor: () => ({ has: () => false }),
    fetch: async () => ({ availableTags: setup.tags }),
    threads: {
      fetch: async () => ({
        parentId: "forum",
        appliedTags: setup.applied(),
        setAppliedTags: setup.port.setTags.bind(null, threadId),
      }),
    },
  };
  const thread = { id: threadId, parent: forum, isThread: () => true };
  const guild = {
    id: "guild",
    client: new Client({ intents: [] }),
    roles: { everyone: roles.get("@everyone"), fetch: async () => roles },
    channels: {
      cache: new Collection([[threadId, thread]]),
      fetch: async (id?: string) =>
        id ? thread : new Collection([["forum", forum]]),
    },
    members: {
      fetch: async () => ({
        id: "ACTOR_USER_ID",
        roles: { cache: new Collection([["GM", {}]]) },
      }),
    },
  } as unknown as Guild;
  const sample = JSON.parse(
    readFileSync(
      new URL("./fixtures/recruiting-audit.json", import.meta.url),
      "utf8",
    ),
  );
  await setup.port.setTags(
    threadId,
    sample.changes[0].new_value,
    setup.applied(),
  );
  sample.id = ((BigInt(Date.now()) - 1420070400000n) << 22n).toString();
  const entry = Reflect.construct(AuditEntry, [guild, sample]) as AuditEntry;
  const handler = recruitingHandlers(
    { user: { id: "bot" } } as Client,
    setup.data,
    setup.principal,
    "guild",
  ).guildAuditLogEntryCreate;
  assert.ok(handler);
  await handler(entry, guild);
  const candidate = await setup.core.candidate(threadId);
  assert.equal(candidate?.recruiting?.stage, "Interview");
  assert.equal(candidate?.recruiting?.changedBy, "ACTOR_USER_ID");
  const later = (raw: Record<string, unknown>, offset: number) =>
    Reflect.construct(AuditEntry, [
      guild,
      {
        ...raw,
        user_id: "ACTOR_USER_ID",
        target_id: threadId,
        id: ((BigInt(Date.now() + offset) - 1420070400000n) << 22n).toString(),
      },
    ]) as AuditEntry;
  const swap = ["TAG_INTERVIEW_ID", "TAG_TRIAL_ID"];
  await setup.port.setTags(threadId, swap, setup.applied());
  await handler(
    later(
      {
        action_type: 111,
        changes: [
          {
            key: "applied_tags",
            old_value: ["TAG_INTERVIEW_ID"],
            new_value: swap,
          },
        ],
      },
      1000,
    ),
    guild,
  );
  assert.equal(
    (await setup.core.candidate(threadId))?.recruiting?.stage,
    "Trial",
  );
  assert.deepEqual(setup.applied(), ["TAG_TRIAL_ID"]);
  const healthyRoles = guild.roles.fetch;
  Object.assign(guild.roles, {
    fetch: async () => {
      throw new Error("roles unavailable");
    },
  });
  await handler(later({ action_type: 112, changes: [] }, 2000), guild);
  Object.assign(guild.roles, { fetch: healthyRoles });
  assert.equal(
    (await setup.core.candidate(threadId))?.recruiting?.stage,
    "Withdrawn",
  );
  setup.items.clear();
  const errorLog = context.mock.method(console, "error", () => {});
  await assert.rejects(handler(entry, guild), /CANDIDATE_NOT_FOUND:THREAD_ID/);
  const alarm = JSON.parse(String(errorLog.mock.calls[0].arguments[0]));
  assert.equal(alarm.threadId, threadId);
  assert.equal(alarm.RecruitingError, 1);
  assert.deepEqual(alarm._aws.CloudWatchMetrics[0].Dimensions, [[]]);
  await checkRecruitingAuditAccess(guild);
  assert.equal(
    JSON.parse(String(errorLog.mock.calls[1].arguments[0])).code,
    "RECRUITING_AUDIT_UNAVAILABLE",
  );
  errorLog.mock.restore();
});

test("bot stage change updates the tag", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.constantFrom(...STAGES), { minLength: 1, maxLength: 12 }),
      async (stages) => {
        const setup = fixture();
        await seed(setup);
        for (const [index, stage] of stages.entries()) {
          await setup.core.setStage(threadId, stage, "bot", `event-${index}`);
          assert.equal(
            (await setup.core.candidate(threadId))?.recruiting?.stage,
            stage,
          );
          assert.deepEqual(
            new Set(setup.applied()),
            new Set(["TAG_APPLY FORM_ID", `TAG_${stage.toUpperCase()}_ID`]),
          );
        }
      },
    ),
    { numRuns: 20 },
  );
});

test("stage failures alarm after candidate-first persistence", async () => {
  for (const kind of ["candidate", "officerNote", "tags"] as const) {
    const setup = fixture();
    await seed(setup);
    if (kind === "tags")
      setup.port.setTags = async () => {
        throw new Error("Discord unavailable");
      };
    else setup.failWrites(kind);
    await assert.rejects(
      setup.core.setStage(threadId, "Trial", "bot", "change"),
      /CANDIDATE_SAVE_FAILED:THREAD_ID/,
    );
    assert.equal(
      (await setup.core.candidate(threadId))?.recruiting?.stage,
      kind === "candidate" ? "New" : "Trial",
    );
    assert.equal(setup.failures[0]?.code, "CANDIDATE_SAVE_FAILED");
  }
});

test("old audit corrections preserve the current officer edit", async () => {
  const setup = fixture();
  await seed(setup);
  await setup.port.setTags(
    threadId,
    ["TAG_TRIAL_ID", "TAG_APPLY FORM_ID", "TAG_OFFICER LEAD_ID"],
    setup.applied(),
  );
  const reconcile = (
    tags: readonly string[],
    at = "2099-01-01T00:00:00.000Z",
  ) =>
    setup.core.officerTags({
      threadId,
      actor: setup.actor,
      eventId: at,
      at,
      tags,
    });
  await reconcile([]);
  assert.ok(setup.applied().includes("TAG_TRIAL_ID"));
  await reconcile([...setup.applied()]);
  assert.equal(
    (await setup.core.candidate(threadId))?.recruiting?.stage,
    "Trial",
  );
  assert.deepEqual(setup.applied(), [
    "TAG_TRIAL_ID",
    "TAG_APPLY FORM_ID",
    "TAG_OFFICER LEAD_ID",
  ]);
  setup.port.setTags = async () => assert.fail("Old event wrote tags");
  await reconcile([], "2098-01-01T00:00:00.000Z");
});

test("concurrent correction keeps the newer edit through the Discord adapter", async () => {
  const setup = fixture();
  await seed(setup);
  const trial = ["TAG_TRIAL_ID", "TAG_APPLY FORM_ID"];
  let current = ["TAG_NEW_ID", "TAG_INTERVIEW_ID"];
  let reads = 0;
  let writes = 0;
  const forum = {
    id: "forum",
    fetch: async () => ({ availableTags: setup.tags }),
    threads: {
      fetch: async () => {
        if (++reads === 2) current = [...trial];
        return {
          parentId: "forum",
          appliedTags: [...current],
          setAppliedTags: async (tags: string[]) => {
            writes++;
            current = tags;
          },
        };
      },
    },
  } as unknown as ForumChannel;
  Object.assign(setup.port, discordForum(forum));
  const edit = (tags: string[], at: string, added?: string[]) =>
    setup.core.officerTags({
      threadId,
      tags,
      added,
      actor: setup.actor,
      eventId: at,
      at,
    });
  await edit(["TAG_NEW_ID", "TAG_INTERVIEW_ID"], "2099-01-01T00:00:00.000Z", [
    "TAG_INTERVIEW_ID",
  ]);
  assert.deepEqual(current, trial);
  await edit(trial, "2099-01-02T00:00:00.000Z");
  assert.equal(
    (await setup.core.candidate(threadId))?.recruiting?.stage,
    "Trial",
  );
  assert.equal(writes, 0);
});

test("officer stage swaps follow the added tag and never fight the officer", async () => {
  const setup = fixture();
  await seed(setup);
  let at = Date.parse("2099-01-01T00:00:00.000Z");
  const click = async (next: string[]) => {
    const previous = setup.applied();
    await setup.port.setTags(threadId, next, previous);
    const stamp = new Date(at++).toISOString();
    await setup.core.officerTags({
      threadId,
      tags: next,
      added: next.filter((tag) => !previous.includes(tag)),
      actor: setup.actor,
      eventId: stamp,
      at: stamp,
    });
  };
  const stage = async () =>
    (await setup.core.candidate(threadId))?.recruiting?.stage;
  await click(["TAG_APPLY FORM_ID", "TAG_NEW_ID", "TAG_CONTACTED_ID"]);
  assert.equal(await stage(), "Contacted");
  assert.deepEqual(setup.applied(), ["TAG_APPLY FORM_ID", "TAG_CONTACTED_ID"]);
  await click(["TAG_APPLY FORM_ID"]);
  await click([]);
  assert.deepEqual(setup.applied(), []);
  assert.equal(await stage(), "Contacted");
  await click(["TAG_TRIAL_ID"]);
  assert.equal(await stage(), "Trial");
  assert.deepEqual(setup.applied(), ["TAG_TRIAL_ID"]);
});

test("deleting an open candidate's thread withdraws it once", async () => {
  const setup = fixture();
  await seed(setup);
  const remove = (eventId: string) =>
    setup.core.threadDeleted({
      threadId,
      actorId: "officer",
      eventId,
      at: "2099-01-01T00:00:00.000Z",
    });
  await remove("delete");
  const candidate = await setup.core.candidate(threadId);
  assert.equal(candidate?.recruiting?.stage, "Withdrawn");
  assert.equal(candidate?.recruiting?.changedBy, "officer");
  await remove("again");
  await setup.core.threadDeleted({
    threadId: "OTHER_THREAD_ID",
    actorId: "officer",
    eventId: "unrelated",
    at: "2099-01-01T00:00:00.000Z",
  });
  const notes = [...setup.items.values()].filter(
    (item) => item.kind === "officerNote" && item.sk.includes("#delete"),
  );
  assert.equal(notes.length, 1);
  assert.equal(
    [...setup.items.values()].filter(
      (item) => item.sk.includes("#again") || item.sk.includes("#unrelated"),
    ).length,
    0,
  );
  const closed = fixture();
  await seed(closed);
  await closed.core.setStage(threadId, "Declined", "officer", "decline");
  await closed.core.threadDeleted({
    threadId,
    actorId: "officer",
    eventId: "closed",
    at: "2099-01-01T00:00:00.000Z",
  });
  assert.equal(
    (await closed.core.candidate(threadId))?.recruiting?.stage,
    "Declined",
  );
});

test("failed acceptance preserves stage, restores tags and accepts on retry", async () => {
  for (const newerEdit of [false, true]) {
    let attempts = 0;
    const setup = fixture(async () => {
      if (++attempts > 1) return;
      if (newerEdit) await setup.port.setTags(threadId, ["TAG_TRIAL_ID"], []);
      throw new Error("ROSTER_SAVE_FAILED");
    });
    await seed(setup);
    const tags = ["TAG_ACCEPTED_ID", "TAG_APPLY FORM_ID"];
    await setup.port.setTags(threadId, tags, []);
    await assert.rejects(
      setup.core.officerTags({
        threadId,
        tags,
        actor: setup.actor,
        eventId: "failed-acceptance",
        at: new Date().toISOString(),
      }),
      /CANDIDATE_SAVE_FAILED/,
    );
    assert.equal(
      (await setup.core.candidate(threadId))?.recruiting?.stage,
      "New",
    );
    assert.deepEqual(
      setup.applied(),
      newerEdit ? ["TAG_TRIAL_ID"] : ["TAG_APPLY FORM_ID", "TAG_NEW_ID"],
    );
    await setup.core.setStage(threadId, "Accepted", "officer", "retry");
    assert.equal(attempts, 2);
  }
});

for (const [behaviour, name, discordUserId, count] of [
  ["same Discord account merges", "Othermain", "applicant", 1],
  ["same character name from two sources merges", " synthetic ", undefined, 1],
  ["different people stay separate", "Different", "other", 2],
] as const) {
  test(behaviour, async () => {
    const setup = fixture();
    await setup.core.create({
      name: "Synthetic",
      discordUserId: "applicant",
      source: "Apply form",
      actorId: "applicant",
    });
    const input = {
      name,
      discordUserId,
      source: "Officer lead" as const,
      actorId: "officer",
      content: "New details",
    };
    await setup.core.create(input);
    if (count === 1) await setup.core.create(input);
    assert.equal(setup.created(), count);
    assert.deepEqual(
      setup.posts,
      count === 1 ? ["Applied again through Officer lead:\nNew details"] : [],
    );
  });
}

test("Discord identity separates namesakes and wins over a name match", async () => {
  const setup = fixture();
  const intake = {
    name: "Synthetic",
    source: "Apply form" as const,
    actorId: "actor",
  };
  await setup.core.create({ ...intake, name: "Alias" });
  const first = await setup.core.create({
    ...intake,
    discordUserId: "account-a",
  });
  const second = await setup.core.create({
    ...intake,
    discordUserId: "account-b",
  });
  assert.notEqual(second.sk, first.sk);
  const repeated = await setup.core.create({
    ...intake,
    discordUserId: "account-b",
    name: "Alias",
    content: "Updated",
  });
  assert.equal(repeated.sk, second.sk);
  assert.equal(setup.created(), 3);
});

test("failed repeat post is reposted on retry", async () => {
  const setup = fixture();
  await seed(setup);
  let posts = 0;
  setup.port.post = async () => {
    if (++posts === 1) throw new Error("post failed");
  };
  await assert.rejects(seed(setup, "Officer lead"));
  await seed(setup, "Officer lead");
  assert.equal(posts, 2);
});

const adoptedLink = "https://discord.com/channels/1/2";
async function blockedFixture(
  input: CreateCandidateInput = {
    name: "Synthetic",
    source: "Apply form" as const,
    actorId: "officer",
  },
) {
  const setup = fixture(undefined, "1");
  const create = setup.port.create;
  setup.port.create = async () => {
    throw new Error("uncertain");
  };
  await assert.rejects(setup.core.create(input), /uncertain/);
  await assert.rejects(setup.core.create(input), /CANDIDATE_INTAKE_BLOCKED/);
  setup.port.create = create;
  setup.port.verifyIntake = async () => {};
  const state = () =>
    [...setup.items.values()].find((item) => item.kind === "recruitingIntake");
  const original = state();
  assert.ok(original?.kind === "recruitingIntake");
  return {
    ...setup,
    input,
    state,
    original,
    resolve: (thread?: string) =>
      setup.core.resolveIntake(setup.actor, {
        ref: original.ref,
        ...(thread ? { thread } : { release: true }),
      }),
  };
}

test("adoption resumes completion, preserves edits, refuses retention and clears payload", async () => {
  for (const mismatched of [false, true]) {
    const setup = await blockedFixture();
    setup.failWrites("candidate");
    await assert.rejects(setup.resolve(adoptedLink), /CANDIDATE_SAVE_FAILED/);
    assert.equal(setup.state()?.state, "created");
    setup.failWrites();
    const edited: Candidate = {
      ...recordKey("candidate", "1", "2"),
      kind: "candidate",
      ownerId: "1",
      name: "Officer edit",
      ...(mismatched
        ? {
            recruiting: {
              threadId: "3",
              stage: "Trial" as const,
              source: "Apply form" as const,
              changedBy: "officer",
              changedAt: "2030-01-01T00:00:00Z",
            },
          }
        : {}),
    };
    setup.items.set(`${edited.pk}/${edited.sk}`, edited);
    assert.equal(await setup.resolve(adoptedLink), "adopted");
    const completed = setup.state();
    assert.equal(decode(completed)?.kind, "recruitingIntake");
    assert.equal(completed?.payload, undefined);
    assert.equal(await setup.resolve(adoptedLink), "adopted");
    await assert.rejects(
      setup.resolve("https://discord.com/channels/1/3"),
      /ALREADY_RESOLVED/,
    );
    const adopted = await setup.core.candidate("2");
    assert.equal(adopted?.name, edited.name);
    assert.equal(adopted?.recruiting?.threadId, "2");
    assert.equal(adopted?.recruiting?.stage, mismatched ? "Trial" : "New");
    assert.equal(setup.items.size, 3);
    assert.equal(setup.created(), 0);
    assert.deepEqual(setup.posts, []);
    const retained = {
      ...edited,
      retention: {
        outcome: "Declined" as const,
        threadId: "2",
        archived: true,
      },
    };
    setup.items.set(`${edited.pk}/${edited.sk}`, retained);
    await assert.rejects(setup.resolve(adoptedLink), /CANDIDATE_RETAINED/);
    assert.deepEqual(setup.state(), completed);
  }
});

test("a release generation has one create winner and rejects stale payload writes", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: 1_900_000_000_000 });
  const setup = await blockedFixture();
  assert.equal(await setup.resolve(), "released");
  const released = setup.state();
  assert.equal(released?.payload, undefined);
  assert.ok(decode(released));
  assert.equal(
    decode({ ...released, payload: setup.original.payload }),
    undefined,
  );
  await assert.rejects(
    setup.data.forSystem(setup.principal).transitionIntake(setup.original, {
      state: "blocked",
      attemptId: setup.original.attemptId,
      noticeSent: true,
    }),
    /WRITE_CONFLICT/,
  );
  context.mock.timers.tick(900_000);
  const ready = deferred(),
    claim = deferred(),
    entered = deferred(),
    finish = deferred();
  const tags = setup.port.tags;
  let arrived = 0,
    creates = 0;
  setup.port.tags = async () => {
    if (++arrived === 2) ready.resolve();
    await claim.promise;
    return tags();
  };
  setup.port.create = async () => {
    creates++;
    if (creates > 1) return "duplicate";
    entered.resolve();
    await finish.promise;
    return "fresh";
  };
  const outcomes = [
    setup.core.create(setup.input),
    setup.core.create(setup.input),
  ].map(async (operation) => {
    try {
      return await operation;
    } catch (error) {
      return error;
    }
  });
  await ready.promise;
  claim.resolve();
  await entered.promise;
  assert.match(String(await Promise.race(outcomes)), /IN_PROGRESS/);
  finish.resolve();
  assert.equal(
    (await Promise.all(outcomes)).filter((result) => !(result instanceof Error))
      .length,
    1,
  );
  assert.equal(creates, 1);
  assert.equal(setup.state()?.payload, undefined);
  assert.ok(decode(setup.state()));
});

test("competing decisions cannot act on a later blocked generation", async () => {
  const setup = await blockedFixture();
  const entered = deferred(),
    finish = deferred();
  setup.port.verifyIntake = async () => {
    entered.resolve();
    await finish.promise;
  };
  const adoption = setup.resolve(adoptedLink);
  await entered.promise;
  await setup.resolve();
  let attempts = 0;
  setup.port.create = async () => {
    attempts++;
    throw Object.assign(new Error("rejected"), { status: 400 });
  };
  await assert.rejects(setup.core.create(setup.input), /BLOCKED/);
  const blocked = setup.state();
  finish.resolve();
  await assert.rejects(adoption, /BLOCKED/);
  for (let retry = 0; retry < 3; retry++)
    await assert.rejects(setup.core.create(setup.input), /BLOCKED/);
  assert.equal(attempts, 1);
  assert.deepEqual(setup.state(), blocked);
  assert.equal(blocked?.outcome, "rejected");
  await setup.resolve();
  await assert.rejects(setup.core.create(setup.input), /BLOCKED/);
  assert.equal(attempts, 2);
});

test("GoW resolved paths map once, while rejected attempts and real failures still alarm", async () => {
  for (const adopt of [true, false]) {
    const payload = {
      id: 101,
      character: { name: "Synthetic", className: "Mage" },
      selectedRolesText: "Damage",
      message: "Application",
    };
    const input = {
      name: "Synthetic",
      source: "Guilds of WoW",
      actorId: "gow-intake",
      submissionId: "101",
      content: "Class: Mage\nRole: Damage\n\nApplication",
    } as const;
    const setup = await blockedFixture(input);
    const records = setup.data.forSystem(
      createSystemPrincipal([
        "gowApplication",
        "candidate",
        "officerNote",
        "recruitingIntake",
      ]),
    );
    const raw = applicationRecord("1", payload);
    await records.write(raw);
    const mapping = {
      guildId: "1",
      records,
      create: setup.core.create,
      report: () => {},
    };
    await assert.rejects(mapApplications(mapping), /MAPPING_FAILED/);
    if (adopt) await setup.resolve(adoptedLink);
    else {
      await setup.resolve();
      let attempts = 0;
      setup.port.create = async () => {
        attempts++;
        throw Object.assign(new Error("rejected"), { status: 400 });
      };
      for (let poll = 0; poll < 3; poll++)
        await assert.rejects(mapApplications(mapping), /MAPPING_FAILED/);
      assert.equal(attempts, 1);
      await setup.resolve();
      setup.port.create = async () => "fresh";
    }
    assert.deepEqual(await mapApplications(mapping), { mapped: 1 });
    assert.deepEqual(await mapApplications(mapping), { mapped: 0 });
    const [stored] = await records.get(raw);
    assert.ok(stored.kind === "gowApplication");
    assert.equal(stored.mappedThreadId, adopt ? "2" : "fresh");
    assert.equal(stored.payload, raw.payload);
    await records.write(raw);
    await assert.rejects(
      mapApplications({
        ...mapping,
        create: async () => {
          throw new Error("real failure");
        },
      }),
      /MAPPING_FAILED/,
    );
  }
});

test("release dedupe consumes the grant on both submission-note paths", async () => {
  for (const previousNote of [false, true]) {
    const setup = await blockedFixture();
    const existing = await setup.core.create({
      ...setup.input,
      source: "Officer lead",
    });
    if (previousNote) {
      await setup.data.forSystem(setup.principal).insert(
        {
          ...recordKey(
            "officerNote",
            "1",
            `${threadId}#submission#${setup.original.ref}`,
          ),
          kind: "officerNote",
          ownerId: "1",
          text: "Previous submission",
        },
        threadId,
      );
    }
    await setup.resolve();
    assert.equal((await setup.core.create(setup.input)).sk, existing.sk);
    assert.equal(setup.state()?.state, "done");
    assert.equal(setup.state()?.payload, undefined);
    assert.equal(setup.created(), 1);
  }
});

test("released retry refuses a stale candidate write and recovers after a failed post", async () => {
  const setup = await blockedFixture();
  await setup.core.create({ ...setup.input, source: "Officer lead" });
  await setup.resolve();
  const entered = deferred(),
    resume = deferred();
  const put = setup.storage.put;
  let pause = true;
  setup.storage.put = async (item, condition) => {
    if (item.kind === "candidate" && pause) {
      pause = false;
      entered.resolve();
      await resume.promise;
    }
    await put(item, condition);
  };
  const stale = setup.core.create(setup.input).catch((error: unknown) => error);
  await entered.promise;
  await setup.core.setFollowUp(threadId, setup.actor, {
    owner: "edited-owner",
  });
  resume.resolve();
  const result = await stale;
  assert.equal(
    (await setup.core.candidate(threadId))?.recruiting?.owner,
    "edited-owner",
  );
  assert.ok(result instanceof Error && /WRITE_CONFLICT/.test(result.message));
  assert.equal(setup.state()?.state, "released");
  const post = setup.port.post;
  setup.port.post = async () => {
    throw new Error("post failed");
  };
  await assert.rejects(setup.core.create(setup.input), /SAVE_FAILED/);
  assert.equal(setup.state()?.state, "released");
  setup.port.post = post;
  await setup.core.create(setup.input);
  assert.equal(setup.state()?.state, "done");
  assert.equal(
    (await setup.core.candidate(threadId))?.recruiting?.owner,
    "edited-owner",
  );
});

test("supplied-thread verifier checks authenticated ownership and the final starter ref", async () => {
  const setup = await blockedFixture();
  const ref = setup.original.ref;
  const thread = {
    type: 11,
    guildId: "1",
    parentId: "forum",
    ownerId: "bot",
    fetchStarterMessage: async () => ({
      author: { id: "bot" },
      content: `Application\n-# ref ${ref} \n`,
    }),
  };
  const forum = {
    id: "forum",
    guild: { id: "1" },
    client: {
      rest: {
        get: async (path: string) => {
          assert.equal(path, "/users/@me");
          return { id: "bot" };
        },
      },
    },
    threads: {
      fetch: async (threadId: string) => (threadId === "2" ? thread : null),
    },
  };
  const verify = discordForum(forum as unknown as ForumChannel).verifyIntake;
  assert.ok(verify);
  setup.port.verifyIntake = verify;
  await assert.rejects(
    setup.resolve("https://discord.com/channels/1/2/3"),
    /VERIFICATION_FAILED/,
  );
  assert.deepEqual(setup.state(), setup.original);
  for (const changed of [
    { ownerId: "other" },
    { parentId: "elsewhere" },
    { guildId: "other" },
    { type: 12 },
    { fetchStarterMessage: async () => null },
    {
      fetchStarterMessage: async () => ({
        author: { id: "bot" },
        content: `Application\n-# ref ${"b".repeat(64)}`,
      }),
    },
    {
      fetchStarterMessage: async () => ({
        author: { id: "other" },
        content: `Application\n-# ref ${ref}`,
      }),
    },
    {
      fetchStarterMessage: async () => ({
        author: { id: "bot" },
        content: `Application\n-# ref ${ref}\nMore text`,
      }),
    },
  ]) {
    const snapshot = { ...thread };
    Object.assign(thread, changed);
    await assert.rejects(setup.resolve(adoptedLink), /VERIFICATION_FAILED/);
    assert.deepEqual(setup.state(), setup.original);
    Object.assign(thread, snapshot);
  }
  assert.equal(await setup.resolve(adoptedLink), "adopted");
});
