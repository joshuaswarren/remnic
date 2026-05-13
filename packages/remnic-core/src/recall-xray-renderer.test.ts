import assert from "node:assert/strict";
import { test } from "node:test";

import type { RecallXraySnapshot } from "./recall-xray.js";
import {
  RECALL_XRAY_FORMATS,
  parseXrayFormat,
  renderXray,
  renderXrayJson,
  renderXrayMarkdown,
  renderXrayText,
} from "./recall-xray-renderer.js";

// ─── fixtures ─────────────────────────────────────────────────────────────

function minimalSnapshot(): RecallXraySnapshot {
  return {
    schemaVersion: "1",
    query: "what is my favorite editor?",
    snapshotId: "11111111-1111-1111-1111-111111111111",
    capturedAt: 1_700_000_000_000,
    tierExplain: null,
    results: [],
    filters: [],
    budget: { chars: 4096, used: 0 },
  };
}

function fullSnapshot(): RecallXraySnapshot {
  return {
    schemaVersion: "1",
    query: "what is my favorite editor?",
    snapshotId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    capturedAt: 1_700_000_000_000,
    sessionKey: "sess-42",
    namespace: "workspace-a",
    traceId: "trace-xyz",
    tierExplain: {
      tier: "direct-answer",
      tierReason: "high-trust match",
      filteredBy: ["trustZone", "importance"],
      candidatesConsidered: 7,
      latencyMs: 42,
      sourceAnchors: [
        { path: "facts/tools/editor.md", lineRange: [12, 18] },
        { path: "facts/tools/misc.md" },
      ],
    },
    filters: [
      { name: "namespace", considered: 120, admitted: 30 },
      {
        name: "recall-result-limit",
        considered: 30,
        admitted: 5,
        reason: "cap=5",
      },
    ],
    results: [
      {
        memoryId: "mem-1",
        path: "facts/tools/editor.md",
        servedBy: "direct-answer",
        scoreDecomposition: {
          final: 0.87,
          vector: 0.81,
          bm25: 0.42,
          importance: 0.9,
          mmrPenalty: 0.05,
          tierPrior: 0.2,
        },
        admittedBy: ["namespace", "trustZone", "importance"],
        graphPath: ["mem-root", "mem-1"],
        auditEntryId: "audit-2026-04-20-abc",
      },
      {
        memoryId: "mem-2",
        path: "facts/tools/editor-historical.md",
        servedBy: "hybrid",
        scoreDecomposition: { final: 0.55 },
        admittedBy: ["namespace"],
        rejectedBy: "mmr",
      },
    ],
    budget: { chars: 4096, used: 1234 },
  };
}

// ─── parseXrayFormat ─────────────────────────────────────────────────────

test("parseXrayFormat defaults undefined/null to text", () => {
  assert.equal(parseXrayFormat(undefined), "text");
  assert.equal(parseXrayFormat(null), "text");
});

test("parseXrayFormat accepts each valid format", () => {
  for (const f of RECALL_XRAY_FORMATS) {
    assert.equal(parseXrayFormat(f), f);
  }
});

test("parseXrayFormat accepts case-insensitive strings with surrounding whitespace", () => {
  assert.equal(parseXrayFormat("  JSON  "), "json");
  assert.equal(parseXrayFormat("Markdown"), "markdown");
  assert.equal(parseXrayFormat("TEXT"), "text");
});

test("parseXrayFormat rejects unknown format strings with an options list", () => {
  assert.throws(
    () => parseXrayFormat("xml"),
    /--format expects one of json, text, markdown; got "xml"/,
  );
});

test("parseXrayFormat rejects non-string values", () => {
  assert.throws(
    () => parseXrayFormat(42 as unknown),
    /--format expects one of json, text, markdown; got number/,
  );
});

// ─── renderXrayJson ──────────────────────────────────────────────────────

test("renderXrayJson returns stable envelope for null snapshot", () => {
  const out = renderXrayJson(null);
  const parsed = JSON.parse(out);
  assert.deepEqual(parsed, { schemaVersion: "1", snapshotFound: false });
});

test("renderXrayJson emits snapshotFound=true and preserves snapshot fields", () => {
  const snap = fullSnapshot();
  const out = renderXrayJson(snap);
  const parsed = JSON.parse(out);
  assert.equal(parsed.snapshotFound, true);
  assert.equal(parsed.schemaVersion, "1");
  assert.equal(parsed.snapshotId, snap.snapshotId);
  assert.equal(parsed.query, snap.query);
  assert.equal(parsed.budget.chars, 4096);
  assert.equal(parsed.budget.used, 1234);
  assert.equal(parsed.results.length, 2);
  assert.equal(parsed.filters.length, 2);
  assert.equal(parsed.tierExplain.tier, "direct-answer");
});

