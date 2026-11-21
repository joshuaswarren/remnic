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

test("outbox spills overflow to disk and replays it before the hot queue after restart", async () => {
  const filePath = tmpOutboxPath("spill-order");
  const outbox = new ObserveOutbox(filePath, { maxEntries: 2 });
  const notifications: Array<{ message: string; level: string }> = [];
  const notify = (message: string, level: "info" | "warning" | "error") => notifications.push({ message, level });

  await outbox.enqueue(entryInput("one"), notify);
  await outbox.enqueue(entryInput("two"), notify);
  await outbox.enqueue(entryInput("three"), notify);

  assert.equal(await outbox.size(), 3, "overflow remains accepted and queued");
  assert.deepEqual([...await outbox.pendingHashes()], ["hash-one", "hash-two", "hash-three"]);
  assert.deepEqual(readContents(filePath), ["two", "three"], "the hot file stays within its configured bound");
  assert.deepEqual(readSpilledContents(filePath), ["one"], "the oldest capture is disk-backed");
  assert.equal(fs.statSync(`${filePath}.spill`).mode & 0o777, 0o700, "the spill directory stays private");
  assert.equal(fs.statSync(spillSegments(filePath)[0]).mode & 0o777, 0o600, "spill contents stay private");
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].message, /spilled 1 oldest queued capture/);
  assert.equal(notifications[0].level, "info");

  const restarted = new ObserveOutbox(filePath, { maxEntries: 2 });
  const delivered: string[] = [];
  const result = await restarted.drain(async (entry) => { delivered.push(entry.messages[0].content); });
  assert.deepEqual(delivered, ["one", "two", "three"], "restart preserves FIFO across spill and hot files");
  assert.deepEqual(result, { delivered: 3, dropped: 0, pending: 0 });
});

test("legacy outbox files load and remain ordered when another writer spills", async () => {
  const filePath = tmpOutboxPath("spill-legacy");
  fs.writeFileSync(filePath, entryLine("legacy"));
  const writerA = new ObserveOutbox(filePath, { maxEntries: 2 });
  const writerB = new ObserveOutbox(filePath, { maxEntries: 2 });
  await writerB.pendingHashes();
  await writerA.enqueue(entryInput("second"));
  await writerB.enqueue(entryInput("third"));

  const restarted = new ObserveOutbox(filePath, { maxEntries: 2 });
  const delivered: string[] = [];
  await restarted.drain(async (entry) => { delivered.push(entry.messages[0].content); });
  assert.deepEqual(delivered, ["legacy", "second", "third"]);
});

test("ambiguous failures remain durable after repeated timeouts and survive restart", async () => {
  const filePath = tmpOutboxPath("keep-ambiguous");
  const outbox = new ObserveOutbox(filePath, { maxEntries: 1 });
  await outbox.enqueue(entryInput("unresolved"));
  await outbox.enqueue(entryInput("later"));
  const first = await outbox.drain(async () => {
    throw new RemnicRequestTimeoutError(1000);
  }, { maxAttempts: 8, jitterRatio: 0, sleep: async () => undefined });

  assert.equal(first.pending, 2, "eight ambiguous failures do not discard accepted captures");
  assert.deepEqual(readSpilledContents(filePath), ["unresolved"], "overflow remains disk-backed");
  const restarted = new ObserveOutbox(filePath, { maxEntries: 1 });
  assert.equal(await restarted.size(), 2, "both captures remain after restart");
  const delivered: string[] = [];
  const second = await restarted.drain(async (entry) => { delivered.push(entry.messages[0].content); });
  assert.deepEqual(delivered, ["unresolved", "later"], "FIFO retry proceeds after restart");
  assert.equal(second.pending, 0);
});

