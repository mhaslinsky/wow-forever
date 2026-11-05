import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unwatchFile,
  watchFile,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createReader, type Status } from "./reader.mts";
import { readToken, scheduledTask } from "./windows.mts";

function main() {
  const command = process.argv[2] ?? "run";
  if (process.platform !== "win32") throw new Error("WindowsRequiredError");
  const appData = process.env.APPDATA;
  if (!appData) throw new Error("MissingAppDataError");
  const directory = join(appData, "wow-forever-reader");
  mkdirSync(directory, { recursive: true });
  const statusPath = join(directory, "status.json");
  if (command === "status") {
    if (!existsSync(statusPath)) throw new Error("StatusUnavailableError");
    console.log(readFileSync(statusPath, "utf8"));
    return;
  }
  if (command === "install" || command === "uninstall") {
    scheduledTask(command, resolve(fileURLToPath(import.meta.url)));
    return;
  }
  if (command !== "run") throw new Error("UnknownCommandError");
  const config = JSON.parse(
    readFileSync(join(directory, "config.json"), "utf8"),
  );
  if (
    typeof config.savedVariablesPath !== "string" ||
    !config.savedVariablesPath ||
    typeof config.endpoint !== "string"
  )
    throw new Error("InvalidConfigError");
  const endpoint = new URL(config.endpoint);
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password)
    throw new Error("InvalidEndpointError");
  let status: Status = {};
  if (existsSync(statusPath))
    status = JSON.parse(readFileSync(statusPath, "utf8"));
  delete status.pendingRetryAt;
  const save = (value: Status) => {
    const temporary = `${statusPath}.new`;
    writeFileSync(temporary, JSON.stringify(value, null, 2));
    renameSync(temporary, statusPath);
    const log = join(directory, "reader.log");
    if (existsSync(log) && statSync(log).size >= 1024 * 1024)
      renameSync(log, `${log}.1`);
    appendFileSync(log, `${JSON.stringify(value)}\n`);
  };
  const reader = createReader(
    {
      clock: {
        now: Date.now,
        schedule(callback, delay) {
          const timer = setTimeout(callback, delay);
          return () => clearTimeout(timer);
        },
      },
      async read() {
        const before = statSync(config.savedVariablesPath);
        const text = readFileSync(config.savedVariablesPath, "utf8");
        const after = statSync(config.savedVariablesPath);
        if (before.mtimeMs !== after.mtimeMs || before.size !== after.size)
          throw new Error("FileChangedDuringReadError");
        return { text, writtenAt: Math.floor(after.mtimeMs) };
      },
      async upload(snapshot) {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${readToken()}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(snapshot),
          signal: AbortSignal.timeout(30000),
          redirect: "error",
        });
        let body: { outcome?: string; error?: string } = {};
        try {
          body = (await response.json()) as typeof body;
        } catch {
          body = { error: "InvalidResponseError" };
        }
        return { ...body, status: response.status };
      },
      save,
    },
    status,
  );
  watchFile(
    config.savedVariablesPath,
    { interval: 1000 },
    (current, previous) => {
      if (
        current.mtimeMs !== previous.mtimeMs ||
        current.size !== previous.size
      )
        reader.changed();
    },
  );
  reader.changed();
  const stop = () => {
    reader.stop();
    unwatchFile(config.savedVariablesPath);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "ReaderError");
  process.exitCode = 1;
}
