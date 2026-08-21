/**
 * Tests for the `MemoryObservation` exported type shape (issue #685 PR 1/3).
 *
 * These tests verify:
 *   1. `MemoryObservation` is exported from `@remnic/core` with the correct
 *      required and optional fields.
 *   2. The `summarizeObservationThroughput` doctor check produces an `ok`
 *      status check with the expected shape for both empty and populated
 *      ledgers.
 *
 * Tests are purely structural / behavioral — they do not require a real
 * OpenAI key or QMD daemon.
 */

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";

// Verify the public export chain.
import type { MemoryObservation } from "../src/types.js";
// Also verify it flows through the barrel export.
import type { MemoryObservation as BarrelMemoryObservation } from "../src/index.js";

import { summarizeObservationThroughput } from "../src/operator-toolkit.js";
import {
  judgeTelemetryPath,
} from "../src/extraction-judge-telemetry.js";
import { EXTRACTION_JUDGE_VERDICT_CATEGORY } from "../src/extraction-judge-telemetry.js";

// ---------------------------------------------------------------------------
// Type-shape tests (compile-time + runtime)
// ---------------------------------------------------------------------------

test("MemoryObservation has required id, observedAt, and fact fields", () => {
  // Construct a minimal valid MemoryObservation at the type level.
  const obs: MemoryObservation = {
    id: "obs-1",
    observedAt: "2026-01-01T00:00:00Z",
    fact: {
      category: "fact",
      content: "The sky is blue.",
      confidence: 0.9,
      tags: [],
    },
  };

  assert.equal(obs.id, "obs-1");
  assert.equal(obs.observedAt, "2026-01-01T00:00:00Z");
  assert.equal(obs.fact.content, "The sky is blue.");
  assert.equal(obs.fact.category, "fact");
  assert.equal(obs.fact.confidence, 0.9);
  assert.deepEqual(obs.fact.tags, []);
});

test("MemoryObservation optional fields are assignable", () => {
  const full: MemoryObservation = {
    id: "obs-2",
    sessionId: "session-abc",
    observedAt: "2026-01-01T01:00:00Z",
    fact: {
      category: "fact",
      content: "TypeScript is structurally typed.",
      confidence: 0.8,
      tags: ["typescript", "typing"],
    },
    importance: 0.7,
    judgeAccepted: true,
    judgeRejectionReason: undefined,
    resultingPrimitiveId: "fact-xyz",
  };

  assert.equal(full.sessionId, "session-abc");
  assert.equal(full.importance, 0.7);
  assert.equal(full.judgeAccepted, true);
  assert.equal(full.resultingPrimitiveId, "fact-xyz");
});

test("MemoryObservation rejected observation is assignable", () => {
  const rejected: MemoryObservation = {
    id: "obs-3",
    observedAt: "2026-01-01T02:00:00Z",
    fact: {
      category: "fact",
      content: "ok",
      confidence: 0.1,
      tags: [],
    },
    judgeAccepted: false,
    judgeRejectionReason: "trivial content",
  };
  assert.equal(rejected.judgeAccepted, false);
  assert.equal(rejected.judgeRejectionReason, "trivial content");
});

test("MemoryObservation and barrel export are the same shape", () => {
  // Both type aliases must accept the same object — this verifies that
  // the barrel export hasn't been removed or aliased to a different type.
  const obs: BarrelMemoryObservation = {
    id: "obs-barrel",
    observedAt: "2026-01-01T00:00:00Z",
    fact: {
      category: "fact",
      content: "Barrel export test.",
      confidence: 0.5,
      tags: [],
    },
  };
  assert.equal(obs.id, "obs-barrel");
});

// ---------------------------------------------------------------------------
// summarizeObservationThroughput (doctor check) tests
// ---------------------------------------------------------------------------

test("summarizeObservationThroughput: returns ok with zero count when ledger is absent", async () => {
  const memoryDir = await mkdtemp(
    path.join(os.tmpdir(), "engram-obs-check-"),
  );
  const check = await summarizeObservationThroughput(memoryDir);

  assert.equal(check.key, "observations");
  assert.equal(check.status, "ok");
  assert.match(check.summary, /No observations/);

  const details = check.details as Record<string, unknown>;
  assert.equal(details.total, 0);
  assert.equal(details.accept, 0);
  assert.equal(details.reject, 0);
  assert.equal(details.defer, 0);
  assert.equal(details.lastObservedAt, null);
});

test("summarizeObservationThroughput: surfaces counts from populated ledger", async () => {
  const memoryDir = await mkdtemp(
    path.join(os.tmpdir(), "engram-obs-populated-"),
  );
  const ledgerPath = judgeTelemetryPath(memoryDir);
  await mkdir(path.dirname(ledgerPath), { recursive: true });

  const baseEvent = {
    version: 1 as const,
    category: EXTRACTION_JUDGE_VERDICT_CATEGORY,
    deferrals: 0,
    elapsedMs: 10,
    candidateCategory: "fact",
    confidence: 0.8,
    contentHash: "abc123",
    fromCache: false,
  };

  const rows = [
    { ...baseEvent, ts: "2026-01-01T00:00:00Z", verdictKind: "accept" },
    { ...baseEvent, ts: "2026-01-01T00:01:00Z", verdictKind: "accept" },
    { ...baseEvent, ts: "2026-01-01T00:02:00Z", verdictKind: "reject" },
    { ...baseEvent, ts: "2026-01-01T00:03:00Z", verdictKind: "defer" },
    { ...baseEvent, ts: "2026-01-01T00:04:00Z", verdictKind: "accept" },
  ];

  await writeFile(
    ledgerPath,
    rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
    "utf-8",
  );

  const check = await summarizeObservationThroughput(memoryDir);

  assert.equal(check.key, "observations");
  assert.equal(check.status, "ok");

  const details = check.details as Record<string, unknown>;
  assert.equal(details.total, 5);
  assert.equal(details.accept, 3);
  assert.equal(details.reject, 1);
  assert.equal(details.defer, 1);
  assert.equal(details.lastObservedAt, "2026-01-01T00:04:00Z");
  assert.equal(details.firstObservedAt, "2026-01-01T00:00:00Z");

  // Summary string should include the percentages.
  assert.match(check.summary, /5 observations recorded/);
  assert.match(check.summary, /Last observed:/);
});

test("summarizeObservationThroughput: check key is 'observations'", async () => {
  // Regression guard: the key must be exactly 'observations' so the
  // doctor CLI section-header and JSON output match the documented name.
  const memoryDir = await mkdtemp(
    path.join(os.tmpdir(), "engram-obs-key-"),
  );
  const check = await summarizeObservationThroughput(memoryDir);
  assert.equal(check.key, "observations");
});
