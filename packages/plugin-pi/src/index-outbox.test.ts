import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RemnicClient } from "./client.js";
import type { RemnicPiConfig } from "./config.js";
import { createRemnicPiExtension, observeMessages } from "./index.js";
import type { PiApi } from "./index.js";
import { observedMessageDedupeKey, toObserveMessage } from "./messages.js";
import { ObserveOutbox } from "./outbox.js";

// ---------------------------------------------------------------------------
// Durable observe outbox: capacity refusals and ambiguous failures must never
// lose a turn. Entries are queued durably with a replay-nonce idempotency
// key, replayed with bounded Retry-After-aware attempts, and drained on the
// next successful contact or session start.
// ---------------------------------------------------------------------------

function outboxTestConfig(overrides: Partial<RemnicPiConfig> = {}): RemnicPiConfig {
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
    observeOutboxPath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "remnic-pi-outbox-")), "observe-outbox.jsonl"),
    ...overrides,
  };
}

type ObserveBody = { idempotencyKey?: string; messages?: Array<{ content?: string }> };

function observeCtx(sessionId: string, notify?: (message: string, level: string) => void) {
  const ctx = {
    cwd: "/tmp/remnic-pi",
    sessionManager: { getSessionId: () => sessionId },
  };
  if (notify) {
    return { ...ctx, ui: { notify } };
  }
  return ctx;
}

test("repeat 503 capacity refusals queue durably, then drain exactly once in order", async (t) => {
  const outboxPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "remnic-pi-outbox-")), "observe-outbox.jsonl");
  const config = outboxTestConfig({ observeOutboxPath: outboxPath });
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const requests: ObserveBody[] = [];
  const ingestCount = new Map<string, number>();
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (!url.endsWith("/engram/v1/observe")) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    // SAFETY: this test's own fetch mock serialized the request body; the spy
    // only reads idempotencyKey/messages and every read is asserted.
    const body = JSON.parse(String(init?.body ?? "{}")) as ObserveBody;
    const key = body.idempotencyKey ?? "";
    if (ingestCount.has(key)) {
      // Server already processed this payload: deduplicated replay, nothing re-ingested.
      return new Response(JSON.stringify({ ok: true, idempotencyReplay: true }), { status: 200 });
    }
    ingestCount.set(key, 1);
    requests.push(body);
    if (requests.length <= 2) {
      return new Response(JSON.stringify({ error: "at capacity", code: "capture_capacity_exceeded" }), {
        status: 503,
        headers: { "retry-after": "0" },
      });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const outbox = new ObserveOutbox(outboxPath);
  const observedHashes = new Set<string>();
  const notifications: Array<{ message: string; level: string }> = [];
  const ctx = observeCtx("repeat-503", (message, level) => notifications.push({ message, level }));
  const client = new RemnicClient(config);
  const raw1 = { id: "m-1", role: "user", content: "turn one" };
  const raw2 = { id: "m-2", role: "user", content: "turn two" };
  const raw3 = { id: "m-3", role: "user", content: "turn three" };

  await observeMessages(ctx, client, [raw1], observedHashes, undefined, config, outbox);
  await observeMessages(ctx, client, [raw2], observedHashes, undefined, config, outbox);
  await observeMessages(ctx, client, [raw3], observedHashes, undefined, config, outbox);

  // Live sends carry ONLY the new turn's messages — queued messages are never re-sent live.
  assert.equal(requests.length, 3);
  assert.deepEqual(
    requests.map((r) => r.messages?.map((m) => m.content)),
    [["turn one"], ["turn two"], ["turn three"]]
  );

  // The queued replays went out under the SAME identity as the refused send, so the
  // server deduplicated them; each distinct payload was ingested exactly once.
  const keyByContent = new Map(requests.map((r) => [r.messages?.[0]?.content ?? "", r.idempotencyKey ?? ""]));
  assert.equal(ingestCount.get(keyByContent.get("turn one") ?? ""), 1);
  assert.equal(ingestCount.get(keyByContent.get("turn two") ?? ""), 1);
  assert.equal(ingestCount.get(keyByContent.get("turn three") ?? ""), 1);
  assert.equal(await outbox.size(), 0, "outbox drained after successful contact");

  // Delivered turns are remembered as observed so shutdown replay does not re-send them.
  for (const raw of [raw1, raw2, raw3]) {
    const message = toObserveMessage(raw);
    const hash = message ? observedMessageDedupeKey(message, "pi:repeat-503") : null;
    assert.ok(hash && observedHashes.has(hash), `hash for ${raw.id} remembered`);
  }

  const deferrals = notifications.filter((n) => /queued durably/.test(n.message));
  assert.equal(deferrals.length, 2, "each refused turn surfaces a visible deferral notification");
  assert.ok(deferrals.every((n) => n.level === "warning"));
});

