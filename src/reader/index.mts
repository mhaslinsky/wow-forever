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
import { createReader, errorName, type Status } from "./reader.mts";
import { uploadSnapshot } from "./transport.mts";
import { refreshTray, type TrayPort } from "./tray.mts";
import { windowsTray } from "./tray-windows.mts";
import { readToken, scheduledTask } from "./windows.mts";

function main() {
  const command = process.argv[2] ?? "run";
  if (process.platform !== "win32")
    throw Object.assign(new Error("WindowsRequiredError"), {
      name: "WindowsRequiredError",
    });
  const appData = process.env.APPDATA;
  if (!appData)
    throw Object.assign(new Error("MissingAppDataError"), {
      name: "MissingAppDataError",
    });
  const directory = join(appData, "wow-forever-reader");
  mkdirSync(directory, { recursive: true });
  const statusPath = join(directory, "status.json");
  if (command === "status") {
    if (!existsSync(statusPath))
      throw Object.assign(new Error("StatusUnavailableError"), {
        name: "StatusUnavailableError",
      });
    console.log(readFileSync(statusPath, "utf8"));
    return;
  }
  if (command === "install" || command === "uninstall") {
    scheduledTask(command, resolve(fileURLToPath(import.meta.url)));
    return;
  }
  if (command !== "run")
    throw Object.assign(new Error("UnknownCommandError"), {
      name: "UnknownCommandError",
    });
  const config = JSON.parse(
    readFileSync(join(directory, "config.json"), "utf8"),
  );
  if (
    typeof config.savedVariablesPath !== "string" ||
    !config.savedVariablesPath ||
    typeof config.endpoint !== "string"
  )
    throw Object.assign(new Error("InvalidConfigError"), {
      name: "InvalidConfigError",
    });
  const endpoint = new URL(config.endpoint);
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password)
    throw Object.assign(new Error("InvalidEndpointError"), {
      name: "InvalidEndpointError",
    });
  let status: Status = {};
  try {
    if (existsSync(statusPath)) {
      const loaded = JSON.parse(readFileSync(statusPath, "utf8"));
      if (!loaded || typeof loaded !== "object" || Array.isArray(loaded))
        throw Object.assign(new Error("Invalid status"), {
          name: "InvalidStatusError",
        });
      status = loaded;
    }
  } catch (error) {
    console.error(`Status unavailable: ${errorName(error)}`);
  }
  delete status.pendingRetryAt;
  let tray: TrayPort | undefined;
  try {
    tray = windowsTray();
  } catch (error) {
    console.error(`Tray unavailable: ${errorName(error)}`);
  }
  const updateTray = () => {
    if (tray) refreshTray(tray, () => readFileSync(statusPath, "utf8"));
  };
  if (tray) {
    updateTray();
    watchFile(statusPath, { interval: 1000 }, updateTray);
  }
  const save = (value: Status) => {
    try {
      const temporary = `${statusPath}.new`;
      writeFileSync(temporary, JSON.stringify(value, null, 2));
      renameSync(temporary, statusPath);
      updateTray();
      const log = join(directory, "reader.log");
      if (existsSync(log) && statSync(log).size >= 1024 * 1024)
        renameSync(log, `${log}.1`);
      appendFileSync(log, `${JSON.stringify(value)}\n`);
    } catch (error) {
      console.error(`Status write failed: ${errorName(error)}`);
    }
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
          throw Object.assign(new Error("FileChangedDuringReadError"), {
            name: "FileChangedDuringReadError",
          });
        return { text, writtenAt: Math.floor(after.mtimeMs) };
      },
      async upload(snapshot) {
        return uploadSnapshot(endpoint, readToken(), snapshot);
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
    unwatchFile(statusPath);
    tray?.close();
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
