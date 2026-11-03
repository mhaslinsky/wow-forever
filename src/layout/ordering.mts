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
