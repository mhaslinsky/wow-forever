import { authority, type Principal } from "../auth/index.mts";
import type { createDataAccess } from "../data/index.mts";
import { type GuildRecord, recordKey } from "../data/records.mts";
import {
  SOURCES,
  type Source,
  STAGES,
  type Stage,
} from "../data/recruiting.mts";
import { type RecruitingFailure, reportRecruitingFailure } from "./alarm.mts";

export type Candidate = Extract<GuildRecord, { kind: "candidate" }>;
export type CreateCandidateInput = {
  name: string;
  source: Source;
  actorId: string;
  actor?: Principal<"user">;
  content?: string;
  owner?: string;
  nextActionAt?: string;
};
export type ForumTag = { id: string; name: string };
export type ForumPort = {
  tags(): Promise<readonly ForumTag[]>;
  create(input: {
    name: string;
    content: string;
    tags: string[];
  }): Promise<string>;
  tagsFor(threadId: string): Promise<readonly string[]>;
  setTags(
    threadId: string,
    tags: string[],
    expected: readonly string[],
  ): Promise<void>;
};

export function sameTags(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((tag) => expected.includes(tag))
  );
}

function tagId(tags: readonly ForumTag[], name: string): string {
  const matches = tags.filter((tag) => tag.name === name);
  if (matches.length !== 1)
    throw new Error(`RECRUITING_TAG_MISSING_OR_AMBIGUOUS:${name}`);
  return matches[0].id;
}

