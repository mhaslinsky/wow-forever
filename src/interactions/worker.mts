import type { Interaction, Ports, Route } from "./core.mts";
import { bounded, findRoute, pause } from "./core.mts";

export function createWorker(ports: Ports, routes: readonly Route[]) {
  return async (interaction: Interaction, remaining: () => number) => {
    const route = findRoute(routes, interaction);
    if (!route || route.mode !== "slow")
      throw new Error("Unknown worker route");
    const work = new AbortController();
    let won = false;
    let owned = false;
    let final: Promise<void> | undefined;
    const finish = (content: string): Promise<void> => {
      if (won || !owned) return final ?? Promise.resolve();
      won = true;
      work.abort();
      final = (async () => {
        try {
          await bounded(
            ports.clock,
            Math.min(3500, remaining() - 500),
            new AbortController().signal,
            async (signal) => {
              const end =
                ports.clock.now() +
                Math.min(3000, Math.max(0, remaining() - 2500));
              let exists = false;
              do {
                const status = await bounded(
                  ports.clock,
                  500,
                  signal,
                  (requestSignal) =>
                    ports.discord(
                      interaction,
                      "GET",
                      undefined,
                      requestSignal,
                      false,
                    ),
                );
                if (status === 200) {
                  exists = true;
                  break;
                }
                if (status !== 404)
                  throw new Error("Acknowledgement check failed");
                if (ports.clock.now() >= end) break;
                await pause(
                  ports.clock,
                  Math.min(250, end - ports.clock.now()),
                  signal,
                );
              } while (ports.clock.now() < end);
              const status = await bounded(
                ports.clock,
                2000,
                signal,
                (requestSignal) =>
                  ports.discord(
                    interaction,
                    exists ? "PATCH" : "POST",
                    content,
                    requestSignal,
                    route.visibility === "ephemeral",
                  ),
              );
              if (status < 200 || status >= 300)
                throw new Error("Reply failed");
            },
          );
        } catch {
          ports.report();
        }
      })();
      return final;
    };
    let watchdogDone: Promise<void> | undefined;
    let releaseWatchdog: (() => void) | undefined;
    const watchdog = new Promise<void>((resolve) => {
      releaseWatchdog = resolve;
    });
    const cancel = ports.clock.schedule(Math.max(0, remaining() - 4000), () => {
      watchdogDone = finish("Request timed out");
      work.abort();
      releaseWatchdog?.();
    });
    const run = async () => {
      try {
        owned = await bounded(ports.clock, 1000, work.signal, (signal) =>
          ports.claim(
            `interaction#${interaction.id}`,
            Math.floor(ports.clock.now() / 1000) + 3600,
            signal,
          ),
        );
        if (!owned) return;
        if (route.cooldownSeconds) {
          const user = interaction.member?.user?.id ?? interaction.user?.id;
          if (!user) {
            await finish("User unavailable");
            return;
          }
          const allowed = await bounded(
            ports.clock,
            1000,
            work.signal,
            (signal) =>
              ports.claim(
                `user#${user}#${route.name}`,
                Math.floor(ports.clock.now() / 1000) +
                  (route.cooldownSeconds ?? 0),
                signal,
              ),
          );
          if (!allowed) {
            await finish(`Try again in ${route.cooldownSeconds} s`);
            return;
          }
        }
        const result = await route.handler(interaction, work.signal);
        if (result.type !== 4 || !result.data.content)
          throw new Error("Worker returned no message");
        await finish(result.data.content);
      } catch {
        if (!won) ports.report();
        await finish("Request failed");
      }
    };
    try {
      await Promise.race([run(), watchdog]);
      if (watchdogDone) await watchdogDone;
    } finally {
      cancel();
      work.abort();
    }
  };
}
