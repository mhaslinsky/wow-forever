export type RecruitingFailure =
  | { code: "GOW_APPLICATION_PARSE_FAILED"; recordKey: string }
  | { code: "RECRUITING_DIGEST_FAILED" }
  | { code: "RECRUITING_RETENTION_FAILED"; key?: { pk: string; sk: string } }
  | {
      code:
        | "MEMBER_GRANT_SKIPPED"
        | "MEMBER_ROLE_GRANT_FAILED"
        | "CANDIDATE_SAVE_FAILED"
        | "CANDIDATE_NOT_FOUND"
        | "RECRUITING_MEMBER_LOOKUP_FAILED"
        | "RECRUITING_EDIT_DENIED"
        | "SUBMISSION_NOTE_CLEANUP_FAILED";
      threadId: string;
    }
  | { code: "RECRUITING_AUDIT_UNAVAILABLE"; guildId: string };

export function reportRecruitingFailure(failure: RecruitingFailure): void {
  console.error(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: "wow-forever/recruiting",
            Dimensions: [[]],
            Metrics: [{ Name: "RecruitingError", Unit: "Count" }],
          },
        ],
      },
      RecruitingError: 1,
      ...failure,
      ...(failure.code === "MEMBER_GRANT_SKIPPED"
        ? { message: `MEMBER_GRANT_SKIPPED:${failure.threadId}` }
        : {}),
    }),
  );
}
