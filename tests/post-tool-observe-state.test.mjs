import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// The Codex plugin's PostToolUse hook is now the unified Node.js runner
// (issue #1440 — packages/plugin-codex/hooks/bin/remnic-codex-hook.cjs).
// State-dir / cursor / lock hardening is covered by the runner's own
// integration tests in remnic-codex-hook.test.cjs. Only the Claude Code
// bash script is still asserted from here.
const hookCases = [
  {
    name: "claude-code-package",
    scriptPath: "packages/plugin-claude-code/hooks/bin/post-tool-observe.sh",
  },
];

async function waitFor(predicate, message) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(message);
}

async function makeFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-post-tool-state-"));
  const home = path.join(root, "home");
  const stateHome = path.join(root, "state");
  const transcript = path.join(root, "transcript.jsonl");
  await mkdir(home, { recursive: true });
  await mkdir(stateHome, { recursive: true });
  await writeFile(transcript, "", "utf8");
  return { root, home, stateHome, transcript };
}

async function removeFixture(fixture) {
  await rm(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function runHook(hookCase, fixture, sessionId) {
  return spawnSync("bash", [hookCase.scriptPath], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: fixture.home,
      XDG_STATE_HOME: fixture.stateHome,
      OPENCLAW_REMNIC_ACCESS_TOKEN: "test-token",
    },
    input: JSON.stringify({
      session_id: sessionId,
      transcript_path: fixture.transcript,
      cwd: process.cwd(),
      tool_name: "Bash",
    }),
  });

}

// `runCodexSessionEnd` lived here when the Codex plugin shipped a bash
// session-end.sh. The unified Node.js runner now owns that surface (#1440),
// and its symlinked-cursor + /tmp-migration regressions are exercised by
// `packages/plugin-codex/hooks/bin/remnic-codex-hook.test.cjs`. Nothing here
// needs to spawn a Codex hook anymore.

