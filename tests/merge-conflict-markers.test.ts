import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const filesToCheck = ["CHANGELOG.md", "openclaw.plugin.json", "src/types.ts"];

const conflictMarkerPattern = /^(<<<<<<<|=======|>>>>>>>) /m;

test("tracked files do not contain unresolved merge conflict markers", async () => {
  for (const file of filesToCheck) {
    const content = await readFile(file, "utf8");
    assert.equal(
      conflictMarkerPattern.test(content),
      false,
      `${file} contains unresolved merge conflict markers`,
    );
  }
});
