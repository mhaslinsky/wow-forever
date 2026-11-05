import { randomUUID } from "node:crypto";
import type { createDataAccess } from "../data/index.mts";
import type { IntakePayload } from "../data/intake.mts";
import { type GuildRecord, recordKey } from "../data/records.mts";
import type { Candidate, ForumPort } from "./core.mts";

type Intake = Extract<GuildRecord, { kind: "recruitingIntake" }>;
type Records = ReturnType<ReturnType<typeof createDataAccess>["forSystem"]>;
const conflict = (error: unknown) =>
  error instanceof Error && error.message === "WRITE_CONFLICT";

export function createIntake(ports: {
  records: Records;
  guildId: string;
  forum: ForumPort;
  candidate(threadId: string): Promise<Candidate | undefined>;
  notify(content: string): Promise<void>;
  saving<Result>(
    threadId: string,
    work: () => Promise<Result>,
  ): Promise<Result>;
}) {
  const { records, guildId } = ports;
  async function read(ref: string): Promise<Intake | undefined> {
    const [item] = await records.get(
      recordKey("recruitingIntake", guildId, ref),
    );
    return item?.kind === "recruitingIntake" ? item : undefined;
  }
  async function transition(previous: Intake, next: Intake) {
    try {
      await records.transitionIntake(next, {
        state: previous.state,
        attemptId: previous.attemptId,
        ...(previous.state === "blocked"
          ? { noticeSent: previous.noticeSent }
          : {}),
      });
      return true;
    } catch (error) {
      if (!conflict(error)) throw error;
      return false;
    }
  }
  async function blocked(intake: Intake): Promise<never> {
    if (!intake.noticeSent) {
      const payload = intake.payload;
      if (!payload) throw new Error("INVALID_INTAKE_PAYLOAD");
      await ports.notify(
        `Recruiting intake for ${payload.name} (${payload.source}) is on hold, ref ${intake.ref}. Check #recruiting for a thread with that ref before re-adding them.`,
      );
      await transition(intake, { ...intake, noticeSent: true });
    }
    throw new Error("CANDIDATE_INTAKE_BLOCKED");
  }
  async function insert(item: GuildRecord, threadId?: string) {
    try {
      await records.insert(item, threadId);
    } catch (error) {
      if (!conflict(error)) throw error;
      const [existing] = await records.get(item);
      if (!existing) throw error;
    }
  }
  async function resume(
    intake: Intake,
    retryNotice = true,
  ): Promise<Candidate> {
    if (intake.state === "blocked") {
      if (retryNotice) return blocked(intake);
      throw new Error("CANDIDATE_INTAKE_BLOCKED");
    }
    if (intake.state === "pending" || intake.state === "uncertain") {
      if (
        intake.state === "pending" &&
        Date.now() - Date.parse(intake.startedAt) < 360_000
      )
        throw new Error("CANDIDATE_INTAKE_IN_PROGRESS");
      const next: Intake = {
        ...intake,
        state: "blocked",
        noticeSent: false,
        outcome: intake.state === "pending" ? "expired" : "uncertain",
      };
      if (await transition(intake, next)) return blocked(next);
      return current(intake.ref);
    }
    const threadId = intake.threadId;
    if (!threadId) throw new Error("INVALID_INTAKE_THREAD");
    if (intake.state === "done") {
      const existing = await ports.candidate(threadId);
      if (!existing || existing.retention)
        throw new Error("CANDIDATE_INTAKE_BLOCKED");
      return existing;
    }
    return ports.saving(threadId, async () => {
      const payload = intake.payload;
      if (!payload) throw new Error("INVALID_INTAKE_PAYLOAD");
      await insert(
        {
          ...recordKey(
            "officerNote",
            guildId,
            `${threadId}#submission#${intake.ref}`,
          ),
          kind: "officerNote",
          ownerId: guildId,
          text: payload.submission,
        },
        threadId,
      );
      await insert({
        ...recordKey("candidate", guildId, threadId),
        kind: "candidate",
        ownerId: guildId,
        name: payload.name,
        ...(payload.discordUserId
          ? { discordUserId: payload.discordUserId }
          : {}),
        ...(payload.characters ? { characters: payload.characters } : {}),
        ...(payload.application ? { application: payload.application } : {}),
        recruiting: {
          threadId,
          source: payload.source,
          stage: "New",
          changedBy: payload.actorId,
          changedAt: payload.changedAt,
          nextActionAt: payload.nextActionAt,
          ...(payload.owner ? { owner: payload.owner } : {}),
        },
      });
      const existing = await ports.candidate(threadId);
      if (!existing || existing.retention)
        throw new Error("CANDIDATE_INTAKE_BLOCKED");
      const { payload: _payload, ...completed } = intake;
      if (!(await transition(intake, { ...completed, state: "done" })))
        return current(intake.ref);
      return existing;
    });
  }
  async function current(ref: string): Promise<Candidate> {
    const intake = await read(ref);
    if (!intake) throw new Error("CANDIDATE_INTAKE_MISSING");
    return resume(intake, false);
  }
  return {
    async replay(ref: string) {
      const intake = await read(ref);
      return intake ? resume(intake) : undefined;
    },
    async create(ref: string, payload: IntakePayload, tags: string[]) {
      const pending: Intake = {
        ...recordKey("recruitingIntake", guildId, ref),
        kind: "recruitingIntake",
        ownerId: guildId,
        state: "pending",
        attemptId: randomUUID(),
        startedAt: new Date().toISOString(),
        ref,
        payload,
      };
      try {
        await records.insert(pending);
      } catch (error) {
        if (!conflict(error)) throw error;
        return current(ref);
      }
      let threadId: string;
      try {
        threadId = await ports.forum.create({
          name: payload.name,
          content: payload.content,
          tags,
          ref,
        });
      } catch (error) {
        const definite =
          error &&
          typeof error === "object" &&
          "status" in error &&
          typeof error.status === "number" &&
          error.status >= 400 &&
          error.status < 500;
        try {
          if (definite) await records.deleteIntake(pending);
          else await transition(pending, { ...pending, state: "uncertain" });
        } catch (storageError) {
          if (!conflict(storageError)) throw storageError;
        }
        throw error;
      }
      const created: Intake = { ...pending, state: "created", threadId };
      if (!(await transition(pending, created))) return current(ref);
      return resume(created);
    },
  };
}
