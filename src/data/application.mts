import type { CharacterDeclaration } from "./recruiting.mts";

type RaidRole = CharacterDeclaration["raidRole"];
const damage: RaidRole[] = ["Damage"];
const healer: RaidRole[] = ["Healer"];
const tank: RaidRole[] = ["Tank"];
export const classes: Record<string, Record<string, RaidRole[]>> = {
  Druid: { Balance: damage, Feral: ["Tank", "Damage"], Restoration: healer },
  Hunter: { "Beast Mastery": damage, Marksmanship: damage, Survival: damage },
  Mage: { Arcane: damage, Fire: damage, Frost: damage },
  Paladin: { Holy: healer, Protection: tank, Retribution: damage },
  Priest: { Discipline: healer, Holy: healer, Shadow: damage },
  Rogue: { Assassination: damage, Combat: damage, Subtlety: damage },
  Shaman: { Elemental: damage, Enhancement: damage, Restoration: healer },
  Warlock: { Affliction: damage, Demonology: damage, Destruction: damage },
  Warrior: { Arms: damage, Fury: damage, Protection: tank },
};

export function specsFor(characterClass: string) {
  return Object.hasOwn(classes, characterClass)
    ? classes[characterClass]
    : undefined;
}
export function rolesFor(characterClass: string, spec: string) {
  const specs = specsFor(characterClass);
  return specs && Object.hasOwn(specs, spec) ? specs[spec] : undefined;
}
export const NIGHTS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];
export type Application = {
  offspecs: string[];
  nights: string[];
  raidHistory: string;
  logsUrl: string;
  about: string;
};
export function applicationAnswers(
  raw: unknown,
  character: CharacterDeclaration | undefined,
): raw is Application {
  if (!raw || typeof raw !== "object" || !character) return false;
  const value = raw as Application;
  const otherSpecs = Object.keys(specsFor(character.class) ?? {}).filter(
    (spec) => spec !== character.spec,
  );
  return (
    Array.isArray(value.offspecs) &&
    value.offspecs.every((spec) => otherSpecs.includes(spec)) &&
    new Set(value.offspecs).size === value.offspecs.length &&
    Array.isArray(value.nights) &&
    value.nights.length > 0 &&
    value.nights.every((night) => NIGHTS.includes(night)) &&
    new Set(value.nights).size === value.nights.length &&
    typeof value.raidHistory === "string" &&
    !!value.raidHistory.trim() &&
    value.raidHistory.length <= 700 &&
    typeof value.about === "string" &&
    value.about.length <= 500 &&
    typeof value.logsUrl === "string" &&
    value.logsUrl.length <= 300 &&
    (!value.logsUrl || validLogsUrl(value.logsUrl))
  );
}
export function validLogsUrl(value: string): boolean {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}
