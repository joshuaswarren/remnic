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

test("replay nonce is persisted with the entry, survives a restart, and reaches the sender", async () => {
  const file = tmpOutboxPath("nonce");
  const first = new ObserveOutbox(file);
  await first.enqueue({ ...entryInput("kept"), replayNonce: "nonce-from-first-attempt" });

  const reloaded = new ObserveOutbox(file);
  const seen: Array<string | undefined> = [];
  await reloaded.drain(async (entry) => {
    seen.push(entry.replayNonce);
  });
  assert.deepEqual(seen, ["nonce-from-first-attempt"], "replay reuses the nonce of the original attempt");
});

test("an old-format entry without a nonce gets a stable one derived from its id", async () => {
  const file = tmpOutboxPath("legacy-nonce");
  fs.writeFileSync(file, entryLine("legacy"));
  const seen: Array<string | undefined> = [];
  for (let run = 0; run < 2; run += 1) {
    const outbox = new ObserveOutbox(file);
    await outbox.drain(async (entry) => {
      seen.push(entry.replayNonce);
      throw new RemnicHttpError(503, "busy", "buffer_admission_refused");
    }, { maxAttempts: 1, jitterRatio: 0, sleep: async () => undefined });
  }
  assert.equal(seen[0], "id-legacy", "nonce falls back to the persisted entry id");
  assert.equal(seen[1], seen[0], "and is identical after a restart");
});

test("status exposes queued, retried, delivered, dropped counters and the oldest entry age", async () => {
  const outbox = new ObserveOutbox(tmpOutboxPath("stats"));
  await outbox.enqueue(entryInput("a"));
  await outbox.enqueue(entryInput("b"));
  let failedOnce = false;
  await outbox.drain(async () => {
    if (!failedOnce) {
      failedOnce = true;
      throw new RemnicHttpError(503, "busy", "buffer_admission_refused");
    }
  }, { jitterRatio: 0, sleep: async () => undefined });
  const done = await outbox.status();
  assert.deepEqual(
    { queued: done.queued, retried: done.retried, delivered: done.delivered, dropped: done.dropped, pending: done.pending, oldestAgeMs: done.oldestAgeMs },
    { queued: 2, retried: 1, delivered: 2, dropped: 0, pending: 0, oldestAgeMs: null },
  );
});

test("replaying an entry older than the server idempotency window warns that a duplicate is possible", async () => {
  const file = tmpOutboxPath("age");
  const queuedAtMs = Date.parse("2026-01-01T00:00:00.000Z");
  fs.writeFileSync(file, entryLine("old"));
  const notifications: Array<{ message: string; level: string }> = [];
  const outbox = new ObserveOutbox(file);
  await outbox.drain(async () => undefined, {
    now: () => queuedAtMs + 16 * 60_000,
    notify: (message, level) => notifications.push({ message, level }),
  });
  assert.equal(notifications.length, 1, "one warning for the one stale replay");
  assert.match(notifications[0].message, /most recent 512/);
  assert.match(notifications[0].message, /duplicate/);
  assert.equal(notifications[0].level, "warning");

  fs.writeFileSync(file, entryLine("fresh"));
  const quiet: string[] = [];
  const fresh = new ObserveOutbox(file);
  await fresh.drain(async () => undefined, {
    now: () => queuedAtMs + 14 * 60_000,
    notify: (message) => quiet.push(message),
  });
  assert.deepEqual(quiet, [], "no warning inside the window");
});

function threeEntries(outbox: ObserveOutbox) {
  return Promise.all(["a", "b", "c"].map((c) => outbox.enqueue(entryInput(c))));
}

test("REVIEW 1: a 429 write_rate_limited keeps every queued capture", async () => {
  const outbox = new ObserveOutbox(tmpOutboxPath("rate-limit"));
  await threeEntries(outbox);
  const result = await outbox.drain(async () => {
    throw new RemnicHttpError(429, "write_rate_limited", "write_rate_limited");
  }, { maxAttempts: 2, jitterRatio: 0, sleep: async () => undefined });
  assert.equal(result.dropped, 0, "a rate limit is not a rejection of the capture");
  assert.equal(result.pending, 3, "rate-limited captures were never executed; they stay queued");
});

test("transient gateway statuses 408, 502 and 504 keep the capture queued", async () => {
  for (const status of [408, 502, 504]) {
    const outbox = new ObserveOutbox(tmpOutboxPath(`gw-${status}`));
    await outbox.enqueue(entryInput("kept"));
    const result = await outbox.drain(async () => {
      throw new RemnicHttpError(status, "transient", "transient");
    }, { maxAttempts: 2, jitterRatio: 0, sleep: async () => undefined });
    assert.deepEqual({ dropped: result.dropped, pending: result.pending }, { dropped: 0, pending: 1 }, `status ${status}`);
  }
});

