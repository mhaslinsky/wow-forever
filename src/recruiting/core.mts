import { createHash } from "node:crypto";
import { authority, type Principal } from "../auth/index.mts";
import { type Application, applicationAnswers } from "../data/application.mts";
import type { createDataAccess, WriteCondition } from "../data/index.mts";
import { type GuildRecord, recordKey } from "../data/records.mts";
import {
  type CharacterDeclaration,
  type RecruitingState,
  SOURCES,
  type Source,
  STAGES,
  type Stage,
} from "../data/recruiting.mts";
import { acceptanceStamp, createRoster } from "../roster/core.mts";
import { type RecruitingFailure, reportRecruitingFailure } from "./alarm.mts";
import { createIntake } from "./intake.mts";
import { type IntakeResolution, resolutionThread } from "./resolve.mts";

export type Candidate = Extract<GuildRecord, { kind: "candidate" }>;
export type CreateCandidateInput = {
  name: string;
  submissionId?: string;
  source: Source;
  actorId: string;
  actor?: Principal<"user">;
  content?: string;
  owner?: string;
  nextActionAt?: string;
  discordUserId?: string;
  characters?: CharacterDeclaration[];
  application?: Application;
};
export type ForumTag = { id: string; name: string };
export type ForumPort = {
  verifyIntake?(threadId: string, ref: string): Promise<void>;
  tags(): Promise<readonly ForumTag[]>;
  create(input: {
    name: string;
    content: string;
    tags: string[];
    ref?: string;
  }): Promise<string>;
  post(threadId: string, content: string): Promise<void>;
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

const CLOSED_STAGES: readonly Stage[] = ["Accepted", "Declined", "Withdrawn"];
const SAVE_ATTEMPTS = 3;

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
  accepted?: (candidate: Candidate) => Promise<void>,
  notify: (content: string) => Promise<void> = async () => {
    throw new Error("INTAKE_ALERTS_UNAVAILABLE");
  },
) {
  const records = data.forSystem(principal);
  async function candidate(threadId: string): Promise<Candidate | undefined> {
    const [record] = await records.get(
      recordKey("candidate", guildId, threadId),
    );
    return record?.kind === "candidate" ? record : undefined;
  }
  const intake = createIntake({
    records,
    guildId,
    forum,
    candidate,
    notify,
    saving,
  });
  async function saving<Result>(threadId: string, work: () => Promise<Result>) {
    try {
      return await work();
    } catch (cause) {
      report({ code: "CANDIDATE_SAVE_FAILED", threadId });
      if (cause instanceof Error && cause.message === "WRITE_CONFLICT")
        throw new Error(`CANDIDATE_WRITE_CONFLICT:${threadId}`, { cause });
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
  /**
   * Saves a change to the candidate as it is stored now. The gateway and the
   * Lambdas write the same record, so a save that finds the candidate changed
   * since its read reads again and reapplies the change instead of overwriting.
   */
  async function saveCandidate(
    threadId: string,
    change: (record: Candidate) => Candidate | undefined,
    condition: Omit<WriteCondition, "candidatePrevious"> = {},
  ): Promise<{ record: Candidate; updated?: Candidate }> {
    for (let attempt = 1; ; attempt++) {
      const record = await candidate(threadId);
      if (!record) throw new Error("CANDIDATE_NOT_FOUND");
      // The store refuses any write to a purged candidate, so rereading is pointless.
      if (record.retention) throw new Error("WRITE_CONFLICT");
      const updated = change(record);
      if (!updated) return { record };
      try {
        await records.write(updated, {
          ...condition,
          candidatePrevious: record,
        });
        return { record, updated };
      } catch (cause) {
        const conflict =
          cause instanceof Error && cause.message === "WRITE_CONFLICT";
        if (!conflict || attempt >= SAVE_ATTEMPTS) throw cause;
      }
    }
  }
  async function saveStage(
    threadId: string,
    stageFor: (state: RecruitingState) => Stage | undefined,
    actorId: string,
    eventId: string,
    at: string,
    acceptanceFailed?: (restored: RecruitingState) => Promise<void>,
  ) {
    const saved = await saveCandidate(threadId, (record) => {
      if (!record.recruiting) throw new Error("CANDIDATE_THREAD_MISSING");
      const stage = stageFor(record.recruiting);
      // Rewriting the same stage would replace the marker a pending
      // acceptance needs to roll itself back.
      if (stage === undefined || stage === record.recruiting.stage) return;
      if (!STAGES.includes(stage)) throw new Error("INVALID_RECRUITING_STAGE");
      return {
        ...record,
        recruiting: {
          ...record.recruiting,
          stage,
          changedBy: actorId,
          changedAt: at,
        },
      };
    });
    const before = saved.record.recruiting;
    const after = saved.updated?.recruiting;
    if (!before || !after || !saved.updated) return saved;
    // A repeat acceptance must not send the approval DM twice.
    if (after.stage === "Accepted" && before.stage !== "Accepted") {
      try {
        if (!accepted) throw new Error("ROSTER_ACCEPTANCE_UNAVAILABLE");
        await accepted(saved.updated);
      } catch (cause) {
        // Put back only the stage this save wrote, so another acceptance can
        // retry it without undoing a follow-up edit made in between.
        const rollback = await saveCandidate(threadId, (current) =>
          current.recruiting?.stage === "Accepted" &&
          current.recruiting.changedBy === actorId &&
          current.recruiting.changedAt === at
            ? {
                ...current,
                recruiting: {
                  ...current.recruiting,
                  stage: before.stage,
                  changedBy: before.changedBy,
                  changedAt: before.changedAt,
                },
              }
            : undefined,
        ).catch(() => {
          report({ code: "CANDIDATE_SAVE_FAILED", threadId });
          return undefined;
        });
        if (rollback?.updated) await acceptanceFailed?.(before);
        throw cause;
      }
    }
    await records.write(
      {
        ...recordKey("officerNote", guildId, `${before.threadId}#${eventId}`),
        kind: "officerNote",
        ownerId: guildId,
        text: JSON.stringify({
          from: before.stage,
          to: after.stage,
          actorId,
          at,
        }),
      },
      {
        candidateThreadId: before.threadId,
      },
    );
    return saved;
  }
  /**
   * Finishes a saved move whose officer note is missing. The acceptance runs
   * again unless the roster entry carries this move's stamp, which it saves
   * before the approval DM.
   */
  async function finishDecision(
    current: Candidate,
    state: RecruitingState,
    note: ReturnType<typeof recordKey>,
  ) {
    if (state.stage === "Accepted") {
      const [member] = current.discordUserId
        ? await records.get(recordKey("member", current.discordUserId, guildId))
        : [];
      if (
        member?.kind !== "member" ||
        member.accepted !== acceptanceStamp(current)
      ) {
        if (!accepted) throw new Error("ROSTER_ACCEPTANCE_UNAVAILABLE");
        await accepted(current);
      }
    }
    await records.write(
      {
        ...note,
        kind: "officerNote",
        ownerId: guildId,
        text: JSON.stringify({
          to: state.stage,
          actorId: state.changedBy,
          at: state.changedAt,
        }),
      },
      { candidateThreadId: state.threadId },
    );
  }
  return {
    candidate,
    async resolveIntake(actor: Principal<"user">, input: IntakeResolution) {
      const threadId = resolutionThread(actor, input, guildId);
      return intake.resolve(input.ref, threadId);
    },
    registerRoster: createRoster(data, guildId).register,
    async create(input: CreateCandidateInput) {
      if (
        !input.name.trim() ||
        !input.actorId ||
        !SOURCES.includes(input.source)
      )
        throw new Error("INVALID_CANDIDATE");
      if (
        input.application !== undefined &&
        !applicationAnswers(
          input.application,
          input.characters?.find((character) => character.main),
        )
      )
        throw new Error("INVALID_APPLICATION");
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
      const submission = JSON.stringify({
        source: input.source,
        name: input.name,
        discordUserId: input.discordUserId,
        characters: input.characters,
        application: input.application,
        content: input.content || input.name,
      });
      const submissionId = createHash("sha256")
        .update(
          input.submissionId
            ? JSON.stringify([input.source, input.submissionId])
            : submission,
        )
        .digest("hex");
      const replay = await intake.replay(submissionId);
      if (replay.candidate) return replay.candidate;
      const candidates = await records.query(
        recordKey("candidate", guildId, "unused").pk,
      );
      const mainName = (value: {
        name: string;
        characters?: CharacterDeclaration[];
      }) =>
        (
          value.characters?.find((character) => character.main)?.name ??
          value.name
        )
          .trim()
          .normalize("NFC")
          .toLowerCase();
      const candidateRecords = candidates.filter(
        (record): record is Candidate =>
          record.kind === "candidate" && !record.retention,
      );
      const accountMatch = input.discordUserId
        ? candidateRecords.find(
            (record) => record.discordUserId === input.discordUserId,
          )
        : undefined;
      const existing =
        accountMatch ??
        candidateRecords.find(
          (record) =>
            (!input.discordUserId || !record.discordUserId) &&
            mainName(record) === mainName(input),
        );
      const note = (threadId: string) => ({
        ...recordKey(
          "officerNote",
          guildId,
          `${threadId}#submission#${submissionId}`,
        ),
        kind: "officerNote" as const,
        ownerId: guildId,
        text: submission,
      });
      if (existing) {
        if (!existing.recruiting) throw new Error("CANDIDATE_THREAD_MISSING");
        const threadId = existing.recruiting.threadId;
        return saving(threadId, async () => {
          const [previous] = await records.get(note(threadId));
          if (previous) return intake.finishReleased(replay.released, existing);
          const saved = await saveCandidate(
            threadId,
            (current) => ({
              ...current,
              ...(!current.discordUserId && input.discordUserId
                ? { discordUserId: input.discordUserId }
                : {}),
              ...(!current.characters && input.characters
                ? {
                    characters: input.characters,
                    ...(input.application
                      ? { application: input.application }
                      : {}),
                  }
                : {}),
            }),
            replay.released ? { releasedIntake: replay.released } : {},
          );
          const enriched = saved.updated ?? saved.record;
          await records.write(note(threadId), {
            candidateThreadId: threadId,
          });
          try {
            await forum.post(
              threadId,
              `Applied again through ${input.source}:\n${input.content || input.name}`,
            );
          } catch (cause) {
            // A failed delivery must not make its retry look like a duplicate.
            try {
              await records.removeOfficerNote(note(threadId));
            } catch {
              report({ code: "SUBMISSION_NOTE_CLEANUP_FAILED", threadId });
            }
            throw cause;
          }
          return intake.finishReleased(replay.released, enriched);
        });
      }
      const tags = await forum.tags();
      const applied = [tagId(tags, "New"), tagId(tags, input.source)];
      return intake.create(
        submissionId,
        {
          name: input.name,
          content: input.content || input.name,
          submission,
          source: input.source,
          actorId: input.actorId,
          changedAt: createdAt.toISOString(),
          nextActionAt,
          ...(owner ? { owner } : {}),
          ...(input.discordUserId
            ? { discordUserId: input.discordUserId }
            : {}),
          ...(input.characters ? { characters: input.characters } : {}),
          ...(input.application ? { application: input.application } : {}),
        },
        applied,
        replay.released,
      );
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
      const saved = await saving(threadId, () =>
        saveCandidate(threadId, (current) =>
          current.recruiting
            ? { ...current, recruiting: { ...current.recruiting, ...update } }
            : undefined,
        ),
      );
      if (!saved.updated) throw new Error("CANDIDATE_NOT_FOUND");
      return saved.updated;
    },
    async threadDeleted(input: {
      threadId: string;
      actorId: string;
      eventId: string;
      at: string;
    }) {
      const record = await candidate(input.threadId);
      if (
        !record?.recruiting ||
        CLOSED_STAGES.includes(record.recruiting.stage)
      )
        return;
      const saved = await saving(input.threadId, () =>
        saveStage(
          input.threadId,
          (state) =>
            CLOSED_STAGES.includes(state.stage) ? undefined : "Withdrawn",
          input.actorId,
          input.eventId,
          input.at,
        ),
      );
      return saved.updated;
    },
    async officerTags(input: {
      threadId: string;
      tags: readonly string[];
      added?: readonly string[];
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
        const stageTags = available.filter((tag) =>
          STAGES.some((stage) => stage === tag.name),
        );
        const present = stageTags.filter((tag) => current.includes(tag.id));
        // Discord saves each tag click separately, so an officer swapping
        // stages passes through zero or two stage tags on the way.
        if (!present.length) return;
        const added = present.filter((tag) => input.added?.includes(tag.id));
        const chosen =
          present.length === 1
            ? present[0]
            : added.length === 1
              ? added[0]
              : undefined;
        if (!chosen) {
          await syncTags(input.threadId, state.stage, state.source, current);
          return;
        }
        const stage = chosen.name as Stage;
        const newer = (fresh: RecruitingState) =>
          Date.parse(input.at) < Date.parse(fresh.changedAt);
        const saved = await saveStage(
          input.threadId,
          (fresh) =>
            newer(fresh) || fresh.stage === stage ? undefined : stage,
          actor.userId,
          input.eventId,
          input.at,
          (restored) =>
            syncTags(input.threadId, restored.stage, restored.source, current),
        );
        // A change saved after this edit was made wins, tags included.
        const fresh = saved.record.recruiting;
        if (!saved.updated && fresh && newer(fresh)) return;
        const updated = saved.updated ?? saved.record;
        const next = current.filter(
          (id) => id === chosen.id || !stageTags.some((tag) => tag.id === id),
        );
        if (!sameTags(current, next))
          await forum.setTags(input.threadId, next, current);
        return updated;
      });
    },
    async setStage(
      threadId: string,
      stage: Stage,
      actorId: string,
      eventId: string,
      from?: Stage,
    ) {
      if (!STAGES.includes(stage) || !actorId)
        throw new Error("INVALID_RECRUITING_STAGE");
      const record = await candidate(threadId);
      if (!record?.recruiting) throw new Error("CANDIDATE_NOT_FOUND");
      const source = record.recruiting.source;
      return saving(threadId, async () => {
        // With `from`, the move applies only to the stage the caller expects,
        // so it never overwrites a stage saved since the caller looked.
        const saved = await saveStage(
          threadId,
          (state) => (from && state.stage !== from ? undefined : stage),
          actorId,
          eventId,
          new Date().toISOString(),
        );
        const current = saved.updated ?? saved.record;
        if (current.recruiting?.stage === stage)
          await syncTags(threadId, stage, source);
        return current;
      });
    },
    /**
     * Applies an outside decision to the candidate as it was read, if still
     * open. A rerun finishes a move this actor already saved: the acceptance,
     * the officer note and the tags.
     */
    async applyDecision(
      threadId: string,
      stage: Stage,
      actorId: string,
      eventId: string,
    ): Promise<"moved" | "resumed" | "kept"> {
      if (!STAGES.includes(stage) || !actorId)
        throw new Error("INVALID_RECRUITING_STAGE");
      const record = await candidate(threadId);
      if (record?.retention) return "kept";
      return saving(threadId, async () => {
        const read = record?.recruiting;
        if (!read) throw new Error("CANDIDATE_NOT_FOUND");
        const ours = (state: RecruitingState) =>
          state.stage === stage && state.changedBy === actorId;
        const note = recordKey(
          "officerNote",
          guildId,
          `${read.threadId}#${eventId}`,
        );
        let outcome: "moved" | "resumed" = "resumed";
        // The note means this decision already moved the candidate once, so
        // a stage change since then is an officer's and must not be undone.
        if ((await records.get(note))[0]) {
          if (!ours(read)) return "kept";
        } else {
          // Any stage change since the read, open stages included, is an
          // officer decision and wins.
          const saved = await saveStage(
            threadId,
            (state) =>
              CLOSED_STAGES.includes(state.stage) ||
              state.stage !== read.stage ||
              state.changedBy !== read.changedBy ||
              state.changedAt !== read.changedAt
                ? undefined
                : stage,
            actorId,
            eventId,
            new Date().toISOString(),
          );
          const current = saved.updated ?? saved.record;
          const state = current.recruiting;
          if (!state) throw new Error("CANDIDATE_NOT_FOUND");
          if (saved.updated) outcome = "moved";
          else if (!ours(state)) return "kept";
          else await finishDecision(current, state, note);
        }
        // An officer change made during the acceptance keeps its own tags.
        const latest = (await candidate(threadId))?.recruiting;
        if (latest && ours(latest))
          await syncTags(threadId, stage, latest.source);
        return outcome;
      });
    },
  };
}
