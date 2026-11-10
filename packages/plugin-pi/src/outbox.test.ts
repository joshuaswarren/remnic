import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RemnicHttpError, RemnicRequestTimeoutError, isTransientNetworkError } from "./client.js";
import type { ObserveMessage } from "./client.js";
import { ObserveOutbox, type ObserveOutboxEntry, classifyObserveFailure } from "./outbox.js";

function tmpOutboxPath(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `remnic-outbox-${label}-`));
  return path.join(dir, "observe-outbox.jsonl");
}

function entryInput(content: string, hash = `hash-${content}`) {
  return {
    sessionKey: "sess-1",
    cwd: "/tmp/work",
    messages: [{ role: "user" as const, content }] satisfies ObserveMessage[],
    messageHashes: [hash],
  };
}

function entryLine(content: string): string {
  return `${JSON.stringify({
    id: `id-${content}`,
    queuedAt: "2026-01-01T00:00:00.000Z",
    ...entryInput(content),
  })}\n`;
}

test("enqueue persists entries durably and preserves arrival order", async () => {
  const outbox = new ObserveOutbox(tmpOutboxPath("order"));
  await outbox.enqueue(entryInput("first"));
  await outbox.enqueue(entryInput("second"));
  await outbox.enqueue(entryInput("third"));

  assert.equal(await outbox.size(), 3);
  const raw = fs.readFileSync(outbox.filePath, "utf8");
  const lines = raw.trim().split("\n");
  // SAFETY: each line was serialized by enqueue from a known entry shape; the
  // assertions below re-verify exactly the fields they read.
  const parsedLines = lines.map(
    (line) => JSON.parse(line) as { id: string; queuedAt: string; messages: ObserveMessage[] }
  );
  assert.deepEqual(
    parsedLines.map((parsed) => parsed.messages[0].content),
    ["first", "second", "third"]
  );
  // Every entry carries a stable identity for idempotent replay.
  for (const parsed of parsedLines) {
    assert.ok(parsed.id && parsed.id.length > 0);
    assert.ok(!Number.isNaN(Date.parse(parsed.queuedAt)));
  }
});

test("outbox survives a process restart: entries reload and drain in order", async () => {
  const filePath = tmpOutboxPath("crash");
  const before = new ObserveOutbox(filePath);
  await before.enqueue(entryInput("alpha"));
  await before.enqueue(entryInput("beta"));

  // Simulated restart: a brand-new instance over the same file.
  const after = new ObserveOutbox(filePath);
  const delivered: string[] = [];
  const result = await after.drain(async (entry) => {
    delivered.push(entry.messages[0].content);
  });

  assert.deepEqual(delivered, ["alpha", "beta"]);
  assert.deepEqual(result, { delivered: 2, dropped: 0, pending: 0 });
  assert.equal(await after.size(), 0);
});

test("bounded outbox evicts the oldest entry with a visible notification, never silently", async () => {
  const outbox = new ObserveOutbox(tmpOutboxPath("bound"), { maxEntries: 2 });
  const notifications: Array<{ message: string; level: string }> = [];
  const notify = (message: string, level: "info" | "warning" | "error") => notifications.push({ message, level });

  await outbox.enqueue(entryInput("one"), notify);
  await outbox.enqueue(entryInput("two"), notify);
  await outbox.enqueue(entryInput("three"), notify);

  assert.equal(await outbox.size(), 2);
  const delivered: string[] = [];
  await outbox.drain(async (entry) => {
    delivered.push(entry.messages[0].content);
  });
  assert.deepEqual(delivered, ["two", "three"]);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].message, /dropped 1 oldest/);
  assert.equal(notifications[0].level, "warning");
});

test("corrupt or partially written lines are skipped without losing valid entries", async () => {
  const filePath = tmpOutboxPath("corrupt");
  fs.writeFileSync(
    filePath,
    `${entryLine("intact")}{corrupt, never closed\n\n{"id":"trunc", "messages":[{"role":"user"\n`,
    "utf8"
  );
  const outbox = new ObserveOutbox(filePath);
  const notifications: Array<{ message: string; level: string }> = [];
  const result = await outbox.drain(async () => undefined, {
    notify: (message, level) => notifications.push({ message, level }),
  });

  assert.equal(result.delivered, 1);
  assert.match(notifications[0].message, /skipped 2 unreadable line/);
});

