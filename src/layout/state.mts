import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { dirname, resolve } from "node:path";
import type { ChannelType, IdMap, State } from "./types.mts";
import { channelTypes } from "./types.mts";

export type UncertainCreate =
  | { kind: "role"; key: string; name: string }
  | {
      kind: "channel";
      key: string;
      name: string;
      type: ChannelType;
      parentKey?: string;
    };
export type LayoutState = State & { uncertainCreates: UncertainCreate[] };
export type PlanBinding = {
  guildId: string;
  layoutHash: string;
  stateHash: string;
};
export type SavedPlan = PlanBinding & { schemaVersion: 1; plan: unknown };
export type LockOwner = { pid: number; startedAt: string };

export class StateLockError extends Error {
  readonly path: string;
  readonly status: "active" | "stale" | "unknown";
  readonly owner?: LockOwner;

  constructor(
    path: string,
    status: "active" | "stale" | "unknown",
    owner?: LockOwner,
  ) {
    super(`State lock ${status}: ${path}`);
    this.name = "StateLockError";
    this.path = path;
    this.status = status;
    this.owner = owner;
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected an object");
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error("Expected a nonempty string");
  return value;
}

function idEntries(value: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record(value)).map(([key, id]) => [text(key), text(id)]),
  );
}

function parseUncertain(value: unknown): UncertainCreate {
  const entry = record(value);
  const key = text(entry.key);
  const name = text(entry.name);
  if (entry.kind === "role") return { kind: "role", key, name };
  if (
    entry.kind !== "channel" ||
    !channelTypes.includes(entry.type as ChannelType)
  )
    throw new Error("Invalid uncertain create");
  return {
    kind: "channel",
    key,
    name,
    type: entry.type as ChannelType,
    ...(entry.parentKey === undefined
      ? {}
      : { parentKey: text(entry.parentKey) }),
  };
}

function uniqueIds(ids: IdMap) {
  const seen = new Set<string>();
  for (const entries of [ids.roles, ids.channels, ...Object.values(ids.tags)])
    for (const id of Object.values(entries)) {
      if (seen.has(id)) throw new Error(`Duplicate Discord ID: ${id}`);
      seen.add(id);
    }
}

export function parseState(value: unknown): LayoutState {
  const entry = record(value);
  if (entry.schemaVersion !== 1) throw new Error("Unsupported state version");
  const rawIds = record(entry.ids);
  const ids: IdMap = {
    roles: idEntries(rawIds.roles),
    channels: idEntries(rawIds.channels),
    tags: Object.fromEntries(
      Object.entries(record(rawIds.tags)).map(([key, tags]) => [
        text(key),
        idEntries(tags),
      ]),
    ),
  };
  uniqueIds(ids);
  // Version 1 predates recovery records; an omitted list means no pending create.
  const pending =
    entry.uncertainCreates === undefined ? [] : entry.uncertainCreates;
  if (!Array.isArray(pending)) throw new Error("Invalid uncertain creates");
  const uncertainCreates = pending.map(parseUncertain);
  const seen = new Set<string>();
  for (const pendingCreate of uncertainCreates) {
    const identity = JSON.stringify([pendingCreate.kind, pendingCreate.key]);
    if (seen.has(identity)) throw new Error("Duplicate uncertain create");
    seen.add(identity);
  }
  return {
    schemaVersion: 1,
    guildId: text(entry.guildId),
    ids,
    uncertainCreates,
  };
}

export function emptyState(guildId: string): LayoutState {
  return {
    schemaVersion: 1,
    guildId: text(guildId),
    ids: { roles: {}, channels: {}, tags: {} },
    uncertainCreates: [],
  };
}

export function loadState(path: string): LayoutState {
  return parseState(JSON.parse(fs.readFileSync(path, "utf8")));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}

export function contentHash(value: unknown): string {
  const json = JSON.stringify(canonical(value));
  if (json === undefined) throw new Error("Cannot hash an absent value");
  return createHash("sha256").update(json).digest("hex");
}

function atomicWrite(path: string, value: unknown) {
  const json = `${JSON.stringify(value, null, 2)}\n`;
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const descriptor = fs.openSync(temporary, "wx", 0o600);
  try {
    try {
      fs.writeFileSync(descriptor, json, "utf8");
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporary, path);
    const directory = fs.openSync(dirname(path), "r");
    try {
      fs.fsyncSync(directory);
    } finally {
      fs.closeSync(directory);
    }
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "State write and cleanup failed",
      );
    }
    throw error;
  }
}

function lockConflict(path: string): StateLockError {
  let owner: LockOwner;
  try {
    const entry = record(JSON.parse(fs.readFileSync(path, "utf8")));
    if (
      !Number.isSafeInteger(entry.pid) ||
      (entry.pid as number) <= 0 ||
      !Number.isFinite(Date.parse(text(entry.startedAt)))
    )
      throw new Error("Invalid lock owner");
    owner = { pid: entry.pid as number, startedAt: entry.startedAt as string };
  } catch {
    return new StateLockError(path, "unknown");
  }
  try {
    process.kill(owner.pid, 0);
    return new StateLockError(path, "active", owner);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return new StateLockError(
      path,
      code === "ESRCH" ? "stale" : code === "EPERM" ? "active" : "unknown",
      owner,
    );
  }
}

export type LockedState = {
  read(): LayoutState;
  write(state: LayoutState | State): void;
  savePlan(path: string, binding: PlanBinding, plan: unknown): void;
};

export async function withStateLock<Result>(
  path: string,
  action: (state: LockedState) => Result | Promise<Result>,
): Promise<Result> {
  path = resolve(path);
  fs.mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lockPath = `${path}.lock`;
  let descriptor: number;
  try {
    descriptor = fs.openSync(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw lockConflict(lockPath);
  }
  let active = true;
  const requireLock = () => {
    if (!active) throw new Error("State lock released");
  };
  try {
    fs.writeFileSync(
      descriptor,
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );
    fs.fsyncSync(descriptor);
    return await action({
      read: () => {
        requireLock();
        return loadState(path);
      },
      write: (state) => {
        requireLock();
        atomicWrite(path, parseState(state));
      },
      savePlan: (planPath, binding, plan) => {
        requireLock();
        planPath = resolve(planPath);
        if (planPath === path || planPath === lockPath)
          throw new Error("Plan path overlaps state or lock");
        validateBinding(binding);
        if (plan === undefined || plan === null)
          throw new Error("Missing saved plan");
        atomicWrite(planPath, { schemaVersion: 1, ...binding, plan });
      },
    });
  } finally {
    active = false;
    try {
      fs.closeSync(descriptor);
    } finally {
      fs.unlinkSync(lockPath);
    }
  }
}

function validateBinding(binding: PlanBinding) {
  text(binding.guildId);
  for (const hash of [binding.layoutHash, binding.stateHash])
    if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash))
      throw new Error("Invalid plan hash");
}

export function loadSavedPlan(path: string, expected: PlanBinding): SavedPlan {
  validateBinding(expected);
  const entry = record(JSON.parse(fs.readFileSync(path, "utf8")));
  if (entry.schemaVersion !== 1) throw new Error("Unsupported plan version");
  for (const key of ["guildId", "layoutHash", "stateHash"] as const)
    if (entry[key] !== expected[key])
      throw new Error(`Saved plan ${key} differs`);
  if (!("plan" in entry) || entry.plan === null)
    throw new Error("Missing saved plan");
  return { schemaVersion: 1, ...expected, plan: entry.plan };
}
