import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { DEFAULT_CREATE_GAP_SEC, msToWait } from "../scripts/pr-create-stagger.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

test("msToWait returns the remainder of the gap", () => {
  assert.equal(msToWait(1000, 1000 + 10, 65), 55_000);
  assert.equal(msToWait(1000, 1000 + 65, 65), 0);
});

test("msToWait is 0 once the gap elapsed, on clock skew, and on garbage input", () => {
  assert.equal(msToWait(1000, 1000 + 120, 65), 0);
  assert.equal(msToWait(2000, 1000, 65), 0, "stamp in the future never blocks");
  assert.equal(msToWait(Number.NaN, 1000, 65), 0);
  assert.equal(msToWait(1000, Number.NaN, 65), 0);
  assert.equal(msToWait("garbage", 1000, 65), 0);
});

test("msToWait honors a custom gap and rejects non-positive gaps", () => {
  assert.equal(msToWait(1000, 1000 + 4, 5), 1_000);
  assert.equal(msToWait(1000, 1000, 0), 0);
  assert.equal(msToWait(1000, 1000, -10), 0);
});

test("CLI --wait-seconds prints 0 for a long-elapsed stamp and a whole-number wait otherwise", () => {
  const run = (arg) =>
    Number.parseInt(
      execFileSync("node", [path.join(repoRoot, "scripts", "pr-create-stagger.mjs"), "--wait-seconds", arg], {
        encoding: "utf8",
      }).trim(),
      10
    );
  assert.equal(run(String(Math.floor(Date.now() / 1000) - 600)), 0);
  assert.equal(run("not-a-number"), 0);
  const wait = run(String(Math.floor(Date.now() / 1000) - 10));
  // ceil((65-10)s) = 55s, +/- 1s for process-start jitter across a second tick.
  assert.ok(wait >= 54 && wait <= 56, `expected ~55, got ${wait}`);
  assert.equal(DEFAULT_CREATE_GAP_SEC, 65);
});

test("stagger wrapper sleeps the remainder, execs gh with all args, and writes a fresh stamp", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pr-create-stagger-test-"));
  const tmpRoot = path.join(dir, "tmp");
  const lockDir = path.join(tmpRoot, "remnic-pr-create-stagger");
  const binDir = path.join(dir, "bin");
  mkdirSync(lockDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  const ghLog = path.join(dir, "gh.log");
  writeFileSync(
    path.join(binDir, "gh"),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${ghLog}"\necho PR-URL-FROM-STUB\n`,
    { mode: 0o755 }
  );

  writeFileSync(path.join(lockDir, "stamp"), String(Math.floor(Date.now() / 1000)));
  const startedAt = Date.now();
  const out = execFileSync(
    "bash",
    [path.join(repoRoot, "scripts", "gh-pr-create-stagger.sh"), "--title", "t", "--fill"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        TMPDIR: tmpRoot,
        REMNIC_PR_CREATE_GAP_SEC: "3",
      },
    }
  );
  const elapsed = Date.now() - startedAt;
  assert.match(out, /PR-URL-FROM-STUB/);
  assert.deepEqual(readFileSync(ghLog, "utf8").trim().split("\n"), ["pr", "create", "--title", "t", "--fill"]);
  assert.ok(elapsed >= 1000, `expected a stagger sleep, finished in ${elapsed}ms`);
  assert.equal(existsSync(path.join(lockDir, "lock")), true, "lock lives under TMPDIR");
  const stamp = Number.parseInt(readFileSync(path.join(lockDir, "stamp"), "utf8"), 10);
  assert.ok(Number.isInteger(stamp) && stamp >= Math.floor(Date.now() / 1000) - 2, "stamp refreshed after the create");

  rmSync(dir, { recursive: true, force: true });
});

test("stagger wrapper writes a stamp even when gh fails (never hammer through a 429)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pr-create-stagger-test-"));
  const tmpRoot = path.join(dir, "tmp");
  const lockDir = path.join(tmpRoot, "remnic-pr-create-stagger");
  const binDir = path.join(dir, "bin");
  mkdirSync(lockDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(path.join(binDir, "gh"), "#!/usr/bin/env bash\nexit 1\n", { mode: 0o755 });
  writeFileSync(path.join(lockDir, "stamp"), String(Math.floor(Date.now() / 1000) - 600));

  const rc = execFileSync(
    "bash",
    [
      "-c",
      `PATH="${binDir}:$PATH" TMPDIR="${tmpRoot}" REMNIC_PR_CREATE_GAP_SEC="1" ` +
        `bash "${path.join(repoRoot, "scripts", "gh-pr-create-stagger.sh")}" --title x; echo "rc=$?"`,
    ],
    { encoding: "utf8" }
  ).trim();
  assert.match(rc, /rc=1$/);
  const stamp = Number.parseInt(readFileSync(path.join(lockDir, "stamp"), "utf8"), 10);
  assert.ok(Number.isInteger(stamp) && stamp >= Math.floor(Date.now() / 1000) - 2, "stamp written despite gh failure");

  rmSync(dir, { recursive: true, force: true });
});

test("stagger wrapper locks under TMPDIR and does not reference a home path", () => {
  const src = readFileSync(path.join(repoRoot, "scripts", "gh-pr-create-stagger.sh"), "utf8");
  assert.match(src, /\$\{TMPDIR:-\/tmp\}\/remnic-pr-create-stagger/);
  assert.match(src, /flock 9/);
  assert.doesNotMatch(src, /\$HOME|~\//);
  assert.doesNotMatch(src, /os\.homedir/);
});

test("stagger wrapper refuses a symlinked stagger dir and symlinked lock or stamp", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pr-create-stagger-test-"));
  const tmpRoot = path.join(dir, "tmp");
  const binDir = path.join(dir, "bin");
  const realDir = path.join(tmpRoot, "real");
  mkdirSync(realDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(path.join(binDir, "gh"), "#!/usr/bin/env bash\necho SHOULD-NOT-RUN\n", { mode: 0o755 });
  const run = (tmp) =>
    execFileSync(
      "bash",
      [
        "-c",
        `PATH="${binDir}:$PATH" TMPDIR="${tmp}" bash "${path.join(repoRoot, "scripts", "gh-pr-create-stagger.sh")}" --title x; echo "rc=$?"`,
      ],
      { encoding: "utf8" }
    ).trim();

  // Symlinked stagger dir: refused before gh runs.
  const linkRoot = path.join(dir, "linktmp");
  mkdirSync(linkRoot, { recursive: true });
  symlinkSync(realDir, path.join(linkRoot, "remnic-pr-create-stagger"));
  assert.equal(run(linkRoot), "rc=2");

  // Symlinked state files inside an owned dir: refused before gh runs.
  const ownRoot = path.join(dir, "owntmp");
  const ownLockDir = path.join(ownRoot, "remnic-pr-create-stagger");
  mkdirSync(ownLockDir, { recursive: true });
  writeFileSync(path.join(ownLockDir, "victim"), "data");
  symlinkSync(path.join(ownLockDir, "victim"), path.join(ownLockDir, "stamp"));
  assert.equal(run(ownRoot), "rc=2");
  rmSync(path.join(ownLockDir, "stamp"));
  symlinkSync(path.join(ownLockDir, "victim"), path.join(ownLockDir, "lock"));
  assert.equal(run(ownRoot), "rc=2");

  rmSync(dir, { recursive: true, force: true });
});
