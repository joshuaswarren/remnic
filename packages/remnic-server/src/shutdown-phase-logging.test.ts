// Shutdown-phase logging behavioral tests: the native daemon's stop path must
// emit monotonic, non-content start/end/failure markers per phase (listener
// closure, scheduler abort+settle, orchestrator drain/flush/dispose) so a
// 700s-class stop stall attributes to the await that is stuck. Uses the REAL
// server (startServer) wherever feasible; failure injection uses the real
// exported teardown chain with controlled rejecting callbacks, because a real
// listener cannot be made to fail close() without seams.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { initLogger } from "@remnic/core";
import type { LoggerBackend } from "@remnic/core/logger";
import type { BacklogScheduler } from "@remnic/core/orchestration/backlog-scheduler.js";

import { logShutdownPhase, shutdownBacklogDrain } from "./backlog-drain-lifecycle.js";
import { startServer, type ServerResult } from "./index.js";

/** Every shutdown marker: kebab phase id, durations only — never content. */
const MARKER =
  /^shutdown-phase-(start|end|failure) phase=(listener-closure|scheduler-abort-settle|orchestrator-drain-flush-dispose)( durationMs=\d+)?$/;

const PHASE_SEQUENCE = [
  "shutdown-phase-start phase=listener-closure",
  "shutdown-phase-end phase=listener-closure durationMs=",
  "shutdown-phase-start phase=scheduler-abort-settle",
  "shutdown-phase-end phase=scheduler-abort-settle durationMs=",
  "shutdown-phase-start phase=orchestrator-drain-flush-dispose",
  "shutdown-phase-end phase=orchestrator-drain-flush-dispose durationMs=",
];

function installRecordingLogger(): { lines: string[] } {
  const lines: string[] = [];
  // core's fmt() prefixes every line with "remnic: "; strip it so assertions
  // match the bare marker text.
  const body = (msg: string) => msg.replace(/^remnic: /, "");
  const backend: LoggerBackend = {
    info: (msg) => lines.push(body(msg)),
    warn: (msg) => lines.push(body(msg)),
    error: (msg) => lines.push(body(msg)),
  };
  initLogger(backend, false, { timestamps: false });
  return { lines };
}

// Only initLogger is exported from @remnic/core; restore the silent backend
// the same way access-service-namespace.test.ts does.
function quietLogger(): void {
  initLogger({ info() {}, warn() {}, error() {}, debug() {} }, false);
}

