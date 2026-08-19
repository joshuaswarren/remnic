import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { withTempDirSync } from "../testing/tmp-dir.js";
import { runJournalVaultCommand } from "./journal-vault.js";

const START = "<!-- remnic:timeline:start -->";
const END = "<!-- remnic:timeline:end -->";

function capture(rest: string[]): { code: number; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = runJournalVaultCommand(rest, {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });
  return { code, stdout, stderr };
}

test("show prints the stripped section and does not write", () => {
  withTempDirSync("journal-vault-show", (dir) => {
    const file = path.join(dir, "daily.md");
    const original = [
      "## Journal",
      "user text",
      START,
      "published",
      END,
      "## Notes",
      "",
    ].join("\n");
    fs.writeFileSync(file, original);
    const result = capture(["show", "--file", file, "--section", "Journal"]);
    assert.equal(result.code, 0);
    assert.equal(result.stdout.join("\n"), "user text");
    assert.equal(result.stderr.length, 0);
    assert.equal(fs.readFileSync(file, "utf8"), original);
  });
});

test("missing file and missing heading print exists:false and do not create a file", () => {
  withTempDirSync("journal-vault-missing", (dir) => {
    const missing = path.join(dir, "absent.md");
    const missingFile = capture(["show", "--file", missing, "--section", "Journal"]);
    assert.equal(missingFile.code, 0);
    assert.deepEqual(missingFile.stdout, ["exists:false"]);
    assert.equal(fs.existsSync(missing), false);

    const file = path.join(dir, "daily.md");
    fs.writeFileSync(file, "## Notes\nonly notes\n");
    const before = fs.readFileSync(file, "utf8");
    const missingHeading = capture(["show", "--file", file, "--section", "Journal"]);
    assert.equal(missingHeading.code, 0);
    assert.deepEqual(missingHeading.stdout, ["exists:false"]);
    assert.equal(fs.readFileSync(file, "utf8"), before);
  });
});

test("duplicate heading exits non-zero and lists line numbers", () => {
  withTempDirSync("journal-vault-dup", (dir) => {
    const file = path.join(dir, "daily.md");
    const original = ["# Day", "## Journal", "first", "## Notes", "## Journal", "second", ""].join(
      "\n",
    );
    fs.writeFileSync(file, original);
    const result = capture(["show", "--file", file, "--section", "Journal"]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout.length, 0);
    assert.match(result.stderr.join("\n"), /duplicate heading at lines 2, 5/);
    assert.equal(fs.readFileSync(file, "utf8"), original);
  });
});

test("show without --file or --section is a usage error", () => {
  const result = capture(["show"]);
  assert.equal(result.code, 1);
  assert.equal(result.stdout.length, 0);
  assert.match(result.stderr.join("\n"), /--file/);
});
