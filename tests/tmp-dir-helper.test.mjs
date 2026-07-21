import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { makeTempDir, makeTempDirSync, withTempDir, withTempDirSync } from "./helpers/tmp-dir.mjs";

test("makeTempDir creates an existing dir with the requested prefix", async () => {
  const dir = await makeTempDir("tmp-dir-helper-async-");
  assert.ok(existsSync(dir));
  assert.match(basename(dir), /^tmp-dir-helper-async-/);
});

test("makeTempDirSync creates an existing dir with the requested prefix", () => {
  const dir = makeTempDirSync("tmp-dir-helper-sync-");
  assert.ok(existsSync(dir));
  assert.match(basename(dir), /^tmp-dir-helper-sync-/);
});

test("withTempDir exposes the dir to the callback and removes it afterward", async () => {
  let seen = "";
  const returned = await withTempDir(async (dir) => {
    seen = dir;
    assert.ok(existsSync(dir));
    return "ok";
  }, "tmp-dir-helper-scoped-");
  assert.equal(returned, "ok");
  assert.equal(existsSync(seen), false);
});

test("withTempDirSync exposes the dir to the callback and removes it afterward", () => {
  let seen = "";
  const returned = withTempDirSync((dir) => {
    seen = dir;
    assert.ok(existsSync(dir));
    return 42;
  }, "tmp-dir-helper-scoped-sync-");
  assert.equal(returned, 42);
  assert.equal(existsSync(seen), false);
});

test("withTempDir removes the dir when the callback rejects", async () => {
  let seen = "";
  await assert.rejects(
    withTempDir(async (dir) => {
      seen = dir;
      assert.ok(existsSync(dir));
      throw new Error("boom");
    }, "tmp-dir-helper-reject-"),
    /boom/,
  );
  assert.notEqual(seen, "");
  assert.equal(existsSync(seen), false);
});

test("withTempDirSync removes the dir when the callback throws", () => {
  let seen = "";
  assert.throws(
    () =>
      withTempDirSync((dir) => {
        seen = dir;
        assert.ok(existsSync(dir));
        throw new Error("boom");
      }, "tmp-dir-helper-throw-sync-"),
    /boom/,
  );
  assert.notEqual(seen, "");
  assert.equal(existsSync(seen), false);
});
