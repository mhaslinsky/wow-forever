import { PermissionFlagsBits as flags } from "discord.js";
import {
  createCandidates,
  executeOperation,
  pendingCandidates,
} from "./execute-operation.mts";
import { adoptionCandidates } from "./inventory.mts";
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
}

export function adopt(
  layout: Layout,
  snapshot: Snapshot,
  state: LayoutState,
): LayoutState {
  if (snapshot.guildId !== state.guildId)
    throw new Error("Target guild differs");
  const recovering = structuredClone(state);
  for (const pending of recovering.uncertainCreates) {
    const bindings =
      pending.kind === "role" ? recovering.ids.roles : recovering.ids.channels;
    const previous = bindings[pending.key];
    const matches = createCandidates(pending, snapshot, recovering);
    if (matches.some((entry) => entry.id === previous)) continue;
    if (matches.length > 1)
      throw new Error(`Ambiguous adoption: ${pending.key}`);
    if (matches.length === 0) continue;
    const replacement = matches[0].id;
    if (Object.values(bindings).includes(replacement))
      throw new Error(`Ambiguous adoption: ${pending.key}`);
    if (
      previous &&
      (pending.kind === "role" ? snapshot.roles : snapshot.channels).some(
        (entry) => entry.id === previous,
      )
    ) {
      // Keep the replaced object bound until the planner deletes it.
      const retired = `replaced:${pending.key}:${previous}`;
      bindings[retired] = previous;
      if (pending.kind === "channel")
        recovering.ids.tags[retired] = recovering.ids.tags[pending.key] ?? {};
    }
    bindings[pending.key] = replacement;
    if (pending.kind === "channel") recovering.ids.tags[pending.key] = {};
  }
  const ids = adoptionCandidates(layout, snapshot, recovering.ids);
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
    preflight(snapshot, state, options);
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
