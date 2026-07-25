import assert from "node:assert/strict";
import test from "node:test";

import { SmartBuffer } from "./buffer.js";
import { parseConfig } from "./config.js";
import {
  ExtractionLivenessWarnThrottle,
  evaluateExtractionLiveness,
  parseExtractionLivenessConfig,
  renderExtractionLivenessStats,
  type ExtractionBufferSnapshot,
  type ExtractionLivenessStatus,
} from "./extraction-liveness.js";
import type { BufferState, BufferTurn } from "./types.js";

const NOW = 1_700_000_000_000;
const WINDOW = 1000;

function turn(timestamp: string, content = "hi"): BufferTurn {
  return { role: "user", content, timestamp };
}

function snapshot(over: Partial<ExtractionBufferSnapshot> = {}): ExtractionBufferSnapshot {
  return { bufferedSessionCount: 0, pendingTurnCount: 0, oldestTurnTimestamp: null, ...over };
}

class FakeBufferStorage {
  constructor(private readonly initial: BufferState) {}
  async loadBuffer(): Promise<BufferState> {
    return structuredClone(this.initial);
  }
  async saveBuffer(): Promise<void> {}
}

function bufferFor(state: BufferState): SmartBuffer {
  return new SmartBuffer(
    parseConfig({}),
    new FakeBufferStorage(state) as unknown as ConstructorParameters<typeof SmartBuffer>[1],
  );
}

// ── parseExtractionLivenessConfig ────────────────────────────────────────────

test("parseExtractionLivenessConfig: defaults enabled=true, staleWindowMs=24h", () => {
  assert.deepEqual(parseExtractionLivenessConfig({}), {
    enabled: true,
    staleWindowMs: 86_400_000,
  });
});

test("parseExtractionLivenessConfig: coerces string/boolean falsy opt-outs (§24)", () => {
  assert.equal(parseExtractionLivenessConfig({ extractionLiveness: { enabled: "false" } }).enabled, false);
  assert.equal(parseExtractionLivenessConfig({ extractionLiveness: { enabled: "0" } }).enabled, false);
  assert.equal(parseExtractionLivenessConfig({ extractionLiveness: { enabled: false } }).enabled, false);
  assert.equal(parseExtractionLivenessConfig({ extractionLiveness: { enabled: "true" } }).enabled, true);
});

test("parseExtractionLivenessConfig: honors a valid integer staleWindowMs (number or string)", () => {
  assert.equal(parseExtractionLivenessConfig({ extractionLiveness: { staleWindowMs: 5000 } }).staleWindowMs, 5000);
  assert.equal(parseExtractionLivenessConfig({ extractionLiveness: { staleWindowMs: "7000" } }).staleWindowMs, 7000);
});

test("parseExtractionLivenessConfig: rejects fractional/non-positive/non-numeric staleWindowMs (§1/§17/§39)", () => {
  // Fractional values must be REJECTED, not floored: "0.5"→0 would make every
  // backlog instantly stale and 1.9→1 is a silent reinterpretation.
  for (const bad of ["0.5", 1.9, 0, -5, "abc"]) {
    assert.throws(
      () => parseExtractionLivenessConfig({ extractionLiveness: { staleWindowMs: bad } }),
      /staleWindowMs must be an integer greater than or equal to 1/,
      `expected ${JSON.stringify(bad)} to be rejected`,
    );
  }
});

test("parseExtractionLivenessConfig: rejects an explicit null staleWindowMs; only an absent key defaults (round 9 finding 1 parity)", () => {
  // An explicit `null` is invalid input, not "use the default" — mirrors
  // config.ts parseIntegerInClosedRange. Only an absent key (undefined) defaults.
  assert.throws(
    () => parseExtractionLivenessConfig({ extractionLiveness: { staleWindowMs: null } }),
    /staleWindowMs must be an integer greater than or equal to 1/,
  );
  assert.equal(
    parseExtractionLivenessConfig({ extractionLiveness: { staleWindowMs: undefined } }).staleWindowMs,
    86_400_000,
  );
});

test("parseExtractionLivenessConfig: rejects a non-object block", () => {
  assert.throws(() => parseExtractionLivenessConfig({ extractionLiveness: 5 }), /must be a plain object/);
  assert.throws(() => parseExtractionLivenessConfig({ extractionLiveness: [] }), /must be a plain object/);
});

// ── evaluateExtractionLiveness: degraded matrix ──────────────────────────────

const ENABLED = { enabled: true, staleWindowMs: WINDOW };
const ancient = new Date(NOW - 10 * WINDOW).toISOString();
const nonEmpty = snapshot({ bufferedSessionCount: 2, pendingTurnCount: 5, oldestTurnTimestamp: ancient });

