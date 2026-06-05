import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const sessionEndHook = "packages/plugin-codex/hooks/bin/session-end.sh";

test("Codex session-end hook falls back to private legacy engram cursor files", async () => {
  const content = await readFile(sessionEndHook, "utf8");

  assert.match(content, /LEGACY_CURSOR_FILE="\$\{STATE_DIR\}\/engram-cursor-\$\{SESSION_ID\}"/);
  assert.match(content, /CURSOR_FILE="\$\{STATE_DIR\}\/remnic-cursor-\$\{SESSION_ID\}"/);
  assert.match(content, /if \[ "\$SESSION_ID_SAFE" -eq 1 \] && \[ ! -f "\$CURSOR_FILE" \]/);
  assert.match(content, /CURSOR_FILE="\$LEGACY_CURSOR_FILE"/);
  assert.match(
    content,
    /for TMP_CURSOR_FILE in "\/tmp\/remnic-cursor-\$\{SESSION_ID\}" "\/tmp\/engram-cursor-\$\{SESSION_ID\}"; do/
  );
});

test("Codex session-end hook retries legacy engram tokens when remnic token parsing fails", async () => {
  const content = await readFile(sessionEndHook, "utf8");

  assert.match(
    content,
    /for TOKEN_FILE in "\$\{HOME\}\/\.remnic\/tokens\.json" "\$\{HOME\}\/\.engram\/tokens\.json"; do/
  );
  assert.match(content, /\[ ! -f "\$TOKEN_FILE" \] && continue/);
  assert.match(content, /JSON\.parse\(fs\.readFileSync\(tokenFile, 'utf8'\)\)/);
  assert.match(content, /\[ -n "\$REMNIC_TOKEN" \] && break/);
});

async function waitFor(predicate: () => Promise<boolean>, message: string) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(message);
}

test("Codex session-end hook preserves cursor when final flush observe fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-codex-session-end-"));
  const home = path.join(root, "home");
  const stateHome = path.join(root, "state");
  const stateDir = path.join(stateHome, "remnic", "hooks");
  const fakeBin = path.join(root, "bin");
  const fakeCurl = path.join(fakeBin, "curl");
  const transcriptPath = path.join(root, "transcript.jsonl");
  const sessionId = `codex-final-flush-fail-${process.pid}`;
  const cursorPath = path.join(stateDir, `remnic-cursor-${sessionId}`);
  const logPath = path.join(home, ".remnic", "logs", "remnic-codex-session-end.log");

  try {
    await mkdir(home, { recursive: true });
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    await mkdir(fakeBin, { recursive: true });
    await writeFile(cursorPath, "1\n", "utf8");
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({ type: "user", message: { role: "user", content: "already observed" } }),
        JSON.stringify({ type: "assistant", message: { role: "assistant", content: "pending tail" } }),
      ].join("\n") + "\n",
      "utf8"
    );
    await writeFile(fakeCurl, "#!/usr/bin/env bash\nexit 7\n", "utf8");
    await chmod(fakeCurl, 0o700);

    const result = spawnSync("bash", [sessionEndHook], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        XDG_STATE_HOME: stateHome,
        OPENCLAW_REMNIC_ACCESS_TOKEN: "test-token",
        REMNIC_CODEX_MATERIALIZE: "0",
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
      input: JSON.stringify({
        session_id: sessionId,
        transcript_path: transcriptPath,
      }),
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '{"continue":true}\n');

    await waitFor(async () => {
      if (!existsSync(logPath)) return false;
      return (await readFile(logPath, "utf8")).includes("cursor retained for retry");
    }, "final flush failure was not logged");

    assert.equal(await readFile(cursorPath, "utf8"), "1\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
