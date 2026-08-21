import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import { withTempDir } from "./tmp-dir.js";

test("withTempDir removes the directory after a failed callback", async () => {
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

test("rejects path separators in a temporary directory prefix", async () => {
  await assert.rejects(withTempDir("../escape", async () => undefined), /path separator/);
});
