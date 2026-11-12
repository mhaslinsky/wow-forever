import { applicationRecord } from "../data/gow-applications.mts";
import type { createDataAccess } from "../data/index.mts";
import type { GuildRecord } from "../data/records.mts";
import type { Stage } from "../data/recruiting.mts";
import { reportRecruitingFailure } from "../recruiting/alarm.mts";
import type { createRecruiting } from "../recruiting/core.mts";

// Guilds of WoW publishes no status list. "New" is what the API sends for an
// open application; its MCP schema names Pending, Accepted and Rejected.
const STATUS_STAGES: Record<string, Stage | null> = {
  New: null,
  Pending: null,
  Accepted: "Accepted",
  Rejected: "Declined",
};

const CLOSED = ["Accepted", "Declined", "Withdrawn"];

function liveStatus(recruit: unknown): string | undefined {
  if (!recruit || typeof recruit !== "object") return;
  if ("statusText" in recruit && typeof recruit.statusText === "string")
    return recruit.statusText.trim() || undefined;
  if ("status" in recruit && Number.isFinite(recruit.status))
    return `code:${recruit.status}`;
}

/** Moves open candidates to the stage an officer chose on Guilds of WoW. */
export async function syncStatuses(input: {
  guildId: string;
  recruits: readonly unknown[];
  records: ReturnType<ReturnType<typeof createDataAccess>["forSystem"]>;
  recruiting: Pick<
    ReturnType<typeof createRecruiting>,
    "candidate" | "setStage"
  >;
  report?: typeof reportRecruitingFailure;
}): Promise<{ synced: number }> {
  const report = input.report ?? reportRecruitingFailure;
  let synced = 0;
  let failed = false;
  for (const recruit of input.recruits) {
    const status = liveStatus(recruit);
    if (!status) continue;
    const key = applicationRecord(input.guildId, recruit);
    const [stored] = await input.records.get(key);
    if (
      stored?.kind !== "gowApplication" ||
      !stored.mappedThreadId ||
      stored.gowStatus === status
    )
      continue;
    const threadId = stored.mappedThreadId;
    try {
      const stage = STATUS_STAGES[status];
      if (stage === undefined)
        report({ code: "GOW_STATUS_UNMAPPED", recordKey: key.sk, status });
      else if (stage) {
        const candidate = await input.recruiting.candidate(threadId);
        if (
          candidate?.recruiting &&
          !CLOSED.includes(candidate.recruiting.stage)
        ) {
          await input.recruiting.setStage(
            threadId,
            stage,
            "gow-sync",
            `gow-${key.sk}-${status}`,
          );
          synced++;
        }
      }
      const updated: GuildRecord = { ...stored, gowStatus: status };
      await input.records.write(updated);
    } catch {
      failed = true;
      report({ code: "GOW_STATUS_SYNC_FAILED", recordKey: key.sk });
    }
  }
  if (failed) throw new Error("GOW_STATUS_SYNC_FAILED");
  return { synced };
}
