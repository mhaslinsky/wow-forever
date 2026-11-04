export type RecruitingFailure =
  | {
      code:
        | "CANDIDATE_SAVE_FAILED"
        | "CANDIDATE_NOT_FOUND"
        | "RECRUITING_MEMBER_LOOKUP_FAILED"
        | "RECRUITING_EDIT_DENIED";
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
    }),
  );
}
