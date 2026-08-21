import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { compareCodePoints } from "../codepoint-order.js";
import {
  hashDirectory,
  listRegularFiles,
  stableStringify,
} from "./repeated-failure-suite-shared.js";

test("codepoint comparator returns only ordered trinary results", () => {
  assert.equal(compareCodePoints("same", "same"), 0);
  assert.equal(compareCodePoints("\ue000", "\u{10000}"), -1);
  assert.equal(compareCodePoints("\u{10000}", "\ue000"), 1);
});

test("H6 hash inputs use codepoint order for non-ASCII fixture names", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "h6-codepoint-order-"));
  try {
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "ä-fixture.txt"), "umlaut\n", "utf8");
    await writeFile(path.join(root, "z-fixture.txt"), "ascii\n", "utf8");
    const originalLocaleCompare = String.prototype.localeCompare;
    String.prototype.localeCompare = () => {
      throw new Error("localeCompare must not participate in deterministic H6 outputs");
    };
    try {

      const files = await listRegularFiles(root, false);
      assert.deepEqual(files.map((file) => path.basename(file)), ["z-fixture.txt", "ä-fixture.txt"]);
      assert.equal(stableStringify({ "ä-fixture": 1, "z-fixture": 2 }), '{"z-fixture":2,"ä-fixture":1}');

      const expectedHash = createHash("sha256")
        .update("z-fixture.txt")
        .update("\0")
        .update("ascii\n")
        .update("\0")
        .update("ä-fixture.txt")
        .update("\0")
        .update("umlaut\n")
        .update("\0")
        .digest("hex");
      assert.equal(await hashDirectory(root, false), expectedHash);
    } finally {
      String.prototype.localeCompare = originalLocaleCompare;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
