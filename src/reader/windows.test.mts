import assert from "node:assert/strict";
import test from "node:test";
import { scheduledTask } from "./windows.mts";

test("scheduled task argument arrays preserve paths and reject invalid quoting", () => {
  const script = "C:\\Program Files (x86)\\Reader\\index.mjs";
  for (const command of ["install", "uninstall"] as const) {
    scheduledTask(command, script, (file, args) => {
      assert.equal(file, "schtasks.exe");
      const common = ["/TN", "WoW Forever Reader"];
      const options = ["/SC", "ONLOGON", "/IT", "/RL", "LIMITED"];
      const launch = ["/TR", `"${process.execPath}" "${script}" run`];
      const expected =
        command === "install"
          ? ["/Create", ...common, ...options, ...launch, "/F"]
          : ["/Delete", ...common, "/F"];
      assert.deepEqual(args, expected);
    });
  }
  for (const path of ['C:\\bad"path', "C:\\bad\npath"]) {
    assert.throws(
      () => scheduledTask("install", path, () => assert.fail("runner called")),
      { name: "InvalidTaskPathError" },
    );
  }
});
