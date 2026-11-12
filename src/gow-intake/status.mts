import { applicationRecord } from "../data/gow-applications.mts";
import type { createDataAccess } from "../data/index.mts";
import type { GuildRecord } from "../data/records.mts";
import type { Stage } from "../data/recruiting.mts";
import { reportRecruitingFailure } from "../recruiting/alarm.mts";
import type { createRecruiting } from "../recruiting/core.mts";

// Guilds of WoW publishes no status list. "New" is what the API sends for an
// open application; its MCP schema names Pending, Accepted and Rejected.
const STATUS_STAGES = new Map<string, Stage | null>([
  ["New", null],
  ["Pending", null],
  ["Accepted", "Accepted"],
  ["Rejected", "Declined"],
]);

const MISSING = "(none)";

function liveStatus(recruit: unknown): string {
  if (!recruit || typeof recruit !== "object") return MISSING;
  if ("statusText" in recruit && typeof recruit.statusText === "string") {
    const text = recruit.statusText.trim();
    if (text) return text;
  }
  if ("status" in recruit && Number.isFinite(recruit.status))
    return `code:${recruit.status}`;
  return MISSING;
}

export function unmappedNotice(threadId: string, status: string): string {
  if (status === MISSING)
    return `Guilds of WoW sent no status for <#${threadId}>, so I left it as is.`;
  const shown = status.replaceAll("`", "").slice(0, 40);
  return `Guilds of WoW marked <#${threadId}> as \`${shown}\`, which I don't handle yet, so I left it as is.`;
}

/** Applies officers' Guilds of WoW decisions to the candidates they map to. */
export async function syncStatuses(input: {
  guildId: string;
  recruits: readonly unknown[];
  records: ReturnType<ReturnType<typeof createDataAccess>["forSystem"]>;
  recruiting: Pick<ReturnType<typeof createRecruiting>, "applyDecision">;
  notify: (content: string) => Promise<void>;
  report?: typeof reportRecruitingFailure;
}): Promise<{ synced: number }> {
  const report = input.report ?? reportRecruitingFailure;
  let synced = 0;
  let failed = false;
  for (const recruit of input.recruits) {
    const key = applicationRecord(input.guildId, recruit);
    try {
      const [stored] = await input.records.get(key);
      if (stored?.kind !== "gowApplication" || !stored.mappedThreadId) continue;
      const status = liveStatus(recruit);
      if (stored.gowStatus === status) continue;
      const threadId = stored.mappedThreadId;
      const stage = STATUS_STAGES.get(status);
      if (stage === undefined) {
        report({ code: "GOW_STATUS_UNMAPPED", recordKey: key.sk, status });
        await input.notify(unmappedNotice(threadId, status));
      } else if (stage) {
        const outcome = await input.recruiting.applyDecision(
          threadId,
          stage,
          "gow-sync",
          `gow-${key.sk}-${status}`,
        );
        if (outcome === "moved") synced++;
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
