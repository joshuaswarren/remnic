/**
 * LSP client tests — the 5-mode fake-server matrix (issue #1555 step 1).
 *
 * Each failure mode yields a DISTINCT degradation code (rule 34):
 *   - happy             → ok:true
 *   - server_missing    → server_missing
 *   - handshake_timeout → handshake_timeout
 *   - request_timeout   → request_timeout
 *   - protocol_error    → protocol_error
 *
 * Plus the zombie-cleanup test: after dispose(), no child process remains
 * (asserted via pid liveness).
 *
 * The fake server is a checked-in Node script speaking canned JSON-RPC
 * over stdio (synthetic responses only — rule 33: shapes match LSP 3.17).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import { LspClient } from "./client.js";
import { DEFAULT_LSP_TIMEOUT_MS } from "./config.js";

const FAKE_SERVER = path.resolve(
  import.meta.dirname,
  "fixtures",
  "fake-server.mjs",
);

/**
 * Spawn the fake server with the given scenario and connect a real client.
 * Returns the connect result.
 */
function connectFake(
  scenario: string,
  timeoutMs: number = DEFAULT_LSP_TIMEOUT_MS,
): Promise<
  | { ok: true; client: LspClient }
  | { ok: false; degradation: { code: string; detail?: string } }
> {
  return LspClient.connect({
    launchSpec: { command: process.execPath, args: [FAKE_SERVER, scenario] },
    rootUri: null,
    timeoutMs,
  });
}

// ──────────────────────────────────────────────────────────────────────────
// The 5-mode matrix
// ──────────────────────────────────────────────────────────────────────────

test("fake-server matrix: happy — handshake succeeds, supportsDefinition=true", async () => {
  const result = await connectFake("happy", 5_000);
  assert.equal(result.ok, true, `expected ok, got degradation: ${JSON.stringify(result)}`);
  if (!result.ok) return;
  assert.equal(result.client.supportsDefinition, true);
  await result.client.dispose();
});

test("fake-server matrix: server_missing — spawn fails with ENOENT", async () => {
  const result = await LspClient.connect({
    launchSpec: { command: "/nonexistent/binary/that/does/not/exist", args: [] },
    rootUri: null,
    timeoutMs: 2_000,
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.degradation.code, "server_missing");
  }
});

test("fake-server matrix: handshake_timeout — initialize never responds", async () => {
  const result = await connectFake("handshake_timeout", 1_500);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.degradation.code, "handshake_timeout");
  }
});

test("fake-server matrix: request_timeout — definition never responds", async () => {
  // Handshake succeeds, but definition request hangs.
  const connectResult = await connectFake("request_timeout", 5_000);
  assert.equal(connectResult.ok, true, `handshake should succeed: ${JSON.stringify(connectResult)}`);
  if (!connectResult.ok) return;

  // Override the client's timeout for the definition request.
  // We create a new client with a shorter timeout to test request-level
  // timeout separately from handshake timeout.
  await connectResult.client.dispose();

  // Now connect with a short timeout — both handshake AND requests use it.
  const shortResult = await connectFake("request_timeout", 1_000);
  assert.equal(shortResult.ok, true, `handshake should succeed with short timeout`);
  if (!shortResult.ok) return;

  const defResult = await shortResult.client.definition({
    textDocument: { uri: "file:///fake/test.ts" },
    position: { line: 0, character: 0 },
  });
  assert.equal(defResult.ok, false);
  if (!defResult.ok) {
    assert.equal(defResult.degradation.code, "request_timeout");
  }
  await shortResult.client.dispose();
});