// ─── renderXrayText golden ───────────────────────────────────────────────

test("renderXrayText matches golden output for a full snapshot", () => {
  const out = renderXrayText(fullSnapshot());
  const expected = [
    "=== Recall X-ray ===",
    "query: what is my favorite editor?",
    "snapshot-id: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    "captured-at: 2023-11-14T22:13:20.000Z",
    "session: sess-42",
    "namespace: workspace-a",
    "trace-id: trace-xyz",
    "budget: 1234 / 4096 chars",
    "",
    "--- filters ---",
    "- namespace: 30/120 admitted",
    "- recall-result-limit: 5/30 admitted (cap=5)",
    "",
    "--- results ---",
    "[1] mem-1 — served-by=direct-answer",
    "    path: facts/tools/editor.md",
    "    score: final=0.8700 vector=0.8100 bm25=0.4200 importance=0.9000 mmr_penalty=0.0500 tier_prior=0.2000",
    "    admitted-by: namespace, trustZone, importance",
    "    graph-path: mem-root -> mem-1",
    "    audit-entry: audit-2026-04-20-abc",
    "[2] mem-2 — served-by=hybrid",
    "    path: facts/tools/editor-historical.md",
    "    score: final=0.5500",
    "    admitted-by: namespace",
    "    rejected-by: mmr",
    "",
    "--- tier explain ---",
    "tier: direct-answer",
    "reason: high-trust match",
    "candidates-considered: 7",
    "latency-ms: 42",
    "filtered-by: trustZone, importance",
    "source-anchors:",
    "  - facts/tools/editor.md:12-18",
    "  - facts/tools/misc.md",
  ].join("\n");
  assert.equal(out, expected);
});

test("renderXrayText handles the minimal/empty case", () => {
  const out = renderXrayText(minimalSnapshot());
  const expected = [
    "=== Recall X-ray ===",
    "query: what is my favorite editor?",
    "snapshot-id: 11111111-1111-1111-1111-111111111111",
    "captured-at: 2023-11-14T22:13:20.000Z",
    "budget: 0 / 4096 chars",
    "",
    "--- filters ---",
    "(no filter traces recorded)",
    "",
    "--- results ---",
    "(no results admitted)",
    "",
    "--- tier explain ---",
    "(not populated — direct-answer tier disabled or did not fire)",
  ].join("\n");
  assert.equal(out, expected);
});

test("renderXrayText returns a placeholder for a null snapshot", () => {
  const out = renderXrayText(null);
  assert.equal(out, "=== Recall X-ray ===\nNo X-ray snapshot captured.");
});

// ─── renderXrayMarkdown golden ───────────────────────────────────────────

test("renderXrayMarkdown matches golden output for a full snapshot", () => {
  const out = renderXrayMarkdown(fullSnapshot());
  const expected = [
    "# Recall X-ray",
    "",
    "**Query:** `what is my favorite editor?`",
    "",
    "| Field | Value |",
    "| --- | --- |",
    "| Snapshot ID | `aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee` |",
    "| Captured at | 2023-11-14T22:13:20.000Z |",
    "| Session | `sess-42` |",
    "| Namespace | `workspace-a` |",
    "| Trace ID | `trace-xyz` |",
    "| Budget | 1234 / 4096 chars |",
    "",
    "## Filters",
    "",
    "| Filter | Considered | Admitted | Reason |",
    "| --- | ---: | ---: | --- |",
    "| namespace | 120 | 30 |  |",
    "| recall-result-limit | 30 | 5 | cap=5 |",
    "",
    "## Results",
    "",
    "### 1. `mem-1` — served-by=direct-answer",
    "",
    "- **Path:** `facts/tools/editor.md`",
    "- **Score:** final=0.8700 vector=0.8100 bm25=0.4200 importance=0.9000 mmr_penalty=0.0500 tier_prior=0.2000",
    "- **Admitted by:** `namespace`, `trustZone`, `importance`",
    "- **Graph path:** `mem-root` → `mem-1`",
    "- **Audit entry:** `audit-2026-04-20-abc`",
    "",
    "### 2. `mem-2` — served-by=hybrid",
    "",
    "- **Path:** `facts/tools/editor-historical.md`",
    "- **Score:** final=0.5500",
    "- **Admitted by:** `namespace`",
    "- **Rejected by:** `mmr`",
    "",
    "## Tier Explain",
    "",
    "| Field | Value |",
    "| --- | --- |",
    "| Tier | `direct-answer` |",
    "| Reason | high-trust match |",
    "| Candidates considered | 7 |",
    "| Latency (ms) | 42 |",
    "| Filtered by | `trustZone`, `importance` |",
    "",
    "**Source anchors:**",
    "- `facts/tools/editor.md:12-18`",
    "- `facts/tools/misc.md`",
  ].join("\n");
  assert.equal(out, expected);
});