test("401 and 403 stop the drain and keep the whole queue so a rotated token cannot wipe it", async () => {
  for (const status of [401, 403]) {
    const outbox = new ObserveOutbox(tmpOutboxPath(`auth-${status}`));
    await threeEntries(outbox);
    let sends = 0;
    const notifications: string[] = [];
    const result = await outbox.drain(async () => {
      sends += 1;
      throw new RemnicHttpError(status, "unauthorized", "unauthorized");
    }, { maxAttempts: 4, jitterRatio: 0, sleep: async () => undefined, notify: (message) => notifications.push(message) });
    assert.equal(sends, 1, `status ${status}: auth will not succeed on the next entry, stop at once`);
    assert.deepEqual({ dropped: result.dropped, pending: result.pending }, { dropped: 0, pending: 3 });
    assert.ok(notifications.some((m) => /credentials|authori[sz]/i.test(m)), "the user is told why the queue is parked");
  }
});

test("successful sends do not consume the per-drain attempt budget", async () => {
  const outbox = new ObserveOutbox(tmpOutboxPath("budget"));
  for (const c of ["1", "2", "3", "4", "5", "6"]) await outbox.enqueue(entryInput(c));
  const result = await outbox.drain(async () => undefined, { maxAttempts: 4, jitterRatio: 0, sleep: async () => undefined });
  assert.deepEqual({ delivered: result.delivered, pending: result.pending }, { delivered: 6, pending: 0 });
});

function readContents(file: string): string[] {
  const lines = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
  // SAFETY: every line was written by ObserveOutbox in this test and is read back only for messages[0].content.
  const entries = lines.map((line) => JSON.parse(line) as ObserveOutboxEntry);
  return entries.map((entry) => entry.messages[0].content);
}

test("REVIEW 2: two processes sharing one outbox file keep each other's entries", async () => {
  const file = tmpOutboxPath("two-procs");
  const procA = new ObserveOutbox(file);
  const procB = new ObserveOutbox(file);
  await procB.pendingHashes(); // B loaded the (empty) file before A queued anything
  await procA.enqueue(entryInput("from-A"));
  await procB.enqueue(entryInput("from-B"));
  assert.deepEqual(readContents(file).sort(), ["from-A", "from-B"]);
});

test("many concurrent writers never lose an entry and leave no stray temp files", async () => {
  const file = tmpOutboxPath("many-writers");
  const writers = Array.from({ length: 12 }, () => new ObserveOutbox(file));
  await Promise.all(writers.map((writer, i) => writer.enqueue(entryInput(`w${i}`))));
  assert.deepEqual(
    readContents(file).sort(),
    Array.from({ length: 12 }, (_, i) => `w${i}`).sort(),
  );
  const strays = fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith(".tmp"));
  assert.deepEqual(strays, [], "temp files are unique per write and renamed away");
});

test("a drain removes only the entry it delivered and keeps what another process queued meanwhile", async () => {
  const file = tmpOutboxPath("drain-vs-enqueue");
  const procA = new ObserveOutbox(file);
  const procB = new ObserveOutbox(file);
  await procA.enqueue(entryInput("first"));
  await procA.drain(async () => {
    // Another pi process queues a capture while A is mid-send; A then gets rate limited.
    await procB.enqueue(entryInput("queued-by-B"));
    throw new RemnicHttpError(429, "write_rate_limited", "write_rate_limited");
  }, { maxAttempts: 1, jitterRatio: 0, sleep: async () => undefined });
  assert.deepEqual(readContents(file).sort(), ["first", "queued-by-B"]);

  const done = await procA.drain(async () => undefined, { jitterRatio: 0, sleep: async () => undefined });
  assert.equal(done.delivered, 2, "A sees B's entry and delivers it too");
  assert.equal(readContents(file).length, 0);
});

test("classifyObserveFailure keeps rate limits and gateway errors, parks auth, drops semantic rejections", () => {
  const cls = (status: number) => classifyObserveFailure(new RemnicHttpError(status, "x", "x"));
  assert.equal(cls(429), "retry-capacity");
  assert.equal(cls(503), "retry-capacity");
  assert.equal(cls(408), "retry-capacity");
  assert.equal(cls(502), "retry-capacity");
  assert.equal(cls(504), "retry-capacity");
  assert.equal(cls(401), "blocked");
  assert.equal(cls(403), "blocked");
  assert.equal(cls(400), "permanent");
  assert.equal(cls(409), "permanent");
});

test("backoff is clamped to maxRetryAfterMs even after jitter", async () => {
  const outbox = new ObserveOutbox(tmpOutboxPath("clamp"));
  await outbox.enqueue(entryInput("kept"));
  const slept: number[] = [];
  const realRandom = Math.random;
  Math.random = () => 0.999999; // worst-case jitter: +jitterRatio
  try {
    await outbox.drain(async () => {
      throw new RemnicHttpError(503, "busy", "buffer_admission_refused", 60_000);
    }, { maxAttempts: 2, maxRetryAfterMs: 1000, jitterRatio: 0.2, sleep: async (ms) => { slept.push(ms); } });
  } finally {
    Math.random = realRandom;
  }
  assert.ok(slept.length > 0, "a backoff happened");
  assert.ok(slept.every((ms) => ms <= 1000), `sleeps stay within the 1000 ms cap (got ${slept.join(", ")})`);
});