for (const hookCase of hookCases) {
  test(`${hookCase.name} writes cursor state inside a private state directory`, async () => {
    const fixture = await makeFixture();
    const sessionId = `post-tool-safe-${hookCase.name}-${process.pid}`;
    const stateDir = path.join(fixture.stateHome, "remnic", "hooks");
    const cursorPath = path.join(stateDir, `remnic-cursor-${sessionId}`);

    try {
      const result = runHook(hookCase, fixture, sessionId);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, '{"continue":true}\n');

      await waitFor(async () => existsSync(cursorPath), "cursor was not written");

      assert.equal(await readFile(cursorPath, "utf8"), "0\n");
      assert.equal((await stat(stateDir)).mode & 0o777, 0o700);
      assert.equal(existsSync(path.join(os.tmpdir(), `remnic-cursor-${sessionId}`)), false);
      assert.equal(existsSync(path.join(os.tmpdir(), `engram-cursor-${sessionId}`)), false);
    } finally {
      await removeFixture(fixture);
      await rm(path.join(os.tmpdir(), `remnic-cursor-${sessionId}`), { force: true });
      await rm(path.join(os.tmpdir(), `engram-cursor-${sessionId}`), { force: true });
    }
  });

  test(`${hookCase.name} refuses to write through a symlinked cursor`, async () => {
    const fixture = await makeFixture();
    const sessionId = `post-tool-symlink-${hookCase.name}-${process.pid}`;
    const stateDir = path.join(fixture.stateHome, "remnic", "hooks");
    const cursorPath = path.join(stateDir, `remnic-cursor-${sessionId}`);
    const symlinkTarget = path.join(fixture.root, "target.txt");

    try {
      await mkdir(stateDir, { recursive: true, mode: 0o700 });
      await writeFile(symlinkTarget, "unchanged\n", "utf8");
      await symlink(symlinkTarget, cursorPath);

      const result = runHook(hookCase, fixture, sessionId);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, '{"continue":true}\n');

      const logPath = path.join(fixture.home, ".remnic", "logs", "remnic-post-tool-observe.log");
      await waitFor(async () => {
        if (!existsSync(logPath)) return false;
        return (await readFile(logPath, "utf8")).includes("unsafe cursor file");
      }, "unsafe cursor was not rejected");

      assert.equal(await readFile(symlinkTarget, "utf8"), "unchanged\n");
    } finally {
      await removeFixture(fixture);
    }
  });

  test(`${hookCase.name} reuses a private engram cursor when remnic cursor is absent`, async () => {
    const fixture = await makeFixture();
    const sessionId = `post-tool-engram-${hookCase.name}-${process.pid}`;
    const stateDir = path.join(fixture.stateHome, "remnic", "hooks");
    const engramCursorPath = path.join(stateDir, `engram-cursor-${sessionId}`);
    const remnicCursorPath = path.join(stateDir, `remnic-cursor-${sessionId}`);

    try {
      await mkdir(stateDir, { recursive: true, mode: 0o700 });
      await writeFile(engramCursorPath, "1\n", "utf8");
      await writeFile(
        fixture.transcript,
        `${JSON.stringify({ type: "user", message: { role: "user", content: "hello" } })}\n`,
        "utf8",
      );

      const result = runHook(hookCase, fixture, sessionId);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, '{"continue":true}\n');

      await waitFor(async () => (await readFile(engramCursorPath, "utf8")) === "1\n", "engram cursor changed unexpectedly");

      assert.equal(existsSync(remnicCursorPath), false);
    } finally {
      await removeFixture(fixture);
    }
  });

  test(`${hookCase.name} migrates an owned non-symlink tmp cursor once`, async () => {
    const fixture = await makeFixture();
    const sessionId = `post-tool-tmp-${hookCase.name}-${process.pid}`;
    const stateDir = path.join(fixture.stateHome, "remnic", "hooks");
    const cursorPath = path.join(stateDir, `remnic-cursor-${sessionId}`);
    const tmpCursorPath = `/tmp/remnic-cursor-${sessionId}`;

    try {
      await writeFile(tmpCursorPath, "1\n", "utf8");
      await writeFile(
        fixture.transcript,
        `${JSON.stringify({ type: "user", message: { role: "user", content: "hello" } })}\n`,
        "utf8",
      );

      const result = runHook(hookCase, fixture, sessionId);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, '{"continue":true}\n');

      await waitFor(async () => {
        if (!existsSync(cursorPath) || existsSync(tmpCursorPath)) return false;
        return (await readFile(cursorPath, "utf8")) === "1\n";
      }, "tmp cursor was not migrated");

      assert.equal(await readFile(cursorPath, "utf8"), "1\n");
      assert.equal(existsSync(tmpCursorPath), false);
    } finally {
      await removeFixture(fixture);
      await rm(tmpCursorPath, { force: true });
    }
  });

  test(`${hookCase.name} prefers a newer tmp cursor over older private engram state`, async () => {
    const fixture = await makeFixture();
    const sessionId = `post-tool-newer-tmp-${hookCase.name}-${process.pid}`;
    const stateDir = path.join(fixture.stateHome, "remnic", "hooks");
    const engramCursorPath = path.join(stateDir, `engram-cursor-${sessionId}`);
    const remnicTmpCursorPath = `/tmp/remnic-cursor-${sessionId}`;
    const engramTmpCursorPath = `/tmp/engram-cursor-${sessionId}`;

    try {
      await mkdir(stateDir, { recursive: true, mode: 0o700 });
      await writeFile(engramCursorPath, "1\n", "utf8");
      await writeFile(remnicTmpCursorPath, "2\n", "utf8");
      await writeFile(engramTmpCursorPath, "3\n", "utf8");
      await writeFile(
        fixture.transcript,
        `${JSON.stringify({ type: "user", message: { role: "user", content: "hello" } })}\n${JSON.stringify({ type: "assistant", message: { role: "assistant", content: "world" } })}\n${JSON.stringify({ type: "user", message: { role: "user", content: "again" } })}\n`,
        "utf8",
      );

      const result = runHook(hookCase, fixture, sessionId);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, '{"continue":true}\n');

      await waitFor(async () => {
        if (existsSync(remnicTmpCursorPath) || existsSync(engramTmpCursorPath)) return false;
        return (await readFile(engramCursorPath, "utf8")) === "3\n";
      }, "newer tmp cursor was not preserved");

      assert.equal(existsSync(remnicTmpCursorPath), false);
      assert.equal(existsSync(engramTmpCursorPath), false);
    } finally {
      await removeFixture(fixture);
      await rm(remnicTmpCursorPath, { force: true });
      await rm(engramTmpCursorPath, { force: true });
    }
  });

  test(`${hookCase.name} recovers stale private lock directories`, async () => {
    const fixture = await makeFixture();
    const sessionId = `post-tool-stale-lock-${hookCase.name}-${process.pid}`;
    const stateDir = path.join(fixture.stateHome, "remnic", "hooks");
    const lockDir = path.join(stateDir, `remnic-lock-${sessionId}.d`);
    const cursorPath = path.join(stateDir, `remnic-cursor-${sessionId}`);
    const oldTime = new Date(Date.now() - 20 * 60 * 1000);

    try {
      await mkdir(lockDir, { recursive: true, mode: 0o700 });
      await utimes(lockDir, oldTime, oldTime);

      const result = runHook(hookCase, fixture, sessionId);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, '{"continue":true}\n');

      await waitFor(async () => existsSync(cursorPath), "stale lock was not recovered");

      assert.equal(await readFile(cursorPath, "utf8"), "0\n");
    } finally {
      await removeFixture(fixture);
    }
  });
}

// Codex-specific session-end tests (unsafe-cursor skip, /tmp-cursor migration)
// were ported to the unified Node.js runner's own suite in
// `packages/plugin-codex/hooks/bin/remnic-codex-hook.test.cjs` (issue #1440).
