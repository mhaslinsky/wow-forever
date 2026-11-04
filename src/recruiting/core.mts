import { authority, type Principal } from "../auth/index.mts";
import type { createDataAccess } from "../data/index.mts";
import { type GuildRecord, recordKey } from "../data/records.mts";
import {
  SOURCES,
  type Source,
  STAGES,
  type Stage,
} from "../data/recruiting.mts";

export type Candidate = Extract<GuildRecord, { kind: "candidate" }>;
export type ForumTag = { id: string; name: string };
export type ForumPort = {
  tags(): Promise<readonly ForumTag[]>;
  create(input: {
    name: string;
    content: string;
    tags: string[];
  }): Promise<string>;
  tagsFor(threadId: string): Promise<readonly string[]>;
  setTags(threadId: string, tags: string[]): Promise<void>;
};

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
) {
  const records = data.forSystem(principal);
  async function candidate(threadId: string): Promise<Candidate | undefined> {
    const [record] = await records.get(
      recordKey("candidate", guildId, threadId),
    );
    return record?.kind === "candidate" ? record : undefined;
  }
  async function syncTags(
    threadId: string,
    stage: Stage,
    source: Source,
    tags: readonly string[],
  ) {
    const available = await forum.tags();
    const stageIds = new Set(STAGES.map((name) => tagId(available, name)));
    const sourceIds = new Set(SOURCES.map((name) => tagId(available, name)));
    await forum.setTags(threadId, [
      ...tags.filter((tag) => !stageIds.has(tag) && !sourceIds.has(tag)),
      tagId(available, source),
      tagId(available, stage),
    ]);
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
    return updated;
  }
  return {
    candidate,
    async create(input: {
      name: string;
      source: Source;
      actorId: string;
      content?: string;
    }) {
      if (
        !input.name.trim() ||
        !input.actorId ||
        !SOURCES.includes(input.source)
      )
        throw new Error("INVALID_CANDIDATE");
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
          changedAt: new Date().toISOString(),
        },
      };
      try {
        await records.write(record);
      } catch (cause) {
        throw new Error(`CANDIDATE_SAVE_FAILED:${threadId}`, { cause });
      }
      return record;
    },
    async officerTags(input: {
      threadId: string;
      tags: readonly string[];
      actor: Principal<"user">;
      eventId: string;
      at: string;
    }) {
      const actor = authority(input.actor);
      if (!actor.roles.includes("Officer")) throw new Error("WRITE_DENIED");
      const record = await candidate(input.threadId);
      if (!record?.recruiting) return;
      const tags = await forum.tags();
      const stages = STAGES.filter((stage) =>
        input.tags.includes(tagId(tags, stage)),
      );
      if (Date.parse(input.at) < Date.parse(record.recruiting.changedAt))
        return;
      if (stages.length !== 1) {
        await syncTags(
          input.threadId,
          record.recruiting.stage,
          record.recruiting.source,
          input.tags,
        );
        return;
      }
      if (!input.tags.includes(tagId(tags, record.recruiting.source)))
        await syncTags(
          input.threadId,
          stages[0],
          record.recruiting.source,
          input.tags,
        );
      if (record.recruiting.stage === stages[0]) return;
      return saveStage(
        record,
        stages[0],
        actor.userId,
        input.eventId,
        input.at,
      );
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
      const current = await forum.tagsFor(threadId);
      await syncTags(threadId, stage, record.recruiting.source, current);
      return saveStage(
        record,
        stage,
        actorId,
        eventId,
        new Date().toISOString(),
      );
    },
  };
}
