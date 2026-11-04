import type { Client, ClientEvents } from "discord.js";

export type Handlers = {
  [Event in keyof ClientEvents]?: (
    ...args: ClientEvents[Event]
  ) => Promise<void>;
};
export const handlers: Handlers = {};
export type Metric = (name: "Heartbeat" | "HandlerError") => Promise<void>;
export type Log = (record: Readonly<Record<string, unknown>>) => void;

export function tokenValue(value: string | undefined): string {
  if (!value?.trim() || value.trim() === "None")
    throw new StartupError("TOKEN_NOT_CONFIGURED");
  return value;
}

export function attachGateway(
  client: Client,
  registry: Handlers,
  metric: Metric,
  log: Log,
  now = Date.now,
) {
  const gaps = new Map<number, number>();
  const ready = new Set<number>();
  const report = async (name: "Heartbeat" | "HandlerError") => {
    try {
      await metric(name);
    } catch {
      log({ event: "metric_failed", metric: name });
    }
  };
  const connected = (shard: number, outcome: "resumed" | "re-identified") => {
    ready.add(shard);
    const start = gaps.get(shard);
    if (start !== undefined) {
      log({
        event: "gateway_gap",
        shard,
        disconnectedAt: new Date(start).toISOString(),
        connectedAt: new Date(now()).toISOString(),
        outcome,
      });
      gaps.delete(shard);
    }
  };
  const disconnected = (shard: number) => {
    ready.delete(shard);
    if (!gaps.has(shard)) {
      gaps.set(shard, now());
      log({
        event: "gateway_disconnected",
        shard,
        disconnectedAt: new Date(now()).toISOString(),
      });
    }
  };
  client.on("shardDisconnect", (_event, shard) => disconnected(shard));
  client.on("shardReconnecting", disconnected);
  client.on("shardReady", (shard) => connected(shard, "re-identified"));
  client.on("shardResume", (shard) => connected(shard, "resumed"));
  client.on("error", () => log({ event: "gateway_error" }));
  client.on("shardError", () => log({ event: "gateway_error" }));
  function register<Event extends keyof ClientEvents>(event: Event) {
    const handler = registry[event];
    if (!handler) return;
    client.on(event, (...args: ClientEvents[Event]) => {
      void (async () => {
        try {
          await handler(...args);
        } catch {
          log({ event: "handler_failed" });
          await report("HandlerError");
        }
      })();
    });
  }
  for (const event of Object.keys(registry) as (keyof ClientEvents)[])
    register(event);
  return async () => {
    if (ready.size > 0 && client.isReady()) await report("Heartbeat");
  };
}

export function scheduleHeartbeat(heartbeat: () => Promise<void>) {
  return setInterval(() => {
    void heartbeat();
  }, 60_000);
}

type StartupCode =
  | "GUILD_ID_REQUIRED"
  | "TOKEN_NOT_CONFIGURED"
  | "SSM_READ_FAILED"
  | "LOGIN_FAILED";
export class StartupError extends Error {
  readonly code: StartupCode;
  constructor(code: StartupCode) {
    super(code);
    this.code = code;
  }
}
export function startupFailure(error: unknown) {
  return {
    event: "gateway_start_failed",
    code: error instanceof StartupError ? error.code : "STARTUP_FAILED",
  };
}
