import assert from "node:assert/strict";
import test from "node:test";
import { startReaderSession } from "./session.mts";

test("reader starts the watcher before the tray and cleans up failed startup", () => {
  for (const failure of ["watch", "changed", undefined]) {
    const calls: string[] = [];
    const step = (name: string) => {
      calls.push(name);
      if (name === failure) throw new Error(name);
    };
    const handle = (start: string, stop: string) => {
      step(start);
      return () => step(stop);
    };
    const start = () =>
      startReaderSession({
        watch: () => handle("watch", "unwatch"),
        tray: () => handle("tray", "close"),
        changed: () => step("changed"),
        stop: () => step("stop"),
      });
    if (failure) assert.throws(start, { message: failure });
    else {
      const stop = start();
      stop();
    }
    assert.deepEqual(
      calls,
      failure === "watch"
        ? ["watch", "stop"]
        : ["watch", "tray", "changed", "stop", "unwatch", "close"],
    );
  }
});
