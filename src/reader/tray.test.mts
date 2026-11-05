import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { refreshTray, type TrayState } from "./tray.mts";

test("tray tooltip reflects the status file's last outcome and warning recovers", () => {
  const directory = mkdtempSync(join(tmpdir(), "reader-tray-"));
  const path = join(directory, "status.json");
  let shown: TrayState | undefined;
  const tray = {
    show(state: TrayState) {
      shown = state;
    },
    close() {},
  };
  try {
    for (const [status, tooltip, warning] of [
      [{}, "Guild OS: Waiting for upload", false],
      [
        { lastSuccess: { at: 1, outcome: "stored" } },
        "Guild OS: stored",
        false,
      ],
      [
        {
          lastSuccess: { at: 1, outcome: "stored" },
          lastFailure: { at: 2, error: "Http401Error" },
        },
        "Guild OS: Http401Error",
        true,
      ],
      [
        {
          lastSuccess: { at: 3, outcome: "duplicate" },
          lastFailure: { at: 2, error: "Http401Error" },
        },
        "Guild OS: duplicate",
        false,
      ],
      [{}, "Guild OS: Waiting for upload", false],
      [
        { lastFailure: { at: "bad", error: "bad" } },
        "Guild OS: Status unavailable",
        true,
      ],
    ] as const) {
      writeFileSync(path, JSON.stringify(status));
      refreshTray(tray, () => readFileSync(path, "utf8"));
      assert.deepEqual(shown, { tooltip, warning });
    }
    for (const contents of ["", "{", "null", "[]"]) {
      writeFileSync(path, contents);
      refreshTray(tray, () => readFileSync(path, "utf8"));
      assert.deepEqual(shown, {
        tooltip: "Guild OS: Status unavailable",
        warning: true,
      });
    }
    writeFileSync(path, "{}");
    refreshTray(tray, () => readFileSync(path, "utf8"));
    assert.equal(shown?.warning, false);
    rmSync(path);
    refreshTray(tray, () => readFileSync(path, "utf8"));
    assert.deepEqual(shown, {
      tooltip: "Guild OS: Status unavailable",
      warning: true,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
