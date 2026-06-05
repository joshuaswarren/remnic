import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const hookCases = [
  {
    name: "claude-code",
    scriptPath: "scripts/hooks/claude-code/engram-session-store.sh",
    logPath: [".claude", "logs", "engram-session-store.log"],
  },
  {
    name: "codex",
    scriptPath: "scripts/hooks/codex/engram-session-store.sh",
    logPath: [".codex", "logs", "engram-session-store.log"],
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
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-session-store-"));
  const home = path.join(root, "home");
  const stateHome = path.join(root, "state");
  const transcript = path.join(root, "transcript.jsonl");
  await mkdir(home, { recursive: true });
  await mkdir(stateHome, { recursive: true });
  await writeFile(transcript, "", "utf8");
  return { root, home, stateHome, transcript };
}

function runHook(hookCase, fixture, sessionId, options = {}) {
  return spawnSync("bash", [hookCase.scriptPath], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: fixture.home,
      XDG_STATE_HOME: fixture.stateHome,
      OPENCLAW_ENGRAM_ACCESS_TOKEN: "test-token",
      PATH: options.pathPrefix ? `${options.pathPrefix}:${process.env.PATH}` : process.env.PATH,
    },
    input: JSON.stringify({
      session_id: sessionId,
      transcript_path: fixture.transcript,
      cwd: process.cwd(),
      ...options.input,
    }),
  });
}

for (const hookCase of hookCases) {
  test(`${hookCase.name} session store writes cursor state inside a private state directory`, async () => {
    const fixture = await makeFixture();
    const sessionId = `safe-session-${hookCase.name}-${process.pid}`;
    const stateDir = path.join(fixture.stateHome, "remnic", "hooks");
    const cursorPath = path.join(stateDir, `engram-cursor-${sessionId}`);

    try {
      const result = runHook(hookCase, fixture, sessionId);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "{}\n");

      await waitFor(async () => existsSync(cursorPath), "cursor was not written");

      assert.equal(await readFile(cursorPath, "utf8"), "0\n");
      assert.equal((await stat(stateDir)).mode & 0o777, 0o700);
      assert.equal(existsSync(path.join(os.tmpdir(), `engram-cursor-${sessionId}`)), false);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
      await rm(path.join(os.tmpdir(), `engram-cursor-${sessionId}`), { force: true });
    }
  });

  test(`${hookCase.name} session store refuses to write through a symlinked cursor`, async () => {
    const fixture = await makeFixture();
    const sessionId = `symlink-session-${hookCase.name}-${process.pid}`;
    const stateDir = path.join(fixture.stateHome, "remnic", "hooks");
    const cursorPath = path.join(stateDir, `engram-cursor-${sessionId}`);
    const symlinkTarget = path.join(fixture.root, "target.txt");

    try {
      await mkdir(stateDir, { recursive: true, mode: 0o700 });
      await writeFile(symlinkTarget, "unchanged\n", "utf8");
      await symlink(symlinkTarget, cursorPath);

      const result = runHook(hookCase, fixture, sessionId);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "{}\n");

      const logPath = path.join(fixture.home, ...hookCase.logPath);
      await waitFor(async () => {
        if (!existsSync(logPath)) return false;
        return (await readFile(logPath, "utf8")).includes("unsafe cursor file");
      }, "unsafe cursor was not rejected");

      assert.equal(await readFile(symlinkTarget, "utf8"), "unchanged\n");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test(`${hookCase.name} session store migrates an owned non-symlink tmp cursor once`, async () => {
    const fixture = await makeFixture();
    const sessionId = `tmp-session-${hookCase.name}-${process.pid}`;
    const stateDir = path.join(fixture.stateHome, "remnic", "hooks");
    const cursorPath = path.join(stateDir, `engram-cursor-${sessionId}`);
    const tmpCursorPath = `/tmp/engram-cursor-${sessionId}`;

    try {
      await writeFile(tmpCursorPath, "1\n", "utf8");
      await writeFile(
        fixture.transcript,
        `${JSON.stringify({ type: "user", message: { role: "user", content: "hello" } })}\n`,
        "utf8"
      );

      const result = runHook(hookCase, fixture, sessionId);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "{}\n");

      await waitFor(async () => {
        if (!existsSync(cursorPath) || existsSync(tmpCursorPath)) return false;
        return (await readFile(cursorPath, "utf8")) === "1\n";
      }, "tmp cursor was not migrated");

      assert.equal(await readFile(cursorPath, "utf8"), "1\n");
      assert.equal(existsSync(tmpCursorPath), false);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
      await rm(tmpCursorPath, { force: true });
    }
  });

  test(`${hookCase.name} session store recovers stale private lock directories`, async () => {
    const fixture = await makeFixture();
    const sessionId = `stale-lock-session-${hookCase.name}-${process.pid}`;
    const stateDir = path.join(fixture.stateHome, "remnic", "hooks");
    const lockDir = path.join(stateDir, `engram-lock-${sessionId}.d`);
    const cursorPath = path.join(stateDir, `engram-cursor-${sessionId}`);
    const oldTime = new Date(Date.now() - 20 * 60 * 1000);

    try {
      await mkdir(lockDir, { recursive: true, mode: 0o700 });
      await utimes(lockDir, oldTime, oldTime);

      const result = runHook(hookCase, fixture, sessionId);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "{}\n");

      await waitFor(async () => existsSync(cursorPath), "stale lock was not recovered");

      assert.equal(await readFile(cursorPath, "utf8"), "0\n");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
}

test("codex session store preserves cursor when final-stop observe fails", async () => {
  const hookCase = hookCases.find((entry) => entry.name === "codex");
  assert.ok(hookCase);
  const fixture = await makeFixture();
  const sessionId = `final-fail-session-codex-${process.pid}`;
  const stateDir = path.join(fixture.stateHome, "remnic", "hooks");
  const cursorPath = path.join(stateDir, `engram-cursor-${sessionId}`);
  const fakeBin = path.join(fixture.root, "bin");
  const fakeCurl = path.join(fakeBin, "curl");

  try {
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    await mkdir(fakeBin, { recursive: true });
    await writeFile(cursorPath, "1\n", "utf8");
    await writeFile(
      fixture.transcript,
      [
        JSON.stringify({ type: "user", message: { role: "user", content: "already observed" } }),
        JSON.stringify({ type: "assistant", message: { role: "assistant", content: "pending tail" } }),
      ].join("\n") + "\n",
      "utf8"
    );
    await writeFile(fakeCurl, "#!/usr/bin/env bash\nexit 7\n", "utf8");
    await chmod(fakeCurl, 0o700);

    const result = runHook(hookCase, fixture, sessionId, {
      input: { stop_hook_active: false },
      pathPrefix: fakeBin,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "{}\n");

    const logPath = path.join(fixture.home, ...hookCase.logPath);
    await waitFor(async () => {
      if (!existsSync(logPath)) return false;
      const log = await readFile(logPath, "utf8");
      return log.includes("final-stop") && log.includes("cursor retained for retry");
    }, "final-stop failure was not logged");

    assert.equal(await readFile(cursorPath, "utf8"), "1\n");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
