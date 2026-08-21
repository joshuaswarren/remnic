import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { withTempDir } from "./tmp-dir";

test("withTempDir removes the directory after a successful callback", async () => {
  let createdDir = "";

  await withTempDir("contract", async (dir) => {
    createdDir = dir;
    assert.equal(path.basename(dir).startsWith("remnic-bench-ui-contract-"), true);
    assert.equal(existsSync(dir), true);
  });

  assert.equal(existsSync(createdDir), false);
});

test("withTempDir removes the directory after a rejected callback", async () => {
  let createdDir = "";

  await assert.rejects(
    withTempDir("failure", async (dir) => {
      createdDir = dir;
      throw new Error("callback failed");
    }),
    /callback failed/,
  );

  assert.equal(existsSync(createdDir), false);
});
