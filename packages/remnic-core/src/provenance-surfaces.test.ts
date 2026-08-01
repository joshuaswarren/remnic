/**
 * Issue #1575 PR 3 — Claim-level provenance surfaces: X-ray rendering +
 * `remnic doctor` coverage distribution.
 *
 * PR 1 (types + storage round-trip) and PR 2 (extraction validator) are
 * covered by provenance-frontmatter.test.ts and provenance-extraction.test.ts.
 * This file pins the READ surfaces that operators and downstream features
 * (#1576 faithfulness, #1577 TrustScore, #1580 correction) consume:
 *
 *   - X-ray text/markdown rows render the first quote + observedAt.
 *   - cloneResult deep-copies sourceSpan so getLastXraySnapshot is independent.
 *   - `remnic doctor` reports the verified/unverified/none distribution.
 */

import test from "node:test";
import assert from "node:assert/strict";

import type { RecallXraySnapshot, RecallXrayResult } from "./recall-xray.js";
import { buildXraySnapshot } from "./recall-xray.js";
import { renderXrayText, renderXrayMarkdown } from "./recall-xray-renderer.js";

// ─── X-ray rendering fixtures ────────────────────────────────────────────

function resultWithSourceSpan(): RecallXrayResult {
  return {
    memoryId: "fact-prov-1",
    path: "facts/tech/database.md",
    servedBy: "hybrid",
    scoreDecomposition: { final: 0.82 },
    admittedBy: ["namespace"],
    sourceSpan: {
      quote: "We migrated the production database to pgBouncer",
      observedAt: "2026-05-03T10:00:00.000Z",
      provenance: "verified",
    },
  };
}

function snapshotWithSourceSpan(): RecallXraySnapshot {
  return {
    schemaVersion: "1",
    query: "what database?",
    capturedAt: 1_700_000_000_000,
    snapshotId: "22222222-2222-2222-2222-222222222222",
    tierExplain: null,
    results: [resultWithSourceSpan()],
    appliedResultLimit: 0,
    appliedResults: [],
    headroomResults: [],
    filters: [{ name: "recall-result-limit", considered: 1, admitted: 1 }],
    budget: { chars: 4096, used: 100 },
  };
}

// ─── X-ray text rendering ─────────────────────────────────────────────────

test("renderXrayText: sourceSpan renders quote + observedAt + provenance tag", () => {
  const text = renderXrayText(snapshotWithSourceSpan());
  assert.match(
    text,
    /source: "We migrated the production database to pgBouncer" \(observed 2026-05-03T10:00:00\.000Z\) \[verified\]/,
    "text renderer must surface the source span line",
  );
});

test("renderXrayText: absent sourceSpan produces no source line", () => {
  const snap = buildXraySnapshot({
    query: "q",
    tierExplain: null,
    results: [
      {
        memoryId: "fact-legacy",
        path: "facts/legacy.md",
        servedBy: "hybrid",
        scoreDecomposition: { final: 0.5 },
        admittedBy: [],
      },
    ],
    filters: [],
    budget: { chars: 4096, used: 0 },
  });
  const text = renderXrayText(snap);
  assert.doesNotMatch(text, /source:/, "no source line for legacy memory");
});

