import type { createDataAccess } from "../data/index.mts";
import { recordKey } from "../data/records.mts";

type ObjectValue = Record<string, unknown>;
export type SignUp = {
  userId: string;
  className: string;
  specName: string;
  roleName: string;
  status: "primary" | "secondary" | "queued";
};
export type RaidSignUps = { id: string; startTime: number; signUps: SignUp[] };
export type RaidHelper = { events(): Promise<RaidSignUps[]> };
type Writer = Pick<
  ReturnType<ReturnType<typeof createDataAccess>["forSystem"]>,
  "write"
>;

function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("RAID_HELPER_INVALID_RESPONSE");
  return value as ObjectValue;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value)
    throw new Error("RAID_HELPER_INVALID_RESPONSE");
  return value;
}
function optionalText(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value !== "string")
    throw new Error("RAID_HELPER_INVALID_RESPONSE");
  return value;
}
function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new Error("RAID_HELPER_INVALID_RESPONSE");
  return value;
}
function event(value: unknown, expectedId: string): RaidSignUps {
  const raw = object(value);
  if (text(raw.id) !== expectedId || !Array.isArray(raw.signUps))
    throw new Error("RAID_HELPER_INVALID_RESPONSE");
  return {
    id: expectedId,
    startTime: number(raw.startTime),
    signUps: raw.signUps.map((value: unknown) => {
      const signup = object(value);
      if (
        signup.status !== "primary" &&
        signup.status !== "secondary" &&
        signup.status !== "queued"
      )
        throw new Error("RAID_HELPER_INVALID_RESPONSE");
      return {
        userId: text(signup.userId),
        className: text(signup.className),
        specName: optionalText(signup.specName),
        roleName: optionalText(signup.roleName),
        status: signup.status,
      };
    }),
  };
}

export function createRaidHelper(config: {
  guildId: string;
  apiKey(): Promise<string>;
  http?: typeof fetch;
}): RaidHelper {
  const http = config.http ?? fetch;
  if (!config.guildId) throw new Error("RAID_HELPER_GUILD_REQUIRED");
  return {
    async events() {
      const key = await config.apiKey();
      if (!key.trim() || key === "None")
        throw new Error("RAID_HELPER_KEY_REQUIRED");
      async function get(path: string, page?: number): Promise<unknown> {
        const response = await http(`https://raid-helper.xyz/api/${path}`, {
          headers: {
            Authorization: key,
            ...(page ? { Page: String(page), IncludeSignUps: "true" } : {}),
          },
          signal: AbortSignal.timeout(15_000),
          redirect: "error",
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`RAID_HELPER_HTTP_${response.status}`);
        }
        return response.json();
      }
      const events: RaidSignUps[] = [];
      let pages = 1;
      for (let page = 1; page <= pages; page++) {
        const result = object(
          await get(
            `v4/servers/${encodeURIComponent(config.guildId)}/events`,
            page,
          ),
        );
        pages = number(result.pages);
        if (
          !Number.isInteger(pages) ||
          (pages < page &&
            !(
              page === 1 &&
              pages === 0 &&
              Array.isArray(result.postedEvents) &&
              result.postedEvents.length === 0
            )) ||
          result.currentPage !== page ||
          !Array.isArray(result.postedEvents)
        )
          throw new Error("RAID_HELPER_INVALID_RESPONSE");
        for (const summary of result.postedEvents) {
          const id = text(object(summary).id);
          events.push(event(summary, id));
        }
      }
      return events;
    },
  };
}

export function createSignUpPoller(config: {
  guildId: string;
  api: RaidHelper;
  data: Writer;
  report(code: string): void;
  now?: () => number;
}) {
  return async () => {
    try {
      const events = await config.api.events();
      const polledAt = new Date((config.now ?? Date.now)()).toISOString();
      for (const raid of events) {
        await config.data.write({
          ...recordKey("signup", config.guildId, raid.id),
          kind: "signup",
          ownerId: config.guildId,
          raidId: raid.id,
          startTime: String(raid.startTime),
          signUps: JSON.stringify(raid.signUps),
          polledAt,
        });
      }
      return { raids: events.length };
    } catch {
      config.report("SIGNUP_POLL_FAILED");
      throw new Error("SIGNUP_POLL_FAILED");
    }
  };
}
