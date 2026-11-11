import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { withHeldFileLock } from "@remnic/core/utils/serialize-mutations";

import { RemnicClient } from "./client.js";
import type { RemnicPiConfig } from "./config.js";
import { observeMessages } from "./index.js";
import { settleObserveOutboxDrain } from "./observe-flow.js";
import { ObserveOutbox } from "./outbox.js";

// ---------------------------------------------------------------------------
// The outbox drain runs AFTER a successful live observe and must never hold up
// the live hook or turn its own failures into a failed live observe (review of
// #3380: a refused replay with retry-after made a live observe take 14 s, and a
// locked outbox file produced an "observe failed" error after both POSTs
// returned 200 and re-queued turns that were already delivered).
// ---------------------------------------------------------------------------

function drainTestConfig(outboxPath: string): RemnicPiConfig {
  return {
    remnicDaemonUrl: "http://127.0.0.1:4318",
    recallMode: "auto",
    recallTopK: 8,
    recallBudgetChars: 12000,
    recallEnabled: false,
    observeEnabled: true,
    observeSkipExtraction: false,
    compactionEnabled: false,
    mcpToolsEnabled: false,
    statusEnabled: false,
    requestTimeoutMs: 5_000,
    startupRequestTimeoutMs: 500,
    turnRequestTimeoutMs: 200,
    observeMaxBytes: 102400,
    observeMaxRetries: 0,
    daemonCooldownMs: 1,
    recallTimeoutThreshold: 7,
    recallTimeoutWindow: 10,
    authToken: "test-token",
    observeOutboxPath: outboxPath,
  };
}

function tmpOutboxPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "remnic-pi-drain-")), "observe-outbox.jsonl");
}

function liveCtx(notify: (message: string, level: string) => void) {
  return {
    cwd: "/tmp/remnic-pi",
    sessionManager: { getSessionId: () => "live-session" },
    ui: { notify },
  };
}

const queuedEntry = {
  sessionKey: "other-session",
  cwd: "/tmp/remnic-pi",
  messages: [{ role: "user" as const, content: "queued earlier" }],
  messageHashes: ["hash-queued-earlier"],
};

test("a live observe returns without waiting for a refused queued replay", async (t) => {
  const outboxPath = tmpOutboxPath();
  const config = drainTestConfig(outboxPath);
  const outbox = new ObserveOutbox(outboxPath);
  await outbox.enqueue(queuedEntry);

  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let replayAttempts = 0;
  globalThis.fetch = async (_input, init) => {
    // SAFETY: this test's own fetch mock serialized the request body; only messages[0].content is read.
    const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<{ content?: string }> };
    if (body.messages?.[0]?.content === "live turn") return new Response(JSON.stringify({ ok: true }), { status: 200 });
    replayAttempts += 1;
    return new Response(JSON.stringify({ error: "busy", code: "buffer_admission_refused" }), {
      status: 503,
      headers: { "retry-after": "5" },
    });
  };

  const notifications: Array<{ message: string; level: string }> = [];
  const started = Date.now();
  await observeMessages(
    liveCtx((message, level) => notifications.push({ message, level })),
    new RemnicClient(config),
    [{ id: "l-1", role: "user", content: "live turn" }],
    new Set<string>(),
    undefined,
    config,
    outbox
  );
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 1500, `the live hook must not wait for the replay (took ${elapsed} ms)`);
  assert.equal(await outbox.size(), 1, "the refused entry is still queued, never dropped");
  assert.ok(!notifications.some((n) => n.level === "error"), "no error for a successful live observe");
  assert.ok(replayAttempts <= 4, "the background drain stays bounded");
});

test("a drain failure never reports the delivered live turn as failed or re-queues it", async (t) => {
  const outboxPath = tmpOutboxPath();
  const config = drainTestConfig(outboxPath);
  // The drain's remove() will wait at most 150 ms for the file lock.
  const outbox = new ObserveOutbox(outboxPath, { lockMaxWaitMs: 150 });
  await outbox.enqueue(queuedEntry);

  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const sent: string[] = [];
  globalThis.fetch = async (_input, init) => {
    // SAFETY: this test's own fetch mock serialized the request body; only messages[0].content is read.
    const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<{ content?: string }> };
    sent.push(body.messages?.[0]?.content ?? "");
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  // Another pi process holds the outbox lock for the whole drain.
  const acquired = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const holder = withHeldFileLock(`${outboxPath}.lock`, { staleMs: 60_000, maxWaitMs: 1000 }, async (got) => {
    assert.ok(got, "test setup: the lock was acquired");
    acquired.resolve();
    await release.promise;
  });
  await acquired.promise;

  const notifications: Array<{ message: string; level: string }> = [];
  await observeMessages(
    liveCtx((message, level) => notifications.push({ message, level })),
    new RemnicClient(config),
    [{ id: "l-2", role: "user", content: "live turn" }],
    new Set<string>(),
    undefined,
    config,
    outbox
  );
  await settleObserveOutboxDrain(outbox);
  release.resolve();
  await holder;

  assert.deepEqual(sent, ["live turn", "queued earlier"], "both POSTs succeeded");
  assert.ok(!notifications.some((n) => n.level === "error"), `no error notification (got ${JSON.stringify(notifications)})`);
  assert.ok(
    notifications.some((n) => n.level === "warning" && /outbox drain failed/.test(n.message)),
    "the failure is reported as a drain problem, not a failed observe"
  );
  const queued = fs
    .readFileSync(outboxPath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
  assert.equal(queued.length, 1, "the delivered live turn was not queued again");
  assert.ok(queued[0].includes("queued earlier"));
});
