import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
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
import { createDataAccess } from "../src/data/index.mts";
import type { GuildRecord } from "../src/data/records.mts";
import { SOURCES, STAGES } from "../src/data/recruiting.mts";
import type { RecruitingFailure } from "../src/recruiting/alarm.mts";
import {
  type Candidate,
  createRecruiting,
  type ForumPort,
} from "../src/recruiting/core.mts";
import {
  checkRecruitingAuditAccess,
  discordForum,
  recruitingHandlers,
} from "../src/recruiting/discord.mts";

const threadId = "THREAD_ID";

async function seed(
  setup: ReturnType<typeof fixture>,
  source: (typeof SOURCES)[number] = "Apply form",
) {
  return setup.core.create({ name: "Synthetic", source, actorId: "officer" });
}

function fixture(
  accepted: (candidate: Candidate) => Promise<void> = async () => {},
) {
  const items = new Map<string, GuildRecord>();
  const failures: RecruitingFailure[] = [];
  let failWrites: GuildRecord["kind"] | undefined;
  const data = createDataAccess({
    get: async (key) => items.get(`${key.pk}/${key.sk}`),
    query: async () => ({ items: [...items.values()] }),
    batch: async () => [],
    put: async (item) => {
      if (failWrites === item.kind) throw new Error("storage unavailable");
      items.set(`${item.pk}/${item.sk}`, item);
    },
  });
  const tags = [...STAGES, ...SOURCES].map((name) => ({
    name,
    id: `TAG_${name.toUpperCase()}_ID`,
  }));
  let applied: string[] = [];
  let created = 0;
  const posts: string[] = [];
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
    guildId: "guild",
    memberRoleId: "member",
    officerRoleId: "officer",
    jobs: {},
  }).fromVerifiedInteraction({
    guild_id: "guild",
    member: { user: { id: "officer" }, roles: ["officer"] },
  });
  const principal = createSystemPrincipal(["candidate", "officerNote"]);
  const core = createRecruiting(
    data,
    principal,
    "guild",
    port,
    (failure) => failures.push(failure),
    accepted,
  );
  return {
    core,
    actor,
    failures,
    failWrites: (kind: GuildRecord["kind"]) => {
      failWrites = kind;
    },
    data,
    principal,
    items,
    tags,
    port,
    applied: () => applied,
    created: () => created,
    posts,
  };
}

test("new candidate creates one thread with the New tag", async () => {
  const setup = fixture();
  await seed(setup, "Officer lead");
  assert.equal(setup.created(), 1);
  assert.deepEqual(setup.applied(), ["TAG_NEW_ID", "TAG_OFFICER LEAD_ID"]);
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
  assert.deepEqual(setup.applied(), ["TAG_APPLY FORM_ID", "TAG_TRIAL_ID"]);
  setup.port.setTags = async () => assert.fail("Old event wrote tags");
  await reconcile([], "2098-01-01T00:00:00.000Z");
});

test("concurrent correction keeps the newer edit through the Discord adapter", async () => {
  const setup = fixture();
  await seed(setup);
  const trial = ["TAG_TRIAL_ID", "TAG_APPLY FORM_ID"];
  let current = ["TAG_INTERVIEW_ID"];
  let reads = 0;
  let writes = 0;
  const forum = {
    id: "forum",
    fetch: async () => ({ availableTags: setup.tags }),
    threads: {
      fetch: async () => {
        if (++reads === 3) current = [...trial];
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
  const edit = (tags: string[], at: string) =>
    setup.core.officerTags({
      threadId,
      tags,
      actor: setup.actor,
      eventId: at,
      at,
    });
  await edit(["TAG_INTERVIEW_ID"], "2099-01-01T00:00:00.000Z");
  assert.deepEqual(current, trial);
  await edit(trial, "2099-01-02T00:00:00.000Z");
  assert.equal(
    (await setup.core.candidate(threadId))?.recruiting?.stage,
    "Trial",
  );
  assert.equal(writes, 0);
});

test("failed officer acceptance restores tags without overwriting a newer edit", async () => {
  for (const newerEdit of [false, true]) {
    const setup = fixture(async () => {
      if (newerEdit) await setup.port.setTags(threadId, ["TAG_TRIAL_ID"], []);
      throw new Error("MEMBER_ROLE_GRANT_FAILED");
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
  }
});

for (const [behaviour, name, discordUserId, count] of [
  ["same Discord account merges", "Othermain", "applicant", 1],
  ["same character name from two sources merges", " synthetic ", "other", 1],
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
      count === 1 ? ["Officer lead\nNew details"] : [],
    );
  });
}
