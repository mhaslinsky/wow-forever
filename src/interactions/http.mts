import type { Interaction, Ports, Reply, Route } from "./core.mts";
import {
  bounded,
  findRoute,
  message,
  signatureValid,
  timestampFresh,
} from "./core.mts";

export interface HttpEvent {
  headers?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
}
const response = (statusCode: number, reply: Reply | { error: string }) => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(reply),
});
export function createHttp(ports: Ports, routes: readonly Route[]) {
  return async (event: HttpEvent) => {
    const end = ports.clock.now() + 1900;
    const headers = Object.fromEntries(
      Object.entries(event.headers ?? {}).map(([name, value]) => [
        name.toLowerCase(),
        value,
      ]),
    );
    const signature = headers["x-signature-ed25519"] ?? "";
    const timestamp = headers["x-signature-timestamp"] ?? "";
    const body = Buffer.from(
      event.body ?? "",
      event.isBase64Encoded ? "base64" : "utf8",
    );
    if (
      !timestampFresh(timestamp, ports.clock.now()) ||
      !/^[a-f\d]{128}$/i.test(signature)
    )
      return response(401, { error: "Invalid signature" });
    const signal = new AbortController().signal;
    let key: string;
    try {
      key = await bounded(ports.clock, 1000, signal, ports.publicKey);
    } catch {
      return response(503, { error: "Service unavailable" });
    }
    if (!signatureValid(body, signature, timestamp, key))
      return response(401, { error: "Invalid signature" });
    let interaction: Interaction;
    try {
      interaction = JSON.parse(body.toString("utf8"));
      if (!interaction || typeof interaction !== "object") throw new Error();
    } catch {
      return response(400, { error: "Invalid interaction" });
    }
    if (interaction.type === 1) return response(200, { type: 1 });
    if (
      ![interaction.id, interaction.token, interaction.application_id].every(
        (value) => typeof value === "string" && value.length > 0,
      )
    )
      return response(400, { error: "Invalid interaction" });
    const route = findRoute(routes, interaction);
    if (!route)
      return response(
        200,
        interaction.type === 4
          ? { type: 8, data: { choices: [] } }
          : message("Unknown command"),
      );
    try {
      if (route.mode === "fast")
        return response(
          200,
          await bounded(
            ports.clock,
            end - ports.clock.now(),
            signal,
            (requestSignal) => route.handler(interaction, requestSignal),
          ),
        );
      if (interaction.type === 4)
        return response(200, { type: 8, data: { choices: [] } });
      await bounded(
        ports.clock,
        Math.min(1000, end - ports.clock.now()),
        signal,
        (requestSignal) => ports.invoke(interaction, requestSignal),
      );
      return response(
        200,
        interaction.type === 3
          ? { type: 6 }
          : {
              type: 5,
              data: { flags: route.visibility === "ephemeral" ? 64 : 0 },
            },
      );
    } catch {
      return response(
        200,
        interaction.type === 4
          ? { type: 8, data: { choices: [] } }
          : message("Request unavailable"),
      );
    }
  };
}
