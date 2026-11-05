import { execFileSync } from "node:child_process";
import { Entry } from "@napi-rs/keyring";

export function readToken(): string {
  const token = new Entry("wow-forever-reader", "snapshot-token").getPassword();
  if (!token)
    throw Object.assign(new Error("Token unavailable"), {
      name: "MissingCredentialError",
    });
  return token;
}
export function scheduledTask(
  command: "install" | "uninstall",
  script: string,
  run: (file: string, args: string[]) => unknown = (file, args) =>
    execFileSync(file, args, { stdio: "inherit" }),
) {
  const task = "WoW Forever Reader";
  if (command === "uninstall")
    return run("schtasks.exe", ["/Delete", "/TN", task, "/F"]);
  if (/["\r\n]/.test(script + process.execPath))
    throw new Error("InvalidTaskPathError");
  return run("schtasks.exe", [
    "/Create",
    "/TN",
    task,
    "/SC",
    "ONLOGON",
    "/IT",
    "/RL",
    "LIMITED",
    "/TR",
    `"${process.execPath}" "${script}" run`,
    "/F",
  ]);
}
