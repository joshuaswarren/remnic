import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import { withTempDir, withTempDirSync } from "./tmp-dir.js";

test("withTempDirSync removes the directory after a successful callback", () => {
  let createdDir = "";

  const result = withTempDirSync("success", (dir) => {
    createdDir = dir;
    return 42;
  });

  assert.equal(result, 42);
  assert.equal(existsSync(createdDir), false);
});

test("withTempDirSync removes the directory after a failed callback", () => {
  let createdDir = "";

  assert.throws(() =>
    withTempDirSync("failure", (dir) => {
      createdDir = dir;
      throw new Error("callback failed");
    }),
  /callback failed/);

  assert.equal(existsSync(createdDir), false);
});

test("withTempDir removes the directory after a failed callback", async () => {
  let createdDir = "";

  await assert.rejects(
    withTempDir("async-failure", async (dir) => {
      createdDir = dir;
      throw new Error("callback failed");
    }),
    /callback failed/,
  );

  assert.equal(existsSync(createdDir), false);
});

test("rejects path separators in temporary directory prefixes", async () => {
  assert.throws(() => withTempDirSync("../escape", () => undefined), /path separator/);
  await assert.rejects(withTempDir("nested/escape", async () => undefined), /path separator/);
});
