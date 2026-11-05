import type { Snapshot } from "../guildos/index.mts";
import { decode, type GuildRecord, recordKey } from "./records.mts";

export type SnapshotHistory = Extract<GuildRecord, { kind: "guildSnapshot" }>;
export type SnapshotLatest = Extract<
  GuildRecord,
  { kind: "guildSnapshotLatest" }
>;
export type IngestOutcome = "stored" | "duplicate" | "stale" | "conflict";
export type SnapshotWrites = {
  insertSnapshot?(item: SnapshotHistory): Promise<void>;
  advanceSnapshot?(item: SnapshotLatest): Promise<void>;
};

// Numbers use DynamoDB's maximum size, so this bound never understates an item.
function itemBytes(value: unknown): number {
  if (typeof value === "string") return Buffer.byteLength(value);
  if (typeof value === "number") return 21;
  if (Array.isArray(value))
    return 3 + value.reduce((size, entry) => size + 1 + itemBytes(entry), 0);
  if (value && typeof value === "object")
    return (
      3 +
      Object.entries(value).reduce(
        (size, [name, entry]) =>
          size + Buffer.byteLength(name) + 1 + itemBytes(entry),
        0,
      )
    );
  throw new Error("INVALID_SNAPSHOT_ITEM");
}

export async function ingestSnapshot(
  storage: SnapshotWrites,
  input: {
    snapshot: Snapshot;
    snapshotId: string;
    receivedAt: number;
    writtenAt: number;
  },
) {
  const { snapshot, snapshotId } = input;
  const history: SnapshotHistory = {
    ...recordKey(
      "guildSnapshot",
      snapshot.guildKey,
      `${String(snapshot.exportedAt).padStart(16, "0")}#${snapshotId}`,
    ),
    kind: "guildSnapshot",
    ownerId: snapshot.guildKey,
    snapshotId,
    exportedAt: snapshot.exportedAt,
    receivedAt: input.receivedAt,
    writtenAt: input.writtenAt,
    addonVersion: snapshot.addonVersion,
    snapshotVersion: 1,
    snapshot,
  };
  const latest: SnapshotLatest = {
    ...recordKey("guildSnapshotLatest", snapshot.guildKey, "latest"),
    kind: "guildSnapshotLatest",
    ownerId: snapshot.guildKey,
    snapshotId,
    exportedAt: snapshot.exportedAt,
  };
  if (!decode(history)) throw new Error("INVALID_RECORD");
  if (itemBytes(history) > 350 * 1024) throw new Error("SnapshotTooLargeError");
  if (!storage.insertSnapshot || !storage.advanceSnapshot)
    throw new Error("DATA_UNAVAILABLE");
  try {
    await storage.insertSnapshot(history);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      error.name !== "ConditionalCheckFailedException"
    )
      throw error;
  }
  // Reconcile latest even when history exists: a prior attempt may have stopped between writes.
  try {
    await storage.advanceSnapshot(latest);
    return {
      outcome: "stored" as IngestOutcome,
      currentSnapshotId: snapshotId,
      currentExportedAt: snapshot.exportedAt,
    };
  } catch (error) {
    if (
      !(error instanceof Error) ||
      error.name !== "ConditionalCheckFailedException" ||
      !("Item" in error)
    )
      throw error;
    const current = decode(error.Item);
    if (
      !current ||
      current.kind !== "guildSnapshotLatest" ||
      current.ownerId !== latest.ownerId
    )
      throw new Error("DATA_UNAVAILABLE");
    const outcome: IngestOutcome =
      current.snapshotId === snapshotId &&
      current.exportedAt === snapshot.exportedAt
        ? "duplicate"
        : current.exportedAt > snapshot.exportedAt
          ? "stale"
          : current.exportedAt === snapshot.exportedAt
            ? "conflict"
            : (() => {
                throw new Error("DATA_UNAVAILABLE");
              })();
    return {
      outcome,
      currentSnapshotId: current.snapshotId,
      currentExportedAt: current.exportedAt,
    };
  }
}