test("response loss (server accepted, client timed out) replays without duplicating", async (t) => {
  const outboxPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "remnic-pi-outbox-")), "observe-outbox.jsonl");
  const config = outboxTestConfig({ observeOutboxPath: outboxPath, turnRequestTimeoutMs: 80 });
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const ingestCount = new Map<string, number>();
  const requests: ObserveBody[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (!url.endsWith("/engram/v1/observe")) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    // SAFETY: this test's own fetch mock serialized the request body; the spy
    // only reads idempotencyKey/messages and every read is asserted.
    const body = JSON.parse(String(init?.body ?? "{}")) as ObserveBody;
    const key = body.idempotencyKey ?? "";
    const isFirst = requests.length === 0;
    requests.push(body);
    if (isFirst) {
      // Server accepts and ingests, but the response is lost mid-flight.
      ingestCount.set(key, 1);
      const { promise, reject } = Promise.withResolvers<Response>();
      init?.signal?.addEventListener(
        "abort",
        () => reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })),
        { once: true }
      );
      return promise;
    }
    if (ingestCount.has(key)) {
      // Deduplicated replay — already ingested, do not count again.
      return new Response(JSON.stringify({ ok: true, idempotencyReplay: true }), { status: 200 });
    }
    ingestCount.set(key, 1);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const outbox = new ObserveOutbox(outboxPath);
  const observedHashes = new Set<string>();
  const notifications: Array<{ message: string; level: string }> = [];
  const ctx = observeCtx("response-loss", (message, level) => notifications.push({ message, level }));
  const client = new RemnicClient(config);

  await observeMessages(
    ctx,
    client,
    [{ id: "r-1", role: "user", content: "lost reply" }],
    observedHashes,
    undefined,
    config,
    outbox
  );
  // The timeout trips the breaker for daemonCooldownMs (1 ms here); without this wait the
  // second call can land inside the same millisecond and be fast-skipped (flaky under load).
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  await observeMessages(
    ctx,
    client,
    [{ id: "r-2", role: "user", content: "next turn" }],
    observedHashes,
    undefined,
    config,
    outbox
  );

  assert.equal(requests.length, 3, "original + next turn + one replay");
  assert.equal(requests[2].idempotencyKey, requests[0].idempotencyKey, "replay reuses the lost send's stable identity");
  assert.equal(ingestCount.get(requests[0].idempotencyKey ?? ""), 1, "ingested exactly once despite the replay");
  assert.equal(await outbox.size(), 0);
  assert.ok(notifications.some((n) => /queued durably/.test(n.message)));
});

test("non-capacity errors are neither queued nor retried", async (t) => {
  const outboxPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "remnic-pi-outbox-")), "observe-outbox.jsonl");
  const config = outboxTestConfig({ observeOutboxPath: outboxPath });
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let calls = 0;
  globalThis.fetch = async (input) => {
    if (!String(input).endsWith("/engram/v1/observe")) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    calls += 1;
    return new Response(JSON.stringify({ error: "bad request", code: "invalid_request" }), { status: 400 });
  };

  const outbox = new ObserveOutbox(outboxPath);
  const observedHashes = new Set<string>();
  const notifications: Array<{ message: string; level: string }> = [];
  const ctx = observeCtx("permanent-400", (message, level) => notifications.push({ message, level }));
  const client = new RemnicClient(config);

  await observeMessages(
    ctx,
    client,
    [{ id: "p-1", role: "user", content: "will fail" }],
    observedHashes,
    undefined,
    config,
    outbox
  );

  assert.equal(calls, 1, "no retry of a permanent rejection");
  assert.equal(await outbox.size(), 0, "permanent rejections are not queued");
  assert.ok(notifications.some((n) => n.level === "warning" && /Remnic observe failed/.test(n.message)));
});

