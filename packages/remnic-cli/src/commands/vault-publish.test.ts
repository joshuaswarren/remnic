import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { withTempDirSync } from "../testing/tmp-dir.js";
import { runVaultPublishCommand } from "./vault-publish.js";

const START = "<!-- remnic:timeline:start -->";
const END = "<!-- remnic:timeline:end -->";

function capture(rest: string[]): { code: number; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = runVaultPublishCommand(rest, {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });
  return { code, stdout, stderr };
}

test("apply replaces the marked region and prints ok", () => {
  withTempDirSync("vault-publish-apply", (dir) => {
    const file = path.join(dir, "daily.md");
    fs.writeFileSync(file, ["# Daily", START, "old cards", END, "## Notes", ""].join("\n"));
    const result = capture(["apply", "--file", file, "--name", "timeline", "--content", "new cards"]);
    assert.equal(result.code, 0);
    assert.deepEqual(result.stdout, ["ok"]);
    assert.equal(result.stderr.length, 0);
    assert.equal(
      fs.readFileSync(file, "utf8"),
      ["# Daily", START, "new cards", END, "## Notes", ""].join("\n"),
    );
  });
});

test("missing markers exit 1 with no_marker and do not write", () => {
  withTempDirSync("vault-publish-no-marker", (dir) => {
    const file = path.join(dir, "daily.md");
    const original = "# Daily\nno region\n";
    fs.writeFileSync(file, original);
    const result = capture(["apply", "--file", file, "--name", "timeline", "--content", "new cards"]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout.length, 0);
    assert.deepEqual(result.stderr, ["no_marker"]);
    assert.equal(fs.readFileSync(file, "utf8"), original);
  });
});

test("missing file exits 1 and is not created", () => {
  withTempDirSync("vault-publish-missing", (dir) => {
    const missing = path.join(dir, "absent.md");
    const result = capture([
      "apply",
      "--file",
      missing,
      "--name",
      "timeline",
      "--content",
      "new cards",
    ]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout.length, 0);
    assert.deepEqual(result.stderr, ["missing_file"]);
    assert.equal(fs.existsSync(missing), false);
  });
});

test("apply without required flags is a usage error", () => {
  const result = capture(["apply"]);
  assert.equal(result.code, 1);
  assert.equal(result.stdout.length, 0);
  assert.match(result.stderr.join("\n"), /--file/);
});