test("renderXrayMarkdown handles the minimal/empty case", () => {
  const out = renderXrayMarkdown(minimalSnapshot());
  const expected = [
    "# Recall X-ray",
    "",
    "**Query:** `what is my favorite editor?`",
    "",
    "| Field | Value |",
    "| --- | --- |",
    "| Snapshot ID | `11111111-1111-1111-1111-111111111111` |",
    "| Captured at | 2023-11-14T22:13:20.000Z |",
    "| Budget | 0 / 4096 chars |",
    "",
    "## Filters",
    "",
    "_No filter traces recorded._",
    "",
    "## Results",
    "",
    "_No results admitted._",
    "",
    "## Tier Explain",
    "",
    "_Not populated — direct-answer tier disabled or did not fire._",
  ].join("\n");
  assert.equal(out, expected);
});

test("renderXrayMarkdown returns a placeholder for a null snapshot", () => {
  const out = renderXrayMarkdown(null);
  assert.equal(out, "# Recall X-ray\n\n_No X-ray snapshot captured._");
});

// ─── renderXray dispatcher ───────────────────────────────────────────────

test("renderXray dispatches to the format-specific renderer", () => {
  const snap = fullSnapshot();
  assert.equal(renderXray(snap, "json"), renderXrayJson(snap));
  assert.equal(renderXray(snap, "text"), renderXrayText(snap));
  assert.equal(renderXray(snap, "markdown"), renderXrayMarkdown(snap));
});

// ─── escaping and edge cases ─────────────────────────────────────────────

test("renderXrayMarkdown escapes pipes in filter names and reasons to keep the table valid", () => {
  const snap: RecallXraySnapshot = {
    ...minimalSnapshot(),
    filters: [
      { name: "ns|pipe", considered: 10, admitted: 2, reason: "why|not" },
    ],
  };
  const out = renderXrayMarkdown(snap);
  assert.ok(out.includes("| ns\\|pipe | 10 | 2 | why\\|not |"));
});

test("renderXray formats scores deterministically to 4 decimals", () => {
  const snap: RecallXraySnapshot = {
    ...minimalSnapshot(),
    results: [
      {
        memoryId: "mem-score",
        path: "p.md",
        servedBy: "hybrid",
        scoreDecomposition: {
          final: 0.123456789,
          vector: 0,
        },
        admittedBy: [],
      },
    ],
  };
  const out = renderXrayText(snap);
  assert.ok(out.includes("final=0.1235 vector=0.0000"));
});

test("renderXrayText surfaces provenance and safety context", () => {
  const snap: RecallXraySnapshot = {
    ...minimalSnapshot(),
    results: [
      {
        memoryId: "mem-provenance",
        path: "facts/provenance.md",
        servedBy: "hybrid",
        scoreDecomposition: { final: 0.88 },
        admittedBy: [],
        provenance: {
          source: "conversation",
          created: "2026-04-20T00:00:00.000Z",
          namespace: "default",
          scope: "namespace:default",
          userContextScopes: ["repo", "private"],
          retrievalReason: "served-by=hybrid",
          confidence: 0.9,
          stale: true,
          corrected: true,
          correctionState: "disputed",
          safeToUse: false,
          safety: "requires-review",
          safetyReasons: ["stale=true", "verification=disputed"],
        },
      },
    ],
  };

  const out = renderXrayText(snap);
  assert.ok(
    out.includes(
      "provenance: source=conversation created=2026-04-20T00:00:00.000Z scope=namespace:default confidence=0.90 stale=true corrected=disputed safe=false",
    ),
  );
  assert.ok(out.includes("retrieval-reason: served-by=hybrid"));
  assert.ok(out.includes("context-scopes: repo, private"));
  assert.ok(out.includes("safety: requires-review (stale=true, verification=disputed)"));
});

test("renderXrayMarkdown surfaces provenance and safety context", () => {
  const snap: RecallXraySnapshot = {
    ...minimalSnapshot(),
    results: [
      {
        memoryId: "mem-provenance",
        path: "facts/provenance.md",
        servedBy: "hybrid",
        scoreDecomposition: { final: 0.88 },
        admittedBy: [],
        provenance: {
          source: "conversation",
          created: "2026-04-20T00:00:00.000Z",
          namespace: "default",
          scope: "namespace:default",
          userContextScopes: ["repo"],
          retrievalReason: "served-by=hybrid",
          confidence: 0.9,
          stale: false,
          corrected: false,
          correctionState: "none",
          safeToUse: true,
          safety: "safe",
          safetyReasons: [],
        },
      },
    ],
  };

  const out = renderXrayMarkdown(snap);
  assert.ok(
    out.includes(
      "**Provenance:** source=conversation created=2026-04-20T00:00:00.000Z scope=namespace:default confidence=0.90 stale=false corrected=false safe=true",
    ),
  );
  assert.ok(out.includes("**Retrieval reason:** `served-by=hybrid`"));
  assert.ok(out.includes("**Context scopes:** `repo`"));
  assert.ok(!out.includes("**Safety:**"));
});

