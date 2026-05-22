import test from "node:test";
import assert from "node:assert/strict";
import {
  buildBehaviorSignalHash,
  buildBehaviorSignalsForMemory,
  dedupeBehaviorSignalsByMemoryAndHash,
} from "../src/behavior-signals.ts";

test("corrections generate negative override signals", () => {
  const signals = buildBehaviorSignalsForMemory({
    memoryId: "correction-1",
    category: "correction",
    content: "Actually, use PostgreSQL 15 not 14.",
    namespace: "default",
    confidence: 0.98,
    timestamp: "2026-02-28T00:00:00.000Z",
  });
  assert.equal(signals.length, 1);
  assert.equal(signals[0]?.signalType, "correction_override");
  assert.equal(signals[0]?.direction, "negative");
});

test("preferences generate positive affinity signals", () => {
  const signals = buildBehaviorSignalsForMemory({
    memoryId: "preference-1",
    category: "preference",
    content: "I prefer concise replies.",
    namespace: "default",
    confidence: 0.9,
    timestamp: "2026-02-28T00:00:00.000Z",
  });
  assert.equal(signals.length, 1);
  assert.equal(signals[0]?.signalType, "preference_affinity");
  assert.equal(signals[0]?.direction, "positive");
});

test("duplicate correction signals dedupe by memory id + signal hash", () => {
  const signalHash = buildBehaviorSignalHash("correction", "Same correction content");
  const deduped = dedupeBehaviorSignalsByMemoryAndHash([
    {
      timestamp: "2026-02-28T00:00:00.000Z",
      namespace: "default",
      memoryId: "correction-1",
      category: "correction",
      signalType: "correction_override",
      direction: "negative",
      confidence: 0.8,
      signalHash,
      source: "extraction",
    },
    {
      timestamp: "2026-02-28T00:01:00.000Z",
      namespace: "default",
      memoryId: "correction-1",
      category: "correction",
      signalType: "correction_override",
      direction: "negative",
      confidence: 0.8,
      signalHash,
      source: "extraction",
    },
  ]);

  assert.equal(deduped.length, 1);
});

test("duplicate signal dedupe preserves namespace-distinct memories", () => {
  const signalHash = buildBehaviorSignalHash("preference", "Same preference content");
  const deduped = dedupeBehaviorSignalsByMemoryAndHash([
    {
      timestamp: "2026-02-28T00:00:00.000Z",
      namespace: "default",
      memoryId: "preference-1",
      category: "preference",
      signalType: "preference_affinity",
      direction: "positive",
      confidence: 0.8,
      signalHash,
      source: "extraction",
    },
    {
      timestamp: "2026-02-28T00:01:00.000Z",
      namespace: "shared",
      memoryId: "preference-1",
      category: "preference",
      signalType: "preference_affinity",
      direction: "positive",
      confidence: 0.8,
      signalHash,
      source: "extraction",
    },
  ]);

  assert.equal(deduped.length, 2);
  assert.deepEqual(deduped.map((signal) => signal.namespace), ["default", "shared"]);
});

test("signals are namespace-safe and timestamped", () => {
  const signals = buildBehaviorSignalsForMemory({
    memoryId: "preference-2",
    category: "preference",
    content: "Please route this to shared",
    namespace: "shared",
    confidence: 0.85,
    timestamp: "2026-02-28T10:00:00.000Z",
  });

  assert.equal(signals.length, 1);
  assert.equal(signals[0]?.namespace, "shared");
  assert.equal(signals[0]?.timestamp, "2026-02-28T10:00:00.000Z");
});
