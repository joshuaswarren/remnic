"use strict";

// Integration tests for the unified Devin CLI hook runner.
// Each test spawns the real remnic-devin-hook.cjs against a mock Remnic HTTP
// server, with an isolated HOME/XDG_STATE_HOME and a synthetic ATIF
// transcript, and asserts both the emitted hook JSON and the
// cursor/observe side effects. Devin-specific coverage:
//   - ATIF transcript parsing (steps/source/tool_calls/observation)
//   - transcript_path derived from session_id (Devin sends none)
//   - PostCompaction → drain + LCM flush
//   - SessionEnd → final flush + cursor cleanup
//   - cwd recovered from DEVIN_PROJECT_DIR when the payload omits it

const assert = require("node:assert/strict");
const test = require("node:test");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

function isString(v) {
  return Object.prototype.toString.call(v) === "[object String]";
}

const RUNNER = path.join(__dirname, "remnic-devin-hook.cjs");

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
  return fs.mkdtempSync(path.join(os.tmpdir(), "remnic-devin-test-"));
}

function runHook(event, input, { port, home, env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [RUNNER, event], {
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        XDG_STATE_HOME: path.join(home, "state"),
        XDG_DATA_HOME: path.join(home, "data"),
        REMNIC_HOST: "127.0.0.1",
        REMNIC_PORT: String(port),
        OPENCLAW_REMNIC_ACCESS_TOKEN: env.token === null ? "" : env.token || "test-token",
        OPENCLAW_ENGRAM_ACCESS_TOKEN: "",
        REMNIC_AUTH_TOKEN: "",
        ENGRAM_AUTH_TOKEN: "",
        REMNIC_HOOK_TOKEN: "",
        REMNIC_DAEMON_URL: "",
        ENGRAM_DAEMON_URL: "",
        DEVIN_PROJECT_DIR: "",
        DEVIN_TRANSCRIPT_DIR: "",
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
    child.stdin.end(isString(input) ? input : JSON.stringify(input));
  });
}

// Write an ATIF transcript under the XDG data dir the resolver checks.
function atifTranscript(home, sessionId, steps) {
  const dir = path.join(home, "data", "devin", "cli", "transcripts");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({
      schema_version: "ATIF-v1.7",
      session_id: sessionId,
      agent: { name: "devin" },
      steps,
      final_metrics: {},
    }),
  );
  return file;
}

function cursorPath(home, sessionId) {
  return path.join(home, "state", "remnic", "hooks", `remnic-cursor-${sessionId}`);
}

function donePath(home, sessionId) {
  return path.join(home, "state", "remnic", "hooks", `remnic-done-${sessionId}`);
}

function okServer(extra) {
  return (req, res) => {
    if (req.url === "/engram/v1/health") return res.writeHead(200).end("ok");
    if (req.url === "/engram/v1/recall") {
      return res.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({ context: "remembered preferences", count: 3, mode: "auto" }),
      );
    }
    if (req.url === "/engram/v1/observe") {
      return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
    }
    if (req.url === "/engram/v1/lcm/compaction/flush") {
      return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
    }
    if (extra) return extra(req, res);
    res.writeHead(404).end();
  };
}

// ── session-start ──────────────────────────────────────────────────────────