test("renderXray formats non-finite capturedAt as (unknown)", () => {
  const snap: RecallXraySnapshot = {
    ...minimalSnapshot(),
    capturedAt: Number.NaN,
  };
  const text = renderXrayText(snap);
  assert.ok(text.includes("captured-at: (unknown)"));
  const md = renderXrayMarkdown(snap);
  assert.ok(md.includes("| Captured at | (unknown) |"));
});

test("renderXray falls back to (unknown) for out-of-range finite capturedAt", () => {
  // `new Date(1e20).toISOString()` throws RangeError.  The renderer
  // must not crash on corrupted or custom-clock snapshots.
  const snap: RecallXraySnapshot = {
    ...minimalSnapshot(),
    capturedAt: 1e20,
  };
  const text = renderXrayText(snap);
  assert.ok(text.includes("captured-at: (unknown)"));
  const md = renderXrayMarkdown(snap);
  assert.ok(md.includes("| Captured at | (unknown) |"));
  // Sanity: the JSON renderer is untouched — it serializes the raw
  // number because JSON consumers want the value as captured.
  const json = JSON.parse(renderXrayJson(snap));
  assert.equal(json.capturedAt, 1e20);
});

// ─── Issue #681 PR 3/3 — per-edge confidence rendering ────────────────────

test("renderXrayText surfaces per-edge confidences when present", () => {
  const snap = fullSnapshot();
  // Replace first result with one that carries graphEdgeConfidences.
  const augmented: RecallXraySnapshot = {
    ...snap,
    results: [
      {
        ...snap.results[0],
        graphPath: ["mem-root", "mid", "mem-1"],
        graphEdgeConfidences: [0.8, 0.5],
      },
      ...snap.results.slice(1),
    ],
  };
  const out = renderXrayText(augmented);
  assert.ok(
    out.includes("graph-path: mem-root -> mid -> mem-1"),
    "graph-path line should still render",
  );
  assert.ok(
    out.includes("edge-confidences: 0.80, 0.50"),
    "edge-confidences line should render with two-decimal precision",
  );
});

test("renderXrayMarkdown surfaces per-edge confidences when present", () => {
  const snap = fullSnapshot();
  const augmented: RecallXraySnapshot = {
    ...snap,
    results: [
      {
        ...snap.results[0],
        graphPath: ["mem-root", "mid", "mem-1"],
        graphEdgeConfidences: [0.8, 0.5],
      },
      ...snap.results.slice(1),
    ],
  };
  const out = renderXrayMarkdown(augmented);
  assert.ok(out.includes("**Graph path:** `mem-root` → `mid` → `mem-1`"));
  assert.ok(
    out.includes("**Edge confidences:** `0.80`, `0.50`"),
    `markdown should include edge-confidences row, got:\n${out}`,
  );
});

test("renderXrayText omits per-edge confidence line when graphEdgeConfidences absent", () => {
  // Legacy snapshots without confidences must not introduce an empty row.
  const out = renderXrayText(fullSnapshot());
  assert.ok(!out.includes("edge-confidences:"));
});

test("renderXrayText tier-explain block matches shared helper output", async () => {
  // CLAUDE.md rule 22: the tier-explain text block must be a single
  // source of truth shared between recall-explain-renderer and
  // recall-xray-renderer.  Assert the output lines match the shared
  // helper byte-for-byte so a future edit to either surface can't drift
  // without a test failure.
  const { renderTierExplainTextLines } = await import(
    "./recall-explain-renderer.js"
  );
  const snap = fullSnapshot();
  const text = renderXrayText(snap);
  const sharedLines = renderTierExplainTextLines(snap.tierExplain ?? null);
  for (const line of sharedLines) {
    assert.ok(
      text.includes(line),
      `xray text is missing shared tier-explain line: ${line}`,
    );
  }

  // Also exercise the null-tierExplain branch.
  const nullSnap: RecallXraySnapshot = {
    ...minimalSnapshot(),
    tierExplain: null,
  };
  const nullText = renderXrayText(nullSnap);
  const nullShared = renderTierExplainTextLines(null);
  for (const line of nullShared) {
    assert.ok(nullText.includes(line));
  }
});
