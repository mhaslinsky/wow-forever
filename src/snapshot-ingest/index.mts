import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { createSystemPrincipal } from "../auth/index.mts";
import { createDynamoDataAccess } from "../data/index.mts";
import { createSnapshotHttp } from "./http.mts";

const ssm = new SSMClient({ maxAttempts: 1 });
const data = createDynamoDataAccess({
  tableName: process.env.GUILD_TABLE ?? "",
  region: process.env.AWS_REGION ?? "us-east-1",
}).forSystem(createSystemPrincipal(["guildSnapshot", "guildSnapshotLatest"]));
export const handler = createSnapshotHttp({
  now: Date.now,
  guildKey: process.env.GUILDOS_GUILD_KEY,
  ingest: (input) => data.ingestSnapshot(input),
  async readToken() {
    const result = await ssm.send(
      new GetParameterCommand({
        Name: "/wow-forever/reader_token",
        WithDecryption: true,
      }),
    );
    if (!result.Parameter?.Value) throw new Error("Secret unavailable");
    return result.Parameter.Value;
  },
  report(fields) {
    console.log(
      JSON.stringify({
        ...fields,
        _aws: {
          Timestamp: Date.now(),
          CloudWatchMetrics: [
            {
              Namespace: "WowForever/SnapshotIngest",
              Dimensions: [["outcome"]],
              Metrics: [{ Name: "Uploads", Unit: "Count" }],
            },
          ],
        },
        Uploads: 1,
      }),
    );
  },
});
