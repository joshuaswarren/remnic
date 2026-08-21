import assert from "node:assert/strict";
import test from "node:test";

import type { RecallAuditEntry } from "./recall-audit.js";
import {
  DEFAULT_ANOMALY_DETECTOR_CONFIG,
  detectRecallAnomalies,
  normalizeQueryText,
} from "./recall-audit-anomaly.js";

function makeEntry(
  overrides: Partial<RecallAuditEntry> & { ts: string },
): RecallAuditEntry {
  return {
    ts: overrides.ts,
    sessionKey: overrides.sessionKey ?? "session-a",
    agentId: overrides.agentId ?? "agent-a",
    trigger: overrides.trigger ?? "test",
    queryText: overrides.queryText ?? "hello",
    candidateMemoryIds: overrides.candidateMemoryIds ?? [],
    summary: overrides.summary ?? null,
    injectedChars: overrides.injectedChars ?? 0,
    toggleState: overrides.toggleState ?? "enabled",
    latencyMs: overrides.latencyMs,
    plannerMode: overrides.plannerMode,
    requestedMode: overrides.requestedMode,
    fallbackUsed: overrides.fallbackUsed,
  };
}

function tsAt(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

test("normalizeQueryText lowercases, collapses whitespace, trims", () => {
  assert.equal(normalizeQueryText("  Hello\tWorld\n"), "hello world");
  assert.equal(normalizeQueryText(""), "");
  assert.equal(normalizeQueryText("ALREADY  SPACED"), "already spaced");
});

test("disabled detector returns zero flags but still reports window count", () => {
  const entries = [
    makeEntry({ ts: tsAt(1_000), queryText: "a" }),
    makeEntry({ ts: tsAt(2_000), queryText: "a" }),
  ];
  const result = detectRecallAnomalies({
    entries,
    now: 10_000,
    config: { enabled: false, windowMs: 60_000, repeatQueryLimit: 1 },
  });
  assert.equal(result.flags.length, 0);
  assert.equal(result.windowEntryCount, 2);
});

test("repeat-query flag fires on bursts of the same normalized query", () => {
  const entries: RecallAuditEntry[] = [];
  for (let i = 0; i < 10; i++) {
    entries.push(
      makeEntry({ ts: tsAt(1_000 + i * 100), queryText: "ALEX" }),
    );
  }
  const result = detectRecallAnomalies({
    entries,
    now: 5_000,
    config: {
      enabled: true,
      windowMs: 60_000,
      repeatQueryLimit: 5,
      namespaceWalkLimit: 100,
      highCardinalityReturnLimit: 1_000,
      rapidFireLimit: 1_000,
    },
  });
  const repeat = result.flags.find((f) => f.kind === "repeat-query");
  assert.ok(repeat, "repeat-query flag must fire");
  assert.equal(repeat.signal, "alex");
  assert.equal(repeat.entryIndices.length, 10);
});

test("namespace-walk fires when candidate IDs span > namespaceWalkLimit namespaces", () => {
  const entries = [
    makeEntry({
      ts: tsAt(1_000),
      candidateMemoryIds: ["victim/mem-1", "other/mem-2"],
    }),
    makeEntry({
      ts: tsAt(2_000),
      candidateMemoryIds: ["third/mem-3", "fourth/mem-4"],
    }),
  ];
  const result = detectRecallAnomalies({
    entries,
    now: 10_000,
    config: {
      enabled: true,
      windowMs: 60_000,
      namespaceWalkLimit: 3,
      repeatQueryLimit: 1_000,
      highCardinalityReturnLimit: 1_000,
      rapidFireLimit: 1_000,
    },
  });
  const walk = result.flags.find((f) => f.kind === "namespace-walk");
  assert.ok(walk, "namespace-walk flag must fire");
  assert.equal(walk.severity, "alert");
  assert.equal(walk.signal, 4);
});

test("high-cardinality-return fires on a single huge response", () => {
  const bigList = Array.from({ length: 120 }, (_, i) => `victim/mem-${i}`);
  const entries = [
    makeEntry({
      ts: tsAt(1_000),
      queryText: "dump",
      candidateMemoryIds: bigList,
    }),
  ];
  const result = detectRecallAnomalies({
    entries,
    now: 5_000,
    config: {
      enabled: true,
      windowMs: 60_000,
      highCardinalityReturnLimit: 100,
      repeatQueryLimit: 1_000,
      namespaceWalkLimit: 1_000,
      rapidFireLimit: 1_000,
    },
  });
  const hc = result.flags.find((f) => f.kind === "high-cardinality-return");
  assert.ok(hc, "high-cardinality-return must fire");
  assert.equal(hc.signal, 120);
});

test("rapid-fire fires on too many entries in the window", () => {
  const entries: RecallAuditEntry[] = [];
  for (let i = 0; i < 40; i++) {
    entries.push(makeEntry({ ts: tsAt(1_000 + i), queryText: `q-${i}` }));
  }
  const result = detectRecallAnomalies({
    entries,
    now: 5_000,
    config: {
      enabled: true,
      windowMs: 60_000,
      repeatQueryLimit: 1_000,
      namespaceWalkLimit: 1_000,
      highCardinalityReturnLimit: 1_000,
      rapidFireLimit: 30,
    },
  });
  const rf = result.flags.find((f) => f.kind === "rapid-fire");
  assert.ok(rf, "rapid-fire flag must fire");
  assert.equal(rf.signal, 40);
});

test("entries outside the window are ignored", () => {
  const entries: RecallAuditEntry[] = [];
  // 20 old entries (outside window), 2 new entries (inside).
  for (let i = 0; i < 20; i++) {
    entries.push(makeEntry({ ts: tsAt(0 + i), queryText: "old" }));
  }
  entries.push(makeEntry({ ts: tsAt(10_000), queryText: "new" }));
  entries.push(makeEntry({ ts: tsAt(11_000), queryText: "new" }));
  const result = detectRecallAnomalies({
    entries,
    now: 12_000,
    config: {
      enabled: true,
      windowMs: 5_000, // <- covers 7_000..12_000 only
      repeatQueryLimit: 1,
      namespaceWalkLimit: 1_000,
      highCardinalityReturnLimit: 1_000,
      rapidFireLimit: 1_000,
    },
  });
  assert.equal(result.windowEntryCount, 2);
  // The repeat-query flag fires on "new" (2 repeats > limit 1), not on "old".
  const flag = result.flags.find((f) => f.kind === "repeat-query");
  assert.ok(flag);
  assert.equal(flag.signal, "new");
});

test("invalid ts entries are skipped silently", () => {
  const entries = [
    makeEntry({ ts: "not-a-date", queryText: "a" }),
    makeEntry({ ts: tsAt(1_000), queryText: "a" }),
  ];
  const result = detectRecallAnomalies({
    entries,
    now: 5_000,
    config: { ...DEFAULT_ANOMALY_DETECTOR_CONFIG, enabled: true },
  });
  assert.equal(result.windowEntryCount, 1);
});

test("flags are sorted by severity then kind for deterministic output", () => {
  const entries: RecallAuditEntry[] = [];
  // Trigger alert (namespace-walk) + warn (repeat-query + rapid-fire).
  for (let i = 0; i < 10; i++) {
    entries.push(
      makeEntry({
        ts: tsAt(1_000 + i),
        queryText: "same",
        candidateMemoryIds: [`ns-${i}/mem`],
      }),
    );
  }
  const result = detectRecallAnomalies({
    entries,
    now: 5_000,
    config: {
      enabled: true,
      windowMs: 60_000,
      repeatQueryLimit: 5,
      namespaceWalkLimit: 3,
      highCardinalityReturnLimit: 1_000,
      rapidFireLimit: 5,
    },
  });
  assert.ok(result.flags.length >= 2);
  // alert comes before warn.
  const severities = result.flags.map((f) => f.severity);
  const firstWarn = severities.indexOf("warn");
  const lastAlert = severities.lastIndexOf("alert");
  if (firstWarn >= 0 && lastAlert >= 0) {
    assert.ok(lastAlert < firstWarn, "alerts must precede warns");
  }
});

test("invalid config values are replaced by defaults", () => {
  const entries = [makeEntry({ ts: tsAt(1_000) })];
  const result = detectRecallAnomalies({
    entries,
    now: 2_000,
    config: {
      enabled: true,
      windowMs: Number.NaN,
      repeatQueryLimit: -1,
      namespaceWalkLimit: 0,
      highCardinalityReturnLimit: Number.POSITIVE_INFINITY,
      rapidFireLimit: Number.NaN,
    },
  });
  assert.equal(result.windowMs, DEFAULT_ANOMALY_DETECTOR_CONFIG.windowMs);
});
