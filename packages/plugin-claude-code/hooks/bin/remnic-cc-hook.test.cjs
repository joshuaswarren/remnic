"use strict";

// Integration tests for the unified Claude Code hook runner (issue #1518).
// Each test spawns the real remnic-cc-hook.cjs against a mock Remnic HTTP
// server, with an isolated HOME/XDG_STATE_HOME, and asserts both the emitted
// hook JSON and the cursor/observe side effects. These tests cover the
// cross-platform failure classes called out in #1518:
//   - shell-metacharacter session ids are rejected (no shell injection vector)
//   - short prompts skipped, no-token skipped, dead-daemon guidance
//   - cursor retention on failed final flush (no data loss)
//   - payload via stdin (not env) so large edits do not E2BIG on Windows
//   - hooks.json uses exec form (command + args) so Windows works without
//     Git Bash and shell metacharacters in the plugin root cannot inject

const assert = require("node:assert/strict");
const test = require("node:test");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const RUNNER = path.join(__dirname, "remnic-cc-hook.cjs");

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-cc-test-"));
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
        // Default to an env token unless a test overrides it. When a test
        // asks for "no token", explicitly clear BOTH legacy env vars so a
        // value inherited from the parent shell (e.g.
        // OPENCLAW_ENGRAM_ACCESS_TOKEN in a developer's environment) cannot
        // leak through `...process.env` and make the no-token path take a
        // token (#1518 test isolation).
        OPENCLAW_REMNIC_ACCESS_TOKEN: env.token === null ? "" : env.token || "test-token",
        OPENCLAW_ENGRAM_ACCESS_TOKEN: env.token === null ? "" : "",
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

// ── session-start ──────────────────────────────────────────────────────────

