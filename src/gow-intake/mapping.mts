import type { createDataAccess } from "../data/index.mts";
import { type GuildRecord, recordKey } from "../data/records.mts";
import { reportRecruitingFailure } from "../recruiting/alarm.mts";
import type {
  CreateCandidateInput,
  createRecruiting,
} from "../recruiting/core.mts";

function candidateInput(payload: string): CreateCandidateInput | undefined {
  const value = JSON.parse(payload);
  if (!value || typeof value !== "object")
    throw new Error("GOW_INVALID_APPLICATION");
  if (value.isActive === false || value.isBanned === true) return;
  if (
    typeof value.character?.name !== "string" ||
    !value.character.name.trim() ||
    typeof value.character.className !== "string" ||
    !value.character.className.trim() ||
    typeof value.selectedRolesText !== "string" ||
    typeof value.message !== "string" ||
    !(
      (typeof value.id === "string" && value.id.trim()) ||
      (typeof value.id === "number" && Number.isFinite(value.id))
    )
  )
    throw new Error("GOW_INVALID_APPLICATION");
  return {
    name: value.character.name,
    source: "Guilds of WoW",
    actorId: "gow-intake",
    submissionId: String(value.id),
    content: `Class: ${value.character.className}\nRole: ${value.selectedRolesText}\n\n${value.message}`,
  };
}

export async function mapApplications(input: {
  guildId: string;
  records: ReturnType<ReturnType<typeof createDataAccess>["forSystem"]>;
  create: ReturnType<typeof createRecruiting>["create"];
  report?: typeof reportRecruitingFailure;
}): Promise<{ mapped: number }> {
  const records = await input.records.query(
    recordKey("gowApplication", input.guildId, "unused").pk,
  );
  let mapped = 0;
  let failed = false;
  for (const record of records) {
    if (record.kind !== "gowApplication" || record.mappedThreadId) continue;
    let candidate: CreateCandidateInput | undefined;
    try {
      candidate = candidateInput(record.payload);
    } catch {
      (input.report ?? reportRecruitingFailure)({
        code: "GOW_APPLICATION_PARSE_FAILED",
        recordKey: record.sk,
      });
      continue;
    }
    if (!candidate) continue;
    try {
      const result = await input.create(candidate);
      if (!result.recruiting?.threadId)
        throw new Error("CANDIDATE_THREAD_MISSING");
      const updated: GuildRecord = {
        ...record,
        mappedThreadId: result.recruiting.threadId,
      };
      await input.records.write(updated);
      mapped++;
    } catch {
      failed = true;
      (input.report ?? reportRecruitingFailure)({
        code: "GOW_APPLICATION_PARSE_FAILED",
        recordKey: record.sk,
      });
    }
  }
  if (failed) throw new Error("GOW_APPLICATION_MAPPING_FAILED");
  return { mapped };
}
