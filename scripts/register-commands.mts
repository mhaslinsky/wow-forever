#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { REST } from "@discordjs/rest";
import { Routes } from "discord.js";
import {
  commandDefinitions,
  type Route,
  registry,
} from "../src/interactions/core.mts";
import { readSecret } from "../src/interactions/index.mts";

export interface RegistrationConfig {
  application: string;
  guild: string;
  tokenParameter: string;
}
export interface RegistrationPorts {
  secret(name: string, signal: AbortSignal): Promise<string>;
  replace(token: string, path: `/${string}`, body: unknown): Promise<unknown>;
}
const ports: RegistrationPorts = {
  secret: readSecret,
  replace: (token, path, body) =>
    new REST({ version: "10" }).setToken(token).put(path, { body }),
};

export async function registerCommands(
  config: RegistrationConfig,
  dependencies: RegistrationPorts = ports,
  routes: readonly Route[] = registry,
) {
  if (!/^\d+$/.test(config.application) || !/^\d+$/.test(config.guild))
    throw new Error("Application and guild IDs are required");
  if (!config.tokenParameter.trim())
    throw new Error("Token parameter is required");
  const definitions = commandDefinitions(routes);
  if (!definitions.length) throw new Error("No commands to register");
  const token = await dependencies.secret(
    config.tokenParameter,
    AbortSignal.timeout(10_000),
  );
  if (!token.trim()) throw new Error("Bot token unavailable");
  const result = await dependencies.replace(
    token,
    Routes.applicationGuildCommands(config.application, config.guild),
    definitions,
  );
  if (!Array.isArray(result) || result.length !== definitions.length)
    throw new Error("Command registration returned an unexpected count");
  return result.length;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const { values } = parseArgs({
      options: {
        application: { type: "string" },
        guild: { type: "string" },
        "token-parameter": {
          type: "string",
          default: "/wow-forever/discord_bot_token",
        },
        help: { type: "boolean" },
      },
    });
    if (values.help) {
      console.log(
        "Usage: register-commands.mts --application ID --guild ID [--token-parameter SSM_PATH]",
      );
    } else {
      const count = await registerCommands({
        application: values.application ?? "",
        guild: values.guild ?? "",
        tokenParameter: values["token-parameter"],
      });
      console.log(`Registered ${count} guild commands`);
    }
  } catch (error) {
    // SDK errors can contain request credentials.
    console.error(
      error instanceof Error && error.message === "No commands to register"
        ? error.message
        : "Command registration failed",
    );
    process.exitCode = 1;
  }
}
