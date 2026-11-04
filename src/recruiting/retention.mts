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
    for (const candidate of await ports.candidates()) {
      if (candidate.retention) {
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
    }
    return { purged };
  };
}
