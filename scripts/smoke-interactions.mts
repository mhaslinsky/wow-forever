#!/usr/bin/env node
import { execFile } from "node:child_process";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

export interface SmokeOptions {
  url: string;
  functionName: string;
  discord?: boolean;
  skipDiscord?: boolean;
  fixtureFunction?: string;
  skipFixtures?: boolean;
  botToken?: string;
}
export interface SmokePorts {
  http: typeof fetch;
  aws(args: string[]): Promise<unknown>;
}
export interface Check {
  name: string;
  status: "passed" | "failed" | "skipped";
  detail: string;
}
const execute = promisify(execFile);
export const livePorts: SmokePorts = {
  http: fetch,
  async aws(args) {
    const directory = await mkdtemp(join(tmpdir(), "interactions-smoke-"));
    try {
      const invoking = args[1] === "invoke";
      const output = join(directory, "response.json");
      const result = await execute(
        "aws",
        [...args, ...(invoking ? [output] : []), "--output", "json"],
        { timeout: 90_000, maxBuffer: 1024 * 1024 },
      );
      const metadata = JSON.parse(result.stdout);
      if (metadata.FunctionError) throw new Error("Fixture invocation failed");
      return invoking ? JSON.parse(await readFile(output, "utf8")) : metadata;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
};

function statementsPresent(value: unknown, functionName: string) {
  const envelope = value as { Policy?: string };
  if (typeof envelope?.Policy !== "string") return false;
  const policy = JSON.parse(envelope.Policy) as {
    Statement?: {
      Effect?: string;
      Principal?: unknown;
      Action?: string | string[];
      Resource?: string;
      Condition?: Record<string, Record<string, unknown>>;
    }[];
  };
  if (!Array.isArray(policy.Statement)) return false;
  return ["lambda:InvokeFunctionUrl", "lambda:InvokeFunction"].every((action) =>
    policy.Statement?.some((statement) => {
      const actions = Array.isArray(statement.Action)
        ? statement.Action
        : [statement.Action];
      const principal = statement.Principal;
      const publicAccess =
        principal === "*" ||
        (typeof principal === "object" &&
          principal !== null &&
          "AWS" in principal &&
          principal.AWS === "*");
      const resource = statement.Resource;
      const matchesFunction =
        typeof resource === "string" &&
        (functionName.startsWith("arn:")
          ? resource === functionName
          : resource.endsWith(`:function:${functionName}`));
      const condition = statement.Condition;
      return (
        statement.Effect === "Allow" &&
        publicAccess &&
        matchesFunction &&
        actions.includes(action) &&
        (action === "lambda:InvokeFunctionUrl"
          ? condition?.StringEquals?.["lambda:FunctionUrlAuthType"] === "NONE"
          : ["true", true].includes(
              condition?.Bool?.["lambda:InvokedViaFunctionUrl"] as boolean,
            ))
      );
    }),
  );
}

export async function runSmoke(
  options: SmokeOptions,
  ports: SmokePorts = livePorts,
): Promise<Check[]> {
  const checks: Check[] = [];
  const check = async (
    name: string,
    operation: () => Promise<void>,
    detail = "Verified",
  ) => {
    try {
      await operation();
      checks.push({ name, status: "passed", detail });
    } catch (error) {
      checks.push({
        name,
        status: "failed",
        detail: error instanceof Error ? error.message : "Check failed",
      });
    }
  };
  const post = (headers: Record<string, string> = {}) =>
    ports.http(options.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: '{"type":1}',
      signal: AbortSignal.timeout(10_000),
    });
  await check("unsigned request", async () => {
    const response = await post();
    await response.body?.cancel();
    if (response.status !== 401)
      throw new Error(`Expected 401, received ${response.status}`);
  });
  await check(
    "untrusted stale request",
    async () => {
      const { privateKey } = generateKeyPairSync("ed25519");
      const timestamp = String(Math.floor(Date.now() / 1000) - 600);
      const signature = sign(
        null,
        Buffer.from(`${timestamp}{"type":1}`),
        privateKey,
      ).toString("hex");
      const response = await post({
        "x-signature-timestamp": timestamp,
        "x-signature-ed25519": signature,
      });
      await response.body?.cancel();
      if (response.status !== 401)
        throw new Error(`Expected 401, received ${response.status}`);
    },
    "rejected (signature or freshness, not isolated)",
  );
  await check("function URL policy", async () => {
    const policy = await ports.aws([
      "lambda",
      "get-policy",
      "--function-name",
      options.functionName,
    ]);
    if (!statementsPresent(policy, options.functionName))
      throw new Error("Missing public function URL permission or condition");
  });
  if (options.skipDiscord) {
    checks.push({
      name: "Discord PING",
      status: "skipped",
      detail: "Flag set",
    });
  } else {
    await check("Discord PING", async () => {
      if (!options.discord || !options.botToken)
        throw new Error(
          "Use --discord with DISCORD_BOT_TOKEN or --skip-discord",
        );
      const response = await ports.http(
        "https://discord.com/api/v10/applications/@me",
        {
          method: "PATCH",
          headers: {
            authorization: `Bot ${options.botToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ interactions_endpoint_url: options.url }),
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (response.status !== 200) {
        await response.body?.cancel();
        throw new Error(`Discord validation returned ${response.status}`);
      }
      const application = (await response.json()) as {
        interactions_endpoint_url?: string;
      };
      if (application.interactions_endpoint_url !== options.url)
        throw new Error("Discord did not confirm the endpoint");
    });
  }
  for (const scenario of ["freshness", "slow", "watchdog", "duplicate"]) {
    const name = `fixture ${scenario}`;
    if (options.skipFixtures) {
      checks.push({ name, status: "skipped", detail: "Flag set" });
      continue;
    }
    await check(name, async () => {
      const target = options.fixtureFunction;
      if (!target) throw new Error("Use --fixture-function or --skip-fixtures");
      if (
        target.split(":function:").at(-1)?.split(":")[0] ===
        options.functionName.split(":function:").at(-1)?.split(":")[0]
      )
        throw new Error("Fixture must be separate from production");
      const invoke = (payload: object) =>
        ports.aws([
          "lambda",
          "invoke",
          "--function-name",
          target,
          "--cli-binary-format",
          "raw-in-base64-out",
          "--payload",
          JSON.stringify(payload),
        ]);
      const runId = randomUUID();
      const { publicKey, privateKey } = generateKeyPairSync("ed25519");
      const body = JSON.stringify({
        id: runId,
        application_id: "fixture",
        token: "fixture",
        type: 2,
        data: { name: `smoke-${scenario}` },
      });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const request = {
        body,
        headers: {
          "x-signature-timestamp": timestamp,
          "x-signature-ed25519": sign(
            null,
            Buffer.from(timestamp + body),
            privateKey,
          ).toString("hex"),
        },
      };
      const key = publicKey
        .export({ type: "spki", format: "der" })
        .subarray(-32)
        .toString("hex");
      if (scenario === "freshness") {
        for (const offset of [0, -600]) {
          const timestamp = String(Math.floor(Date.now() / 1000) + offset);
          const response = (await invoke({
            smoke: "http",
            publicKey: key,
            request: {
              body,
              headers: {
                "x-signature-timestamp": timestamp,
                "x-signature-ed25519": sign(
                  null,
                  Buffer.from(timestamp + body),
                  privateKey,
                ).toString("hex"),
              },
            },
          })) as { statusCode?: number };
          if (response.statusCode !== (offset === 0 ? 200 : 401))
            throw new Error("Fixture freshness response differs");
        }
        return;
      }
      const started = (await invoke({
        smoke: "start",
        scenario,
        request,
        publicKey: key,
      })) as {
        runId?: string;
        deferred?: boolean;
      };
      if (started.runId !== runId || started.deferred !== true)
        throw new Error("Fixture did not defer");
      const deadline = Date.now() + 80_000;
      while (Date.now() < deadline) {
        const state = (await invoke({
          smoke: "status",
          runId: started.runId,
        })) as {
          completed?: number;
          work?: number;
          replies?: number;
          content?: string;
        };
        if (
          state.completed === (scenario === "duplicate" ? 2 : 1) &&
          (scenario !== "duplicate" || (state.replies ?? 0) > 0)
        ) {
          if (
            state.work !== 1 ||
            state.replies !== 1 ||
            state.content !==
              (scenario === "watchdog" ? "Request timed out" : "Completed")
          )
            throw new Error("Fixture work or reply result differs");
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw new Error("Fixture workers did not finish");
    });
  }
  return checks;
}

export function parseOptions(args: string[]): SmokeOptions {
  const options: SmokeOptions = { url: "", functionName: "" };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (["--url", "--function", "--fixture-function"].includes(argument)) {
      const value = args[++index];
      if (!value || value.startsWith("--"))
        throw new Error(`Missing ${argument} value`);
      if (argument === "--url") options.url = value;
      else if (argument === "--function") options.functionName = value;
      else options.fixtureFunction = value;
    } else if (argument === "--discord") options.discord = true;
    else if (argument === "--skip-discord") options.skipDiscord = true;
    else if (argument === "--skip-fixtures") options.skipFixtures = true;
    else throw new Error(`Unknown option ${argument}`);
  }
  if (!options.url || !options.functionName)
    throw new Error("Required: --url <https-url> --function <name>");
  if (new URL(options.url).protocol !== "https:")
    throw new Error("URL must use HTTPS");
  if (
    (options.discord && options.skipDiscord) ||
    (options.fixtureFunction && options.skipFixtures)
  )
    throw new Error("Run and skip flags conflict");
  options.botToken = process.env.DISCORD_BOT_TOKEN;
  return options;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const checks = await runSmoke(parseOptions(process.argv.slice(2)));
    for (const result of checks)
      console.log(
        `${result.status.toUpperCase()} ${result.name}: ${result.detail}`,
      );
    process.exitCode = checks.some((result) => result.status === "failed")
      ? 1
      : 0;
  } catch {
    console.error("Smoke could not run; check arguments and connectivity");
    process.exitCode = 1;
  }
}
