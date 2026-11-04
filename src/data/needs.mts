import { classes } from "./application.mts";

export type Targets = {
  roles: Record<string, number>;
  classes: Record<string, number>;
};
export const DEFAULT_TEAM = "Team 1";
export const DEFAULT_TARGETS: Targets = {
  roles: { Tank: 2, Healer: 4, Damage: 14 },
  classes: {},
};
export function targetsValid(raw: unknown): raw is Targets {
  if (!raw || typeof raw !== "object") return false;
  const value = raw as Targets;
  return (
    (["roles", "classes"] as const).every((group) => {
      const counts = value[group];
      return (
        counts &&
        typeof counts === "object" &&
        !Array.isArray(counts) &&
        Object.entries(counts).every(
          ([name, count]) =>
            (group === "roles"
              ? ["Tank", "Healer", "Damage"].includes(name)
              : Object.hasOwn(classes, name)) &&
            Number.isInteger(count) &&
            count >= 0 &&
            count <= 40,
        )
      );
    }) &&
    Object.values(value.roles).reduce((total, count) => total + count, 0) <= 40
  );
}
export function parseTargets(text: string): Targets {
  const value: unknown = JSON.parse(text);
  if (!targetsValid(value)) throw new Error("INVALID_TARGETS");
  return value;
}
