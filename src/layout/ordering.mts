import type { Snapshot } from "./types.mts";

export function comparePosition(
  left: { id: string; position: number },
  right: { id: string; position: number },
  kind: "role" | "channel",
): number {
  if (left.position !== right.position) return left.position - right.position;
  const numeric = /^\d+$/.test(left.id) && /^\d+$/.test(right.id);
  const first = numeric ? BigInt(left.id) : left.id;
  const second = numeric ? BigInt(right.id) : right.id;
  const order = first < second ? -1 : first > second ? 1 : 0;
  return kind === "role" ? -order : order;
}

export function reorderPositions(
  targets: { id: string; position: number }[],
  siblings: { id: string; position: number }[],
): number[] {
  const held = targets
    .map((entry) => entry.position)
    .sort((left, right) => left - right);
  if (new Set(held).size === held.length) return held;
  const managed = new Set(targets.map((entry) => entry.id));
  const reserved = new Set(
    siblings
      .filter((entry) => !managed.has(entry.id))
      .map((entry) => entry.position),
  );
  const positions = new Set(held.filter((position) => !reserved.has(position)));
  let candidate = 0;
  while (positions.size < targets.length) {
    if (!Number.isSafeInteger(candidate))
      throw new Error("No editable reorder positions");
    if (!reserved.has(candidate)) positions.add(candidate);
    candidate++;
  }
  return [...positions].sort((left, right) => left - right);
}

export function roleOrder(targetIds: string[], snapshot: Snapshot) {
  const operator = snapshot.roles.find(
    (role) => role.applicationId === snapshot.applicationId,
  );
  if (!operator) throw new Error("Missing operator role");
  const targets = new Set(targetIds);
  for (const id of targets) {
    const role = snapshot.roles.find((entry) => entry.id === id);
    if (!role) throw new Error("Missing reorder target");
    if (comparePosition(role, operator, "role") >= 0)
      throw new Error(
        `Server owner: drag ${operator.name} to the top of the role list.`,
      );
  }
  let index = 0;
  return snapshot.roles
    .filter(
      (role) =>
        role.id !== snapshot.guildId &&
        comparePosition(role, operator, "role") < 0,
    )
    .sort((left, right) => comparePosition(left, right, "role"))
    .map((role, rank) => ({
      id: targets.has(role.id) ? targetIds[index++] : role.id,
      position: rank + 1,
    }));
}
