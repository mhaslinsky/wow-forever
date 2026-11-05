export function characterIdentity(name: string, fallbackRealm: string): string {
  const [character, ...realm] = name.trim().toLowerCase().split("-");
  return `${character}-${(realm.join("-") || fallbackRealm).toLowerCase().replaceAll(" ", "")}`;
}
