#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";

const [bucket] = process.argv.slice(2);
if (!bucket || !/^[a-z0-9.-]+$/.test(bucket))
  throw new Error("Invalid artifact bucket");
const directory = "/opt/wow-forever-gateway";
const instance = readFileSync("/var/lib/cloud/data/instance-id", "utf8").trim();
if (!/^i-[a-f0-9]+$/.test(instance))
  throw new Error("Missing cloud-init instance ID");
writeFileSync(`${directory}/environment`, `GATEWAY_INSTANCE_ID=${instance}\n`, {
  mode: 0o644,
});
function fetchArtifact(key: string, destination: string) {
  return execFileSync(
    "aws",
    [
      "s3api",
      "get-object",
      "--bucket",
      bucket,
      "--key",
      key,
      destination,
      "--region",
      "us-east-1",
    ],
    { encoding: "utf8", stdio: "pipe" },
  );
}
let available = true;
try {
  fetchArtifact("artifacts/gateway/latest.json", `${directory}/latest.json`);
} catch (error) {
  if (!String((error as { stderr?: Buffer }).stderr).includes("NoSuchKey"))
    throw error;
  available = false;
  console.log("Gateway bundle unavailable; service stays inactive");
}
if (available) {
  const { digest } = JSON.parse(
    readFileSync(`${directory}/latest.json`, "utf8"),
  );
  if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest))
    throw new Error("Invalid gateway artifact digest");
  fetchArtifact(`artifacts/gateway/${digest}.mjs`, `${directory}/next.mjs`);
  if (
    createHash("sha256")
      .update(readFileSync(`${directory}/next.mjs`))
      .digest("hex") !== digest
  )
    throw new Error("Gateway artifact digest mismatch");
  renameSync(`${directory}/next.mjs`, `${directory}/index.mjs`);
}
execFileSync("systemctl", ["enable", "--now", "wow-forever-gateway"], {
  stdio: "inherit",
});
