import { applicationRecord } from "../data/gow-applications.mts";

export const APPLICATIONS_URL =
  "https://api.guildsofwow.com/management/recruitment-applications";

export function reportCapture(recordKey: string): void {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: "wow-forever/recruiting",
            Dimensions: [[]],
            Metrics: [
              { Name: "GOW_APPLICATION_CAPTURED", Unit: "Count" },
              { Name: "RecruitingError", Unit: "Count" },
            ],
          },
        ],
      },
      GOW_APPLICATION_CAPTURED: 1,
      RecruitingError: 1,
      event: "GOW_APPLICATION_CAPTURED",
      recordKey,
    }),
  );
}

export async function captureApplications(input: {
  guildId: string;
  apiKey: string;
  save: (record: ReturnType<typeof applicationRecord>) => Promise<boolean>;
  fetch?: typeof fetch;
  report?: typeof reportCapture;
  fetched?: (recruits: readonly unknown[]) => void;
}): Promise<{ captured: number }> {
  const response = await (input.fetch ?? fetch)(APPLICATIONS_URL, {
    headers: { Authorization: `Bearer ${input.apiKey}` },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status !== 200) throw new Error("GOW_API_HTTP_FAILED");
  const payload: unknown = await response.json();
  if (
    !payload ||
    typeof payload !== "object" ||
    !("success" in payload) ||
    payload.success !== true ||
    !("data" in payload) ||
    !payload.data ||
    typeof payload.data !== "object" ||
    !("recruits" in payload.data) ||
    !Array.isArray(payload.data.recruits)
  )
    throw new Error("GOW_API_RESPONSE_INVALID");
  input.fetched?.(payload.data.recruits);
  let captured = 0;
  for (const recruit of payload.data.recruits) {
    const record = applicationRecord(input.guildId, recruit);
    if (!(await input.save(record))) continue;
    (input.report ?? reportCapture)(record.sk);
    captured++;
  }
  return { captured };
}
