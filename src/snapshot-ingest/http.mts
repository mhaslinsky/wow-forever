import { createHash, timingSafeEqual } from "node:crypto";
import type { createDataAccess } from "../data/index.mts";
import {
  decodeCompanion,
  normalize,
  SavedVariablesError,
} from "../guildos/index.mts";
import type { HttpEvent } from "../interactions/http.mts";

type Ingest = ReturnType<
  ReturnType<typeof createDataAccess>["forSystem"]
>["ingestSnapshot"];
export function createSnapshotHttp(ports: {
  now(): number;
  readToken(): Promise<string>;
  guildKey?: string;
  ingest: Ingest;
  report(fields: Record<string, string | number>): void;
}) {
  let cached: { value: string; until: number } | undefined;
  return async (event: HttpEvent) => {
    const finish = (
      statusCode: number,
      outcome: string,
      error?: string,
      fields: Record<string, string | number> = {},
    ) => {
      ports.report({ outcome, ...fields });
      return {
        statusCode,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(error ? { error } : { outcome }),
      };
    };
    const authorization = Object.entries(event.headers ?? {}).find(
      ([name]) => name.toLowerCase() === "authorization",
    )?.[1];
    if (!authorization?.startsWith("Bearer ") || !authorization.slice(7))
      return finish(401, "unauthorized", "UnauthorizedError");
    try {
      if (!cached || ports.now() >= cached.until) {
        cached = undefined;
        const startedAt = ports.now();
        const value = await ports.readToken();
        if (!value || value === "None") throw new Error("Secret unavailable");
        cached = { value, until: startedAt + 5 * 60 * 1000 };
      }
    } catch {
      return finish(503, "serviceError", "ServiceUnavailableError");
    }
    const digest = (value: string) =>
      createHash("sha256").update(value).digest();
    if (!timingSafeEqual(digest(authorization.slice(7)), digest(cached.value)))
      return finish(401, "unauthorized", "UnauthorizedError");
    if (!ports.guildKey)
      return finish(503, "notConfigured", "IngestNotConfiguredError");
    const body = Buffer.from(
      event.body ?? "",
      event.isBase64Encoded ? "base64" : "utf8",
    );
    if (body.length > 256 * 1024)
      return finish(413, "tooLarge", "RequestTooLargeError");
    let request: { wire: string; writtenAt: number };
    try {
      request = JSON.parse(body.toString("utf8"));
      if (
        !request ||
        typeof request !== "object" ||
        Array.isArray(request) ||
        Object.keys(request).length !== 2 ||
        typeof request.wire !== "string" ||
        !Number.isFinite(request.writtenAt)
      )
        throw new Error("Invalid request");
    } catch {
      return finish(422, "rejected:InvalidRequestError", "InvalidRequestError");
    }
    let snapshot: ReturnType<typeof normalize>;
    try {
      snapshot = normalize(decodeCompanion({ __companion: request.wire }));
      if (!Number.isSafeInteger(snapshot.exportedAt) || snapshot.exportedAt < 0)
        throw new SavedVariablesError(
          "InvalidPayloadShapeError",
          "Invalid exportedAt",
        );
      if (snapshot.guildKey !== ports.guildKey)
        throw new SavedVariablesError("WrongGuildError", "Wrong guild");
      if (snapshot.exportedAt > Math.floor(ports.now() / 1000) + 15 * 60)
        throw new SavedVariablesError("FutureExportError", "Future export");
    } catch (error) {
      if (!(error instanceof SavedVariablesError))
        return finish(503, "serviceError", "ServiceUnavailableError");
      return finish(422, `rejected:${error.name}`, error.name);
    }
    const snapshotId = createHash("sha256").update(request.wire).digest("hex");
    const fields = {
      snapshotId,
      exportedAt: snapshot.exportedAt,
      memberCount: snapshot.members.length,
      lootCount: snapshot.loot.length,
    };
    try {
      const { outcome, ...current } = await ports.ingest({
        snapshot,
        snapshotId,
        writtenAt: request.writtenAt,
        receivedAt: ports.now(),
      });
      return finish(200, outcome, undefined, { ...fields, ...current });
    } catch (error) {
      return error instanceof Error && error.message === "SnapshotTooLargeError"
        ? finish(413, "tooLarge", "SnapshotTooLargeError", fields)
        : finish(503, "serviceError", "ServiceUnavailableError", fields);
    }
  };
}