test("renderXrayText: long quote is truncated to ~120 chars with ellipsis", () => {
  const longQuote = "A".repeat(300);
  const snap = buildXraySnapshot({
    query: "q",
    tierExplain: null,
    results: [
      {
        memoryId: "fact-long",
        path: "facts/long.md",
        servedBy: "hybrid",
        scoreDecomposition: { final: 0.5 },
        admittedBy: [],
        sourceSpan: {
          quote: longQuote,
          observedAt: "2026-06-01T00:00:00.000Z",
          provenance: "verified",
        },
      },
    ],
    filters: [],
    budget: { chars: 4096, used: 0 },
  });
  const text = renderXrayText(snap);
  // The truncated quote should end with an ellipsis and be well under 300 chars
  const sourceLine = text.split("\n").find((l) => l.includes("source:"));
  assert.ok(sourceLine, "source line present");
  assert.match(sourceLine!, /\u2026|…/, "truncated with ellipsis marker");
  // The quote between the first and second double-quotes
  const match = sourceLine!.match(/source: "(.*)" \(observed/);
  assert.ok(match);
  assert.ok(
    match![1].length <= 125,
    `truncated quote should be ~120 chars, got ${match![1].length}`,
  );
});

// ─── X-ray markdown rendering ─────────────────────────────────────────────

test("renderXrayText: quote with newlines is collapsed to a single line", () => {
  const snap = buildXraySnapshot({
    query: "q",
    tierExplain: null,
    results: [
      {
        memoryId: "fact-newline",
        path: "facts/multi.md",
        servedBy: "hybrid",
        scoreDecomposition: { final: 0.5 },
        admittedBy: [],
        sourceSpan: {
          quote: "line one\nline two\r\nline three",
          observedAt: "2026-06-01T00:00:00.000Z",
          provenance: "verified",
        },
      },
    ],
    filters: [],
    budget: { chars: 4096, used: 0 },
  });
  const text = renderXrayText(snap);
  const sourceLine = text.split("\n").find((l) => l.includes("source:"));
  assert.ok(sourceLine);
  // Newlines must be collapsed to spaces — the source line must be a single line
  assert.match(sourceLine!, /line one line two line three/);
  assert.doesNotMatch(sourceLine!, /\n|\r/);
});

test("renderXrayMarkdown: sourceSpan renders as a Source line", () => {
  const md = renderXrayMarkdown(snapshotWithSourceSpan());
  assert.match(
    md,
    /\*\*Source:\*\* "We migrated the production database to pgBouncer" \(`2026-05-03T10:00:00\.000Z`\) — verified/,
    "markdown renderer must surface the source span",
  );
});

test("renderXrayMarkdown: absent sourceSpan produces no Source line", () => {
  const snap = buildXraySnapshot({
    query: "q",
    tierExplain: null,
    results: [
      {
        memoryId: "fact-legacy-2",
        path: "facts/legacy2.md",
        servedBy: "hybrid",
        scoreDecomposition: { final: 0.5 },
        admittedBy: [],
      },
    ],
    filters: [],
    budget: { chars: 4096, used: 0 },
  });
  const md = renderXrayMarkdown(snap);
  assert.doesNotMatch(md, /\*\*Source:\*\*/, "no Source line for legacy memory");
});

// ─── cloneResult preserves sourceSpan ─────────────────────────────────────

test("buildXraySnapshot deep-copies sourceSpan (independent of caller object)", () => {
  const original = resultWithSourceSpan();
  const snap = buildXraySnapshot({
    query: "q",
    tierExplain: null,
    results: [original],
    filters: [],
    budget: { chars: 4096, used: 0 },
  });
  // Mutate the original — the snapshot must be unaffected
  original.sourceSpan!.quote = "MUTATED";
  assert.equal(
    snap.results[0]!.sourceSpan!.quote,
    "We migrated the production database to pgBouncer",
    "snapshot sourceSpan must be a deep copy",
  );
});

// ─── `remnic doctor` provenance coverage (pure helper) ────────────────────
//
// `runOperatorDoctor` calls `summarizeProvenanceCoverage` (a pure function)
// to build the verified/unverified/none distribution. Testing the helper
// directly avoids coupling to the full orchestrator mock while still pinning
// the counting contract the doctor check relies on.

import { summarizeProvenanceCoverage } from "./operator-toolkit.js";

function makeMemoryFile(
  id: string,
  provenance: "verified" | "unverified" | "none" | undefined,
): { frontmatter: { provenance?: string } } {
  return {
    frontmatter: {
      ...(provenance ? { provenance } : {}),
    },
  };
}

test("summarizeProvenanceCoverage: mixed distribution — verified/unverified/none/legacy", () => {
  const memories = [
    makeMemoryFile("v1", "verified"),
    makeMemoryFile("v2", "verified"),
    makeMemoryFile("u1", "unverified"),
    makeMemoryFile("n1", "none"),
    makeMemoryFile("legacy", undefined), // legacy — no field → counts as none
  ];
  const result = summarizeProvenanceCoverage(memories);
  assert.deepEqual(result.counts, { verified: 2, unverified: 1, none: 2 });
  assert.equal(result.total, 5);
});

test("summarizeProvenanceCoverage: all legacy → all none", () => {
  const memories = [
    makeMemoryFile("n1", undefined),
    makeMemoryFile("n2", undefined),
  ];
  const result = summarizeProvenanceCoverage(memories);
  assert.deepEqual(result.counts, { verified: 0, unverified: 0, none: 2 });
  assert.equal(result.total, 2);
});

test("summarizeProvenanceCoverage: empty → zero counts", () => {
  const result = summarizeProvenanceCoverage([]);
  assert.deepEqual(result.counts, { verified: 0, unverified: 0, none: 0 });
  assert.equal(result.total, 0);
});

test("summarizeProvenanceCoverage: unknown tag string → counts as none (defensive)", () => {
  const memories = [
    { frontmatter: { provenance: "bogus" } },
  ];
  const result = summarizeProvenanceCoverage(memories);
  assert.deepEqual(result.counts, { verified: 0, unverified: 0, none: 1 });
});
