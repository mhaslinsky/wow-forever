import { createPublicKey, verify } from "node:crypto";

export interface Clock {
  now(): number;
  schedule(milliseconds: number, callback: () => void): () => void;
}
export const clock: Clock = {
  now: Date.now,
  schedule(milliseconds, callback) {
    const timer = setTimeout(callback, milliseconds);
    return () => clearTimeout(timer);
  },
};
export async function bounded<Result>(
  time: Clock,
  milliseconds: number,
  parent: AbortSignal,
  operation: (signal: AbortSignal) => Promise<Result>,
): Promise<Result> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  parent.addEventListener("abort", abort, { once: true });
  const cancel = time.schedule(Math.max(0, milliseconds), abort);
  try {
    if (parent.aborted) controller.abort();
    return await Promise.race([
      Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return operation(controller.signal);
      }),
      new Promise<never>((_resolve, reject) => {
        const rejectAbort = () => reject(new Error("Request cancelled"));
        if (controller.signal.aborted) rejectAbort();
        else
          controller.signal.addEventListener("abort", rejectAbort, {
            once: true,
          });
      }),
    ]);
  } finally {
    cancel();
    parent.removeEventListener("abort", abort);
    controller.abort();
  }
}
export function pause(time: Clock, milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      cancel();
      reject(new Error("Request cancelled"));
    };
    const cancel = time.schedule(milliseconds, () => {
      signal.removeEventListener("abort", abort);
      resolve();
    });
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}
export interface Interaction {
  id: string;
  application_id: string;
  token: string;
  type: 1 | 2 | 3 | 4 | 5;
  data?: { name?: string; custom_id?: string; [key: string]: unknown };
  member?: { user?: { id: string }; roles?: string[] };
  user?: { id: string };
}
export type Reply =
  | { type: 1 | 6 }
  | { type: 4 | 5; data: { content?: string; flags?: number } }
  | { type: 8; data: { choices: { name: string; value: string | number }[] } }
  | {
      type: 9;
      data: { custom_id: string; title: string; components: unknown[] };
    };
export interface Route {
  type: 2 | 3 | 4 | 5;
  name: string;
  description?: string;
  options?: unknown[];
  mode: "fast" | "slow";
  visibility: "public" | "ephemeral";
  cooldownSeconds?: number;
  handler(interaction: Interaction, signal: AbortSignal): Promise<Reply>;
}
export const registry: readonly Route[] = [];
export function commandDefinitions(routes: readonly Route[] = registry) {
  return routes
    .filter((route) => route.type === 2)
    .map((route) => ({
      name: route.name,
      description: route.description,
      options: route.options,
    }));
}
export function findRoute(routes: readonly Route[], interaction: Interaction) {
  return routes.find(
    (route) =>
      route.type === interaction.type &&
      (route.type === 2 || route.type === 4
        ? route.name === interaction.data?.name
        : interaction.data?.custom_id?.split(":")[0] === route.name),
  );
}
export const message = (content: string): Reply => ({
  type: 4,
  data: { content, flags: 64 },
});
export function signatureValid(
  body: Buffer,
  signature: string,
  timestamp: string,
  publicKey: string,
) {
  if (!/^[a-f\d]{128}$/i.test(signature) || !/^[a-f\d]{64}$/i.test(publicKey))
    return false;
  try {
    const key = createPublicKey({
      key: Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        Buffer.from(publicKey, "hex"),
      ]),
      type: "spki",
      format: "der",
    });
    // Verify the original bytes; JSON serialization changes the signed payload.
    return verify(
      null,
      Buffer.concat([Buffer.from(timestamp), body]),
      key,
      Buffer.from(signature, "hex"),
    );
  } catch {
    return false;
  }
}
export function timestampFresh(timestamp: string, now: number) {
  return (
    /^\d+$/.test(timestamp) &&
    Number.isSafeInteger(Number(timestamp)) &&
    Math.abs(Math.floor(now / 1000) - Number(timestamp)) <= 300
  );
}
export interface Ports {
  clock: Clock;
  publicKey(signal: AbortSignal): Promise<string>;
  invoke(interaction: Interaction, signal: AbortSignal): Promise<void>;
  claim(key: string, expiresAt: number, signal: AbortSignal): Promise<boolean>;
  discord(
    interaction: Interaction,
    method: "GET" | "PATCH" | "POST",
    content: string | undefined,
    signal: AbortSignal,
    ephemeral: boolean,
  ): Promise<number>;
  report(): void;
}