test("evaluate: disabled is never degraded even with a stale watermark and backlog", () => {
  const status = evaluateExtractionLiveness({
    config: { enabled: false, staleWindowMs: WINDOW },
    lastExtractionAt: ancient,
    snapshot: nonEmpty,
    nowMs: NOW,
  });
  assert.equal(status.degraded, false);
  assert.equal(status.degradedReason, null);
  assert.equal(status.bufferedSessionCount, 2);
});

test("evaluate: empty buffer with an ancient watermark is NOT degraded (nothing to extract, §22)", () => {
  const status = evaluateExtractionLiveness({
    config: ENABLED,
    lastExtractionAt: ancient,
    snapshot: snapshot(),
    nowMs: NOW,
  });
  assert.equal(status.degraded, false);
});

test("evaluate: non-empty buffer with an ancient watermark is degraded", () => {
  const status = evaluateExtractionLiveness({
    config: ENABLED,
    lastExtractionAt: ancient,
    snapshot: nonEmpty,
    nowMs: NOW,
  });
  assert.equal(status.degraded, true);
  assert.match(status.degradedReason ?? "", /buffered session/);
  assert.equal(status.oldestBufferedTurnAgeMs, 10 * WINDOW);
});

test("evaluate: non-empty buffer with a null watermark (never succeeded) is degraded", () => {
  const status = evaluateExtractionLiveness({
    config: ENABLED,
    lastExtractionAt: null,
    snapshot: nonEmpty,
    nowMs: NOW,
  });
  assert.equal(status.degraded, true);
  assert.match(status.degradedReason ?? "", /no successful extraction on record/);
});

test("evaluate: staleness boundary is half-open — exactly staleWindowMs is stale, just under is fresh (§23)", () => {
  const atBoundary = evaluateExtractionLiveness({
    config: ENABLED,
    lastExtractionAt: new Date(NOW - WINDOW).toISOString(),
    snapshot: nonEmpty,
    nowMs: NOW,
  });
  assert.equal(atBoundary.degraded, true, "age === staleWindowMs is stale");

  const justUnder = evaluateExtractionLiveness({
    config: ENABLED,
    lastExtractionAt: new Date(NOW - (WINDOW - 1)).toISOString(),
    snapshot: nonEmpty,
    nowMs: NOW,
  });
  assert.equal(justUnder.degraded, false, "age === staleWindowMs - 1 is fresh");
});

test("evaluate: a future (clock-skewed/corrupt) watermark is stale, not fresh — a real backlog stall is not hidden", () => {
  const status = evaluateExtractionLiveness({
    config: ENABLED,
    lastExtractionAt: new Date(NOW + 10 * WINDOW).toISOString(),
    snapshot: nonEmpty,
    nowMs: NOW,
  });
  assert.equal(status.degraded, true, "a future watermark must not read as a fresh extraction");
  assert.match(status.degradedReason ?? "", /buffered session/);
});

test("evaluate: an unreadable buffer degrades with a distinct reason, even with a fresh watermark (§22)", () => {
  const fresh = new Date(NOW).toISOString();
  const readFailedSnap = snapshot({ readFailed: true, readError: "ENOENT: buffer.json missing" });
  const status = evaluateExtractionLiveness({ config: ENABLED, lastExtractionAt: fresh, snapshot: readFailedSnap, nowMs: NOW });
  assert.equal(status.degraded, true, "an unreadable buffer is a pipeline fault, not empty");
  assert.match(status.degradedReason ?? "", /unreadable/);
  assert.match(status.degradedReason ?? "", /ENOENT: buffer\.json missing/);

  // Distinct from a genuinely empty buffer: same fresh watermark, no read failure → healthy.
  const empty = evaluateExtractionLiveness({ config: ENABLED, lastExtractionAt: fresh, snapshot: snapshot(), nowMs: NOW });
  assert.equal(empty.degraded, false, "an empty buffer with a fresh watermark stays healthy");

  // The master gate still suppresses degradation when the feature is disabled.
  const disabled = evaluateExtractionLiveness({
    config: { enabled: false, staleWindowMs: WINDOW },
    lastExtractionAt: fresh,
    snapshot: readFailedSnap,
    nowMs: NOW,
  });
  assert.equal(disabled.degraded, false, "disabled gate suppresses even a read-failure degradation");
});