test("fake-server matrix: protocol_error — malformed frame from server", async () => {
  const result = await connectFake("protocol_error", 2_000);
  // The protocol error happens during handshake — the server sends
  // garbage after receiving initialize.
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.degradation.code, "protocol_error");
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Zombie cleanup — after dispose, no child process remains.
// ──────────────────────────────────────────────────────────────────────────

test("zombie cleanup: after dispose, no child process remains (pid liveness)", async () => {
  const result = await connectFake("happy", 5_000);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const pid = result.client.pid;
  assert.ok(typeof pid === "number" && pid > 0, "client must have a pid");
  assert.ok(isProcessAlive(pid), "process must be alive before dispose");

  await result.client.dispose();

  // After dispose, the process should be gone. Poll pid liveness with a
  // bounded retry instead of a fixed sleep — the process usually dies
  // within one event-loop tick (SIGKILL is synchronous), but on a loaded
  // machine the reaping may lag by a few ms.
  // Integration test: real child-process lifecycle, not fake-timerable.
  const dead = await waitForCondition(() => !isProcessAlive(pid), 2_000, 50);
  assert.equal(
    dead,
    true,
    "process must be dead after dispose — no zombie",
  );
});

test("zombie cleanup: dispose is idempotent — safe to call twice", async () => {
  const result = await connectFake("happy", 5_000);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  await result.client.dispose();
  // Second dispose must not throw.
  await result.client.dispose();
});

// ──────────────────────────────────────────────────────────────────────────
// Happy-path definition request — end-to-end resolution.
// ──────────────────────────────────────────────────────────────────────────

test("happy path: didOpen + definition returns canned locations", async () => {
  const result = await connectFake("happy", 5_000);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  result.client.didOpen({
    uri: "file:///fake/src/caller.ts",
    languageId: "typescript",
    version: 1,
    text: "export function caller() { target(); }",
  });

  const defResult = await result.client.definition({
    textDocument: { uri: "file:///fake/src/caller.ts" },
    position: { line: 0, character: 30 },
  });
  assert.equal(defResult.ok, true, `definition should succeed: ${JSON.stringify(defResult)}`);
  if (defResult.ok) {
    assert.ok(defResult.locations.length > 0, "should return at least one location");
    const loc = defResult.locations[0];
    assert.ok(loc.uri, "location must have a uri");
    assert.ok(loc.range, "location must have a range");
  }
  await result.client.dispose();
});

test("definition after dispose → server_crashed degradation", async () => {
  const result = await connectFake("happy", 5_000);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  await result.client.dispose();
  const defResult = await result.client.definition({
    textDocument: { uri: "file:///fake/test.ts" },
    position: { line: 0, character: 0 },
  });
  assert.equal(defResult.ok, false);
  if (!defResult.ok) {
    assert.equal(defResult.degradation.code, "server_crashed");
  }
});

test("crash_after_start: server exits mid-run → server_crashed", async () => {
  const result = await connectFake("crash_after_start", 5_000);
  assert.equal(result.ok, true, `handshake should succeed before crash: ${JSON.stringify(result)}`);
  if (!result.ok) return;

  // The fake server exits immediately after the initialized notification.
  // Wait for the child process to actually exit before sending the next
  // request. Integration test: real process exit, not fake-timerable.
  const pid = result.client.pid;
  if (typeof pid === "number") {
    await waitForCondition(() => !isProcessAlive(pid), 2_000, 50);
  }

  const defResult = await result.client.definition({
    textDocument: { uri: "file:///fake/test.ts" },
    position: { line: 0, character: 0 },
  });
  assert.equal(defResult.ok, false);
  if (!defResult.ok) {
    assert.equal(
      defResult.degradation.code,
      "server_crashed",
      `expected server_crashed, got ${defResult.degradation.code}`,
    );
  }
  await result.client.dispose();
});

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

/**
 * Check whether a process is still alive by sending signal 0.
 * Returns true if the process exists and we can signal it.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Poll a condition at a bounded interval until it returns true or the
 * deadline elapses. Used for real child-process lifecycle checks where
 * deterministic fake-timers cannot replace the OS scheduler.
 */
function waitForCondition(
  cond: () => boolean,
  timeoutMs: number,
  intervalMs: number,
): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const deadline = Date.now() + timeoutMs;
  const check = () => {
    if (cond()) {
      resolve(true);
      return;
    }
    if (Date.now() >= deadline) {
      resolve(false);
      return;
    }
    setTimeout(check, intervalMs);
  };
  check();
  return promise;
}

// Suppress unhandled rejection noise from the fake server's exit events
// during tests (the 'error' event from ENOENT is handled by the client).
process.on("unhandledRejection", () => {});
