import type { ForumChannel } from "discord.js";
import { reportRecruitingFailure } from "./alarm.mts";
import type { Candidate } from "./core.mts";

export type RetentionPorts = {
  candidates(): Promise<readonly Candidate[]>;
  purge(candidate: Candidate): Promise<void>;
  archive(threadId: string): Promise<void>;
  archived(candidate: Candidate): Promise<void>;
  retentionDays: number;
  now(): number;
};

export function createRetentionPurge(ports: RetentionPorts) {
  if (!Number.isSafeInteger(ports.retentionDays) || ports.retentionDays <= 0)
    throw new Error("INVALID_RETENTION_DAYS");
  return async () => {
    const now = ports.now();
    if (!Number.isFinite(now)) throw new Error("INVALID_RETENTION_CLOCK");
    const cutoff = now - ports.retentionDays * 86_400_000;
    let purged = 0;
    let failed = 0;
    for (const candidate of await ports.candidates()) {
      try {
        if (candidate.retention) {
          if (candidate.recruiting) {
            await ports.purge(candidate);
            purged++;
          }
          if (!candidate.retention.archived) {
            await ports.archive(candidate.retention.threadId);
            await ports.archived(candidate);
          }
          continue;
        }
        const state = candidate.recruiting;
        if (
          !state ||
          !["Declined", "Withdrawn"].includes(state.stage) ||
          Date.parse(state.changedAt) >= cutoff
        )
          continue;
        await ports.purge(candidate);
        await ports.archive(state.threadId);
        await ports.archived(candidate);
        purged++;
      } catch {
        failed++;
        reportRecruitingFailure({
          code: "RECRUITING_RETENTION_FAILED",
          key: { pk: candidate.pk, sk: candidate.sk },
        });
      }
    }
    if (failed) throw new Error(`RECRUITING_RETENTION_FAILED:${failed}`);
    return { purged };
  };
}

export async function archiveRetentionThread(
  forum: Pick<ForumChannel, "id" | "threads">,
  threadId: string,
) {
  try {
    const thread = await forum.threads.fetch(threadId, { force: true });
    if (!thread) return;
    if (thread.parentId !== forum.id)
      throw new Error("CANDIDATE_THREAD_MISSING");
    await thread.edit({ archived: true, locked: true });
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      (("code" in error && error.code === 10003) ||
        ("status" in error && error.status === 404))
    )
      return;
    throw error;
  }
}