test("evaluate: an unreadable watermark degrades with a distinct reason, even with an empty buffer (§22)", () => {
  const status = evaluateExtractionLiveness({
    config: ENABLED,
    lastExtractionAt: null,
    snapshot: snapshot(),
    nowMs: NOW,
    metaReadFailed: true,
    metaReadError: "EIO: meta.json unreadable",
  });
  assert.equal(status.degraded, true, "an unreadable watermark is a storage fault, not never-extracted");
  assert.match(status.degradedReason ?? "", /watermark unreadable/);
  assert.match(status.degradedReason ?? "", /EIO: meta\.json unreadable/);

  // The three fault classes carry distinct reasons (meta-read vs buffer-read vs never-extracted).
  const bufferFail = evaluateExtractionLiveness({
    config: ENABLED,
    lastExtractionAt: new Date(NOW).toISOString(),
    snapshot: snapshot({ readFailed: true, readError: "boom" }),
    nowMs: NOW,
  });
  assert.match(bufferFail.degradedReason ?? "", /buffer unreadable/);

  const neverExtracted = evaluateExtractionLiveness({
    config: ENABLED,
    lastExtractionAt: null,
    snapshot: snapshot({ bufferedSessionCount: 1, pendingTurnCount: 1 }),
    nowMs: NOW,
  });
  assert.match(neverExtracted.degradedReason ?? "", /no successful extraction on record/);

  // A meta-read failure takes precedence over staleness when both would degrade.
  const metaOverStale = evaluateExtractionLiveness({
    config: ENABLED,
    lastExtractionAt: null,
    snapshot: snapshot({ bufferedSessionCount: 3, pendingTurnCount: 9 }),
    nowMs: NOW,
    metaReadFailed: true,
    metaReadError: "boom",
  });
  assert.match(metaOverStale.degradedReason ?? "", /watermark unreadable/);
});

// ── SmartBuffer.getBufferSnapshot ────────────────────────────────────────────

test("getBufferSnapshot: empty buffer reports zeros and a null oldest", async () => {
  const snap = await bufferFor({ turns: [], lastExtractionAt: null, extractionCount: 0 }).getBufferSnapshot();
  assert.deepEqual(snap, { bufferedSessionCount: 0, pendingTurnCount: 0, oldestTurnTimestamp: null });
});

test("getBufferSnapshot: counts sessions/turns across the entries map and picks the oldest turn", async () => {
  const older = "2026-02-01T00:00:00.000Z";
  const newer = "2026-03-01T00:00:00.000Z";
  const snap = await bufferFor({
    turns: [],
    lastExtractionAt: null,
    extractionCount: 0,
    entries: {
      recent: { turns: [turn(newer)], lastExtractionAt: null, extractionCount: 0 },
      stale: { turns: [turn(older), turn("2026-03-15T00:00:00.000Z")], lastExtractionAt: null, extractionCount: 0 },
    },
  }).getBufferSnapshot();
  assert.equal(snap.bufferedSessionCount, 2);
  assert.equal(snap.pendingTurnCount, 3);
  assert.equal(snap.oldestTurnTimestamp, older);
});

test("getBufferSnapshot: covers the legacy top-level turns array (single session)", async () => {
  const first = "2026-01-10T00:00:00.000Z";
  const snap = await bufferFor({
    turns: [turn(first), turn("2026-01-11T00:00:00.000Z")],
    lastExtractionAt: null,
    extractionCount: 0,
  }).getBufferSnapshot();
  assert.equal(snap.bufferedSessionCount, 1);
  assert.equal(snap.pendingTurnCount, 2);
  assert.equal(snap.oldestTurnTimestamp, first);
});

test("getBufferSnapshot: empty entries are not counted as sessions", async () => {
  const snap = await bufferFor({
    turns: [],
    lastExtractionAt: null,
    extractionCount: 0,
    entries: {
      empty: { turns: [], lastExtractionAt: null, extractionCount: 0 },
      live: { turns: [turn("2026-04-01T00:00:00.000Z")], lastExtractionAt: null, extractionCount: 0 },
    },
  }).getBufferSnapshot();
  assert.equal(snap.bufferedSessionCount, 1);
  assert.equal(snap.pendingTurnCount, 1);
});

test("evaluate: emits watermarkScope, defaulting to root-store and honoring an explicit scope", () => {
  const rootScoped = evaluateExtractionLiveness({
    config: ENABLED,
    lastExtractionAt: null,
    snapshot: snapshot(),
    nowMs: NOW,
  });
  assert.equal(rootScoped.watermarkScope, "root-store", "defaults to root-store today (#2159)");
  const aggregate = evaluateExtractionLiveness({
    config: ENABLED,
    lastExtractionAt: null,
    snapshot: snapshot(),
    nowMs: NOW,
    watermarkScope: "aggregate",
  });
  assert.equal(aggregate.watermarkScope, "aggregate", "threads an explicit scope for #2159");
});

