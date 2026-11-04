export type RecruitingFailure = {
  code: "CANDIDATE_SAVE_FAILED" | "CANDIDATE_NOT_FOUND";
  threadId: string;
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
    }),
  );
}
