"use strict";


const assert = require("node:assert/strict");
const test = require("node:test");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const RUNNER = path.join(__dirname, "remnic-codex-hook.cjs");
const CORE = path.join(__dirname, "remnic-hook-core.cjs");

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

function runHook(event, input, { port, home, env = {} } = {}) {
  return new Promise((resolve) => {
    const noToken = env.token === null;
    const child = spawn(process.execPath, [RUNNER, event], {
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        XDG_STATE_HOME: path.join(home, "state"),
        REMNIC_HOST: "127.0.0.1",
        REMNIC_PORT: String(port),
        REMNIC_CODEX_MATERIALIZE: "0",
        OPENCLAW_REMNIC_ACCESS_TOKEN: noToken ? "" : env.token || "test-token",
        OPENCLAW_ENGRAM_ACCESS_TOKEN: "",
        REMNIC_AUTH_TOKEN: "",
        ENGRAM_AUTH_TOKEN: "",
        REMNIC_HOOK_TOKEN: "",
        REMNIC_DAEMON_URL: "",
        ENGRAM_DAEMON_URL: "",
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
    if (req.url === "/engram/v1/live") return res.writeHead(200).end("ok");
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
    if (req.url === "/engram/v1/live") return res.writeHead(200).end("ok");
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
    if (req.url === "/engram/v1/live") return res.writeHead(200).end("ok");
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
    const tpath = transcript(home, [{ role: "user", content: "pending tail" }]);
    fs.mkdirSync(path.join(home, "state", "remnic", "hooks"), { recursive: true });
    fs.writeFileSync(cursorPath(home, "sEnd"), "0\n");
    const { json } = await runHook("session-end", { session_id: "sEnd", transcript_path: tpath }, { port, home });
    assert.equal(json.continue, true);
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


const POSIX_HOOK_EVENTS = Object.freeze({
  SessionStart: "session-start",
  PostToolUse: "post-tool-observe",
  UserPromptSubmit: "user-prompt-recall",
  Stop: "session-end",
  PreCompact: "pre-compact",
});

test("hooks.json: every POSIX event invokes the correct launcher event through sh", () => {
  const cfg = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "hooks.json"), "utf8"),
  );
  for (const [event, runnerEvent] of Object.entries(POSIX_HOOK_EVENTS)) {
    for (const matcher of cfg.hooks[event]) {
      for (const hook of matcher.hooks) {
        assert.equal(
          hook.command,
          `sh "\${PLUGIN_ROOT}/hooks/bin/remnic-codex-hook.sh" ${runnerEvent}`,
          `${event}.command must invoke the matching runner event through sh`,
        );
        assert.ok(hook.commandWindows, `${event} must declare commandWindows`);
        assert.match(
          hook.commandWindows,
          /-File "\$\{PLUGIN_ROOT\}\\hooks\\bin\\remnic-codex-hook\.ps1"\s/,
          `${event}.commandWindows must pass a quoted \${PLUGIN_ROOT} -File path`,
        );
        assert.match(
          hook.commandWindows,
          /^powershell\b/,
          `${event}.commandWindows must invoke powershell (not pwsh) for stock Windows compatibility`,
        );
      }
    }
  }
});

test(
  "hooks.json: every POSIX command runs a packaged launcher without executable mode",
  { skip: process.platform === "win32" },
  async () => {
    const home = mkHome();
    try {
      const pluginRoot = path.join(home, "plugin root");
      const binDir = path.join(pluginRoot, "hooks", "bin");
      fs.mkdirSync(binDir, { recursive: true });
      for (const file of ["remnic-codex-hook.sh", "remnic-codex-hook.cjs", "remnic-hook-core.cjs"]) {
        fs.copyFileSync(path.join(__dirname, file), path.join(binDir, file));
      }
      fs.chmodSync(path.join(binDir, "remnic-codex-hook.sh"), 0o644);

      const cfg = JSON.parse(
        fs.readFileSync(path.join(__dirname, "..", "hooks.json"), "utf8"),
      );
      const runCommand = (command, sessionId) => new Promise((resolve, reject) => {
        const child = spawn("sh", ["-c", command], {
          env: {
            ...process.env,
            HOME: home,
            USERPROFILE: home,
            XDG_STATE_HOME: path.join(home, "state"),
            PLUGIN_ROOT: pluginRoot,
            REMNIC_CODEX_MATERIALIZE: "0",
            OPENCLAW_REMNIC_ACCESS_TOKEN: "",
            OPENCLAW_ENGRAM_ACCESS_TOKEN: "",
            REMNIC_AUTH_TOKEN: "",
            ENGRAM_AUTH_TOKEN: "",
            REMNIC_HOOK_TOKEN: "",
            REMNIC_DAEMON_URL: "",
            ENGRAM_DAEMON_URL: "",
          },
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (data) => {
          stdout += data;
        });
        child.stderr.on("data", (data) => {
          stderr += data;
        });
        child.stdin.end(JSON.stringify({ session_id: sessionId, cwd: home }));
        child.on("error", reject);
        child.on("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
      });

      for (const [event, runnerEvent] of Object.entries(POSIX_HOOK_EVENTS)) {
        const command = cfg.hooks[event][0].hooks[0].command;
        const result = await runCommand(command, `${runnerEvent}-mode-test`);
        assert.equal(result.exitCode, 0, `${event}: ${result.stderr}`);
        assert.equal(JSON.parse(result.stdout).continue, true, event);
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  },
);

test("runner source: remnic→engram fallthrough is PATH-gated and Windows-shim aware (#1443 review)", () => {
  const src = fs.readFileSync(CORE, "utf8");
  const onPathHits = (src.match(/onPath\(bin\)/g) || []).length;
  assert.ok(onPathHits >= 2, "both migration and daemon-start loops must PATH-gate with onPath()");
  assert.match(
    src,
    /shell:\s*process\.platform === "win32"/,
    "CLI launches must use a shell on Windows so .cmd shims run",
  );
});

test("runner source: materialize child receives an explicit HOME (#1443 review)", () => {
  const src = fs.readFileSync(CORE, "utf8");
  assert.match(
    src,
    /const childEnv = \{ \.\.\.process\.env, HOME \}/,
    "runMaterialize must pass an explicit HOME to the materializer child",
  );
  assert.match(src, /env:\s*childEnv/, "materialize spawnSync must use childEnv");
});

test("runner source: stdin is the single payload source — no env-var override (#1443 review)", () => {
  const src = fs.readFileSync(CORE, "utf8");
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
  const src = fs.readFileSync(CORE, "utf8");
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
    assert.equal(calls.filter((c) => c.url === "/engram/v1/observe").length, 0);
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
    const tmpCursor = path.join(os.tmpdir(), `remnic-cursor-${sessionId}`);
    fs.writeFileSync(tmpCursor, "5\n");
    try {
      const tpath = transcript(home, [
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
      ]);
      await runHook(
        "__observe-worker__",
        JSON.stringify({ session_id: sessionId, transcript_path: tpath }),
        { port, home },
      );
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


test("pre-compact: POSTs /engram/v1/lcm/compaction/flush and returns continue:true (#1571)", async () => {
  const home = mkHome();
  const { server, port, calls } = await startServer((req, res) => {
    if (req.url === "/engram/v1/lcm/compaction/flush") {
      return res.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({ ok: true, flushed: 3 }),
      );
    }
    res.writeHead(404).end();
  });
  try {
    const { json } = await runHook(
      "pre-compact",
      { session_id: "compact-1", trigger: "manual", turn_id: "t1", cwd: home },
      { port, home },
    );
    assert.deepEqual(json, { continue: true });
    const flush = calls.find((c) => c.url === "/engram/v1/lcm/compaction/flush");
    assert.ok(flush, "compaction/flush was called");
    assert.equal(flush.body.sessionKey, "compact-1");
    assert.equal(flush.method, "POST");
    // Auth gating is covered by the no-token test below; the mock helper
    // does not record headers, so we assert the call happened, not the header.
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("pre-compact: no token → bare continue, no flush call (#1571)", async () => {
  const home = mkHome();
  const { server, port, calls } = await startServer((req, res) =>
    res.writeHead(200).end("{}"),
  );
  try {
    const { json } = await runHook(
      "pre-compact",
      { session_id: "compact-2", trigger: "auto", cwd: home },
      { port, home, env: { token: null } },
    );
    assert.deepEqual(json, { continue: true });
    assert.equal(
      calls.filter((c) => c.url === "/engram/v1/lcm/compaction/flush").length,
      0,
      "no flush call without a token",
    );
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("pre-compact: HTTP failure still returns continue:true — never blocks compaction (#1571)", async () => {
  const home = mkHome();
  const { server, port, calls } = await startServer((req, res) => {
    if (req.url === "/engram/v1/lcm/compaction/flush") {
      return res.writeHead(500).end(JSON.stringify({ error: "boom" }));
    }
    res.writeHead(404).end();
  });
  try {
    const { json } = await runHook(
      "pre-compact",
      { session_id: "compact-3", trigger: "auto", cwd: home },
      { port, home },
    );
    assert.deepEqual(json, { continue: true });
    assert.equal(
      calls.filter((c) => c.url === "/engram/v1/lcm/compaction/flush").length,
      1,
      "flush was attempted",
    );
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("pre-compact: dead daemon still returns continue:true (#1571)", async () => {
  const home = mkHome();
  const dead = await startServer(() => {});
  const port = dead.port;
  dead.server.close();
  await new Promise((r) => setTimeout(r, 50));
  const { json } = await runHook(
    "pre-compact",
    { session_id: "compact-4", trigger: "auto", cwd: home },
    { port, home },
  );
  assert.deepEqual(json, { continue: true });
  fs.rmSync(home, { recursive: true, force: true });
});

test("pre-compact: REMNIC_NAMESPACE attaches a namespace to the flush (#1571)", async () => {
  const home = mkHome();
  const { server, port, calls } = await startServer((req, res) =>
    res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}'),
  );
  try {
    await runHook(
      "pre-compact",
      { session_id: "compact-ns", trigger: "manual", cwd: home },
      { port, home, env: { extra: { REMNIC_NAMESPACE: "team/fleet" } } },
    );
    const flush = calls.find((c) => c.url === "/engram/v1/lcm/compaction/flush");
    assert.ok(flush, "flush called");
    assert.equal(flush.body.namespace, "team/fleet");
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("session-start: REMNIC_DAEMON_URL routes recall to the remote base URL (#1571)", async () => {
  const home = mkHome();
  const { server, port, calls } = await startServer((req, res) => {
    if (req.url === "/engram/v1/live") return res.writeHead(200).end("ok");
    if (req.url === "/engram/v1/recall") {
      return res.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({ context: "remote recall", count: 1, mode: "auto" }),
      );
    }
    res.writeHead(404).end();
  });
  try {
    const { json } = await runHook(
      "session-start",
      { session_id: "remote-1", cwd: home },
      {
        port: 1, // deliberately unused; daemon URL wins
        home,
        env: { extra: { REMNIC_DAEMON_URL: `http://127.0.0.1:${port}` } },
      },
    );
    assert.equal(json.continue, true);
    assert.match(json.hookSpecificOutput.additionalContext, /remote recall/);
    assert.ok(
      calls.some((c) => c.url === "/engram/v1/recall"),
      "recall reached the REMNIC_DAEMON_URL host",
    );
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("pre-compact: REMNIC_DAEMON_URL routes the flush to the remote base URL (#1571)", async () => {
  const home = mkHome();
  const { server, port, calls } = await startServer((req, res) =>
    res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}'),
  );
  try {
    await runHook(
      "pre-compact",
      { session_id: "remote-flush", trigger: "auto", cwd: home },
      {
        port: 1,
        home,
        env: { extra: { REMNIC_DAEMON_URL: `http://127.0.0.1:${port}` } },
      },
    );
    assert.ok(
      calls.some((c) => c.url === "/engram/v1/lcm/compaction/flush"),
      "flush reached the REMNIC_DAEMON_URL host",
    );
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("runner source: DAEMON_URL honors https:// remotes and falls back to HOST/PORT (#1571)", () => {
  const src = fs.readFileSync(CORE, "utf8");
  assert.match(src, /const https = require\("https"\)/, "https transport is required");
  assert.match(
    src,
    /DAEMON_URL\.protocol === "https:" \? https : http/,
    "transport selection honors the daemon URL protocol",
  );
  assert.match(src, /REMNIC_DAEMON_URL \|\| process\.env\.ENGRAM_DAEMON_URL/, "daemon URL env precedence");
  assert.match(src, /new URL\(`http:\/\/\$\{HOST\}:\$\{PORT\}`\)/, "HOST/PORT fallback preserved");
});

test("pre-compact: drains the unobserved transcript tail to /observe BEFORE the LCM flush (#1571 review)", async () => {
  const home = mkHome();
  const sessionId = "compact-tail";
  const tpath = transcript(home, [
    { role: "user", content: "first turn already observed" },
    { role: "assistant", content: "response one" },
    { role: "user", content: "second turn — the unobserved tail" },
    { role: "assistant", content: "response two" },
  ]);
  fs.mkdirSync(path.join(home, "state", "remnic", "hooks"), { recursive: true });
  fs.writeFileSync(cursorPath(home, sessionId), "2\n");
  const order = [];
  const { server, port, calls } = await startServer((req, res) => {
    order.push(req.url);
    if (req.url === "/engram/v1/observe") {
      return res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}');
    }
    if (req.url === "/engram/v1/lcm/compaction/flush") {
      return res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}');
    }
    res.writeHead(404).end();
  });
  try {
    const { json } = await runHook(
      "pre-compact",
      { session_id: sessionId, transcript_path: tpath, trigger: "auto", cwd: home },
      { port, home },
    );
    assert.deepEqual(json, { continue: true });
    const observeIdx = order.indexOf("/engram/v1/observe");
    const flushIdx = order.indexOf("/engram/v1/lcm/compaction/flush");
    assert.ok(observeIdx !== -1, "observe (tail drain) was called");
    assert.ok(flushIdx !== -1, "LCM flush was called");
    assert.ok(observeIdx < flushIdx, "observe (tail drain) runs BEFORE the LCM flush");
    const observe = calls.find((c) => c.url === "/engram/v1/observe");
    assert.equal(observe.body.messages.length, 2, "exactly the pending tail was observed");
    assert.equal(fs.readFileSync(cursorPath(home, sessionId), "utf8").trim(), "4");
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("pre-compact: retains the cursor when the tail-drain observe fails (#1571 review)", async () => {
  const home = mkHome();
  const sessionId = "compact-tail-fail";
  const tpath = transcript(home, [
    { role: "user", content: "tail that won't drain this time" },
    { role: "assistant", content: "response" },
  ]);
  fs.mkdirSync(path.join(home, "state", "remnic", "hooks"), { recursive: true });
  fs.writeFileSync(cursorPath(home, sessionId), "0\n");
  const { server, port } = await startServer((req, res) => {
    if (req.url === "/engram/v1/observe") return res.writeHead(500).end('{"error":"x"}');
    if (req.url === "/engram/v1/lcm/compaction/flush") return res.writeHead(200).end('{"ok":true}');
    res.writeHead(404).end();
  });
  try {
    const { json } = await runHook(
      "pre-compact",
      { session_id: sessionId, transcript_path: tpath, trigger: "manual", cwd: home },
      { port, home },
    );
    assert.deepEqual(json, { continue: true });
    assert.equal(fs.readFileSync(cursorPath(home, sessionId), "utf8").trim(), "0");
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("pre-compact: REMNIC_NAMESPACE also scopes the tail-drain /observe to the same key (#1571 review)", async () => {
  const home = mkHome();
  const sessionId = "compact-ns-drain";
  const tpath = transcript(home, [
    { role: "user", content: "turn one" },
    { role: "assistant", content: "reply one" },
    { role: "user", content: "turn two (unobserved tail)" },
    { role: "assistant", content: "reply two" },
  ]);
  fs.mkdirSync(path.join(home, "state", "remnic", "hooks"), { recursive: true });
  fs.writeFileSync(cursorPath(home, sessionId), "2\n");
  const { server, port, calls } = await startServer((req, res) =>
    res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}'),
  );
  try {
    const { json } = await runHook(
      "pre-compact",
      { session_id: sessionId, transcript_path: tpath, trigger: "auto", cwd: home },
      { port, home, env: { extra: { REMNIC_NAMESPACE: "team/fleet" } } },
    );
    assert.deepEqual(json, { continue: true });
    const observe = calls.find((c) => c.url === "/engram/v1/observe");
    assert.ok(observe, "tail drain observed");
    assert.equal(observe.body.namespace, "team/fleet", "drain observe carries the namespace");
    assert.equal(observe.body.messages.length, 2, "drained the pending tail");
    const flush = calls.find((c) => c.url === "/engram/v1/lcm/compaction/flush");
    assert.ok(flush, "flush called");
    assert.equal(flush.body.namespace, "team/fleet", "flush carries the same namespace");
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("pre-compact: an invalid explicit REMNIC_DAEMON_URL disables the daemon instead of falling back to localhost (#1571 review)", async () => {
  const home = mkHome();
  const { server, port, calls } = await startServer((req, res) =>
    res.writeHead(200).end('{"ok":true}'),
  );
  try {
    const { json, stderr } = await runHook(
      "pre-compact",
      { session_id: "bad-url", trigger: "auto", cwd: home },
      {
        port, // the localhost fallback target — must NOT be reached
        home,
        env: {
          extra: {
            REMNIC_DAEMON_URL: "macstudio:4318", // missing scheme → invalid
            REMNIC_HOOK_QUIET: "1",
          },
        },
      },
    );
    assert.deepEqual(json, { continue: true });
    assert.equal(calls.length, 0, "invalid daemon URL did not fall back to localhost");
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("pre-compact: when the session lock stays held, the drain returns busy and the LCM flush is skipped (#1571 review)", async () => {
  const home = mkHome();
  const sessionId = "compact-busy";
  const tpath = transcript(home, [
    { role: "user", content: "turn while worker holds the lock" },
    { role: "assistant", content: "reply" },
  ]);
  const lockDir = path.join(home, "state", "remnic", "hooks", `remnic-lock-${sessionId}.d`);
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  fs.mkdirSync(lockDir); // simulate the detached worker holding the lock
  const { server, port, calls } = await startServer((req, res) =>
    res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}'),
  );
  try {
    const { json } = await runHook(
      "pre-compact",
      { session_id: sessionId, transcript_path: tpath, trigger: "auto", cwd: home },
      { port, home, env: { extra: { REMNIC_PRECOMPACT_LOCK_RETRIES: "2" } } },
    );
    assert.deepEqual(json, { continue: true });
    assert.ok(
      !calls.some((c) => c.url === "/engram/v1/lcm/compaction/flush"),
      "LCM flush was skipped because the drain could not acquire the lock",
    );
    assert.ok(
      !calls.some((c) => c.url === "/engram/v1/observe"),
      "tail drain /observe was skipped because the lock was held",
    );
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("observe worker: REMNIC_NAMESPACE scopes the PostToolUse /observe (#1571 review)", async () => {
  const home = mkHome();
  const { server, port, calls } = await startServer((req, res) => res.writeHead(200).end("{}"));
  try {
    const tpath = transcript(home, [
      { role: "user", content: "tool turn one" },
      { role: "assistant", content: "tool reply one" },
    ]);
    await runHook(
      "__observe-worker__",
      JSON.stringify({ session_id: "sObsNs", transcript_path: tpath }),
      { port, home, env: { extra: { REMNIC_NAMESPACE: "fleet/alpha" } } },
    );
    const observe = calls.find((c) => c.url === "/engram/v1/observe");
    assert.ok(observe, "observe was called");
    assert.equal(observe.body.namespace, "fleet/alpha", "worker observe carries the namespace");
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("session-end: REMNIC_NAMESPACE scopes the final-flush /observe (#1571 review)", async () => {
  const home = mkHome();
  const { server, port, calls } = await startServer((req, res) => res.writeHead(200).end("{}"));
  try {
    const tpath = transcript(home, [{ role: "user", content: "pending tail at session end" }]);
    fs.mkdirSync(path.join(home, "state", "remnic", "hooks"), { recursive: true });
    fs.writeFileSync(cursorPath(home, "sEndNs"), "0\n");
    await runHook(
      "session-end",
      { session_id: "sEndNs", transcript_path: tpath },
      { port, home, env: { extra: { REMNIC_NAMESPACE: "fleet/beta" } } },
    );
    const observe = calls.find((c) => c.url === "/engram/v1/observe");
    assert.ok(observe, "final flush observed");
    assert.equal(observe.body.namespace, "fleet/beta", "session-end observe carries the namespace");
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("pre-compact: REMNIC_PRECOMPACT_LOCK_RETRIES=0 is honored, not coerced to 150 (#1571 kilo review)", async () => {
  const home = mkHome();
  const sessionId = "compact-zero-retries";
  const tpath = transcript(home, [
    { role: "user", content: "x" },
    { role: "assistant", content: "y" },
  ]);
  const lockDir = path.join(home, "state", "remnic", "hooks", `remnic-lock-${sessionId}.d`);
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  fs.mkdirSync(lockDir);
  const { server, port, calls } = await startServer((req, res) =>
    res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}'),
  );
  try {
    const start = Date.now();
    const { json } = await runHook(
      "pre-compact",
      { session_id: sessionId, transcript_path: tpath, trigger: "auto", cwd: home },
      { port, home, env: { extra: { REMNIC_PRECOMPACT_LOCK_RETRIES: "0" } } },
    );
    const elapsed = Date.now() - start;
    assert.deepEqual(json, { continue: true });
    assert.ok(!calls.some((c) => c.url === "/engram/v1/lcm/compaction/flush"), "flush skipped (busy)");
    assert.ok(elapsed < 5000, `0-retries returned in ${elapsed}ms (not coerced to 150)`);
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("session-start: a path-prefixed REMNIC_DAEMON_URL routes under the prefix (#1571 review)", async () => {
  const home = mkHome();
  const { server, port, calls } = await startServer((req, res) => {
    if (req.url === "/remnic/engram/v1/live") return res.writeHead(200).end("ok");
    if (req.url === "/remnic/engram/v1/recall") {
      return res.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({ context: "prefixed recall", count: 1, mode: "auto" }),
      );
    }
    res.writeHead(404).end();
  });
  try {
    const { json } = await runHook(
      "session-start",
      { session_id: "prefixed-1", cwd: home },
      {
        port: 1,
        home,
        env: { extra: { REMNIC_DAEMON_URL: `http://127.0.0.1:${port}/remnic` } },
      },
    );
    assert.equal(json.continue, true);
    assert.match(json.hookSpecificOutput.additionalContext, /prefixed recall/);
    assert.ok(
      calls.some((c) => c.url === "/remnic/engram/v1/recall"),
      "recall honored the /remnic path prefix",
    );
    assert.ok(
      calls.some((c) => c.url === "/remnic/engram/v1/live"),
      "health check honored the /remnic path prefix",
    );
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("session-start: REMNIC_NAMESPACE scopes the recall body (#1571 review, parity with plugin-pi)", async () => {
  const home = mkHome();
  const { server, port, calls } = await startServer((req, res) => {
    if (req.url === "/engram/v1/live") return res.writeHead(200).end("ok");
    if (req.url === "/engram/v1/recall") {
      return res.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({ context: "namespaced recall", count: 1, mode: "auto" }),
      );
    }
    res.writeHead(404).end();
  });
  try {
    await runHook(
      "session-start",
      { session_id: "recall-ns", cwd: home },
      { port, home, env: { extra: { REMNIC_NAMESPACE: "fleet/gamma" } } },
    );
    const recall = calls.find((c) => c.url === "/engram/v1/recall");
    assert.ok(recall, "recall was called");
    assert.equal(recall.body.namespace, "fleet/gamma", "recall body carries the namespace (parity with plugin-pi)");
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("pre-compact: REMNIC_PRECOMPACT_LOCK_RETRIES=0 still takes a FREE lock (does not skip acquisition) (#1571 review)", async () => {
  const home = mkHome();
  const sessionId = "compact-zero-free";
  const tpath = transcript(home, [
    { role: "user", content: "free-lock turn" },
    { role: "assistant", content: "reply" },
  ]);
  fs.mkdirSync(path.join(home, "state", "remnic", "hooks"), { recursive: true });
  fs.writeFileSync(cursorPath(home, sessionId), "0\n");
  const { server, port, calls } = await startServer((req, res) =>
    res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}'),
  );
  try {
    const { json } = await runHook(
      "pre-compact",
      { session_id: sessionId, transcript_path: tpath, trigger: "auto", cwd: home },
      { port, home, env: { extra: { REMNIC_PRECOMPACT_LOCK_RETRIES: "0" } } },
    );
    assert.deepEqual(json, { continue: true });
    assert.ok(calls.some((c) => c.url === "/engram/v1/lcm/compaction/flush"), "flush ran (free lock taken despite 0 retries)");
    assert.ok(calls.some((c) => c.url === "/engram/v1/observe"), "tail drain ran (free lock taken despite 0 retries)");
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});


function authServer() {
  const seen = { health: "unset", recall: "unset" };
  return startServer((req, res) => {
    if (req.url === "/engram/v1/live") {
      seen.health = req.headers.authorization || null;
      return res.writeHead(200).end("ok");
    }
    if (req.url === "/engram/v1/recall") {
      seen.recall = req.headers.authorization || null;
      return res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ context: "ctx", count: 1, mode: "auto" }));
    }
    res.writeHead(404).end();
  }).then((started) => ({ ...started, seen }));
}

test("session-start: health probe carries the bearer token (auth-gated daemons)", async () => {
  const home = mkHome();
  const { server, port, seen } = await authServer();
  try {
    await runHook("session-start", { session_id: "sAuth", cwd: home }, { port, home });
    assert.equal(seen.health, "Bearer test-token");
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

for (const name of ["REMNIC_AUTH_TOKEN", "ENGRAM_AUTH_TOKEN"]) {
  test(`token resolution: ${name} authenticates health and recall (no token store)`, async () => {
    const home = mkHome();
    const { server, port, seen } = await authServer();
    try {
      const res = await runHook(
        "session-start",
        { session_id: "sEnv", cwd: home },
        { port, home, env: { token: null, extra: { [name]: "operator-secret" } } },
      );
      assert.equal(seen.health, "Bearer operator-secret");
      assert.equal(seen.recall, "Bearer operator-secret");
      assert.doesNotMatch(
        res.json.hookSpecificOutput.additionalContext,
        /daemon not running/,
        "an authenticated daemon must not be reported as down",
      );
    } finally {
      server.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
}

test("token resolution: OPENCLAW_REMNIC_ACCESS_TOKEN outranks REMNIC_AUTH_TOKEN", async () => {
  const home = mkHome();
  const { server, port, seen } = await authServer();
  try {
    await runHook(
      "session-start",
      { session_id: "sPrec", cwd: home },
      { port, home, env: { token: "connector-tok", extra: { REMNIC_AUTH_TOKEN: "operator-secret" } } },
    );
    assert.equal(seen.health, "Bearer connector-tok");
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("token resolution: REMNIC_AUTH_TOKEN outranks the legacy OPENCLAW_ENGRAM_ACCESS_TOKEN", async () => {
  const home = mkHome();
  const { server, port, seen } = await authServer();
  try {
    await runHook(
      "session-start",
      { session_id: "sLegacyPrec", cwd: home },
      {
        port,
        home,
        env: {
          token: null,
          extra: {
            OPENCLAW_ENGRAM_ACCESS_TOKEN: "stale-legacy-tok",
            REMNIC_AUTH_TOKEN: "operator-secret",
          },
        },
      },
    );
    assert.equal(seen.health, "Bearer operator-secret");
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("token resolution: tokens.json still outranks REMNIC_AUTH_TOKEN", async () => {
  const home = mkHome();
  fs.mkdirSync(path.join(home, ".remnic"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".remnic", "tokens.json"),
    JSON.stringify({ tokens: [{ connector: "codex-cli", token: "codex-tok" }] }),
  );
  const { server, port, seen } = await authServer();
  try {
    await runHook(
      "session-start",
      { session_id: "sStore", cwd: home },
      { port, home, env: { token: null, extra: { REMNIC_AUTH_TOKEN: "operator-secret" } } },
    );
    assert.equal(seen.health, "Bearer codex-tok");
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("token resolution: REMNIC_AUTH_TOKEN outranks ENGRAM_AUTH_TOKEN when both are set", async () => {
  const home = mkHome();
  const { server, port, seen } = await authServer();
  try {
    await runHook(
      "session-start",
      { session_id: "sBothCanonical", cwd: home },
      {
        port,
        home,
        env: {
          token: null,
          extra: { REMNIC_AUTH_TOKEN: "current-tok", ENGRAM_AUTH_TOKEN: "legacy-tok" },
        },
      },
    );
    assert.equal(seen.health, "Bearer current-tok");
    assert.equal(seen.recall, "Bearer current-tok");
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("health probe uses the same bearer as the operation it gates", async () => {
  const home = mkHome();
  const { server, port, seen } = await authServer();
  try {
    await runHook(
      "session-start",
      { session_id: "sSnapshot", cwd: home },
      { port, home, env: { extra: { REMNIC_HOOK_TOKEN: "inherited-worker-tok" } } },
    );
    assert.equal(seen.health, "Bearer test-token");
    assert.equal(seen.recall, seen.health);
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
