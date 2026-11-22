import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { withHeldFileLock } from "@remnic/core/utils/serialize-mutations";

import { RemnicClient, RemnicHttpError } from "./client.js";
import type { RemnicPiConfig } from "./config.js";
import { createRemnicPiExtension, observeMessages } from "./index.js";
import type { PiApi } from "./index.js";
import { observedMessageDedupeKey, sessionKeyFromContext, toObserveMessage } from "./messages.js";
import { drainObserveOutbox, settleObserveOutboxDrain } from "./observe-flow.js";
import { ObserveOutbox } from "./outbox.js";

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
    firstTurnRecallBudgetMs: 1000,
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
  const releaseReplay = Promise.withResolvers<void>();
  globalThis.fetch = async (_input, init) => {
    // SAFETY: this test's own fetch mock serialized the request body; only messages[0].content is read.
    const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<{ content?: string }> };
    if (body.messages?.[0]?.content === "live turn") return new Response(JSON.stringify({ ok: true }), { status: 200 });
    replayAttempts += 1;
    if (replayAttempts === 1) await releaseReplay.promise;
    return new Response(JSON.stringify({ error: "token rejected" }), { status: 401 });
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

  releaseReplay.resolve();
  await settleObserveOutboxDrain(outbox);
  assert.equal(await outbox.size(), 1, "a blocked refusal keeps the capture queued");
  assert.ok(replayAttempts <= 4, "the drain made at most its bounded attempts");
});

