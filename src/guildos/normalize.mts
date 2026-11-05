import { SavedVariablesError } from "./saved-variables.mts";

export type Member = {
  key: string;
  name: string;
  class: string;
  race: string;
  level: number;
  rank: string;
  rankIndex: number;
  avgIlvl: number;
  lastUpdate: number;
  att25: number;
  prefRoles: string[];
  spec?: { tree: string; treeIndex: number; points: number[] };
  main?: string;
  joinedAt?: number;
};
export type Loot = {
  playerKey: string;
  player: string;
  itemId: number;
  itemName: string;
  quality: number;
  timestamp: number;
  raid: string;
};
export type Snapshot = {
  snapshotVersion: 1;
  guildKey: string;
  guildName: string;
  realm: string;
  game: "FOREVER";
  exportedAt: number;
  exportedBy: string;
  addonVersion: string;
  v: 14;
  members: Member[];
  loot: Loot[];
};

type Fields = Record<string, unknown>;
function invalid(path: string): never {
  throw new SavedVariablesError(
    "InvalidPayloadShapeError",
    `Invalid field: ${path}`,
  );
}
function object(value: unknown, path: string): Fields {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid(path);
  return value as Fields;
}
function stringField(fields: Fields, key: string, path: string): string {
  if (typeof fields[key] !== "string") invalid(`${path}.${key}`);
  return fields[key];
}
function numberField(fields: Fields, key: string, path: string): number {
  if (typeof fields[key] !== "number" || !Number.isFinite(fields[key]))
    invalid(`${path}.${key}`);
  return fields[key];
}
function list(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) invalid(path);
  return value;
}
function member(value: unknown, index: number): Member {
  const path = `members[${index}]`;
  const fields = object(value, path);
  const output: Member = {
    key: stringField(fields, "key", path),
    name: stringField(fields, "name", path),
    class: stringField(fields, "class", path),
    race: stringField(fields, "race", path),
    level: numberField(fields, "level", path),
    rank: stringField(fields, "rank", path),
    rankIndex: numberField(fields, "rankIndex", path),
    avgIlvl: numberField(fields, "avgIlvl", path),
    lastUpdate: numberField(fields, "lastUpdate", path),
    att25: numberField(fields, "att25", path),
    prefRoles: list(fields.prefRoles, `${path}.prefRoles`).map((role) => {
      if (typeof role !== "string") invalid(`${path}.prefRoles`);
      return role;
    }),
  };
  if (Object.hasOwn(fields, "main"))
    output.main = stringField(fields, "main", path);
  if (Object.hasOwn(fields, "joinedAt"))
    output.joinedAt = numberField(fields, "joinedAt", path);
  if (Object.hasOwn(fields, "spec")) {
    const specPath = `${path}.spec`;
    const spec = object(fields.spec, specPath);
    output.spec = {
      tree: stringField(spec, "tree", specPath),
      treeIndex: numberField(spec, "treeIndex", specPath),
      points: list(spec.points, `${specPath}.points`).map((points) => {
        if (typeof points !== "number" || !Number.isFinite(points))
          invalid(`${specPath}.points`);
        return points;
      }),
    };
  }
  return output;
}
function lootEntry(value: unknown, index: number): Loot {
  const path = `loot[${index}]`;
  const fields = object(value, path);
  return {
    playerKey: stringField(fields, "playerKey", path),
    player: stringField(fields, "player", path),
    itemId: numberField(fields, "itemId", path),
    itemName: stringField(fields, "itemName", path),
    quality: numberField(fields, "quality", path),
    timestamp: numberField(fields, "timestamp", path),
    raid: stringField(fields, "raid", path),
  };
}

export function normalize(payload: unknown): Snapshot {
  const fields = object(payload, "payload");
  if (fields.fmt !== "GOSCOMP1")
    throw new SavedVariablesError(
      "UnsupportedFormatError",
      "Expected GOSCOMP1 format",
    );
  if (fields.v !== 14)
    throw new SavedVariablesError(
      "UnsupportedPayloadVersionError",
      "Expected payload version 14",
    );
  if (fields.game !== "FOREVER")
    throw new SavedVariablesError(
      "UnsupportedGameError",
      "Expected FOREVER game",
    );
  const members = list(fields.members, "members").map(member);
  if (fields.count !== members.length)
    throw new SavedVariablesError(
      "MemberCountMismatchError",
      "Member count does not match members",
    );
  return {
    snapshotVersion: 1,
    guildKey: stringField(fields, "guildKey", "payload"),
    guildName: stringField(fields, "guildName", "payload"),
    realm: stringField(fields, "realm", "payload"),
    game: "FOREVER",
    exportedAt: numberField(fields, "exportedAt", "payload"),
    exportedBy: stringField(fields, "exportedBy", "payload"),
    addonVersion: stringField(fields, "addonVersion", "payload"),
    v: 14,
    members,
    loot: list(fields.loot, "loot").map(lootEntry),
  };
}