test("a crash between spill and hot-file rewrites does not duplicate or lose a capture", async () => {
  const filePath = tmpOutboxPath("spill-shadow");
  const outbox = new ObserveOutbox(filePath, { maxEntries: 1 });
  await outbox.enqueue(entryInput("old"));
  await outbox.enqueue(entryInput("new"));

  const oldLine = fs.readFileSync(spillSegments(filePath)[0], "utf8").trim();
  fs.writeFileSync(filePath, `${oldLine}\n${fs.readFileSync(filePath, "utf8")}`);
  const recovered = new ObserveOutbox(filePath, { maxEntries: 1 });
  assert.equal(await recovered.size(), 2, "the spill copy wins over the crash-window shadow");
  const delivered: string[] = [];
  await recovered.drain(async (entry) => { delivered.push(entry.messages[0].content); });
  assert.deepEqual(delivered, ["old", "new"]);
  assert.equal(await recovered.size(), 0);
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

test("permanent rejection stays queued, reports the cause, and preserves FIFO", async () => {
  const outbox = new ObserveOutbox(tmpOutboxPath("permanent"));
  await outbox.enqueue(entryInput("bad-1", "hash-bad-1"));
  await outbox.enqueue(entryInput("good"));
  const notifications: Array<{ message: string; level: string }> = [];
  const delivered: string[] = [];
  let sleeps = 0;
  const result = await outbox.drain(
    async (entry) => {
      if (entry.messages[0].content === "bad-1") throw new RemnicHttpError(400, "bad request", "invalid_request");
      delivered.push(entry.messages[0].content);
    },
    {
      sleep: async () => {
        sleeps += 1;
      },
      notify: (message, level) => notifications.push({ message, level }),
    }
  );

  assert.deepEqual(delivered, []);
  assert.deepEqual(result, { delivered: 0, dropped: 0, pending: 2 });
  assert.equal(sleeps, 0, "permanent failures are not retried inside this drain");
  assert.equal(await outbox.size(), 2, "the capture stays available for a later retry");
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].message, /remains queued for retry/);
  assert.equal(notifications[0].level, "warning");
});

test("a permanently refused capture does not block later captures from other sessions (#3520)", async () => {
  const outbox = new ObserveOutbox(tmpOutboxPath("refused-other-session"));
  await outbox.enqueue(entryInput("refused", "hash-refused"));
  await outbox.enqueue({ ...entryInput("later"), sessionKey: "sess-2" });
  const delivered: string[] = [];
  const result = await outbox.drain(
    async (entry) => {
      if (entry.messages[0].content === "refused") throw new RemnicHttpError(400, "bad request", "invalid_request");
      delivered.push(entry.messages[0].content);
    },
    { sleep: async () => {} }
  );

  assert.deepEqual(delivered, ["later"], "the later capture from another session is delivered");
  assert.equal(result.delivered, 1);
  assert.equal(await outbox.size(), 1, "the refused capture stays queued for retry after the cause is fixed");
});