export function createRecruiting(
  data: ReturnType<typeof createDataAccess>,
  principal: Principal<"system">,
  guildId: string,
  forum: ForumPort,
  report: (failure: RecruitingFailure) => void = reportRecruitingFailure,
) {
  const records = data.forSystem(principal);
  async function candidate(threadId: string): Promise<Candidate | undefined> {
    const [record] = await records.get(
      recordKey("candidate", guildId, threadId),
    );
    return record?.kind === "candidate" ? record : undefined;
  }
  async function saving<Result>(threadId: string, work: () => Promise<Result>) {
    try {
      return await work();
    } catch (cause) {
      report({ code: "CANDIDATE_SAVE_FAILED", threadId });
      throw new Error(`CANDIDATE_SAVE_FAILED:${threadId}`, { cause });
    }
  }
  async function syncTags(
    threadId: string,
    stage: Stage,
    source: Source,
    expected?: readonly string[],
  ) {
    const tags = await forum.tagsFor(threadId);
    if (expected && !sameTags(tags, expected)) return;
    const available = await forum.tags();
    const stageIds = new Set(
      available
        .filter((tag) => STAGES.some((name) => name === tag.name))
        .map((tag) => tag.id),
    );
    const sourceIds = new Set(
      available
        .filter((tag) => SOURCES.some((name) => name === tag.name))
        .map((tag) => tag.id),
    );
    const next = [
      ...tags.filter((tag) => !stageIds.has(tag) && !sourceIds.has(tag)),
      tagId(available, source),
      tagId(available, stage),
    ];
    if (sameTags(tags, next)) return;
    await forum.setTags(threadId, next, tags);
  }
  async function saveStage(
    record: Candidate,
    stage: Stage,
    actorId: string,
    eventId: string,
    at: string,
  ) {
    if (!STAGES.includes(stage)) throw new Error("INVALID_RECRUITING_STAGE");
    if (!record.recruiting) throw new Error("CANDIDATE_THREAD_MISSING");
    const updated: Candidate = {
      ...record,
      recruiting: {
        ...record.recruiting,
        stage,
        changedBy: actorId,
        changedAt: at,
      },
    };
    await records.write(updated);
    await records.write({
      ...recordKey(
        "officerNote",
        guildId,
        `${record.recruiting.threadId}#${eventId}`,
      ),
      kind: "officerNote",
      ownerId: guildId,
      text: JSON.stringify({
        from: record.recruiting.stage,
        to: stage,
        actorId,
        at,
      }),
    });
    return updated;
  }
  return {
    candidate,
    async create(input: CreateCandidateInput) {
      if (
        !input.name.trim() ||
        !input.actorId ||
        !SOURCES.includes(input.source)
      )
        throw new Error("INVALID_CANDIDATE");
      const createdAt = new Date();
      const actor = input.actor ? authority(input.actor) : undefined;
      const owner =
        input.owner ??
        (actor?.roles.includes("Officer") ? actor.userId : undefined);
      const nextActionAt =
        input.nextActionAt ??
        new Date(createdAt.getTime() + 86_400_000).toISOString();
      if (
        (owner !== undefined && !owner.trim()) ||
        !Number.isFinite(Date.parse(nextActionAt))
      )
        throw new Error("INVALID_FOLLOW_UP");
      const tags = await forum.tags();
      const applied = [tagId(tags, "New"), tagId(tags, input.source)];
      const threadId = await forum.create({
        name: input.name,
        content: input.content || input.name,
        tags: applied,
      });
      const record: Candidate = {
        ...recordKey("candidate", guildId, threadId),
        kind: "candidate",
        ownerId: guildId,
        name: input.name,
        recruiting: {
          threadId,
          source: input.source,
          stage: "New",
          changedBy: input.actorId,
          changedAt: createdAt.toISOString(),
          ...(owner ? { owner } : {}),
          nextActionAt,
        },
      };
      await saving(threadId, () => records.write(record));
      return record;
    },
    async setFollowUp(
      threadId: string,
      actor: Principal<"user">,
      update: { owner?: string; nextActionAt?: string },
    ) {
      if (!authority(actor).roles.includes("Officer"))
        throw new Error("WRITE_DENIED");
      if (
        (update.owner !== undefined && !update.owner.trim()) ||
        (update.nextActionAt !== undefined &&
          !Number.isFinite(Date.parse(update.nextActionAt)))
      )
        throw new Error("INVALID_FOLLOW_UP");
      const record = await candidate(threadId);
      if (!record?.recruiting) throw new Error("CANDIDATE_NOT_FOUND");
      const updated: Candidate = {
        ...record,
        recruiting: { ...record.recruiting, ...update },
      };
      await saving(threadId, () => records.write(updated));
      return updated;
    },
    async officerTags(input: {
      threadId: string;
      tags: readonly string[];
      actor: Principal<"user">;
      eventId: string;
      at: string;
    }) {
      const actor = authority(input.actor);
      if (!actor.roles.includes("Officer")) {
        report({ code: "RECRUITING_EDIT_DENIED", threadId: input.threadId });
        throw new Error("WRITE_DENIED");
      }
      const record = await candidate(input.threadId);
      if (!record?.recruiting) {
        report({ code: "CANDIDATE_NOT_FOUND", threadId: input.threadId });
        throw new Error(`CANDIDATE_NOT_FOUND:${input.threadId}`);
      }
      if (Date.parse(input.at) < Date.parse(record.recruiting.changedAt))
        return;
      const state = record.recruiting;
      return saving(input.threadId, async () => {
        const current = await forum.tagsFor(input.threadId);
        // A newer Discord edit must keep its own actor.
        if (!sameTags(current, input.tags)) return;
        const available = await forum.tags();
        const stages = STAGES.filter((stage) =>
          available.some(
            (tag) => tag.name === stage && current.includes(tag.id),
          ),
        );
        if (stages.length !== 1) {
          await syncTags(input.threadId, state.stage, state.source, current);
          return;
        }
        const updated =
          state.stage === stages[0]
            ? record
            : await saveStage(
                record,
                stages[0],
                actor.userId,
                input.eventId,
                input.at,
              );
        await syncTags(input.threadId, stages[0], state.source, current);
        return updated;
      });
    },
    async setStage(
      threadId: string,
      stage: Stage,
      actorId: string,
      eventId: string,
    ) {
      if (!STAGES.includes(stage) || !actorId)
        throw new Error("INVALID_RECRUITING_STAGE");
      const record = await candidate(threadId);
      if (!record?.recruiting) throw new Error("CANDIDATE_NOT_FOUND");
      const source = record.recruiting.source;
      return saving(threadId, async () => {
        const updated = await saveStage(
          record,
          stage,
          actorId,
          eventId,
          new Date().toISOString(),
        );
        await syncTags(threadId, stage, source);
        return updated;
      });
    },
  };
}
