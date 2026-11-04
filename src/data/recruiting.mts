export const STAGES = [
  "New",
  "Contacted",
  "Applied",
  "Interview",
  "Trial",
  "Accepted",
  "Declined",
  "Withdrawn",
] as const;
export const SOURCES = [
  "Guilds of WoW",
  "Apply form",
  "Officer lead",
  "In-game recruit",
] as const;
export type Stage = (typeof STAGES)[number];
export type Source = (typeof SOURCES)[number];
export type RecruitingState = {
  threadId: string;
  source: Source;
  stage: Stage;
  changedBy: string;
  changedAt: string;
  owner?: string;
  nextActionAt?: string;
};

export function recruitingState(raw: unknown): raw is RecruitingState {
  if (!raw || typeof raw !== "object") return false;
  const value = raw as Record<string, unknown>;
  return (
    (value.owner === undefined ||
      (typeof value.owner === "string" && !!value.owner.trim())) &&
    (value.nextActionAt === undefined ||
      (typeof value.nextActionAt === "string" &&
        Number.isFinite(Date.parse(value.nextActionAt)))) &&
    typeof value.threadId === "string" &&
    !!value.threadId &&
    SOURCES.some((source) => source === value.source) &&
    STAGES.some((stage) => stage === value.stage) &&
    typeof value.changedBy === "string" &&
    !!value.changedBy &&
    typeof value.changedAt === "string" &&
    Number.isFinite(Date.parse(value.changedAt))
  );
}