test("session start drains an outbox left behind by a previous process", async (t) => {
  const outboxPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "remnic-pi-outbox-")), "observe-outbox.jsonl");
  const config = outboxTestConfig({ observeOutboxPath: outboxPath });
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  // Simulate a crashed process: the outbox file exists with one queued entry.
  const seeded = {
    id: "seed-1",
    queuedAt: "2026-01-01T00:00:00.000Z",
    sessionKey: "drain-startup",
    cwd: "/tmp/remnic-pi",
    messages: [{ role: "user", content: "queued before restart" }],
    messageHashes: ["hash-queued"],
  };
  fs.mkdirSync(path.dirname(outboxPath), { recursive: true });
  fs.writeFileSync(outboxPath, `${JSON.stringify(seeded)}\n`, "utf8");

  const observeRequests: ObserveBody[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (!url.endsWith("/engram/v1/observe")) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    // SAFETY: this test's own fetch mock serialized the request body; assertions
    // below read only messages/idempotencyKey from it.
    observeRequests.push(JSON.parse(String(init?.body ?? "{}")) as ObserveBody);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  type TestPiEventHandler = Parameters<PiApi["on"]>[1];
  const handlers = new Map<string, TestPiEventHandler[]>();
  const pi: PiApi = {
    on: (event, handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand: () => undefined,
    registerTool: () => undefined,
    appendEntry: () => undefined,
  };
  const extension = createRemnicPiExtension({ config });
  await extension(pi);
  for (const handler of handlers.get("session_start") ?? []) {
    await handler(
      {},
      {
        cwd: "/tmp/remnic-pi",
        ui: { setStatus: () => undefined, notify: () => undefined },
        sessionManager: { getSessionId: () => "drain-startup", getEntries: () => [] },
      }
    );
  }

  assert.equal(observeRequests.length, 1, "queued entry drained on session start");
  assert.deepEqual(
    observeRequests[0].messages?.map((m) => m.content),
    ["queued before restart"]
  );
  assert.match(String(observeRequests[0].idempotencyKey), /^obs-/);
  assert.equal(fs.readFileSync(outboxPath, "utf8").trim().length, 0, "outbox emptied after drain");
});

test("session start with a dead daemon returns quickly and keeps the queue intact", async (t) => {
  const outboxPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "remnic-pi-outbox-")), "observe-outbox.jsonl");
  const config = outboxTestConfig({ observeOutboxPath: outboxPath });
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const seeded = {
    id: "seed-dead",
    queuedAt: "2026-01-01T00:00:00.000Z",
    sessionKey: "dead-daemon",
    cwd: "/tmp/remnic-pi",
    messages: [{ role: "user", content: "still queued" }],
    messageHashes: ["hash-dead"],
  };
  fs.mkdirSync(path.dirname(outboxPath), { recursive: true });
  fs.writeFileSync(outboxPath, `${JSON.stringify(seeded)}\n`, "utf8");

  let observeCalls = 0;
  globalThis.fetch = async (input) => {
    if (String(input).endsWith("/engram/v1/observe")) observeCalls += 1;
    throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  };

  type TestPiEventHandler = Parameters<PiApi["on"]>[1];
  const handlers = new Map<string, TestPiEventHandler[]>();
  const pi: PiApi = {
    on: (event, handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand: () => undefined,
    registerTool: () => undefined,
    appendEntry: () => undefined,
  };
  const extension = createRemnicPiExtension({ config });
  await extension(pi);
  const started = Date.now();
  for (const handler of handlers.get("session_start") ?? []) {
    await handler(
      {},
      {
        cwd: "/tmp/remnic-pi",
        ui: { setStatus: () => undefined, notify: () => undefined },
        sessionManager: { getSessionId: () => "dead-daemon", getEntries: () => [] },
      }
    );
  }
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1500, `startup must not block on a dead daemon (took ${elapsed} ms)`);
  assert.equal(observeCalls, 1, "one cheap attempt at startup, no backoff ladder");
  assert.equal(fs.readFileSync(outboxPath, "utf8").trim().split("\n").length, 1, "the queued capture is still on disk");
});

test("a failed enqueue is reported to the user instead of losing the turn silently", async (t) => {
  // The outbox directory cannot be created: its parent path is a regular file.
  const blocker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "remnic-pi-outbox-")), "not-a-dir");
  fs.writeFileSync(blocker, "x", "utf8");
  const config = outboxTestConfig({ observeOutboxPath: path.join(blocker, "observe-outbox.jsonl") });
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "busy" }), { status: 503 });

  const outbox = new ObserveOutbox(config.observeOutboxPath ?? "");
  const notifications: Array<{ message: string; level: string }> = [];
  const ctx = observeCtx("enqueue-fails", (message, level) => notifications.push({ message, level }));
  await observeMessages(
    ctx,
    new RemnicClient(config),
    [{ id: "e-1", role: "user", content: "cannot be queued" }],
    new Set<string>(),
    undefined,
    config,
    outbox
  );

  const failure = notifications.find((n) => /could not be queued/.test(n.message));
  assert.ok(failure, "the user is told the capture could not be queued");
  assert.equal(failure.level, "error");
  assert.ok(
    !notifications.some((n) => /queued durably/.test(n.message)),
    "no false claim that the turn was queued durably"
  );
});
