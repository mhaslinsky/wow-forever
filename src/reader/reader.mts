import {
  decodeCompanion,
  normalize,
  parseSavedVariables,
} from "../guildos/index.mts";

export type Status = {
  lastSuccess?: { at: number; outcome: string };
  lastFailure?: { at: number; error: string };
  pendingRetryAt?: number;
};
export type Snapshot = { wire: string; writtenAt: number };
export type Clock = {
  now(): number;
  schedule(callback: () => void, delay: number): () => void;
};
export function createReader(
  ports: {
    clock: Clock;
    read(): Promise<{ text: string; writtenAt: number }>;
    upload(
      snapshot: Snapshot,
    ): Promise<{ status: number; outcome?: string; error?: string }>;
    save(status: Status): void;
  },
  status: Status = {},
) {
  let generation = 0;
  let cancel: (() => void) | undefined;
  let pending: Snapshot | undefined;
  let attempts = 0;
  const save = () => ports.save(structuredClone(status));
  const failure = (error: string) => {
    status.lastFailure = { at: ports.clock.now(), error };
  };
  async function upload(version: number) {
    if (!pending || version !== generation) return;
    delete status.pendingRetryAt;
    let retry = false;
    try {
      const result = await ports.upload(pending);
      if (version !== generation) return;
      if (
        result.status === 200 &&
        ["stored", "duplicate", "stale"].includes(result.outcome ?? "")
      ) {
        status.lastSuccess = {
          at: ports.clock.now(),
          outcome: result.outcome as string,
        };
        pending = undefined;
      } else {
        failure(result.error ?? result.outcome ?? `Http${result.status}Error`);
        retry = result.status >= 500;
        if (!retry) pending = undefined;
      }
    } catch (error) {
      if (version !== generation) return;
      failure(error instanceof Error ? error.name : "UploadError");
      retry = true;
    }
    if (retry) {
      const delay = Math.min(5000 * 2 ** Math.min(attempts++, 6), 300000);
      status.pendingRetryAt = ports.clock.now() + delay;
      cancel = ports.clock.schedule(() => {
        void upload(version);
      }, delay);
    }
    save();
  }
  async function read(version: number) {
    try {
      const file = await ports.read();
      if (version !== generation) return;
      const database = parseSavedVariables(file.text);
      normalize(decodeCompanion(database));
      pending = {
        wire: database.__companion as string,
        writtenAt: file.writtenAt,
      };
    } catch (error) {
      if (version !== generation) return;
      failure(error instanceof Error ? error.name : "ReadError");
      save();
      return;
    }
    await upload(version);
  }
  return {
    changed() {
      generation++;
      const version = generation;
      cancel?.();
      pending = undefined;
      attempts = 0;
      delete status.pendingRetryAt;
      save();
      cancel = ports.clock.schedule(() => {
        void read(version);
      }, 1000);
    },
    stop() {
      generation++;
      cancel?.();
    },
  };
}
