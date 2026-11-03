import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as store from "../src/layout/state.mts";

const moduleUrl = new URL("../src/layout/state.mts", import.meta.url).href;
function sandbox(context: { after(callback: () => void): void }) {
  const directory = fs.mkdtempSync(join(tmpdir(), "layout-state-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, path: join(directory, "state.json") };
}
function child(source: string) {
  const args = ["--input-type=module", "-e", source];
  const result = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.ifError(result.error);
  return result;
}

test("a second apply is refused across processes and symlinked paths", async (context) => {
  const { path, directory } = sandbox(context);
  const alias = join(directory, "alias");
  fs.symlinkSync(directory, alias, "dir");
  const aliasPath = join(alias, "state.json");
  await store.withStateLock(path, () => {
    const owner = JSON.parse(fs.readFileSync(`${path}.lock`, "utf8"));
    assert.equal(owner.pid, process.pid);
    assert.ok(Number.isFinite(Date.parse(owner.startedAt)));
    const result = child(`
      import { withStateLock } from ${JSON.stringify(moduleUrl)};
      try {
        await withStateLock(${JSON.stringify(aliasPath)}, () => process.exit(42));
      } catch (error) { console.log(error.status); }
    `);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "active");
  });
  await store.withStateLock(path, () => {});
});

test("an interrupted write preserves the previous state and leaves a reported stale lock", async (context) => {
  const { path } = sandbox(context);
  const previous = store.emptyState("guild");
  await store.withStateLock(path, (state) => state.write(previous));
  const result = child(`
    import fs from 'node:fs';
    import { emptyState, withStateLock } from ${JSON.stringify(moduleUrl)};
    fs.renameSync = () => process.kill(process.pid, 'SIGKILL');
    await withStateLock(${JSON.stringify(path)}, (state) => state.write(emptyState('changed')));
  `);
  assert.equal(result.signal, "SIGKILL", result.stderr);
  assert.deepEqual(store.loadState(path), previous);
  await assert.rejects(
    store.withStateLock(path, () => assert.fail("acquired stale lock")),
    { status: "stale" },
  );
  assert.equal(fs.existsSync(`${path}.lock`), true);
});

test("state preserves tag identities and uncertain adoption records; saved plans bind all inputs", async (context) => {
  const { path, directory } = sandbox(context);
  const state = store.emptyState("guild");
  state.ids = {
    roles: { member: "role" },
    channels: { forum: "channel" },
    tags: { forum: { open: "tag" } },
  };
  state.uncertainCreates = [
    { kind: "role", key: "officer", name: "Officer" },
    {
      kind: "channel",
      key: "secret",
      name: "Secret",
      type: "text",
      parentKey: "officers",
    },
  ];
  const plan = { operations: [] };
  const binding = {
    guildId: "guild",
    layoutHash: store.contentHash({ roles: [] }),
    stateHash: store.contentHash(state),
    planHash: store.contentHash(plan),
  };
  const saved = join(directory, "plan.json");
  await store.withStateLock(path, (locked) => {
    locked.write(state);
    const { uncertainCreates: _pending, ...bare } = state;
    assert.throws(() => {
      // @ts-expect-error Bare State has no recovery records.
      locked.write(bare);
    }, /Invalid uncertain creates/);
    assert.deepEqual(locked.read(), state);
    locked.savePlan(saved, binding, plan);
    const alias = join(directory, "alias");
    fs.symlinkSync(directory, alias, "dir");
    const aliasState = join(alias, "state.json");
    assert.throws(() => locked.savePlan(aliasState, binding, {}), /overlaps/);
    const stale = { ...binding, stateHash: store.contentHash("old") };
    assert.throws(() => locked.savePlan(saved, stale, plan), /stateHash/);
  });
  assert.deepEqual(store.loadSavedPlan(saved, binding).plan, plan);
  for (const key of ["guildId", "layoutHash", "stateHash"] as const)
    assert.throws(
      () =>
        store.loadSavedPlan(saved, {
          ...binding,
          [key]: key === "guildId" ? "other" : store.contentHash("other"),
        }),
      new RegExp(`${key} differs`),
    );
  assert.notEqual(
    store.contentHash(state),
    store.contentHash({ ...state, uncertainCreates: [] }),
  );
  assert.equal(fs.statSync(path).mode & 0o777, 0o600);
  const edited = JSON.parse(fs.readFileSync(saved, "utf8"));
  edited.plan = { operations: ["delete"] };
  fs.writeFileSync(saved, JSON.stringify(edited));
  assert.throws(() => store.loadSavedPlan(saved, binding), /planHash differs/);
});

test("state load rejects duplicate IDs, malformed and unsupported files; missing is distinct from empty", async (context) => {
  const { path } = sandbox(context);
  assert.throws(() => store.loadState(path), { code: "ENOENT" });
  const state = store.emptyState("guild");
  for (const kind of ["roles", "channels", "tags"] as const) {
    const ids = structuredClone(state.ids),
      duplicate = { first: "same", second: "same" };
    if (kind === "tags") ids.tags.forum = duplicate;
    else ids[kind] = duplicate;
    fs.writeFileSync(path, JSON.stringify({ ...state, ids }));
    assert.throws(() => store.loadState(path), /Duplicate Discord ID/);
  }
  for (const value of [
    "",
    "{",
    JSON.stringify({ ...state, schemaVersion: 2 }),
    JSON.stringify({ ...state, uncertainCreates: [{}] }),
  ]) {
    fs.writeFileSync(path, value);
    assert.throws(() => store.loadState(path));
  }
  await store.withStateLock(path, (locked) => locked.write(state));
  assert.deepEqual(store.loadState(path), state);
  for (const partial of ["", "{", '{"pid":1}']) {
    fs.writeFileSync(`${path}.lock`, partial);
    await assert.rejects(
      store.withStateLock(path, () => assert.fail("acquired partial lock")),
      { status: "active", initializing: true },
    );
  }
});

test("release preserves a replacement lock and the callback error", async (context) => {
  const { path } = sandbox(context);
  const failure = new Error("callback failed");
  await assert.rejects(
    store.withStateLock(path, () => {
      fs.writeFileSync(`${path}.lock`, '{"token":"replacement"}');
      throw failure;
    }),
    (error: unknown) => {
      const replacement = JSON.parse(fs.readFileSync(`${path}.lock`, "utf8"));
      assert.equal(replacement.token, "replacement");
      return error instanceof AggregateError && error.errors.includes(failure);
    },
  );
});
