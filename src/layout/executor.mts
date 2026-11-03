import { PermissionFlagsBits as flags } from "discord.js";
import { executeOperation, pendingCandidates } from "./execute-operation.mts";
import { adoptionCandidates } from "./inventory.mts";
import { comparePosition } from "./ordering.mts";
import { plan } from "./plan.mts";
import { readback } from "./readback.mts";
import type { LayoutState, LockedState } from "./state.mts";
import { contentHash, loadSavedPlan, withStateLock } from "./state.mts";
import type { DiscordPort, Target } from "./transport.mts";
import { fetchSnapshot, LayoutTransportError } from "./transport.mts";
import type { Layout, Operation, Snapshot } from "./types.mts";

export function inspectPlan(
  layout: Layout,
  snapshot: Snapshot,
  state: LayoutState,
) {
  const result = plan(layout, snapshot, state.ids);
  result.errors.push(...pendingCandidates(state, snapshot));
  result.ok &&= result.errors.length === 0;
  return result;
}
export function planBinding(
  layout: Layout,
  state: LayoutState,
  result: unknown,
) {
  return {
    guildId: state.guildId,
    layoutHash: contentHash(layout),
    stateHash: contentHash(state),
    planHash: contentHash(result),
  };
}
export function preflight(
  layout: Layout,
  snapshot: Snapshot,
  state: LayoutState,
  target: Target,
) {
  if (state.guildId !== target.guildId || snapshot.guildId !== target.guildId)
    throw new Error("Target guild differs");
  if (snapshot.applicationId !== target.applicationId)
    throw new Error("Operator application differs");
  const operator = snapshot.roles.find(
    (role) => role.applicationId === target.applicationId,
  );
  const everyone = snapshot.roles.find((role) => role.id === target.guildId);
  if (!operator || !everyone)
    throw new Error("Missing operator or everyone role");
  const permissions =
    BigInt(operator.permissions) | BigInt(everyone.permissions);
  if (
    !(permissions & flags.Administrator) &&
    (permissions & (flags.ManageRoles | flags.ManageChannels)) !==
      (flags.ManageRoles | flags.ManageChannels)
  )
    throw new Error("Operator lacks ManageRoles or ManageChannels");
  for (const role of layout.roles) {
    const live = snapshot.roles.find(
      (entry) => entry.id === state.ids.roles[role.key],
    );
    if (
      role.kind === "managed" &&
      live &&
      (live.managed || comparePosition(live, operator, "role") >= 0)
    )
      throw new Error(`Uneditable role: ${role.key}`);
  }
}

export function adopt(
  layout: Layout,
  snapshot: Snapshot,
  state: LayoutState,
): LayoutState {
  if (snapshot.guildId !== state.guildId)
    throw new Error("Target guild differs");
  const ids = adoptionCandidates(layout, snapshot, state.ids);
  for (const pending of state.uncertainCreates) {
    const candidates = pendingCandidates(
      { ...state, uncertainCreates: [pending] },
      snapshot,
    );
    if (
      candidates.length &&
      !(pending.kind === "role"
        ? ids.roles[pending.key]
        : ids.channels[pending.key])
    )
      throw new Error(`Cannot adopt uncertain create: ${pending.key}`);
  }
  return { ...state, ids, uncertainCreates: [] };
}

export type ApplyResult = {
  ok: boolean;
  completed: Operation[];
  error?: string;
  errorKind?: LayoutTransportError["kind"];
  retryAfterMs?: number;
  readback?: ReturnType<typeof readback>;
  readbackError?: string;
  remaining?: ReturnType<typeof inspectPlan>;
};
type ApplyOptions = Target & {
  layout: Layout;
  statePath: string;
  planPath: string;
  allowDelete: boolean;
  port: DiscordPort;
};
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export async function applyLocked(
  options: ApplyOptions,
  locked: LockedState,
): Promise<ApplyResult> {
  const result: ApplyResult = { ok: false, completed: [] };
  let state: LayoutState | undefined;
  try {
    state = locked.read();
    const snapshot = await fetchSnapshot(options.port, options);
    preflight(options.layout, snapshot, state, options);
    const fresh = inspectPlan(options.layout, snapshot, state);
    loadSavedPlan(options.planPath, planBinding(options.layout, state, fresh));
    if (!fresh.ok)
      throw new Error(
        `Plan refused: ${fresh.errors.join("; ") || "Untracked objects"}`,
      );
    if (fresh.destructive && !options.allowDelete)
      throw new Error("Destructive changes require --allow-delete");
    for (const operation of fresh.operations) {
      await executeOperation(operation, options.port, options, state, locked);
      result.completed.push(operation);
    }
  } catch (error) {
    result.error = message(error);
    if (error instanceof LayoutTransportError) {
      result.errorKind = error.kind;
      result.retryAfterMs = error.retryAfterMs;
    }
  }
  try {
    const snapshot = await fetchSnapshot(options.port, options);
    state = locked.read();
    result.readback = readback(options.layout, snapshot, state.ids);
    result.remaining = inspectPlan(options.layout, snapshot, state);
    result.ok =
      !result.error &&
      result.readback.ok &&
      result.remaining.ok &&
      result.remaining.operations.length === 0;
  } catch (error) {
    result.readbackError = message(error);
  }
  return result;
}

export async function applyLayout(options: ApplyOptions): Promise<ApplyResult> {
  return withStateLock(options.statePath, (locked) =>
    applyLocked(options, locked),
  );
}