test("session-start: injects recall context and recovers cwd from DEVIN_PROJECT_DIR", async () => {
  const home = mkHome();
  const { server, port, calls } = await startServer(okServer());
  try {
    const { json } = await runHook(
      "session-start",
      { session_id: "s1", source: "startup" },
      { port, home, env: { extra: { DEVIN_PROJECT_DIR: home } } },
    );
    assert.equal(json.continue, true);
    assert.match(json.hookSpecificOutput.additionalContext, /Remnic Memory Recall — 3 memories/);
    const recall = calls.find((c) => c.url === "/engram/v1/recall");
    assert.ok(recall, "recall was called");
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ── user-prompt-recall ─────────────────────────────────────────────────────

test("user-prompt-recall: short prompts are skipped", async () => {
  const home = mkHome();
  const { server, port, calls } = await startServer(okServer());
  try {
    const { json } = await runHook(
      "user-prompt-recall",
      { session_id: "s1", prompt: "hi" },
      { port, home },
    );
    assert.equal(json.continue, true);
    assert.ok(!json.hookSpecificOutput, "no context injected for a trivial prompt");
    assert.ok(!calls.find((c) => c.url === "/engram/v1/recall"), "recall not called");
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ── post-tool-observe with ATIF transcript ─────────────────────────────────

test("post-tool-observe: observes ATIF transcript delta resolved from session_id", async () => {
  const home = mkHome();
  const sessionId = "sess-atif-1";
  atifTranscript(home, sessionId, [
    { step_id: 1, timestamp: "t", source: "system", message: "You are Devin." },
    { step_id: 2, timestamp: "t", source: "user", message: "Please fix the flaky test in parser.ts" },
    {
      step_id: 3,
      timestamp: "t",
      source: "agent",
      message: "I'll update the test.",
      tool_calls: [
        { tool_call_id: "c1", function_name: "edit", arguments: { file_path: "parser.ts" } },
      ],
      observation: { results: [{ source_call_id: "c1", content: "edit applied" }] },
    },
  ]);
  const { server, port, calls } = await startServer(okServer());
  try {
    const { json } = await runHook(
      "post-tool-observe",
      { session_id: sessionId, tool_name: "edit", prompt_id: "p1" },
      { port, home },
    );
    assert.equal(json.continue, true);
    // The observe runs in a detached worker — wait for it to hit the mock.
    const deadline = Date.now() + 10000;
    let observe = null;
    while (Date.now() < deadline) {
      observe = calls.find((c) => c.url === "/engram/v1/observe");
      if (observe) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(observe, "observe endpoint was called");
    assert.equal(observe.body.sessionKey, sessionId);
    const messages = observe.body.messages;
    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, "user");
    assert.match(messages[0].content, /flaky test/);
    assert.equal(messages[1].role, "assistant");
    assert.match(messages[1].content, /tool call\] edit/);
    assert.match(messages[1].content, /tool result\] edit applied/);
    // Cursor advances only after the observe response succeeds; poll with a
    // deadline rather than a fixed sleep.
    const cursorDeadline = Date.now() + 10000;
    while (!fs.existsSync(cursorPath(home, sessionId)) && Date.now() < cursorDeadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(fs.existsSync(cursorPath(home, sessionId)), "cursor file written");
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ── post-compaction ────────────────────────────────────────────────────────

test("post-compaction: drains tail and flushes LCM compaction", async () => {
  const home = mkHome();
  const sessionId = "sess-compact-1";
  atifTranscript(home, sessionId, [
    { step_id: 1, timestamp: "t", source: "user", message: "remember the deployment runbook location" },
    { step_id: 2, timestamp: "t", source: "agent", message: "Noted: runbook lives in docs/runbook.md." },
  ]);
  const { server, port, calls } = await startServer(okServer());
  try {
    const { json } = await runHook(
      "post-compaction",
      { session_id: sessionId, summary: "compacted", prompt_id: "p1" },
      { port, home },
    );
    assert.equal(json.continue, true);
    const deadline = Date.now() + 15000;
    let flush = null;
    let observe = null;
    while (Date.now() < deadline) {
      flush = calls.find((c) => c.url === "/engram/v1/lcm/compaction/flush");
      observe = calls.find((c) => c.url === "/engram/v1/observe");
      if (flush && observe) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(observe, "tail drain observed the transcript");
    assert.ok(flush, "LCM compaction flush was called");
    assert.equal(flush.body.sessionKey, sessionId);
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ── session-end ────────────────────────────────────────────────────────────

test("session-end: final flush observes remaining tail and clears cursor", async () => {
  const home = mkHome();
  const sessionId = "sess-end-1";
  atifTranscript(home, sessionId, [
    { step_id: 1, timestamp: "t", source: "user", message: "final user message about the migration" },
  ]);
  const { server, port, calls } = await startServer(okServer());
  try {
    const { json } = await runHook(
      "session-end",
      { session_id: sessionId, reason: "exit" },
      { port, home },
    );
    assert.equal(json.continue, true);
    const observe = calls.find((c) => c.url === "/engram/v1/observe");
    assert.ok(observe, "final flush observed the tail");
    assert.match(observe.body.messages[0].content, /migration/);
    assert.ok(!fs.existsSync(cursorPath(home, sessionId)), "cursor removed after successful flush");
    assert.ok(fs.existsSync(donePath(home, sessionId)), "done tombstone written");
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("session-end: a queued observe worker does not replay the transcript", async () => {
  const home = mkHome();
  const sessionId = "sess-end-queued";
  atifTranscript(home, sessionId, [
    { step_id: 1, timestamp: "t", source: "user", message: "the last message of the session" },
  ]);
  const { server, port, calls } = await startServer(okServer());
  try {
    await runHook("session-end", { session_id: sessionId, reason: "exit" }, { port, home });
    const observesBefore = calls.filter((c) => c.url === "/engram/v1/observe").length;
    assert.equal(observesBefore, 1, "session-end flushed the tail once");
    // A detached observe worker spawned just before SessionEnd can still be
    // queued behind the lock; once it runs it must see the done tombstone
    // and exit instead of treating the removed cursor as 0.
    await runHook(
      "post-tool-observe",
      { session_id: sessionId, tool_name: "edit", prompt_id: "p1" },
      { port, home },
    );
    // Give the detached worker time to acquire the lock and (wrongly) observe.
    await new Promise((r) => setTimeout(r, 3000));
    const observesAfter = calls.filter((c) => c.url === "/engram/v1/observe").length;
    assert.equal(observesAfter, observesBefore, "queued worker did not replay the transcript");
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("session resume: done marker restores the cursor checkpoint and observation resumes", async () => {
  const home = mkHome();
  const sessionId = "sess-resume-1";
  atifTranscript(home, sessionId, [
    { step_id: 1, timestamp: "t", source: "user", message: "first message before the break" },
  ]);
  const { server, port, calls } = await startServer(okServer());
  try {
    await runHook("session-end", { session_id: sessionId, reason: "exit" }, { port, home });
    assert.ok(fs.existsSync(donePath(home, sessionId)), "done marker written");
    assert.ok(!fs.existsSync(cursorPath(home, sessionId)), "cursor removed after flush");

    // Devin reuses session_id across resume; the transcript gains a step.
    atifTranscript(home, sessionId, [
      { step_id: 1, timestamp: "t", source: "user", message: "first message before the break" },
      { step_id: 2, timestamp: "t", source: "user", message: "new message after resume" },
    ]);
    await runHook("session-start", { session_id: sessionId, source: "resume" }, { port, home });
    assert.ok(!fs.existsSync(donePath(home, sessionId)), "done marker cleared on resume");
    assert.ok(fs.existsSync(cursorPath(home, sessionId)), "cursor restored from checkpoint");

    await runHook(
      "post-tool-observe",
      { session_id: sessionId, tool_name: "edit", prompt_id: "p2" },
      { port, home },
    );
    const deadline = Date.now() + 10000;
    let observes = [];
    while (Date.now() < deadline) {
      observes = calls.filter((c) => c.url === "/engram/v1/observe");
      if (observes.length >= 2) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(observes.length >= 2, "post-resume observe ran");
    const last = observes[observes.length - 1];
    assert.equal(last.body.messages.length, 1, "only the new tail was observed");
    assert.match(last.body.messages[0].content, /after resume/);
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ── fail-open ──────────────────────────────────────────────────────────────

test("fail-open: dead daemon still emits continue and never throws", async () => {
  const home = mkHome();
  // Nothing listening on this port.
  const { json, stderr } = await runHook(
    "session-start",
    { session_id: "dead-1", source: "startup" },
    { port: 1, home },
  );
  assert.equal(json.continue, true);
  fs.rmSync(home, { recursive: true, force: true });
});
