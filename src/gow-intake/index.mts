import { createSystemPrincipal } from "../auth/index.mts";
import { createGowStore } from "../data/gow-applications.mts";
import { readSecret } from "../interactions/index.mts";
import { captureApplications } from "./core.mts";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

export async function handler() {
  try {
    return await captureApplications({
      guildId: required("GUILD_ID"),
      apiKey: await readSecret(
        "/wow-forever/guildsofwow_api_key",
        AbortSignal.timeout(15_000),
      ),
      save: createGowStore(
        required("GUILD_TABLE"),
        createSystemPrincipal(["gowApplication"]),
      ),
    });
  } catch {
    throw new Error("GOW_INTAKE_FAILED");
  }
}