test("a drain failure never reports the delivered live turn as failed or re-queues it", async (t) => {
  const outboxPath = tmpOutboxPath();
  const config = drainTestConfig(outboxPath);
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

test("session start survives a locked outbox: no rejection, bounded, and the startup probe still runs", async (t) => {
  const outboxPath = tmpOutboxPath();
  const config = drainTestConfig(outboxPath);
  const seeded = new ObserveOutbox(outboxPath);
  await seeded.enqueue({ ...queuedEntry, sessionKey: "session-start-locked" });

  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const urls: string[] = [];
  globalThis.fetch = async (input) => {
    urls.push(String(input));
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const acquired = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const holder = withHeldFileLock(`${outboxPath}.lock`, { staleMs: 60_000, maxWaitMs: 1000 }, async (got) => {
    assert.ok(got, "test setup: the lock was acquired");
    acquired.resolve();
    await release.promise;
  });
  await acquired.promise;

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
  await createRemnicPiExtension({ config })(pi);

  const notifications: Array<{ message: string; level: string }> = [];
  const started = Date.now();
  try {
    for (const handler of handlers.get("session_start") ?? []) {
      await handler(
        {},
        {
          cwd: "/tmp/remnic-pi",
          ui: {
            setStatus: () => undefined,
            notify: (message: string, level: string) => notifications.push({ message, level }),
          },
          sessionManager: { getSessionId: () => "session-start-locked", getEntries: () => [] },
        }
      );
    }
  } finally {
    release.resolve();
    await holder;
  }
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 4500, `session start stays bounded while the outbox is locked (took ${elapsed} ms)`);
  assert.ok(!notifications.some((n) => n.level === "error"), "no error notification");
  const deadline = Date.now() + 2000;
  while (!urls.some((url) => !url.endsWith("/engram/v1/observe")) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(urls.some((url) => !url.endsWith("/engram/v1/observe")), "the startup health probe still ran");
});

test("#3381: a replay stopped by rejected credentials names the credentials, not daemon saturation", async () => {
  for (const status of [400, 401, 403, 503]) {
    const outboxPath = tmpOutboxPath();
    const config = drainTestConfig(outboxPath);
    const outbox = new ObserveOutbox(outboxPath);
    await outbox.enqueue(queuedEntry);
    const client = new RemnicClient(config);
    client.observe = async () => {
      throw new RemnicHttpError(status, `HTTP ${status}`);
    };
    const warnings: string[] = [];
    const session = { notify: (message: string) => warnings.push(message) };

    await drainObserveOutbox(session, client, config, outbox, new Set<string>(), undefined, true);

    assert.equal(await outbox.size(), 1, `HTTP ${status}: the capture stays queued`);
    const saturated = warnings.some((message) => message.includes("daemon saturated"));
    if (status === 503) {
      assert.ok(saturated, "a capacity stop still reports saturation");
    } else if (status === 400) {
      assert.ok(warnings.some((message) => message.includes("permanently rejected")), "the rejection cause reaches the user");
      assert.equal(saturated, false, "a permanent rejection is not daemon saturation");
    } else {
      assert.ok(
        warnings.some((message) => message.includes(`rejected the request credentials (HTTP ${status})`)),
        `HTTP ${status}: the stop reason reaches the user`,
      );
      assert.equal(saturated, false, `HTTP ${status}: a credential stop is not daemon saturation`);
    }
  }
});

test("replay sends the queued entry's principal, not the draining process's", async (t) => {
  const outboxPath = tmpOutboxPath();
  const config = { ...drainTestConfig(outboxPath), principal: "wD6:p1@drainer-host" };
  const outbox = new ObserveOutbox(outboxPath);
  await outbox.enqueue({ ...queuedEntry, principal: "w7P:p2@writer-host" });
  await outbox.enqueue({ ...queuedEntry, sessionKey: "entry-no-principal", messageHashes: ["hash-no-principal"] });

  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const sentPrincipals: Array<string | null> = [];
  globalThis.fetch = async (_input, init) => {
    sentPrincipals.push(new Headers(init?.headers).get("x-engram-principal"));
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const session = { notify: () => {} };
  await drainObserveOutbox(session, new RemnicClient(config), config, outbox, new Set<string>(), undefined, true);
  assert.equal(sentPrincipals.length, 1, "bounded replay stops after one delivery");
  assert.equal(await outbox.size(), 1, "the next entry remains queued");
  await drainObserveOutbox(session, new RemnicClient(config), config, outbox, new Set<string>(), undefined, true);

  assert.equal(sentPrincipals[0], "w7P:p2@writer-host", "queued writer identity survives a foreign drainer");
  assert.equal(sentPrincipals[1], "wD6:p1@drainer-host", "entries without a principal keep the drainer's");
});

test("#3381: a foreign session's delivered entry updates that session's state, not the drainer's", async () => {
  const outboxPath = tmpOutboxPath();
  const config = drainTestConfig(outboxPath);
  const outbox = new ObserveOutbox(outboxPath);
  await outbox.enqueue(queuedEntry); // sessionKey "other-session"
  await outbox.enqueue({ ...queuedEntry, sessionKey: "gone-session", messageHashes: ["hash-gone"] });
  const client = new RemnicClient(config);
  client.observe = async () => ({ ok: true });

  const drainerHashes = new Set<string>();
  const drainerReplayKeys = new Map<string, number>();
  const writerState = { observedHashes: new Set<string>(), liveObservedReplayKeys: new Map<string, number>() };
  const session = { notify: () => {} };

  await drainObserveOutbox(
    session,
    client,
    config,
    outbox,
    drainerHashes,
    drainerReplayKeys,
    true,
    (key) => (key === "other-session" ? writerState : undefined),
  );

  assert.ok(writerState.observedHashes.has("hash-queued-earlier"));
  assert.equal(writerState.liveObservedReplayKeys.size, 1);
  assert.equal(drainerHashes.size, 0);
  assert.equal(drainerReplayKeys.size, 0);
});

test("a lost-response replay keeps the live attempt's idempotency key even when rawContent is bounded out", async (t) => {
  const outboxPath = tmpOutboxPath();
  const config = drainTestConfig(outboxPath);
  const outbox = new ObserveOutbox(outboxPath);
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const keys: Array<string | undefined> = [];
  let calls = 0;
  globalThis.fetch = async (_input, init) => {
    calls += 1;
    // SAFETY: this test's own fetch mock serialized the request body; only the key is read.
    const body = JSON.parse(String(init?.body ?? "{}")) as { idempotencyKey?: string };
    keys.push(body.idempotencyKey);
    return calls === 1
      ? new Response(JSON.stringify({ error: "internal_error" }), { status: 500 })
      : new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const big = { id: "l-big", role: "user", content: "live turn", blob: "x".repeat(64 * 1024) };
  await observeMessages(liveCtx(() => {}), new RemnicClient(config), [big], new Set<string>(), undefined, config, outbox);
  assert.equal(await outbox.size(), 1, "the ambiguous 500 queues the turn");

  await drainObserveOutbox({ notify: () => {} }, new RemnicClient(config), config, outbox, new Set<string>(), undefined, true);

  assert.ok(keys[0] && keys[1], "the live attempt and the replay each carried an idempotency key");
  assert.equal(keys[1], keys[0], "the replay must reuse the live attempt's key or the daemon ingests twice");
});

test("a queued entry bound to another daemon does not suppress the live capture for this one", async (t) => {
  const outboxPath = tmpOutboxPath();
  const config = drainTestConfig(outboxPath); // remnicDaemonUrl http://127.0.0.1:4318
  const outbox = new ObserveOutbox(outboxPath);
  const raw = { id: "l-1", role: "user", content: "shared capture" };
  const message = toObserveMessage(raw);
  assert.ok(message);
  const ctx = liveCtx(() => {});
  const liveSessionKey = sessionKeyFromContext(ctx);
  await outbox.enqueue({
    ...queuedEntry,
    sessionKey: liveSessionKey,
    destination: "http://daemon-a:4318",
    messageHashes: [observedMessageDedupeKey(message, liveSessionKey)],
  });

  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let sent = 0;
  globalThis.fetch = async () => {
    sent += 1;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  await observeMessages(ctx, new RemnicClient(config), [raw], new Set<string>(), undefined, config, outbox);
  await settleObserveOutboxDrain(outbox);
  assert.equal(sent, 1, "the capture reaches this daemon instead of being suppressed by the foreign entry");
  assert.equal(await outbox.size(), 1, "the foreign entry stays queued for its own daemon");
});

test("a successful bounded send leaving entries reports no daemon saturation", async () => {
  const outboxPath = tmpOutboxPath();
  const config = drainTestConfig(outboxPath);
  const outbox = new ObserveOutbox(outboxPath);
  await outbox.enqueue(queuedEntry);
  await outbox.enqueue({ ...queuedEntry, sessionKey: "second-entry", messageHashes: ["hash-second"] });

  const client = new RemnicClient(config);
  let sends = 0;
  client.observe = async () => {
    sends += 1;
    return { ok: true };
  };
  const warnings: string[] = [];
  const session = { notify: (message: string) => warnings.push(message) };

  await drainObserveOutbox(session, client, config, outbox, new Set<string>(), undefined, true);

  assert.equal(sends, 1, "the bounded drain sent exactly one capture");
  assert.equal(await outbox.size(), 1, "the second entry remains queued");
  assert.equal(
    warnings.some((message) => message.includes("daemon saturated")),
    false,
    "normal bounded pacing after a successful send is not saturation"
  );
});