test("drain retries capacity refusals honoring Retry-After with capped, jittered backoff", async () => {
  const outbox = new ObserveOutbox(tmpOutboxPath("retry-after"));
  await outbox.enqueue(entryInput("queued"));
  const delays: number[] = [];
  let attempts = 0;
  const result = await outbox.drain(
    async () => {
      attempts += 1;
      if (attempts <= 2) {
        throw new RemnicHttpError(503, "at capacity", "capture_capacity_exceeded", 5000);
      }
    },
    {
      jitterRatio: 0,
      maxRetryAfterMs: 30_000,
      sleep: async (ms) => {
        delays.push(ms);
      },
    }
  );

  assert.equal(result.delivered, 1);
  assert.deepEqual(delays, [5000, 5000]);
  // Retry-After is capped at maxRetryAfterMs even when the server asks for more.
  const outbox2 = new ObserveOutbox(tmpOutboxPath("retry-capped"));
  await outbox2.enqueue(entryInput("queued"));
  const cappedDelays: number[] = [];
  let attempts2 = 0;
  await outbox2.drain(
    async () => {
      attempts2 += 1;
      if (attempts2 === 1) throw new RemnicHttpError(503, "at capacity", "capture_capacity_exceeded", 120_000);
    },
    {
      maxRetryAfterMs: 30_000,
      jitterRatio: 0,
      sleep: async (ms) => {
        cappedDelays.push(ms);
      },
    }
  );
  assert.deepEqual(cappedDelays, [30_000]);
});

test("drain makes bounded attempts per drain and keeps undelivered entries", async () => {
  const outbox = new ObserveOutbox(tmpOutboxPath("bounded-attempts"));
  await outbox.enqueue(entryInput("stuck"));
  let attempts = 0;
  const result = await outbox.drain(
    async () => {
      attempts += 1;
      throw new RemnicHttpError(503, "at capacity", "capture_capacity_exceeded", 0);
    },
    { maxAttempts: 3, jitterRatio: 0, sleep: async () => undefined }
  );

  assert.equal(attempts, 3);
  assert.equal(result.delivered, 0);
  assert.equal(result.pending, 1);
  assert.equal(await outbox.size(), 1, "undelivered entries stay queued");
});

test("drain drops permanently rejected entries with a notification and continues", async () => {
  const outbox = new ObserveOutbox(tmpOutboxPath("permanent"));
  await outbox.enqueue(entryInput("bad-1", "hash-bad-1"));
  await outbox.enqueue(entryInput("good"));
  const notifications: Array<{ message: string; level: string }> = [];
  const delivered: string[] = [];
  let sleeps = 0;
  const result = await outbox.drain(
    async (entry) => {
      if (entry.messages[0].content === "bad-1") {
        throw new RemnicHttpError(400, "bad request", "invalid_request");
      }
      delivered.push(entry.messages[0].content);
    },
    {
      sleep: async () => {
        sleeps += 1;
      },
      notify: (message, level) => notifications.push({ message, level }),
    }
  );

  assert.deepEqual(delivered, ["good"]);
  assert.deepEqual(result, { delivered: 1, dropped: 1, pending: 0 });
  assert.equal(sleeps, 0, "permanent failures are not retried");
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].message, /dropped 1 capture/);
  assert.equal(notifications[0].level, "warning");
});

test("drain on an empty outbox is a no-op", async () => {
  const outbox = new ObserveOutbox(tmpOutboxPath("empty"));
  const result = await outbox.drain(async () => undefined);
  assert.deepEqual(result, { delivered: 0, dropped: 0, pending: 0 });
});

test("classifyObserveFailure separates retryable backpressure from permanent rejection", () => {
  assert.equal(
    classifyObserveFailure(new RemnicHttpError(503, "at capacity", "capture_capacity_exceeded")),
    "retry-capacity"
  );
  assert.equal(classifyObserveFailure(new RemnicRequestTimeoutError(1000)), "retry-ambiguous");
  const networkErr = Object.assign(new Error("socket connection was closed"), {});
  assert.ok(isTransientNetworkError(networkErr));
  assert.equal(classifyObserveFailure(networkErr), "retry-ambiguous");
  assert.equal(classifyObserveFailure(new RemnicHttpError(400, "bad request", "invalid_request")), "permanent");
  assert.equal(
    classifyObserveFailure(new RemnicHttpError(500, "storage target missing", "storage_target_missing")),
    "permanent"
  );
  // Unknown failures are ambiguous: bounded retry with a stable idempotency key is safe.
  assert.equal(classifyObserveFailure(new Error("something unexpected")), "retry-ambiguous");
});
