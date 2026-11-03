#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { globSync } from "node:fs";

const testFiles = globSync("**/*.test.mts", {
  exclude: ["**/node_modules/**"],
}).sort();

if (testFiles.length === 0) {
  console.error("No .test.mts files found.");
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...testFiles], {
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error.message);
}
process.exit(result.status ?? 1);
