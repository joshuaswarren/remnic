import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(repoRoot, "scripts", "agent-checkpoint.mjs");

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function createRepo() {
  const root = mkdtempSync(path.join(os.tmpdir(), "remnic-agent-checkpoint-"));
  git(root, "init");
  git(root, "config", "user.email", "dev@example.com");
  git(root, "config", "user.name", "Dev");
  writeFileSync(path.join(root, "README"), "ok\n");
  git(root, "add", "README");
  git(root, "commit", "-m", "init");
  return root;
}

function run(cwd, args) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    encoding: "utf8",
  });
}

function stateFile(cwd) {
  return path.join(git(cwd, "rev-parse", "--absolute-git-dir"), "AGENT-STATE.md");
}

test("write creates and appends formatted entries", () => {
  const root = createRepo();
  try {
    const head = git(root, "rev-parse", "--short", "HEAD");
    const created = run(root, ["write", "--note", "first milestone"]);
    assert.equal(created.status, 0, created.stderr);
    const first = readFileSync(stateFile(root), "utf8");
    assert.match(
      first,
      new RegExp(`^\\d{4}-\\d{2}-\\d{2}T[^\\n]*Z \\| ${head} \\| first milestone\\n$`),
    );

    const appended = run(root, ["write", "inferred", "from", "args"]);
    assert.equal(appended.status, 0, appended.stderr);
    const lines = readFileSync(stateFile(root), "utf8").trimEnd().split("\n");
    assert.equal(lines.length, 2);
    assert.match(lines[1], new RegExp(`\\| ${head} \\| inferred from args$`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("read returns entries and exit codes", () => {
  const root = createRepo();
  try {
    const missing = run(root, ["read"]);
    assert.equal(missing.status, 1);

    writeFileSync(stateFile(root), "");
    const empty = run(root, ["read"]);
    assert.equal(empty.status, 1);

    const written = run(root, ["write", "--note", "alpha"]);
    assert.equal(written.status, 0, written.stderr);

    const text = run(root, ["read"]);
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /\| alpha\n$/);

    const json = run(root, ["read", "--json"]);
    assert.equal(json.status, 0, json.stderr);
    const parsed = JSON.parse(json.stdout);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].note, "alpha");
    assert.match(parsed[0].timestamp, /^\d{4}-\d{2}-\d{2}T.*Z$/);
    assert.equal(parsed[0].head, git(root, "rev-parse", "--short", "HEAD"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
