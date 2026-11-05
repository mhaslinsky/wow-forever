import { createSystemPrincipal } from "../auth/index.mts";
import {
  type createDataAccess,
  createDynamoDataAccess,
} from "../data/index.mts";
import { recordKey } from "../data/records.mts";

export const HISTORY_WINDOW_MS = 43200000;
export function createMemoryReplies(
  data: ReturnType<typeof createDataAccess>,
  now: () => number = Date.now,
) {
  const system = data.forSystem(createSystemPrincipal(["memoryReply"]));
  return {
    async mark(ownerId: string, messageId: string, deliveryBudgetMs = 0) {
      if (!ownerId || !messageId) throw new Error("INVALID_MEMORY_REPLY");
      await system.write({
        ...recordKey("memoryReply", ownerId, messageId),
        kind: "memoryReply",
        ownerId,
        messageId,
        expiresAt: Math.ceil(
          (now() + HISTORY_WINDOW_MS + deliveryBudgetMs) / 1000,
        ),
      });
    },
    async hidden(ownerId: string, messageId: string) {
      const rows = await system.get(
        recordKey("memoryReply", ownerId, messageId),
      );
      return rows.some(
        (row) => row.kind === "memoryReply" && row.expiresAt * 1000 > now(),
      );
    },
  };
}
export function runtimeMemoryReplies() {
  return createMemoryReplies(
    createDynamoDataAccess({
      tableName: process.env.GUILD_TABLE ?? "wow-forever",
      region: "us-east-1",
    }),
  );
}
