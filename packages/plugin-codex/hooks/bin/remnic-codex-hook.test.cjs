"use strict";

// Integration tests for the unified Codex hook runner (issue #1440).
// Each test spawns the real remnic-codex-hook.cjs against a mock Remnic HTTP
// server, with an isolated HOME/XDG_STATE_HOME, and asserts both the emitted
// hook JSON and the cursor/observe side effects — including the regressions
// fixed relative to the original PR (cursor retention on failed final flush).

const assert = require("node:assert/strict");
const test = require("node:test");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const RUNNER = path.join(__dirname, "remnic-codex-hook.cjs");

function startServer(handler) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let parsed = null;
      try {
        parsed = body ? JSON.parse(body) : null;
      } catch {
        parsed = body;
      }
      calls.push({ method: req.method, url: req.url, body: parsed });
      handler(req, res, parsed);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port, calls });
    });
  });
}

function mkHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-codex-test-"));
  return dir;
}

// Async spawn (NOT spawnSync) so the in-process mock HTTP server's event loop
// stays free to answer the runner's requests while it runs.
function runHook(event, input, { port, home, env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [RUNNER, event], {
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        XDG_STATE_HOME: path.join(home, "state"),
        REMNIC_HOST: "127.0.0.1",
        REMNIC_PORT: String(port),
        REMNIC_CODEX_MATERIALIZE: "0",
        // Default to an env token unless a test overrides it.
        OPENCLAW_REMNIC_ACCESS_TOKEN: env.token === null ? "" : env.token || "test-token",
        ...env.extra,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", () => {
      let json = null;
      try {
        json = JSON.parse(stdout.trim().split("\n").filter(Boolean).pop());
      } catch {
        /* leave null */
      }
      resolve({ stdout, stderr, json });
    });
    child.stdin.end(typeof input === "string" ? input : JSON.stringify(input));
  });
}

