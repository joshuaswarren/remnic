/**
 * Tests for buffer-surprise telemetry (issue #563 PR 3).
 *
 * Covers two concerns:
 *
 *  1. SmartBuffer emits one `BUFFER_SURPRISE` row per scored turn and
 *     NEVER emits when the probe was not consulted (flag off, non-smart
 *     trigger mode, high signal, or decision was not `keep_buffering`).
 *     Probe returning `null`, throwing, or producing a non-finite score
 *     must NOT write a row.
 *
 *  2. `reportBufferSurpriseDistribution` produces stable summary stats
 *     over the recent window — mean, median, p90, triggered rate — and
 *     returns the empty-distribution shape when no rows are available.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { SmartBuffer, type BufferSurpriseProbe } from "./buffer.js";
import { parseConfig } from "./config.js";
import { reportBufferSurpriseDistribution } from "./buffer-surprise-report.js";
import type {
  BufferState,
  BufferSurpriseEvent,
  BufferTurn,
} from "./types.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

class RecordingStorage {
  public saved: BufferState | null = null;
  public events: BufferSurpriseEvent[] = [];

  constructor(private readonly initial: BufferState) {}

  async loadBuffer(): Promise<BufferState> {
    return structuredClone(this.initial);
  }

  async saveBuffer(state: BufferState): Promise<void> {
    this.saved = structuredClone(state);
  }

  async appendBufferSurpriseEvents(events: BufferSurpriseEvent[]): Promise<number> {
    this.events.push(...events);
    return events.length;
  }
}

function makeTurn(sessionKey: string, content: string): BufferTurn {
  return {
    role: "user",
    content,
    timestamp: "2026-04-20T12:00:00.000Z",
    sessionKey,
  };
}

function emptyBuffer(): BufferState {
  return { turns: [], lastExtractionAt: null, extractionCount: 0 };
}

function fixedScoreProbe(score: number | null): BufferSurpriseProbe {
  return {
    async scoreTurn() {
      return score;
    },
  };
}

// ---------------------------------------------------------------------------
// SmartBuffer emission
// ---------------------------------------------------------------------------

test("emits one BUFFER_SURPRISE row per scored turn (triggering)", async () => {
  const storage = new RecordingStorage(emptyBuffer());
  const config = parseConfig({
    bufferSurpriseTriggerEnabled: true,
    bufferSurpriseThreshold: 0.35,
    bufferMaxTurns: 5,
    triggerMode: "smart",
  });
  const buffer = new SmartBuffer(config, storage as any, fixedScoreProbe(0.9));

  await buffer.addTurn("sess-1", makeTurn("sess-1", "novel"));
  await buffer.flushSurpriseTelemetry();

  assert.equal(storage.events.length, 1);
  const row = storage.events[0]!;
  assert.equal(row.event, "BUFFER_SURPRISE");
  assert.equal(row.triggeredFlush, true);
  assert.equal(row.surpriseScore, 0.9);
  assert.equal(row.threshold, 0.35);
  assert.equal(row.turnRole, "user");
  assert.equal(row.bufferKey, "sess-1");
  assert.equal(row.sessionKey, "sess-1");
  assert.equal(row.turnCountInWindow, 1);
  assert.ok(
    typeof row.timestamp === "string" && row.timestamp.length > 0,
    "timestamp must be a non-empty ISO string",
  );
});

test("emits BUFFER_SURPRISE row for non-triggering turns too", async () => {
  // The whole point of telemetry is tuning the threshold from real
  // distributions, so below-threshold scores must also be recorded.
  const storage = new RecordingStorage(emptyBuffer());
  const config = parseConfig({
    bufferSurpriseTriggerEnabled: true,
    bufferSurpriseThreshold: 0.35,
    bufferMaxTurns: 5,
    triggerMode: "smart",
  });
  const buffer = new SmartBuffer(config, storage as any, fixedScoreProbe(0.1));

  await buffer.addTurn("sess-1", makeTurn("sess-1", "routine"));
  await buffer.flushSurpriseTelemetry();

  assert.equal(storage.events.length, 1);
  assert.equal(storage.events[0]!.triggeredFlush, false);
  assert.equal(storage.events[0]!.surpriseScore, 0.1);
});

test("does NOT emit when flag is off", async () => {
  const storage = new RecordingStorage(emptyBuffer());
  const config = parseConfig({
    bufferSurpriseTriggerEnabled: false,
    triggerMode: "smart",
  });
  const buffer = new SmartBuffer(config, storage as any, fixedScoreProbe(0.9));

  await buffer.addTurn("sess-1", makeTurn("sess-1", "anything"));
  assert.equal(storage.events.length, 0);
});

test("does NOT emit when probe returns null", async () => {
  const storage = new RecordingStorage(emptyBuffer());
  const config = parseConfig({
    bufferSurpriseTriggerEnabled: true,
    triggerMode: "smart",
  });
  const buffer = new SmartBuffer(config, storage as any, fixedScoreProbe(null));

  await buffer.addTurn("sess-1", makeTurn("sess-1", "anything"));
  assert.equal(storage.events.length, 0);
});

test("does NOT emit when probe throws", async () => {
  const storage = new RecordingStorage(emptyBuffer());
  const config = parseConfig({
    bufferSurpriseTriggerEnabled: true,
    triggerMode: "smart",
  });
  const probe: BufferSurpriseProbe = {
    async scoreTurn() {
      throw new Error("embedder down");
    },
  };
  const buffer = new SmartBuffer(config, storage as any, probe);

  await buffer.addTurn("sess-1", makeTurn("sess-1", "anything"));
  assert.equal(storage.events.length, 0);
});

test("does NOT emit when probe returns NaN", async () => {
  const storage = new RecordingStorage(emptyBuffer());
  const config = parseConfig({
    bufferSurpriseTriggerEnabled: true,
    triggerMode: "smart",
  });
  const buffer = new SmartBuffer(
    config,
    storage as any,
    fixedScoreProbe(Number.NaN),
  );

  await buffer.addTurn("sess-1", makeTurn("sess-1", "anything"));
  assert.equal(storage.events.length, 0);
});

test("does NOT emit when high-signal path already flushes", async () => {
  // High-signal decisions short-circuit before the probe is consulted,
  // so no row must be recorded for them.
  const storage = new RecordingStorage(emptyBuffer());
  const config = parseConfig({
    bufferSurpriseTriggerEnabled: true,
    triggerMode: "smart",
    highSignalPatterns: ["\\bURGENT\\b"],
  });
  const buffer = new SmartBuffer(config, storage as any, fixedScoreProbe(0.9));

  await buffer.addTurn("sess-1", makeTurn("sess-1", "URGENT heads up"));
  assert.equal(storage.events.length, 0);
});

test("does NOT emit when turn-count path already flushes (extract_batch)", async () => {
  // Additive invariant: existing batch flush does not consult the probe.
  const storage = new RecordingStorage(emptyBuffer());
  const config = parseConfig({
    bufferSurpriseTriggerEnabled: true,
    bufferMaxTurns: 2,
    triggerMode: "smart",
  });
  const buffer = new SmartBuffer(config, storage as any, fixedScoreProbe(0.9));

  await buffer.addTurn("sess-1", makeTurn("sess-1", "first"));
  await buffer.flushSurpriseTelemetry();
  // first turn WAS scored (decision was keep_buffering)
  assert.equal(storage.events.length, 1);

  const before = storage.events.length;
  await buffer.addTurn("sess-1", makeTurn("sess-1", "second"));
  await buffer.flushSurpriseTelemetry();
  // second turn flushes via turn-count; probe is not consulted → no new row.
  assert.equal(storage.events.length, before);
});

test("telemetry writes are serialized in wall-clock order under variable latency", async () => {
  // Reviewer concern: fire-and-forget appends could settle out of
  // order on slow filesystems. Simulate this with a storage double
  // whose append latency decreases with each call via microtask
  // hops — without serialization, the later appends would land first.
  // Using microtask chains instead of setTimeout keeps the test
  // deterministic and does not leak timers into the node:test teardown.
  const order: number[] = [];
  let call = 0;
  class ReorderingStorage {
    async loadBuffer(): Promise<BufferState> {
      return emptyBuffer();
    }
    async saveBuffer() {}
    async appendBufferSurpriseEvents(events: BufferSurpriseEvent[]) {
      const nth = ++call;
      // First append hops the microtask queue more times than later
      // ones, mimicking variable latency deterministically.
      const hops = Math.max(1, 6 - nth * 2);
      for (let i = 0; i < hops; i += 1) {
        await Promise.resolve();
      }
      for (const ev of events) order.push(ev.turnCountInWindow);
      return events.length;
    }
  }

  const storage = new ReorderingStorage();
  const config = parseConfig({
    bufferSurpriseTriggerEnabled: true,
    bufferMaxTurns: 50,
    triggerMode: "smart",
  });
  const buffer = new SmartBuffer(config, storage as any, fixedScoreProbe(0.1));
  for (const i of [1, 2, 3]) {
    await buffer.addTurn(
      "sess-1",
      { ...makeTurn("sess-1", "turn " + i) },
    );
  }
  await buffer.flushSurpriseTelemetry();
  assert.deepEqual(order, [1, 2, 3]);
});

test("works with legacy StorageManager lacking appendBufferSurpriseEvents", async () => {
  // The buffer must feature-detect the sink and silently skip when the
  // host's storage double is on the old surface.
  class LegacyStorage {
    public saved: BufferState | null = null;
    async loadBuffer(): Promise<BufferState> {
      return emptyBuffer();
    }
    async saveBuffer(state: BufferState) {
      this.saved = state;
    }
  }
  const storage = new LegacyStorage();
  const config = parseConfig({
    bufferSurpriseTriggerEnabled: true,
    triggerMode: "smart",
  });
  const buffer = new SmartBuffer(config, storage as any, fixedScoreProbe(0.9));

  const decision = await buffer.addTurn(
    "sess-1",
    makeTurn("sess-1", "anything"),
  );
  // Core decision still works — only the telemetry path no-ops.
  assert.equal(decision, "extract_now");
});

// ---------------------------------------------------------------------------
// StorageManager read-ledger behavior
// ---------------------------------------------------------------------------

test("StorageManager.readBufferSurpriseEvents: limit over valid rows, not raw lines", async () => {
  // A malformed tail row must not hide valid data above it when
  // `limit: 1` is requested. Simulate an interrupted append by writing
  // a valid row then a partial one, ask for limit=1, and expect the
  // valid row back.
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { StorageManager } = await import("./storage.js");

  const dir = mkdtempSync(join(tmpdir(), "remnic-buffer-surprise-"));
  const stateDir = join(dir, "state");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(stateDir, { recursive: true });
  const ledgerPath = join(stateDir, "buffer-surprise-ledger.jsonl");
  const valid =
    JSON.stringify({
      event: "BUFFER_SURPRISE",
      timestamp: "2026-04-20T12:00:00.000Z",
      bufferKey: "a",
      sessionKey: "a",
      turnRole: "user",
      surpriseScore: 0.5,
      threshold: 0.35,
      triggeredFlush: true,
      turnCountInWindow: 1,
    }) + "\n";
  const truncated = '{"event":"BUFFER_SURPRISE","timestam'; // no newline, broken JSON
  writeFileSync(ledgerPath, valid + truncated);

  const storage = new StorageManager(dir);
  const rows = await storage.readBufferSurpriseEvents({ limit: 1 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.surpriseScore, 0.5);
});

test("StorageManager.readBufferSurpriseEvents: non-positive limit returns empty", async () => {
  const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { StorageManager } = await import("./storage.js");

  const dir = mkdtempSync(join(tmpdir(), "remnic-buffer-surprise-lim-"));
  const stateDir = join(dir, "state");
  mkdirSync(stateDir, { recursive: true });
  const ledgerPath = join(stateDir, "buffer-surprise-ledger.jsonl");
  writeFileSync(
    ledgerPath,
    JSON.stringify({
      event: "BUFFER_SURPRISE",
      timestamp: "2026-04-20T12:00:00.000Z",
      bufferKey: "a",
      sessionKey: "a",
      turnRole: "user",
      surpriseScore: 0.5,
      threshold: 0.35,
      triggeredFlush: true,
      turnCountInWindow: 1,
    }) + "\n",
  );
  const storage = new StorageManager(dir);

  // 0, negative, fractional < 1 all return empty rather than silently
  // devolving into "entire file".
  for (const limit of [0, -1, 0.5]) {
    const rows = await storage.readBufferSurpriseEvents({ limit });
    assert.equal(rows.length, 0, `limit=${limit} should return empty`);
  }
});

test("StorageManager.readBufferSurpriseEvents: sorts by event timestamp before limiting", async () => {
  const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { StorageManager } = await import("./storage.js");

  const dir = mkdtempSync(join(tmpdir(), "remnic-buffer-surprise-order-"));
  const stateDir = join(dir, "state");
  mkdirSync(stateDir, { recursive: true });
  const ledgerPath = join(stateDir, "buffer-surprise-ledger.jsonl");
  const newer = {
    event: "BUFFER_SURPRISE",
    timestamp: "2026-04-20T12:00:01.000Z",
    bufferKey: "a",
    sessionKey: "a",
    turnRole: "user",
    surpriseScore: 0.8,
    threshold: 0.35,
    triggeredFlush: true,
    turnCountInWindow: 2,
  };
  const older = {
    event: "BUFFER_SURPRISE",
    timestamp: "2026-04-20T12:00:00.000Z",
    bufferKey: "a",
    sessionKey: "a",
    turnRole: "user",
    surpriseScore: 0.2,
    threshold: 0.35,
    triggeredFlush: false,
    turnCountInWindow: 1,
  };
  writeFileSync(
    ledgerPath,
    `${JSON.stringify(newer)}\n${JSON.stringify(older)}\n`,
  );

  const storage = new StorageManager(dir);
  const rows = await storage.readBufferSurpriseEvents({ limit: 1 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.timestamp, newer.timestamp);
});

// ---------------------------------------------------------------------------
// reportBufferSurpriseDistribution
// ---------------------------------------------------------------------------

function syntheticRow(
  score: number,
  triggered: boolean,
  ts = "2026-04-20T12:00:00.000Z",
  threshold = 0.35,
): BufferSurpriseEvent {
  return {
    event: "BUFFER_SURPRISE",
    timestamp: ts,
    bufferKey: "sess-x",
    sessionKey: "sess-x",
    turnRole: "user",
    surpriseScore: score,
    threshold,
    triggeredFlush: triggered,
    turnCountInWindow: 1,
  };
}

test("report: empty ledger returns zeros, currentThreshold=null", async () => {
  const dist = await reportBufferSurpriseDistribution(async () => []);
  assert.equal(dist.count, 0);
  assert.equal(dist.triggeredCount, 0);
  assert.equal(dist.triggeredRate, 0);
  assert.equal(dist.mean, 0);
  assert.equal(dist.median, 0);
  assert.equal(dist.p90, 0);
  assert.equal(dist.currentThreshold, null);
});

test("report: computes mean, median, p90 over recent rows", async () => {
  const rows: BufferSurpriseEvent[] = [
    syntheticRow(0.1, false),
    syntheticRow(0.2, false),
    syntheticRow(0.3, false),
    syntheticRow(0.4, true),
    syntheticRow(0.5, true),
    syntheticRow(0.9, true),
  ];
  const dist = await reportBufferSurpriseDistribution(async () => rows);
  assert.equal(dist.count, 6);
  assert.equal(dist.triggeredCount, 3);
  assert.ok(Math.abs(dist.triggeredRate - 0.5) < 1e-9);
  assert.ok(Math.abs(dist.mean - (0.1 + 0.2 + 0.3 + 0.4 + 0.5 + 0.9) / 6) < 1e-9);
  // nearest-rank p50 over 6 → rank 3 → 0.3
  assert.equal(dist.median, 0.3);
  // nearest-rank p90 over 6 → ceil(5.4)=6 → 0.9
  assert.equal(dist.p90, 0.9);
  assert.equal(dist.min, 0.1);
  assert.equal(dist.max, 0.9);
  assert.equal(dist.currentThreshold, 0.35);
});

test("report: sorts by event timestamp for recent window and current threshold", async () => {
  const rows: BufferSurpriseEvent[] = [
    syntheticRow(0.9, true, "2026-04-20T12:00:02.000Z", 0.9),
    syntheticRow(0.1, false, "2026-04-20T12:00:00.000Z", 0.1),
    syntheticRow(0.5, true, "2026-04-20T12:00:01.000Z", 0.5),
  ];
  const dist = await reportBufferSurpriseDistribution(async () => rows, {
    limit: 2,
  });
  assert.equal(dist.count, 2);
  assert.equal(dist.min, 0.5);
  assert.equal(dist.max, 0.9);
  assert.equal(dist.currentThreshold, 0.9);
});

test("report: skips malformed rows (wrong event tag, non-finite score, out of range)", async () => {
  const rows: any[] = [
    syntheticRow(0.1, false),
    { event: "SOMETHING_ELSE", surpriseScore: 0.99 },
    { event: "BUFFER_SURPRISE", surpriseScore: Number.POSITIVE_INFINITY },
    { event: "BUFFER_SURPRISE", surpriseScore: -0.1 },
    { event: "BUFFER_SURPRISE", surpriseScore: 1.1 },
    syntheticRow(0.9, true),
  ];
  const dist = await reportBufferSurpriseDistribution(async () => rows);
  assert.equal(dist.count, 2);
  assert.equal(dist.min, 0.1);
  assert.equal(dist.max, 0.9);
});

test("report: `since` filter excludes rows at or before the boundary", async () => {
  const rows: BufferSurpriseEvent[] = [
    syntheticRow(0.1, false, "2026-04-19T00:00:00.000Z"),
    syntheticRow(0.5, true, "2026-04-20T00:00:00.000Z"),
    syntheticRow(0.9, true, "2026-04-20T12:00:00.000Z"),
  ];
  const dist = await reportBufferSurpriseDistribution(async () => rows, {
    since: "2026-04-20T00:00:00.000Z",
  });
  // Boundary is exclusive: the exactly-equal row at 00:00:00 is filtered.
  assert.equal(dist.count, 1);
  assert.equal(dist.min, 0.9);
  assert.equal(dist.max, 0.9);
});

test("report: limit is forwarded to the reader callback", async () => {
  let seen: number | undefined;
  const reader = async (options: { limit?: number }) => {
    seen = options.limit;
    return [] as BufferSurpriseEvent[];
  };
  await reportBufferSurpriseDistribution(reader, { limit: 42 });
  assert.equal(seen, 42);
});

test("report: defaults limit to 200 when omitted", async () => {
  let seen: number | undefined;
  await reportBufferSurpriseDistribution(
    async (options) => {
      seen = options.limit;
      return [];
    },
  );
  assert.equal(seen, 200);
});

test("report: invalid limits default to the documented 200 row window", async () => {
  const rows = [syntheticRow(0.7, false), syntheticRow(0.9, true)];
  const seen: Array<number | undefined> = [];
  const reader = async (options: { limit?: number }) => {
    seen.push(options.limit);
    return rows;
  };

  for (const limit of [0, -1, 0.5, Number.NaN]) {
    const dist = await reportBufferSurpriseDistribution(reader, { limit });
    assert.equal(dist.count, 2, `limit=${limit} should fall back to default`);
    assert.equal(dist.currentThreshold, 0.35);
  }
  assert.deepEqual(seen, [200, 200, 200, 200]);
});

test("report: positive fractional limit floors to the recent row count", async () => {
  const dist = await reportBufferSurpriseDistribution(
    async () => [
      syntheticRow(0.1, false, "2026-04-20T12:00:00.000Z"),
      syntheticRow(0.8, true, "2026-04-20T12:00:01.000Z"),
      syntheticRow(0.9, true, "2026-04-20T12:00:02.000Z"),
    ],
    { limit: 1.8 },
  );
  assert.equal(dist.count, 1);
  assert.equal(dist.min, 0.9);
  assert.equal(dist.currentThreshold, 0.35);
});

test("report: single-row ledger reports that row in every percentile", async () => {
  const rows: BufferSurpriseEvent[] = [syntheticRow(0.42, true)];
  const dist = await reportBufferSurpriseDistribution(async () => rows);
  assert.equal(dist.count, 1);
  assert.equal(dist.min, 0.42);
  assert.equal(dist.max, 0.42);
  assert.equal(dist.median, 0.42);
  assert.equal(dist.p90, 0.42);
  assert.equal(dist.mean, 0.42);
  assert.equal(dist.triggeredRate, 1);
});

test("report: non-boolean triggeredFlush is rejected, not coerced", async () => {
  // A row with `triggeredFlush: "false"` (string) is truthy in
  // JavaScript. Without strict type-checking, it would be counted as
  // triggered and silently inflate the rate reported to operators.
  const rows: any[] = [
    syntheticRow(0.5, false),
    {
      event: "BUFFER_SURPRISE",
      timestamp: "2026-04-20T12:00:00.000Z",
      bufferKey: "x",
      sessionKey: "x",
      turnRole: "user",
      surpriseScore: 0.9,
      threshold: 0.35,
      triggeredFlush: "false",
      turnCountInWindow: 1,
    },
    {
      event: "BUFFER_SURPRISE",
      timestamp: "2026-04-20T12:00:00.000Z",
      bufferKey: "x",
      sessionKey: "x",
      turnRole: "user",
      surpriseScore: 0.8,
      threshold: 0.35,
      triggeredFlush: 1,
      turnCountInWindow: 1,
    },
  ];
  const dist = await reportBufferSurpriseDistribution(async () => rows);
  assert.equal(dist.count, 1);
  assert.equal(dist.triggeredCount, 0);
  assert.equal(dist.triggeredRate, 0);
});