// ── ExtractionLivenessWarnThrottle ───────────────────────────────────────────

test("throttle: warns once per staleness window and again after it elapses; resets on recovery", () => {
  const degraded: ExtractionLivenessStatus = {
    lastExtractionAt: null,
    bufferedSessionCount: 1,
    pendingTurnCount: 1,
    oldestBufferedTurnAgeMs: null,
    degraded: true,
    degradedReason: "stalled",
    watermarkScope: "root-store",
  };
  const healthy: ExtractionLivenessStatus = { ...degraded, degraded: false, degradedReason: null };
  const t = new ExtractionLivenessWarnThrottle();

  assert.equal(t.maybeWarn(degraded, WINDOW, NOW), true, "first degraded evaluation warns");
  assert.equal(t.maybeWarn(degraded, WINDOW, NOW + WINDOW - 1), false, "same window is throttled");
  assert.equal(t.maybeWarn(degraded, WINDOW, NOW + WINDOW), true, "next window warns again");
  assert.equal(t.maybeWarn(healthy, WINDOW, NOW + WINDOW + 1), false, "healthy never warns");
  assert.equal(t.maybeWarn(degraded, WINDOW, NOW + WINDOW + 2), true, "recovery reset lets a fresh episode warn at once");
});

// ── renderExtractionLivenessStats ────────────────────────────────────────────

test("renderExtractionLivenessStats: emits watermark, backlog, and a degraded verdict", async () => {
  const orchestrator = {
    config: { extractionLiveness: { enabled: true, staleWindowMs: WINDOW } },
    storage: {
      loadMeta: async () => ({ extractionCount: 7, lastExtractionAt: ancient, lastConsolidationAt: null }),
    },
    buffer: {
      getBufferSnapshot: async (): Promise<ExtractionBufferSnapshot> => ({
        bufferedSessionCount: 2,
        pendingTurnCount: 5,
        oldestTurnTimestamp: ancient,
      }),
    },
  };
  const lines = await renderExtractionLivenessStats(orchestrator, NOW);
  assert.ok(lines.includes("Extractions: 7"), "reports extraction count");
  assert.ok(lines.includes("Buffered sessions: 2 (5 turns pending)"), "reports backlog");
  assert.ok(lines.includes("Extraction watermark scope: root-store"), "reports the watermark scope");
  assert.ok(
    lines.some((l) => l.startsWith("Extraction liveness: DEGRADED")),
    "reports a degraded verdict when the watermark is stale",
  );
});

test("renderExtractionLivenessStats: reports DEGRADED when the buffer read fails (§22)", async () => {
  const orchestrator = {
    config: { extractionLiveness: { enabled: true, staleWindowMs: WINDOW } },
    storage: {
      loadMeta: async () => ({
        extractionCount: 7,
        lastExtractionAt: new Date(NOW).toISOString(),
        lastConsolidationAt: null,
      }),
    },
    buffer: {
      getBufferSnapshot: async (): Promise<ExtractionBufferSnapshot> => {
        throw new Error("buffer file corrupt");
      },
    },
  };
  const lines = await renderExtractionLivenessStats(orchestrator, NOW);
  const verdict = lines.find((l) => l.startsWith("Extraction liveness:"));
  assert.ok(verdict, "emits a liveness verdict line");
  assert.match(verdict, /DEGRADED/);
  assert.match(verdict, /unreadable/);
  assert.match(verdict, /buffer file corrupt/);
});

test("renderExtractionLivenessStats: reports DEGRADED + unavailable counts when the meta read fails (§22)", async () => {
  const orchestrator = {
    config: { extractionLiveness: { enabled: true, staleWindowMs: WINDOW } },
    storage: {
      loadMeta: async () => {
        throw new Error("meta.json corrupt");
      },
    },
    buffer: {
      // Empty buffer: proves a meta-read failure degrades even with nothing buffered.
      getBufferSnapshot: async (): Promise<ExtractionBufferSnapshot> => ({
        bufferedSessionCount: 0,
        pendingTurnCount: 0,
        oldestTurnTimestamp: null,
      }),
    },
  };
  const lines = await renderExtractionLivenessStats(orchestrator, NOW);
  assert.ok(lines.includes("Extractions: unavailable"), "meta counts read as unavailable, not 0/never");
  const verdict = lines.find((l) => l.startsWith("Extraction liveness:"));
  assert.match(verdict ?? "", /DEGRADED/);
  assert.match(verdict ?? "", /watermark unreadable/);
  assert.match(verdict ?? "", /meta\.json corrupt/);
});