async function withTestDeadline<T>(promise: Promise<T>, timeoutMs = 30_000): Promise<T> {
  const { promise: deadline, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(() => reject(new Error("test deadline exceeded")), timeoutMs);
  timer.unref?.();
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

// Polls a real daemon's external state (captured log lines, socket events);
// the condition is checked every tick — no guessed fixed sleeps, and fake
// timers cannot drive the real server's event loop.
async function waitFor(
  predicate: () => boolean,
  description: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`condition not met: ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function bootServer(dir: string): Promise<ServerResult> {
  const configPath = path.join(dir, "remnic.json");
  await writeFile(
    configPath,
    JSON.stringify({
      remnic: {
        memoryDir: path.join(dir, "memory"),
        openaiApiKey: "sk-test",
        qmdEnabled: false,
        embeddingFallbackEnabled: false,
        recallPlannerEnabled: false,
        sharedContextEnabled: false,
        localLlmEnabled: false,
        identityContinuityEnabled: false,
        transcriptEnabled: false,
        hourlySummariesEnabled: false,
        compoundingEnabled: false,
        knowledgeIndexEnabled: false,
      },
      server: { host: "127.0.0.1", authToken: "test-token" },
    }),
    "utf8",
  );
  return withTestDeadline(startServer({ configPath, authToken: "test-token", allowEphemeralPort: true }));
}

/** Assert the captured markers are exactly the six expected phase lines in
 *  order, each duration numeric — the whole stop chain attributed, nothing
 *  else. */
function assertPhaseSequence(lines: string[]): void {
  const markers = lines.filter((line) => line.startsWith("shutdown-phase-"));
  assert.equal(markers.length, PHASE_SEQUENCE.length, `unexpected marker count: ${JSON.stringify(markers)}`);
  markers.forEach((line, index) => {
    const expected = PHASE_SEQUENCE[index];
    if (expected.endsWith("durationMs=")) {
      assert.match(line, new RegExp(`^${expected}\\d+$`), `marker ${index} mismatch`);
    } else {
      assert.equal(line, expected, `marker ${index} mismatch`);
    }
    assert.match(line, MARKER, `marker ${index} carries non-marker content`);
  });
}

test("gated stop prints the listener phase start while unresolved and its end after release, in order, on a real server", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-stop-phases-"));
  let result: ServerResult | undefined;
  let socket: net.Socket | undefined;
  let lines: string[] = [];
  try {
    result = await bootServer(dir);
    // startServer re-inits the logger at boot; the recorder goes in after so
    // it captures the shutdown path.
    ({ lines } = installRecordingLogger());
    // An incomplete request keeps the connection active so server.close()
    // genuinely blocks — the listener-closure await is unresolved.
    socket = net.connect(result.port, "127.0.0.1");
    const connected = Promise.withResolvers<void>();
    socket.once("connect", connected.resolve);
    socket.once("error", connected.reject);
    await connected.promise;
    socket.write("GET /engram/v1/health HTTP/1.1\r\nHost: localhost\r\n");

    const stopPromise = result.stop();
    await waitFor(
      () => lines.some((line) => line === "shutdown-phase-start phase=listener-closure"),
      "listener-closure start marker while close() is pending",
    );
    assert.equal(
      lines.some((line) => line.startsWith("shutdown-phase-end phase=listener-closure")),
      false,
      "listener-closure end must not print while close() is unresolved",
    );

    socket.destroy();
    socket = undefined;
    await withTestDeadline(stopPromise);
    assertPhaseSequence(lines);
  } finally {
    socket?.destroy();
    await result?.stop().catch(() => {});
    quietLogger();
    await rm(dir, { recursive: true, force: true });
  }
});

test("normal request activity logs no shutdown-phase markers; they appear only on stop", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-stop-phases-idle-"));
  let result: ServerResult | undefined;
  let lines: string[] = [];
  try {
    result = await bootServer(dir);
    // startServer re-inits the logger at boot; the recorder goes in after so
    // it captures the shutdown path.
    ({ lines } = installRecordingLogger());
    const health = await fetch(`http://127.0.0.1:${result.port}/engram/v1/health`, {
      headers: { authorization: "Bearer test-token" },
      signal: AbortSignal.timeout(5_000),
    });
    await health.text();
    assert.equal(
      lines.some((line) => line.startsWith("shutdown-phase-")),
      false,
      "normal activity must not emit shutdown-phase markers",
    );
    await withTestDeadline(result.stop());
    assert.ok(
      lines.some((line) => line.startsWith("shutdown-phase-start phase=listener-closure")),
      "stop emits the listener-closure start marker",
    );
  } finally {
    await result?.stop().catch(() => {});
    quietLogger();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a scheduler-phase failure logs failure without the error payload and still runs destroy and finish", async () => {
  const { lines } = installRecordingLogger();
  const scheduler = {
    stop: () => Promise.reject(new Error("SECRET-SCHED-7")),
  } as unknown as BacklogScheduler;
  let destroyed = false;
  let finished = false;
  await assert.rejects(
    shutdownBacklogDrain(
      scheduler,
      async () => {
        destroyed = true;
      },
      () => {
        finished = true;
      },
    ),
    /SECRET-SCHED-7/,
    "the original error must propagate unchanged",
  );
  assert.equal(destroyed, true, "destroy still ran after the scheduler phase threw");
  assert.equal(finished, true, "finish still ran after the scheduler phase threw");
  const failure = lines.find((line) =>
    line.startsWith("shutdown-phase-failure phase=scheduler-abort-settle"),
  );
  assert.ok(failure, "scheduler phase failure marker logged");
  assert.match(failure!, MARKER);
  assert.equal(
    lines.some((line) => line.includes("SECRET-SCHED-7")),
    false,
    "no error payload in any log line",
  );
  assert.ok(
    lines.some((line) => line.startsWith("shutdown-phase-start phase=orchestrator-drain-flush-dispose")),
    "orchestrator phase still started after the scheduler failure",
  );
  quietLogger();
});

test("a destroy-phase failure logs failure without the error payload and still runs finish", async () => {
  const { lines } = installRecordingLogger();
  const scheduler = { stop: () => Promise.resolve() } as unknown as BacklogScheduler;
  let finished = false;
  await assert.rejects(
    shutdownBacklogDrain(
      scheduler,
      () => Promise.reject(new Error("SECRET-DESTROY-9")),
      () => {
        finished = true;
      },
    ),
    /SECRET-DESTROY-9/,
    "the original error must propagate unchanged",
  );
  assert.equal(finished, true, "finish still ran after destroy threw");
  const failure = lines.find((line) =>
    line.startsWith("shutdown-phase-failure phase=orchestrator-drain-flush-dispose"),
  );
  assert.ok(failure, "orchestrator phase failure marker logged");
  assert.match(failure!, MARKER);
  assert.equal(
    lines.some((line) => line.includes("SECRET-DESTROY-9")),
    false,
    "no error payload in any log line",
  );
  assert.ok(
    lines.some((line) => line.startsWith("shutdown-phase-end phase=scheduler-abort-settle")),
    "scheduler phase completed before the orchestrator failure",
  );
  quietLogger();
});

test("logShutdownPhase keeps the resolved value and passes it through", async () => {
  installRecordingLogger();
  const value = await logShutdownPhase("listener-closure", async () => 41 + 1);
  assert.equal(value, 42, "the phase helper must be pass-through");
  quietLogger();
});
