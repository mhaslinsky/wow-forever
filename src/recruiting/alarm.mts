export type RecruitingFailure =
  | { code: "GOW_APPLICATION_PARSE_FAILED"; recordKey: string }
  | { code: "RECRUITING_DIGEST_FAILED" }
  | { code: "RECRUITING_RETENTION_FAILED"; key?: { pk: string; sk: string } }
  | {
      code:
        | "APPROVAL_DM_SKIPPED"
        | "APPROVAL_DM_FAILED"
        | "CANDIDATE_SAVE_FAILED"
        | "CANDIDATE_NOT_FOUND"
        | "RECRUITING_MEMBER_LOOKUP_FAILED"
        | "RECRUITING_EDIT_DENIED"
        | "SUBMISSION_NOTE_CLEANUP_FAILED";
      threadId: string;
    }
  | {
      code: "RECRUITING_AUDIT_UNAVAILABLE" | "DEPARTURE_CLAIM_RELEASE_FAILED";
      guildId: string;
    };

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
      ...(failure.code === "APPROVAL_DM_SKIPPED" ||
      failure.code === "APPROVAL_DM_FAILED"
        ? { message: `${failure.code}:${failure.threadId}` }
        : {}),
    }),
  );
}
