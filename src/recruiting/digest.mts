import type { createDataAccess } from "../data/index.mts";
import { recordKey } from "../data/records.mts";

export type DigestData = ReturnType<
  ReturnType<typeof createDataAccess>["forSystem"]
>;
export type DigestPorts = {
  data: Pick<DigestData, "query">;
  guildId: string;
  now(): number;
  post(content: string): Promise<void>;
};

export function createOverdueDigest(ports: DigestPorts) {
  return async () => {
    const now = ports.now();
    if (!Number.isFinite(now)) throw new Error("INVALID_DIGEST_CLOCK");
    const records = await ports.data.query(
      recordKey("candidate", ports.guildId, "unused").pk,
    );
    const overdue = records.filter(
      (record) =>
        record.kind === "candidate" &&
        record.recruiting?.nextActionAt !== undefined &&
        !["Accepted", "Declined", "Withdrawn"].includes(
          record.recruiting.stage,
        ) &&
        Date.parse(record.recruiting.nextActionAt) < now,
    );
    if (!overdue.length) {
      await ports.post("Nothing's overdue today.");
      return { overdue: 0 };
    }
    const lines = overdue.map((record) => {
      if (record.kind !== "candidate" || !record.recruiting)
        throw new Error("INVALID_CANDIDATE");
      const state = record.recruiting;
      const owner = state.owner ? `<@${state.owner}>` : "no owner";
      return `<#${state.threadId}>: ${owner}, due <t:${Math.floor(Date.parse(state.nextActionAt as string) / 1000)}:D>`;
    });
    let content = "Overdue candidates";
    for (const line of lines) {
      if (content.length + line.length + 1 > 2000) {
        await ports.post(content);
        content = "Overdue candidates (continued)";
      }
      content += `\n${line}`;
    }
    await ports.post(content);
    return { overdue: overdue.length };
  };
}