function transcript(home, messages) {
  const file = path.join(home, "transcript.jsonl");
  const lines = messages.map((m) => JSON.stringify({ type: m.role, message: { role: m.role, content: m.content } }));
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

function cursorPath(home, sessionId) {
  return path.join(home, "state", "remnic", "hooks", `remnic-cursor-${sessionId}`);
}

test("session-start: healthy server returns recall context with codingContext cleared outside a repo", async () => {
  const home = mkHome();
  const { server, port, calls } = await startServer((req, res, body) => {
    if (req.url === "/engram/v1/health") return res.writeHead(200).end("ok");
    if (req.url === "/engram/v1/recall") {
      return res.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({ context: "remembered preferences", count: 3, mode: "auto" }),
      );
    }
    res.writeHead(404).end();
  });
  try {
    const { json } = await runHook("session-start", { session_id: "s1", cwd: home }, { port, home });
    assert.equal(json.continue, true);
    assert.match(json.hookSpecificOutput.additionalContext, /Remnic Memory Recall — 3 memories/);
    assert.match(json.hookSpecificOutput.additionalContext, /remembered preferences/);
    const recall = calls.find((c) => c.url === "/engram/v1/recall");
    assert.ok(recall, "recall was called");
    assert.equal(recall.body.mode, "auto");
    assert.equal(recall.body.topK, 12);
    // Outside a git repo, codingContext is explicitly null (clears stale routing).
    assert.ok("codingContext" in recall.body);
    assert.equal(recall.body.codingContext, null);
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("session-start: falls back to minimal mode when full recall fails", async () => {
  const home = mkHome();
  let recallHits = 0;
  const { server, port, calls } = await startServer((req, res) => {
    if (req.url === "/engram/v1/health") return res.writeHead(200).end("ok");
    if (req.url === "/engram/v1/recall") {
      recallHits += 1;
      if (recallHits === 1) return res.writeHead(500).end("boom");
      return res.writeHead(200).end(JSON.stringify({ context: "fallback ctx", count: 1, mode: "minimal" }));
    }
    res.writeHead(404).end();
  });
  try {
    const { json } = await runHook("session-start", { session_id: "s1", cwd: home }, { port, home });
    assert.match(json.hookSpecificOutput.additionalContext, /minimal mode/);
    const recalls = calls.filter((c) => c.url === "/engram/v1/recall");
    assert.equal(recalls.length, 2);
    assert.equal(recalls[1].body.mode, "minimal");
    assert.equal(recalls[1].body.topK, 8);
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("session-start: no token → guidance message, no recall call", async () => {
  const home = mkHome();
  const { server, port, calls } = await startServer((req, res) => {
    if (req.url === "/engram/v1/health") return res.writeHead(200).end("ok");
    res.writeHead(200).end("{}");
  });
  try {
    const { json } = await runHook("session-start", { session_id: "s1", cwd: home }, { port, home, env: { token: null } });
    assert.match(json.hookSpecificOutput.additionalContext, /no auth token/);
    assert.equal(calls.filter((c) => c.url === "/engram/v1/recall").length, 0);
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("session-start: dead daemon → distinct daemon-not-running message", async () => {
  const home = mkHome();
  // Use a port with no listener to simulate a dead daemon.
  const dead = await startServer(() => {});
  const port = dead.port;
  dead.server.close();
  await new Promise((r) => setTimeout(r, 50));
  const { json } = await runHook("session-start", { session_id: "s1", cwd: home }, { port, home });
  assert.match(json.hookSpecificOutput.additionalContext, /daemon not running/);
  fs.rmSync(home, { recursive: true, force: true });
});

test("user-prompt-recall: short prompt is skipped with bare continue", async () => {
  const home = mkHome();
  const { server, port, calls } = await startServer((req, res) => res.writeHead(200).end("{}"));
  try {
    const { json } = await runHook("user-prompt-recall", { session_id: "s1", prompt: "hi there" }, { port, home });
    assert.deepEqual(json, { continue: true });
    assert.equal(calls.length, 0);
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("user-prompt-recall: no token → bare continue, no banner, no call", async () => {
  const home = mkHome();
  const { server, port, calls } = await startServer((req, res) => res.writeHead(200).end("{}"));
  try {
    const { json } = await runHook(
      "user-prompt-recall",
      { session_id: "s1", prompt: "this is a sufficiently long prompt" },
      { port, home, env: { token: null } },
    );
    assert.deepEqual(json, { continue: true });
    assert.equal(calls.length, 0);
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("user-prompt-recall: long prompt injects <remnic-memory> context", async () => {
  const home = mkHome();
  const { server, port, calls } = await startServer((req, res) => {
    if (req.url === "/engram/v1/recall") {
      return res.writeHead(200).end(JSON.stringify({ context: "rel ctx", count: 2 }));
    }
    res.writeHead(404).end();
  });
  try {
    const { json } = await runHook(
      "user-prompt-recall",
      { session_id: "s1", prompt: "please recall the deployment decisions we made" },
      { port, home },
    );
    assert.match(json.hookSpecificOutput.additionalContext, /<remnic-memory count="2">/);
    assert.equal(calls[0].body.mode, "minimal");
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("observe worker: advances cursor only after a successful observe", async () => {
  const home = mkHome();
  const { server, port, calls } = await startServer((req, res) => res.writeHead(200).end("{}"));
  try {
    const tpath = transcript(home, [
      { role: "user", content: "first" },
      { role: "assistant", content: "second" },
    ]);
    // Run the worker mode (foreground spawns this detached), payload via stdin.
    await runHook(
      "__observe-worker__",
      JSON.stringify({ session_id: "sObs", transcript_path: tpath }),
      { port, home },
    );
    const observe = calls.find((c) => c.url === "/engram/v1/observe");
    assert.ok(observe, "observe was called");
    assert.equal(observe.body.messages.length, 2);
    assert.equal(fs.readFileSync(cursorPath(home, "sObs"), "utf8").trim(), "2");
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("observe worker: does NOT advance the cursor when observe fails", async () => {
  const home = mkHome();
  const { server, port } = await startServer((req, res) => {
    if (req.url === "/engram/v1/observe") return res.writeHead(500).end("boom");
    res.writeHead(200).end("{}");
  });
  try {
    const tpath = transcript(home, [{ role: "user", content: "only" }]);
    await runHook(
      "__observe-worker__",
      JSON.stringify({ session_id: "sFail", transcript_path: tpath }),
      { port, home },
    );
    assert.equal(fs.existsSync(cursorPath(home, "sFail")), false, "cursor must not be written on failure");
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("session-end: retains the cursor when the final flush fails (no data loss)", async () => {
  const home = mkHome();
  const { server, port } = await startServer((req, res) => {
    if (req.url === "/engram/v1/observe") return res.writeHead(503).end("down");
    res.writeHead(200).end("{}");
  });
  try {
    // Seed a cursor at 0 with one pending message so a flush is attempted.
    const tpath = transcript(home, [{ role: "user", content: "pending tail" }]);
    fs.mkdirSync(path.join(home, "state", "remnic", "hooks"), { recursive: true });
    fs.writeFileSync(cursorPath(home, "sEnd"), "0\n");
    const { json } = await runHook("session-end", { session_id: "sEnd", transcript_path: tpath }, { port, home });
    assert.equal(json.continue, true);
    // Cursor must be RETAINED for retry — the regression this fixes.
    assert.equal(fs.existsSync(cursorPath(home, "sEnd")), true, "cursor retained after failed flush");
    assert.equal(fs.readFileSync(cursorPath(home, "sEnd"), "utf8").trim(), "0");
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("session-end: removes the cursor after a successful final flush", async () => {
  const home = mkHome();
  const { server, port, calls } = await startServer((req, res) => res.writeHead(200).end("{}"));
  try {
    const tpath = transcript(home, [{ role: "user", content: "pending tail" }]);
    fs.mkdirSync(path.join(home, "state", "remnic", "hooks"), { recursive: true });
    fs.writeFileSync(cursorPath(home, "sEnd2"), "0\n");
    await runHook("session-end", { session_id: "sEnd2", transcript_path: tpath }, { port, home });
    assert.ok(calls.find((c) => c.url === "/engram/v1/observe"), "final flush observed");
    assert.equal(fs.existsSync(cursorPath(home, "sEnd2")), false, "cursor cleared after successful flush");
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("post-tool-observe: foreground emits continue immediately", async () => {
  const home = mkHome();
  const { server, port } = await startServer((req, res) => res.writeHead(200).end("{}"));
  try {
    const tpath = transcript(home, [{ role: "user", content: "x" }]);
    const { json } = await runHook("post-tool-observe", { session_id: "sPt", transcript_path: tpath }, { port, home });
    assert.deepEqual(json, { continue: true });
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("unknown event fails open with continue", async () => {
  const home = mkHome();
  const { server, port } = await startServer((req, res) => res.writeHead(200).end("{}"));
  try {
    const { json } = await runHook("bogus-event", {}, { port, home });
    assert.deepEqual(json, { continue: true });
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ── #1443 review fixes ──────────────────────────────────────────────────────

test("hooks.json: every event resolves via ${PLUGIN_ROOT} and uses powershell (#1443 review)", () => {
  const cfg = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "hooks.json"), "utf8"),
  );
  for (const event of ["SessionStart", "PostToolUse", "UserPromptSubmit", "Stop"]) {
    for (const matcher of cfg.hooks[event]) {
      for (const hook of matcher.hooks) {
        // Codex runs plugin hooks from the session cwd via sh -lc / cmd /C and
        // substitutes ${PLUGIN_ROOT} (openai/codex discovery.rs + command_runner.rs),
        // so the path must be PLUGIN_ROOT-relative AND quoted — an unquoted path
        // would word-split on a plugin root containing spaces (e.g.
        // C:\Users\Jane Doe).
        assert.ok(
          hook.command.startsWith('"${PLUGIN_ROOT}/hooks/bin/'),
          `${event}.command must resolve via a quoted \${PLUGIN_ROOT}, got: ${hook.command}`,
        );
        assert.match(
          hook.command,
          /^"\$\{PLUGIN_ROOT\}\/hooks\/bin\/remnic-codex-hook\.sh"\s/,
          `${event}.command path must be wrapped in double quotes`,
        );
        assert.ok(hook.commandWindows, `${event} must declare commandWindows`);
        assert.match(
          hook.commandWindows,
          /-File "\$\{PLUGIN_ROOT\}\\hooks\\bin\\remnic-codex-hook\.ps1"\s/,
          `${event}.commandWindows must pass a quoted \${PLUGIN_ROOT} -File path`,
        );
        // Use `powershell` not `pwsh` so stock Windows 10/11 works without
        // PowerShell 7 installed (#1443 review).
        assert.match(
          hook.commandWindows,
          /^powershell\b/,
          `${event}.commandWindows must invoke powershell (not pwsh) for stock Windows compatibility`,
        );
      }
    }
  }
});

test("runner source: remnic→engram fallthrough is PATH-gated and Windows-shim aware (#1443 review)", () => {
  const src = fs.readFileSync(path.join(__dirname, "remnic-codex-hook.cjs"), "utf8");
  // Both the migration and daemon-start loops pre-check PATH with onPath()
  // (.cmd/.exe-aware) so the remnic→engram fallthrough happens, and launch
  // through a shell on Windows so `.cmd` npm shims actually run.
  const onPathHits = (src.match(/onPath\(bin\)/g) || []).length;
  assert.ok(onPathHits >= 2, "both migration and daemon-start loops must PATH-gate with onPath()");
  assert.match(
    src,
    /shell:\s*process\.platform === "win32"/,
    "CLI launches must use a shell on Windows so .cmd shims run",
  );
});

test("runner source: materialize child receives an explicit HOME (#1443 review)", () => {
  const src = fs.readFileSync(path.join(__dirname, "remnic-codex-hook.cjs"), "utf8");
  // The spawned materializer must get the runner's resolved HOME so Windows
  // (HOME usually unset) resolves the same config home as the hook.
  assert.match(
    src,
    /const childEnv = \{ \.\.\.process\.env, HOME \}/,
    "runMaterialize must pass an explicit HOME to the materializer child",
  );
  assert.match(src, /env:\s*childEnv/, "materialize spawnSync must use childEnv");
});

test("runner source: stdin is the single payload source — no env-var override (#1443 review)", () => {
  const src = fs.readFileSync(path.join(__dirname, "remnic-codex-hook.cjs"), "utf8");
  // An inherited REMNIC_HOOK_INPUT must NOT be able to override the piped
  // stdin payload, so readStdin must not read it.
  assert.doesNotMatch(
    src,
    /process\.env\.REMNIC_HOOK_INPUT/,
    "readStdin must not consult REMNIC_HOOK_INPUT (env-leak override risk)",
  );
});

test("post-tool-observe: worker payload travels via STDIN, not the environment (#1443 review)", () => {
  // Windows caps the environment block at ~32 KB. Large PostToolUse payloads
  // (big file edits, big command output) would E2BIG; the worker now reads
  // stdin instead. We assert the source rather than running an E2BIG payload
  // because reproducing the limit cross-platform is impractical.
  const src = fs.readFileSync(path.join(__dirname, "remnic-codex-hook.cjs"), "utf8");
  assert.doesNotMatch(
    src,
    /REMNIC_HOOK_INPUT:\s*rawInput/,
    "foreground hook must NOT propagate the payload via env (E2BIG on Windows)",
  );
  assert.match(
    src,
    /child\.stdin\.end\(rawInput\)/,
    "foreground hook must write the payload to the worker's stdin",
  );
});

test("session-end: skips final flush and leaves a symlinked cursor untouched (state hardening)", async () => {
  const home = mkHome();
  const { server, port, calls } = await startServer((req, res) => res.writeHead(200).end("{}"));
  try {
    const stateDir = path.join(home, "state", "remnic", "hooks");
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const cursor = cursorPath(home, "sUnsafe");
    const symTarget = path.join(home, "target.txt");
    fs.writeFileSync(symTarget, "unchanged\n");
    fs.symlinkSync(symTarget, cursor);
    const tpath = transcript(home, [{ role: "user", content: "would-be-pending" }]);
    await runHook("session-end", { session_id: "sUnsafe", transcript_path: tpath }, { port, home });
    // Final flush MUST NOT happen via a symlinked cursor file.
    assert.equal(calls.filter((c) => c.url === "/engram/v1/observe").length, 0);
    // The symlink target must be left exactly as we created it.
    assert.equal(fs.readFileSync(symTarget, "utf8"), "unchanged\n");
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("observe worker: adopts an os.tmpdir() cursor file and cleans it up", async () => {
  const home = mkHome();
  const { server, port } = await startServer((req, res) => res.writeHead(200).end("{}"));
  try {
    const sessionId = `mtmp-${process.pid}`;
    // Place a tmp cursor at a value AHEAD of where the new cursor would be.
    const tmpCursor = path.join(os.tmpdir(), `remnic-cursor-${sessionId}`);
    fs.writeFileSync(tmpCursor, "5\n");
    try {
      // Transcript has 2 messages; without /tmp adoption the runner would
      // observe both. With adoption (5 > 2 > 0), `slice(5)` is empty → no
      // observe, and the cursor lands at the transcript length.
      const tpath = transcript(home, [
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
      ]);
      await runHook(
        "__observe-worker__",
        JSON.stringify({ session_id: sessionId, transcript_path: tpath }),
        { port, home },
      );
      // /tmp cursor must be cleaned up by the runner after adoption.
      assert.equal(fs.existsSync(tmpCursor), false, "/tmp cursor must be removed after adoption");
    } finally {
      try {
        fs.rmSync(tmpCursor, { force: true });
      } catch {
        /* ignore */
      }
    }
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("post-tool worker reads its payload from STDIN end-to-end", async () => {
  const home = mkHome();
  const { server, port, calls } = await startServer((req, res) =>
    res.writeHead(200).end("{}"),
  );
  try {
    const tpath = transcript(home, [
      { role: "user", content: "stdin-payload-test" },
    ]);
    // Pass the payload via stdin — the only channel the worker reads.
    await runHook(
      "__observe-worker__",
      JSON.stringify({ session_id: "sStdin", transcript_path: tpath }),
      { port, home },
    );
    const observe = calls.find((c) => c.url === "/engram/v1/observe");
    assert.ok(observe, "observe was called via stdin payload");
    assert.equal(observe.body.messages.length, 1);
    assert.equal(observe.body.messages[0].content, "stdin-payload-test");
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