test("a permanently refused spill entry does not block later hot captures from other sessions (#3520)", async () => {
  const outbox = new ObserveOutbox(tmpOutboxPath("refused-spill-session"), { maxEntries: 1 });
  await outbox.enqueue(entryInput("refused", "hash-refused"));
  await outbox.enqueue({ ...entryInput("later"), sessionKey: "sess-2" });
  const delivered: string[] = [];
  const result = await outbox.drain(
    async (entry) => {
      if (entry.messages[0].content === "refused") throw new RemnicHttpError(400, "bad request", "invalid_request");
      delivered.push(entry.messages[0].content);
    },
    { sleep: async () => {} }
  );

  assert.deepEqual(delivered, ["later"], "the later hot-file capture from another session is delivered past the refused spill head");
  assert.equal(result.delivered, 1);
  assert.equal(await outbox.size(), 1, "the refused spill entry stays queued");
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
  // #3381: an unrecognized 5xx is ambiguous, not a verdict on the payload.
  assert.equal(
    classifyObserveFailure(new RemnicHttpError(500, "storage target missing", "storage_target_missing")),
    "retry-ambiguous"
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

function spillSegments(filePath: string): string[] {
  return fs
    .readdirSync(`${filePath}.spill`)
    .filter((name) => /^segment-\d{20}\.jsonl$/.test(name))
    .sort()
    .map((name) => path.join(`${filePath}.spill`, name));
}

function readSpilledContents(filePath: string): string[] {
  return spillSegments(filePath).flatMap(readContents);
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
  const writers = Array.from({ length: 12 }, () => new ObserveOutbox(file, { maxEntries: 2 }));
  await Promise.all(writers.map((writer, i) => writer.enqueue(entryInput(`w${i}`))));
  const expected = Array.from({ length: 12 }, (_, i) => `w${i}`).sort();
  const persisted = [...readSpilledContents(file), ...readContents(file)];
  assert.deepEqual([...persisted].sort(), expected, "every concurrent writer survives spill");
  const replayed: string[] = [];
  await new ObserveOutbox(file, { maxEntries: 2 }).drain(async (entry) => { replayed.push(entry.messages[0].content); });
  assert.deepEqual(replayed, persisted, "restart replays concurrent writes in persisted FIFO order");
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

test("classifyObserveFailure keeps rate limits and gateway errors, keeps auth queued, and retains semantic rejections", () => {
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

test("overflow spills captures instead of evicting them", async () => {
  const filePath = tmpOutboxPath("spill-each");
  const outbox = new ObserveOutbox(filePath, { maxEntries: 2 });
  const notices: string[] = [];
  const notify = (message: string) => notices.push(message);
  for (const c of ["a", "b", "c", "d", "e"]) await outbox.enqueue(entryInput(c), notify);
  assert.equal(await outbox.size(), 5, "all accepted captures remain queued");
  assert.deepEqual(readSpilledContents(filePath), ["a", "b", "c"], "overflow is stored in FIFO order");
  assert.equal(spillSegments(filePath).length, 2, "spill storage uses bounded-size segments");
  assert.equal(notices.length, 3, "each spill operation is surfaced");
  for (const notice of notices) {
    assert.match(notice, /spilled 1 oldest queued capture\(s\)/);
    assert.match(notice, /2-entry in-memory bound/);
  }
});

test("a read-side refresh cannot replace entries during a spill mutation", async () => {
  const filePath = tmpOutboxPath("refresh-spill-race");
  const outbox = new ObserveOutbox(filePath, { maxEntries: 2 });
  await outbox.enqueue(entryInput("a"));
  await outbox.enqueue(entryInput("b"));
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const originalAppendSpill = outbox["appendSpill"].bind(outbox);
  outbox["appendSpill"] = async (entries) => {
    await originalAppendSpill(entries);
    entered.resolve();
    await release.promise;
  };

  const enqueue = outbox.enqueue(entryInput("c"));
  await entered.promise;
  let sizeFinished = false;
  const size = outbox.size().then((value) => {
    sizeFinished = true;
    return value;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(sizeFinished, false, "read refresh waits for the in-flight mutation");
  release.resolve();
  await enqueue;
  assert.equal(await size, 3);
  assert.deepEqual(readSpilledContents(filePath), ["a"]);
  assert.deepEqual(readContents(filePath), ["b", "c"]);
});

test("bounded drains stop after one successful send while ordinary drains stay unbounded", async () => {
  const filePath = tmpOutboxPath("bounded-send-count");
  const outbox = new ObserveOutbox(filePath, { maxEntries: 1 });
  for (const value of ["a", "b", "c"]) await outbox.enqueue(entryInput(value));
  const boundedSent: string[] = [];
  const bounded = await outbox.drain(async (entry) => {
    boundedSent.push(entry.messages[0].content);
  }, { maxSends: 1, sleep: async () => undefined });
  assert.deepEqual(boundedSent, ["a"]);
  assert.equal(bounded.delivered, 1);
  assert.equal(await outbox.size(), 2, "unsent entries remain durable");

  const backgroundSent: string[] = [];
  const background = await outbox.drain(async (entry) => {
    backgroundSent.push(entry.messages[0].content);
  }, { sleep: async () => undefined });
  assert.deepEqual(backgroundSent, ["b", "c"]);
  assert.equal(background.delivered, 2);
  assert.equal(await outbox.size(), 0);
});

test("the default 200-entry hot queue spills additional captures to bounded disk segments", async () => {
  const filePath = tmpOutboxPath("default-spill-bound");
  const outbox = new ObserveOutbox(filePath);
  for (let i = 0; i < 205; i += 1) await outbox.enqueue(entryInput(`capture-${i}`));

  assert.equal(await outbox.size(), 205);
  assert.equal(readContents(filePath).length, 200, "only the configured hot capacity stays in memory");
  assert.deepEqual(readSpilledContents(filePath), Array.from({ length: 5 }, (_, i) => `capture-${i}`));
  assert.deepEqual(spillSegments(filePath).map((file) => readContents(file).length), [5]);
});

test("a spill storage failure rejects enqueue without replacing the existing hot queue", async () => {
  const filePath = tmpOutboxPath("spill-failure");
  const outbox = new ObserveOutbox(filePath, { maxEntries: 1 });
  await outbox.enqueue(entryInput("kept"));
  fs.writeFileSync(`${filePath}.spill`, "not a directory");

  await assert.rejects(() => outbox.enqueue(entryInput("not-accepted")));
  assert.deepEqual(readContents(filePath), ["kept"], "the prior durable queue is unchanged");
  assert.equal(await outbox.size(), 1, "read-only status keeps the last known queue");
});

test("a permanent 4xx stays queued with its HTTP status and replay key", async () => {
  const filePath = tmpOutboxPath("keep-4xx");
  const outbox = new ObserveOutbox(filePath);
  await outbox.enqueue({ ...entryInput("rejected"), replayNonce: "nonce-for-rejected" });
  const notifications: string[] = [];
  const result = await outbox.drain(async () => {
    throw new RemnicHttpError(422, "unprocessable", "invalid_request");
  }, { notify: (message) => notifications.push(message), sleep: async () => undefined });
  assert.equal(result.dropped, 0);
  assert.equal(result.pending, 1, "permanent rejections remain available for retry");
  assert.equal(notifications.length, 1);
  assert.match(notifications[0], /HTTP 422/, "the status is in the log line");
  assert.match(notifications[0], /nonce-for-rejected/, "and so is the key that identifies the capture");
  assert.match(notifications[0], /remains queued for retry/);
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

test("#3381: queued captures stay private: file 0600 and a created directory 0700", async () => {
  const filePath = tmpOutboxPath("private");
  const nested = path.join(path.dirname(filePath), "remnic", path.basename(filePath));
  const outbox = new ObserveOutbox(nested);
  await outbox.enqueue(entryInput("secret"));

  // Entries carry rawContent of tool results - private to the owner's account.
  assert.equal(fs.statSync(nested).mode & 0o777, 0o600, "the queue file must not be group/world readable");
  assert.equal(fs.statSync(path.dirname(nested)).mode & 0o777, 0o700, "a directory the outbox creates is private");
});

test("#3381: a looser file is tightened on write; a pre-existing directory keeps its mode", async () => {
  const filePath = tmpOutboxPath("tighten");
  fs.chmodSync(path.dirname(filePath), 0o755);
  fs.writeFileSync(filePath, entryLine("old"), { mode: 0o644 });
  const outbox = new ObserveOutbox(filePath);
  await outbox.enqueue(entryInput("new"));

  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600, "the rewritten queue file is owner-only");
  // observeOutboxPath may point into a shared directory; the outbox must not
  // chmod a parent it did not create (Codex P2 on #3503).
  assert.equal(fs.statSync(path.dirname(filePath)).mode & 0o777, 0o755, "a directory the outbox did not create is left alone");
});

test("repeated 500 responses never discard a queued capture", async () => {
  assert.equal(classifyObserveFailure(new RemnicHttpError(500, "internal_error", "internal_error")), "retry-ambiguous");
  assert.equal(classifyObserveFailure(new RemnicHttpError(599, "x", "x")), "retry-ambiguous");
  assert.equal(classifyObserveFailure(new RemnicHttpError(400, "x", "x")), "permanent");

  const outbox = new ObserveOutbox(tmpOutboxPath("five-hundred"));
  await outbox.enqueue(entryInput("server-erroring"));
  const fail = async () => {
    throw new RemnicHttpError(500, "internal_error", "internal_error");
  };
  for (let run = 0; run < 3; run += 1) {
    const result = await outbox.drain(fail, { sleep: async () => undefined });
    assert.equal(result.dropped, 0);
    assert.equal(result.pending, 1, "repeated ambiguous failures keep the capture queued");
    assert.equal(await outbox.size(), 1);
  }
});

test("a drain only sends entries queued for its own daemon and leaves the rest for their destination", async () => {
  // #3381 item 6: the outbox file is shared per machine; a pane repointed at a
  // second daemon must not replay the first daemon's conversations to it.
  const filePath = tmpOutboxPath("destination");
  const outbox = new ObserveOutbox(filePath);
  await outbox.enqueue({ ...entryInput("foreign-capture"), destination: "http://daemon-a:4318" });
  await outbox.enqueue({ ...entryInput("own-capture"), destination: "http://daemon-b:4318" });
  await outbox.enqueue(entryInput("legacy-capture")); // no destination: written before the field existed

  const sent: string[] = [];
  const result = await outbox.drain(
    async (entry) => {
      sent.push(entry.messages[0].content);
    },
    { destination: "http://daemon-b:4318" }
  );
  assert.deepEqual(sent, ["own-capture", "legacy-capture"], "foreign entries are never sent to a different daemon");
  assert.equal(result.foreign, 1);
  const left = fs.readFileSync(filePath, "utf8");
  assert.ok(left.includes("foreign-capture"), "the foreign entry stays queued for its own daemon");
  assert.ok(!left.includes("own-capture"));
});

test("a drain with no destination delivers every queued entry, including bound ones", async () => {
  // The DrainOptions contract: omitting destination makes every entry
  // eligible, same as before the field existed (coderabbit on #3504).
  const filePath = tmpOutboxPath("destination-omitted");
  const outbox = new ObserveOutbox(filePath);
  await outbox.enqueue({ ...entryInput("bound-capture"), destination: "http://daemon-a:4318" });
  await outbox.enqueue(entryInput("legacy-capture"));

  const sent: string[] = [];
  const result = await outbox.drain(async (entry) => {
    sent.push(entry.messages[0].content);
  });
  assert.deepEqual(sent, ["bound-capture", "legacy-capture"], "an omitted destination makes every entry eligible");
  assert.equal(result.foreign ?? 0, 0, "nothing is foreign to a drain that accepts every destination");
  assert.equal(result.pending, 0);
});

test("enqueue bounds a large rawContent so the durable replay stays small but keeps its identity", async () => {
  // #3381 item 11: rawContent is the original Pi message and can be megabytes;
  // a 200-entry bound is not a byte bound, so the persisted representation is
  // bounded while the replay identity (hashes + nonce) survives.
  const filePath = tmpOutboxPath("bounded");
  const outbox = new ObserveOutbox(filePath);
  const notifications: string[] = [];
  const bigRaw = { tool: "read", output: "x".repeat(512 * 1024) };
  await outbox.enqueue(
    {
      sessionKey: "sess-1",
      cwd: "/tmp/work",
      messages: [{ role: "user", content: "a turn with a huge tool result", rawContent: bigRaw }],
      messageHashes: ["hash-big"],
    },
    (message) => notifications.push(message)
  );
  // SAFETY: this test's drain wrote the entry itself, so the file holds { messages, messageHashes }; the assertions below verify the shape.
  const persisted = JSON.parse(fs.readFileSync(filePath, "utf8").trim()) as { messages: ObserveMessage[]; messageHashes: string[] };
  assert.equal(persisted.messageHashes[0], "hash-big", "the replay identity is preserved");
  assert.equal(persisted.messages[0].content, "a turn with a huge tool result", "the rendered text still replays");
  assert.ok(fs.statSync(filePath).size < 64 * 1024, `the persisted entry is bounded (got ${fs.statSync(filePath).size} bytes)`);
  assert.ok(notifications.some((m) => /bounded|omitted|too large/i.test(m)), "the bound is surfaced, not silent");
});

test("pendingHashes only suppresses captures a drain on this destination would deliver", async () => {
  // #3504 CodeRabbit: switching daemon URLs with a foreign entry queued must not
  // suppress the new live capture — that entry is never delivered to this daemon.
  const outbox = new ObserveOutbox(tmpOutboxPath("pending-dest"));
  await outbox.enqueue({ ...entryInput("foreign-capture"), destination: "http://daemon-a:4318" });
  await outbox.enqueue({ ...entryInput("own-capture"), destination: "http://daemon-b:4318" });
  await outbox.enqueue(entryInput("legacy-capture"));

  const forB = await outbox.pendingHashes("http://daemon-b:4318");
  assert.deepEqual([...forB].sort(), ["hash-legacy-capture", "hash-own-capture"], "own + unbound entries suppress; foreign do not");
  assert.equal((await outbox.pendingHashes()).size, 3, "no destination = general drainer: every queued capture suppresses");
});

function spillSegmentLine(id: string, content: string): string {
  return `${JSON.stringify({ id, queuedAt: "2026-01-01T00:00:00.000Z", ...entryInput(content) })}\n`;
}

test("a symlinked spill directory is rejected entirely", async () => {
  const filePath = tmpOutboxPath("symlink-root");
  const external = fs.mkdtempSync(path.join(path.dirname(filePath), "external-"));
  fs.symlinkSync(external, `${filePath}.spill`, "dir");

  const outbox = new ObserveOutbox(filePath, { maxEntries: 1 });
  await outbox.enqueue(entryInput("first"));
  await assert.rejects(
    () => outbox.enqueue(entryInput("second")),
    /symlink/,
    "appendSpill refuses a symlinked spill root instead of following it"
  );
  assert.deepEqual(fs.readdirSync(external), [], "the external target was never written into");
  assert.equal((await outbox.pendingHashes()).size, 1, "reads ignore the symlinked spill root");
});

test("a symlinked spill segment is ignored, never followed", async () => {
  const filePath = tmpOutboxPath("symlink-segment");
  const spillDir = `${filePath}.spill`;
  fs.mkdirSync(spillDir, { mode: 0o700 });
  fs.writeFileSync(path.join(spillDir, "segment-00000000000000000000.jsonl"), spillSegmentLine("id-real", "real"));
  const externalFile = path.join(fs.mkdtempSync(path.join(path.dirname(filePath), "external-")), "segment-00000000000000000001.jsonl");
  fs.writeFileSync(externalFile, spillSegmentLine("id-external", "external"));
  fs.symlinkSync(externalFile, path.join(spillDir, "segment-00000000000000000001.jsonl"));

  const outbox = new ObserveOutbox(filePath);
  const hashes = await outbox.pendingHashes();
  assert.deepEqual([...hashes], ["hash-real"], "only the regular segment contributes hashes");
  assert.equal(fs.readFileSync(externalFile, "utf8").includes("id-external"), true, "the external file is untouched");
  assert.equal(await outbox.size(), 1);
});

test("appendSpill never chmods through a symlinked spill root", async () => {
  const filePath = tmpOutboxPath("symlink-chmod");
  const external = fs.mkdtempSync(path.join(path.dirname(filePath), "external-"));
  fs.chmodSync(external, 0o755);
  fs.symlinkSync(external, `${filePath}.spill`, "dir");

  const outbox = new ObserveOutbox(filePath, { maxEntries: 1 });
  await outbox.enqueue(entryInput("first"));
  await assert.rejects(() => outbox.enqueue(entryInput("second")), /symlink/);
  assert.equal(fs.statSync(external).mode & 0o777, 0o755, "chmod never touched the external directory's mode");
});

test("pendingHashes returns one consistent state while an enqueue interleaves", async () => {
  const filePath = tmpOutboxPath("pending-chain");
  const outbox = new ObserveOutbox(filePath, { maxEntries: 1 });
  await outbox.enqueue(entryInput("first"));

  // Hold the spill scan mid-flight so the concurrent enqueue can only land
  // after the snapshot, never partway through it.
  const gate = Promise.withResolvers<void>();
  let gated = false;
  const realSpillFiles = outbox["spillFiles"].bind(outbox);
  // SAFETY: test seam into the private scanner; the real lister runs after the gate.
  outbox["spillFiles"] = async () => {
    if (!gated) {
      gated = true;
      await gate.promise;
    }
    return realSpillFiles();
  };

  const snapshot = outbox.pendingHashes();
  const enqueued = outbox.enqueue(entryInput("second"));
  gate.resolve();
  await Promise.all([snapshot, enqueued]);

  const hashes = await snapshot;
  assert.deepEqual([...hashes], ["hash-first"], "the snapshot is the pre-enqueue state, never a torn read");
  assert.deepEqual([...(await outbox.pendingHashes())].sort(), ["hash-first", "hash-second"], "the next read sees both");
});

test("pendingHashes still resolves when the spill scan fails, and the chain keeps working", async () => {
  const filePath = tmpOutboxPath("pending-fail");
  const outbox = new ObserveOutbox(filePath, { maxEntries: 1 });
  await outbox.enqueue(entryInput("first"));

  const realSpillFiles = outbox["spillFiles"].bind(outbox);
  let failing = true;
  outbox["spillFiles"] = async () => {
    if (failing) throw new Error("spill scan exploded");
    return realSpillFiles();
  };

  const hashes = await outbox.pendingHashes();
  assert.deepEqual([...hashes], ["hash-first"], "hot entries survive a failed spill scan");
  failing = false;
  await outbox.enqueue(entryInput("second"));
  assert.deepEqual([...(await outbox.pendingHashes())].sort(), ["hash-first", "hash-second"], "the operation chain stays usable");
});
