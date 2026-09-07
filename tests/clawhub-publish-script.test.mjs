import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const SCRIPT = path.resolve("scripts/clawhub-publish.sh");

// Runs the script against a fake bin dir: `clawhub` publish fails `failures`
// times with `message`, then succeeds. npm/pnpm/git are stubbed as no-ops.
function run({ failures, message }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "clawhub-publish-"));
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  mkdirSync(path.join(dir, "pkg"));
  writeFileSync(path.join(dir, "pkg", "package.json"), JSON.stringify({ version: "1.2.3" }));
  const counter = path.join(dir, "attempts");
  writeFileSync(counter, "0");
  const stub = (name, body) => {
    writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  };
  stub("npm", "exit 0");
  stub("git", 'echo deadbeef');
  stub("pnpm", `touch "$5/plugin-1.2.3.tgz"`);
  stub(
    "clawhub",
    `case "$1 $2" in
      "login "*) exit 0 ;;
      "package inspect") exit 1 ;;
      "package rescan") exit 0 ;;
      "package publish")
        n=$(cat "${counter}"); n=$((n+1)); echo "$n" > "${counter}"
        if [ "$n" -le ${failures} ]; then echo "Error: ${message}"; exit 1; fi
        echo '{"ok":true}'; exit 0 ;;
    esac
    exit 99`,
  );
  const result = spawnSync("bash", [SCRIPT], {
    cwd: dir,
    encoding: "utf8",
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      CLAWHUB_TOKEN: "t",
      SOURCE_REF: "v1.2.3",
      GITHUB_REPOSITORY: "o/r",
      RUNNER_TEMP: dir,
      NPM_PACKAGE_PATH: "pkg",
      CLAWHUB_PUBLISH_BACKOFF_SECONDS: "0",
    },
  });
  return { ...result, attempts: Number(readFileSync(counter, "utf8")) };
}

test("retries transient ClawHub rate-limit errors and succeeds", () => {
  const r = run({ failures: 2, message: "Your request couldn't be completed. Try again later." });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.attempts, 3);
  assert.match(r.stdout, /"ok":true/);
});

test("exhausted transient retries exit 0 with a notice", () => {
  const r = run({ failures: 10, message: "Too many bytes read in a single function execution" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.attempts, 3);
  assert.match(r.stdout, /::notice title=ClawHub publish skipped::/);
});

test("unknown ClawHub errors stay fatal without retry", () => {
  const r = run({ failures: 10, message: "invalid manifest" });
  assert.equal(r.status, 1);
  assert.equal(r.attempts, 1);
});