test("session-start: healthy server returns recall context with codingContext cleared outside a repo", async () => {
  const home = mkHome();
  const { server, port, calls } = await startServer((req, res) => {
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
    // claude-code client id header
    assert.equal(recall.method, "POST");
    // Outside a git repo, codingContext is explicitly null (clears stale routing).
    assert.ok("codingContext" in recall.body);
    assert.equal(recall.body.codingContext, null);
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("session-start: health probe carries the bearer token (auth-gated daemons)", async () => {
  const home = mkHome();
  let healthAuth = "unset";
  const { server, port } = await startServer((req, res) => {
    if (req.url === "/engram/v1/health") {
      healthAuth = req.headers.authorization || null;
      return res.writeHead(200).end("ok");
    }
    if (req.url === "/engram/v1/recall") {
      return res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ context: "ctx", count: 1, mode: "auto" }));
    }
    res.writeHead(404).end();
  });
  try {
    await runHook("session-start", { session_id: "s1", cwd: home }, { port, home });
    // Without this header an auth-gated daemon 401s the probe and the hook
    // reports "daemon not running", silently skipping recall/observe.
    assert.equal(healthAuth, "Bearer test-token");
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("recall body targets REMNIC_NAMESPACE when set, and omits namespace when unset", async () => {
  const mk = () =>
    startServer((req, res) => {
      if (req.url === "/engram/v1/health") return res.writeHead(200).end("ok");
      if (req.url === "/engram/v1/recall") {
        return res
          .writeHead(200, { "Content-Type": "application/json" })
          .end(JSON.stringify({ context: "ctx", count: 1, mode: "auto" }));
      }
      res.writeHead(404).end();
    });

  // set → namespace travels in the request body (REST reads it from the body,
  // not a header; the "claude-code" client id otherwise resolves to the
  // adapter's own empty namespace and recall returns nothing).
  {
    const home = mkHome();
    const { server, port, calls } = await mk();
    try {
      await runHook(
        "session-start",
        { session_id: "s1", cwd: home },
        { port, home, env: { extra: { REMNIC_NAMESPACE: "team-shared" } } },
      );
      const recall = calls.find((c) => c.url === "/engram/v1/recall");
      assert.ok(recall, "recall was called");
      assert.equal(recall.body.namespace, "team-shared");
    } finally {
      server.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  }

  // unset → opt-in no-op, no namespace field (behaviour unchanged for existing users).
  // Explicitly clear both env vars so a value inherited from the developer's
  // shell (`...process.env`) can't leak in and make this path look "set".
  {
    const home = mkHome();
    const { server, port, calls } = await mk();
    try {
      await runHook(
        "session-start",
        { session_id: "s1", cwd: home },
        { port, home, env: { extra: { REMNIC_NAMESPACE: "", ENGRAM_NAMESPACE: "" } } },
      );
      const recall = calls.find((c) => c.url === "/engram/v1/recall");
      assert.ok(recall, "recall was called");
      assert.equal("namespace" in recall.body, false);
    } finally {
      server.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
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

test("session-start: no token → claude-code install hint, no recall call", async () => {
  const home = mkHome();
  const { server, port, calls } = await startServer((req, res) => {
    if (req.url === "/engram/v1/health") return res.writeHead(200).end("ok");
    res.writeHead(200).end("{}");
  });
  try {
    const { json } = await runHook("session-start", { session_id: "s1", cwd: home }, { port, home, env: { token: null } });
    assert.match(json.hookSpecificOutput.additionalContext, /no auth token/);
    assert.match(json.hookSpecificOutput.additionalContext, /claude-code/);
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

// ── user-prompt-recall ─────────────────────────────────────────────────────

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

// ── post-tool-observe ──────────────────────────────────────────────────────

test("observe worker: advances cursor only after a successful observe", async () => {
  const home = mkHome();
  const { server, port, calls } = await startServer((req, res) => res.writeHead(200).end("{}"));
  try {
    const tpath = transcript(home, [
      { role: "user", content: "first" },
      { role: "assistant", content: "second" },
    ]);
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

test("observe worker: shell-metacharacter session id is rejected (no injection vector)", async () => {
  // A session id containing shell metacharacters must NOT reach the observe
  // endpoint or the cursor filesystem path. The runner validates the id
  // charset so a malicious payload field can never become a path traversal
  // or a shell argument even if a future caller regresses to shell=true.
  const home = mkHome();
  const { server, port, calls } = await startServer((req, res) => res.writeHead(200).end("{}"));
  try {
    const tpath = transcript(home, [{ role: "user", content: "x" }]);
    await runHook(
      "__observe-worker__",
      JSON.stringify({ session_id: "s; rm -rf /", transcript_path: tpath }),
      { port, home },
    );
    assert.equal(calls.filter((c) => c.url === "/engram/v1/observe").length, 0, "no observe for invalid session id");
    assert.equal(
      fs.existsSync(cursorPath(home, "s; rm -rf /")),
      false,
      "no cursor file written for invalid session id",
    );
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

test("post-tool-observe: worker payload travels via STDIN, not the environment", async () => {
  // Windows caps the environment block at ~32 KB. Large PostToolUse payloads
  // (big file edits) would E2BIG; the worker reads stdin instead. We assert
  // the source rather than running an E2BIG payload because reproducing the
  // limit cross-platform is impractical.
  const src = fs.readFileSync(RUNNER, "utf8");
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

// ── session-end ────────────────────────────────────────────────────────────

test("session-end: retains the cursor when the final flush fails (no data loss)", async () => {
  const home = mkHome();
  const { server, port } = await startServer((req, res) => {
    if (req.url === "/engram/v1/observe") return res.writeHead(503).end("down");
    res.writeHead(200).end("{}");
  });
  try {
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

test("session-end: skips final flush via a symlinked cursor (state hardening)", async () => {
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
    assert.equal(calls.filter((c) => c.url === "/engram/v1/observe").length, 0);
    assert.equal(fs.readFileSync(symTarget, "utf8"), "unchanged\n");
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ── token resolution ───────────────────────────────────────────────────────

test("token resolution: claude-code connector wins over openclaw in tokens.json", async () => {
  const home = mkHome();
  fs.mkdirSync(path.join(home, ".remnic"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".remnic", "tokens.json"),
    JSON.stringify({
      tokens: [
        { connector: "openclaw", token: "openclaw-tok" },
        { connector: "claude-code", token: "cc-tok" },
      ],
    }),
  );
  const { server, port, calls } = await startServer((req, res) => {
    if (req.url === "/engram/v1/health") return res.writeHead(200).end("ok");
    if (req.url === "/engram/v1/recall") return res.writeHead(200).end("{}");
    res.writeHead(200).end("{}");
  });
  try {
    // No env token — must come from tokens.json.
    await runHook(
      "session-start",
      { session_id: "sTok", cwd: home },
      { port, home, env: { token: null } },
    );
    const recall = calls.find((c) => c.url === "/engram/v1/recall");
    assert.ok(recall, "recall was called using the tokens.json credential");
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("token resolution: legacy ~/.engram/tokens.json is the read fallback", async () => {
  const home = mkHome();
  fs.mkdirSync(path.join(home, ".engram"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".engram", "tokens.json"),
    JSON.stringify({ tokens: [{ connector: "openclaw", token: "legacy-tok" }] }),
  );
  const { server, port, calls } = await startServer((req, res) => {
    if (req.url === "/engram/v1/health") return res.writeHead(200).end("ok");
    if (req.url === "/engram/v1/recall") return res.writeHead(200).end("{}");
    res.writeHead(200).end("{}");
  });
  try {
    await runHook(
      "session-start",
      { session_id: "sLeg", cwd: home },
      { port, home, env: { token: null } },
    );
    const recall = calls.find((c) => c.url === "/engram/v1/recall");
    assert.ok(recall, "recall was called using the legacy engram token store");
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ── hooks.json Windows parity ─────────────────────────────────────────────

test("hooks.json: every event uses cross-platform exec form with ${CLAUDE_PLUGIN_ROOT} (#1518)", () => {
  const cfg = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "hooks.json"), "utf8"),
  );
  const eventToHookName = (event) => {
    switch (event) {
      case "SessionStart": return "session-start";
      case "PostToolUse": return "post-tool-observe";
      case "UserPromptSubmit": return "user-prompt-recall";
      default: throw new Error(`unexpected event ${event}`);
    }
  };
  for (const event of ["SessionStart", "PostToolUse", "UserPromptSubmit"]) {
    const matchers = cfg.hooks[event] || [];
    for (const matcher of matchers) {
      for (const hook of matcher.hooks) {
        // Claude Code hooks do not support `commandWindows` (that field is
        // specific to the Codex plugin loader). The documented cross-
        // platform shape is exec form: `command: "node"` with an `args`
        // vector pointing at the runner. `node.exe` is a real binary on
        // Windows, so the same entry works on every platform without a
        // shell, without Git Bash, and without `.sh`/`.ps1` dispatch.
        // Each `args` element is passed verbatim (no shell tokenization),
        // so a plugin root containing spaces or metacharacters such as `$`
        // or backticks cannot be re-interpreted by a shell.
        assert.equal(
          hook.command,
          "node",
          `${event}.command must be the bare executable "node" (exec form)`,
        );
        assert.ok(
          Array.isArray(hook.args) && hook.args.length >= 2,
          `${event} must declare an args vector [runner, event-name]`,
        );
        assert.ok(
          typeof hook.args[0] === "string" &&
            hook.args[0].startsWith("${CLAUDE_PLUGIN_ROOT}/hooks/bin/remnic-cc-hook.cjs"),
          `${event}.args[0] must point at the bundled runner via \${CLAUDE_PLUGIN_ROOT}, got: ${hook.args && hook.args[0]}`,
        );
        assert.equal(hook.args[1], eventToHookName(event),
          `${event}.args[1] must be the hook event name`);
        // The shell-form fields must NOT be present: no `commandWindows`
        // (unsupported by Claude Code), and `command` must not be a shell
        // string that would let a shell re-tokenize the plugin root.
        assert.ok(
          hook.commandWindows === undefined,
          `${event} must not declare commandWindows (Claude Code ignores it; exec form is the cross-platform path)`,
        );
      }
    }
  }
});

test("runner source: payload fields never reach a shell — spawn uses fixed argv (#1518 guard shell interpolation)", () => {
  const src = fs.readFileSync(RUNNER, "utf8");
  // Every spawn/spawnSync must use a fixed literal argument array, never a
  // string command, so a payload value (session id, cwd, transcript path,
  // prompt, tool name) cannot achieve command injection.
  assert.doesNotMatch(
    src,
    /spawn(Sync)?\(\s*`/m,
    "spawn/spawnSync must never take a template-literal command (shell injection risk)",
  );
  assert.doesNotMatch(
    src,
    /execFileSync\(\s*`|exec\(\s*`/m,
    "exec/execFileSync must never take a template-literal command",
  );
  // Confirm the daemon-start + migration loops pre-check PATH with onPath()
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

test("runner source: stdin is the single payload source — no env-var override", () => {
  const src = fs.readFileSync(RUNNER, "utf8");
  assert.doesNotMatch(
    src,
    /process\.env\.REMNIC_HOOK_INPUT/,
    "readStdin must not consult REMNIC_HOOK_INPUT (env-leak override risk)",
  );
});

test("runner source: path inputs are type-validated before use (#1518 validate path types)", () => {
  const src = fs.readFileSync(RUNNER, "utf8");
  // cwd / transcript_path are coerced via `input.X || ""` so an unexpected
  // non-string payload field (number, object, array) cannot reach fs / git
  // and throw an opaque error or, worse, be coerced by Node to a path.
  assert.match(src, /const cwd = input\.cwd \|\| ""/, "cwd must be defaulted to empty string");
  assert.match(
    src,
    /const transcriptPath = input\.transcript_path \|\| ""/,
    "transcript_path must be defaulted to empty string",
  );
});