test("a non-finite jitterRatio still produces finite, capped sleeps", async () => {
  const outbox = new ObserveOutbox(tmpOutboxPath("nan-jitter"));
  await outbox.enqueue(entryInput("kept"));
  const slept: number[] = [];
  await outbox.drain(async () => {
    throw new RemnicHttpError(503, "busy", "buffer_admission_refused");
  }, { maxAttempts: 3, backoffBaseMs: 100, maxRetryAfterMs: 1000, jitterRatio: Number.NaN, sleep: async (ms) => { slept.push(ms); } });
  assert.ok(slept.length > 0, "a backoff happened");
  assert.ok(slept.every((ms) => Number.isFinite(ms) && ms > 0 && ms <= 1000), `sleeps are finite and capped (got ${slept.join(", ")})`);
});

test("a drain that finds another drain running reports skipped so callers do not warn about saturation", async () => {
  const outbox = new ObserveOutbox(tmpOutboxPath("skipped"));
  await outbox.enqueue(entryInput("held"));
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const first = outbox.drain(async () => {
    entered.resolve();
    await release.promise;
  }, { sleep: async () => undefined });
  await entered.promise;
  const second = await outbox.drain(async () => undefined, { sleep: async () => undefined });
  release.resolve();
  const done = await first;
  assert.equal(second.skipped, true, "the concurrent call did no work");
  assert.equal(second.pending, 1, "and still reports what is queued");
  assert.equal(done.delivered, 1);
  assert.equal(done.skipped, undefined, "the real drain is not marked skipped");
});

test("every eviction warns with the count of captures dropped, not just the first", async () => {
  const outbox = new ObserveOutbox(tmpOutboxPath("evict-each"), { maxEntries: 2 });
  const warnings: string[] = [];
  const notify = (message: string, level: "info" | "warning" | "error") => {
    if (level === "warning") warnings.push(message);
  };
  for (const c of ["a", "b", "c", "d", "e"]) await outbox.enqueue(entryInput(c), notify);
  assert.equal(warnings.length, 3, "one warning for each of the three evictions");
  for (const warning of warnings) {
    assert.match(warning, /dropped 1 oldest queued capture\(s\)/);
    assert.match(warning, /2-entry bound/);
  }
});

test("a dropped 4xx capture is logged with its HTTP status and replay key", async () => {
  const outbox = new ObserveOutbox(tmpOutboxPath("drop-4xx"));
  await outbox.enqueue({ ...entryInput("rejected"), replayNonce: "nonce-for-rejected" });
  const notifications: string[] = [];
  const result = await outbox.drain(async () => {
    throw new RemnicHttpError(422, "unprocessable", "invalid_request");
  }, { notify: (message) => notifications.push(message), sleep: async () => undefined });
  assert.equal(result.dropped, 1, "a retry cannot fix a 4xx, so it is still dropped");
  assert.equal(notifications.length, 1);
  assert.match(notifications[0], /HTTP 422/, "the status is in the log line");
  assert.match(notifications[0], /nonce-for-rejected/, "and so is the key that identifies the capture");
});

test("an unreadable existing outbox fails the write instead of being treated as empty (#3381)", async () => {
  const file = tmpOutboxPath("unreadable");
  const first = new ObserveOutbox(file);
  await first.enqueue(entryInput("kept"));
  fs.chmodSync(file, 0o000);
  try {
    const second = new ObserveOutbox(file);
    await assert.rejects(() => second.enqueue(entryInput("would-overwrite")));
  } finally {
    fs.chmodSync(file, 0o600);
  }
  const lines = fs.readFileSync(file, "utf8").split("\n").filter((line) => line.trim().length > 0);
  assert.equal(lines.length, 1, "the queued capture is still on disk");
  assert.ok(lines[0].includes("kept"));
});

test("read-only views of an unreadable outbox keep the last known entries instead of throwing", async () => {
  const file = tmpOutboxPath("unreadable-views");
  const outbox = new ObserveOutbox(file);
  await outbox.enqueue(entryInput("known"));
  assert.equal(await outbox.size(), 1);
  fs.chmodSync(file, 0o000);
  try {
    // Force a re-read by changing the signature through another writer is not possible while the
    // file is unreadable, so the cached view is what the live hook sees.
    assert.equal(await outbox.size(), 1);
    assert.deepEqual([...(await outbox.pendingHashes())], ["hash-known"]);
  } finally {
    fs.chmodSync(file, 0o600);
  }
});

test("two drains started back to back on one instance send the head entry once (#3381)", async () => {
  const outbox = new ObserveOutbox(tmpOutboxPath("drain-race"));
  await outbox.enqueue(entryInput("head"));
  let sends = 0;
  const send = async () => {
    sends += 1;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  };
  const [a, b] = await Promise.all([
    outbox.drain(send, { sleep: async () => undefined }),
    outbox.drain(send, { sleep: async () => undefined }),
  ]);
  assert.equal(sends, 1, "the second drain must not start while the first is reading");
  assert.equal([a, b].filter((r) => r.skipped).length, 1, "exactly one drain was skipped");
});
