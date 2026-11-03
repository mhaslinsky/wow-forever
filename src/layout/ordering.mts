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
  ceiling = Infinity,
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
  const positions = new Set(
    held.filter((position) => !reserved.has(position) && position < ceiling),
  );
  let candidate = 0;
  while (positions.size < targets.length) {
    if (candidate >= ceiling || !Number.isSafeInteger(candidate))
      throw new Error("No editable reorder positions");
    if (!reserved.has(candidate)) positions.add(candidate);
    candidate++;
  }
  return [...positions].sort((left, right) => left - right);
}
