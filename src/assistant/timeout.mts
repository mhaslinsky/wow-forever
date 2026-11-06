import { authority, type Principal } from "../auth/index.mts";
import { assistantRoleIds } from "./runtime.mts";

type Member = {
  user: { id: string; username?: string; global_name?: string; bot?: boolean };
  nick?: string | null;
  roles: string[];
};
function member(value: unknown): Member {
  if (!value || typeof value !== "object") throw new Error("INVALID_MEMBER");
  const raw = value as Member;
  if (
    !raw.user ||
    typeof raw.user.id !== "string" ||
    !raw.user.id ||
    (raw.user.bot !== undefined && typeof raw.user.bot !== "boolean") ||
    !Array.isArray(raw.roles) ||
    !raw.roles.every((role) => typeof role === "string")
  )
    throw new Error("INVALID_MEMBER");
  return raw;
}

export async function timeoutReply(
  actor: Principal<"user">,
  question: string,
  ports: {
    guildId: string;
    get(path: string): Promise<unknown>;
    patch?(path: string, body: unknown, signal: AbortSignal): Promise<unknown>;
    now(): number;
    report(reason: string): void;
  },
  signal: AbortSignal,
): Promise<string | undefined> {
  const request =
    /^[,.\s]*(?:please\s+)?(?:timeout|time\s+out)\b\s*([\s\S]*)$/i.exec(
      question,
    );
  if (!request || !authority(actor).roles.includes("Officer")) return;
  const input = (request[1] ?? "").replace(/\s+please[.!?]*$/i, "").trim();
  const duration =
    /\s+for\s+(-?\d+(?:\.\d+)?)\s*(?:minutes?|mins?)[.!?]*$/i.exec(input);
  const target = (duration ? input.slice(0, duration.index) : input).trim();
  const minutes = Math.max(1, Math.min(10, Number(duration?.[1] ?? 5)));
  const mention = /^<@!?(\d+)>[.!?]*$/.exec(target);
  if (!target || (!mention && /[<>]|\b(?:for|minutes?|mins?)\b/i.test(target)))
    return "Give me an @mention.";
  const path = `/guilds/${encodeURIComponent(ports.guildId)}`;
  try {
    const roleId = assistantRoleIds(await ports.get(`${path}/roles`));
    const requesterId = authority(actor).userId;
    const requester = member(
      await ports.get(`${path}/members/${encodeURIComponent(requesterId)}`),
    );
    if (requester.user.id !== requesterId) throw new Error("INVALID_MEMBER");
    const gmRole = roleId("GM");
    const officerRole = roleId("Officer");
    const requesterIsGM = requester.roles.includes(gmRole);
    const guild = await ports.get(path);
    if (
      !guild ||
      typeof guild !== "object" ||
      !("owner_id" in guild) ||
      typeof guild.owner_id !== "string" ||
      !guild.owner_id
    )
      throw new Error("INVALID_GUILD");
    let selected: Member;
    if (mention) {
      selected = member(await ports.get(`${path}/members/${mention[1]}`));
      if (selected.user.id !== mention[1]) throw new Error("INVALID_MEMBER");
    } else {
      const members = new Map<string, Member>();
      let after = "";
      for (;;) {
        const page = await ports.get(
          `${path}/members?limit=1000${after ? `&after=${encodeURIComponent(after)}` : ""}`,
        );
        if (!Array.isArray(page) || page.length > 1000)
          throw new Error("INVALID_MEMBERS");
        for (const value of page) {
          const candidate = member(value);
          members.set(candidate.user.id, candidate);
        }
        if (page.length < 1000) break;
        const next = member(page.at(-1)).user.id;
        if (next === after) throw new Error("INVALID_PAGINATION");
        after = next;
      }
      function matching(name: string): Member[] {
        const equal = (value: unknown) =>
          typeof value === "string" &&
          value.toLowerCase() === name.toLowerCase();
        const candidates = [...members.values()];
        const nicknames = candidates.filter((candidate) =>
          equal(candidate.nick),
        );
        if (nicknames.length) return nicknames;
        return candidates.filter((candidate) =>
          [candidate.user.global_name, candidate.user.username].some(equal),
        );
      }
      let matches = matching(target);
      if (!matches.length) matches = matching(target.replace(/[.!?]+$/, ""));
      if (matches.length !== 1) return "Give me an @mention.";
      selected = matches[0] as Member;
    }
    if (
      selected.user.id === guild.owner_id ||
      selected.user.bot ||
      selected.user.id === authority(actor).userId ||
      selected.roles.includes(gmRole) ||
      (!requesterIsGM && selected.roles.includes(officerRole))
    )
      return "Nice try. That one's off limits.";
    if (!ports.patch) throw new Error("TIMEOUT_UNAVAILABLE");
    await ports.patch(
      `${path}/members/${encodeURIComponent(selected.user.id)}`,
      {
        communication_disabled_until: new Date(
          ports.now() + minutes * 60000,
        ).toISOString(),
      },
      signal,
    );
    return `<@${selected.user.id}> gets ${minutes} minute${minutes === 1 ? "" : "s"} in the quiet corner.`;
  } catch (error) {
    ports.report(error instanceof Error ? error.message : "TIMEOUT_FAILED");
    return "Couldn't land that timeout. Even my slap missed.";
  }
}
