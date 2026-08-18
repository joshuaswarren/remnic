import assert from "node:assert/strict";
import { test } from "node:test";

import type { LastRecallSnapshot } from "./recall-state.js";
import {
  parseRecallExplainFormat,
  renderRecallExplain,
  toRecallXraySnapshotFromLegacy,
} from "./recall-explain-renderer.js";

function legacySnapshot(
  overrides: Partial<LastRecallSnapshot> = {},
): LastRecallSnapshot {
  return {
    sessionKey: "sess-42",
    recordedAt: "2023-11-14T22:13:20.000Z",
    queryHash: "deadbeef",
    queryLen: 21,
    memoryIds: ["mem-1", "mem-2"],
    includedMemories: [
      { id: "mem-1", path: "" },
      { id: "mem-2", path: "" },
    ],
    source: "hot_qmd",
    sourcesUsed: ["hot_qmd", "memories"],
    namespace: "workspace-a",
    latencyMs: 42,
    ...overrides,
  };
}

// ─── parseRecallExplainFormat ────────────────────────────────────────────

test("parseRecallExplainFormat accepts the original text+json formats", () => {
  assert.equal(parseRecallExplainFormat("text"), "text");
  assert.equal(parseRecallExplainFormat("json"), "json");
});

test("parseRecallExplainFormat accepts the new markdown format", () => {
  assert.equal(parseRecallExplainFormat("markdown"), "markdown");
  assert.equal(parseRecallExplainFormat("  MARKDOWN  "), "markdown");
});

test("parseRecallExplainFormat rejects unknown formats with a listed-options error", () => {
  assert.throws(
    () => parseRecallExplainFormat("xml"),
    /--format expects "text", "json", or "markdown"/,
  );
});

test("parseRecallExplainFormat defaults to text when absent", () => {
  assert.equal(parseRecallExplainFormat(undefined), "text");
  assert.equal(parseRecallExplainFormat(null), "text");
});

// ─── backward compatibility: text + json unchanged ───────────────────────

test("renderRecallExplain text output is unchanged from pre-#570 behavior", () => {
  const out = renderRecallExplain(legacySnapshot(), "text");
  assert.ok(out.startsWith("=== Recall Explain ==="));
  assert.ok(out.includes("session: sess-42"));
  assert.ok(out.includes("source: hot_qmd"));
  assert.ok(out.includes("memories: mem-1, mem-2"));
  // The tier-explain section is absent because legacy snapshot has
  // no tierExplain field populated.
  assert.ok(out.includes("tier-explain: (not populated"));
});

test("renderRecallExplain json output is unchanged JSON shape", () => {
  const out = renderRecallExplain(legacySnapshot(), "json");
  const parsed = JSON.parse(out);
  assert.equal(parsed.hasExplain, false);
  assert.equal(parsed.snapshotFound, true);
  assert.equal(parsed.sessionKey, "sess-42");
  assert.deepEqual(parsed.memoryIds, ["mem-1", "mem-2"]);
});

// ─── markdown delegation ─────────────────────────────────────────────────

test("renderRecallExplain markdown delegates to the shared X-ray renderer", () => {
  const out = renderRecallExplain(legacySnapshot(), "markdown");
  // X-ray markdown always opens with an H1.
  assert.ok(out.startsWith("# Recall X-ray"));
  // Session + namespace from the legacy snapshot round-trip into the
  // markdown table.
  assert.ok(out.includes("| Session | `sess-42` |"));
  assert.ok(out.includes("| Namespace | `workspace-a` |"));
  // Memory ids become H3 result sections.
  assert.ok(out.includes("### 1. `mem-1` — served-by=hybrid"));
  assert.ok(out.includes("### 2. `mem-2` — served-by=hybrid"));
});

test("renderRecallExplain markdown handles null snapshot via the renderer's placeholder", () => {
  const out = renderRecallExplain(null, "markdown");
  assert.equal(out, "# Recall X-ray\n\n_No X-ray snapshot captured._");
});

// ─── toRecallXraySnapshotFromLegacy adapter ──────────────────────────────

test("toRecallXraySnapshotFromLegacy returns null for a null input", () => {
  assert.equal(toRecallXraySnapshotFromLegacy(null), null);
});

test("toRecallXraySnapshotFromLegacy translates recordedAt to capturedAt epoch ms", () => {
  const xray = toRecallXraySnapshotFromLegacy(legacySnapshot());
  assert.ok(xray);
  assert.equal(xray?.capturedAt, 1_700_000_000_000);
});

test("toRecallXraySnapshotFromLegacy preserves session / namespace / memory ids", () => {
  const xray = toRecallXraySnapshotFromLegacy(legacySnapshot());
  assert.equal(xray?.sessionKey, "sess-42");
  assert.equal(xray?.namespace, "workspace-a");
  assert.equal(xray?.results.length, 2);
  assert.equal(xray?.results[0]?.memoryId, "mem-1");
});

test("toRecallXraySnapshotFromLegacy copes with malformed recordedAt", () => {
  const xray = toRecallXraySnapshotFromLegacy(
    legacySnapshot({ recordedAt: "not-a-date" }),
  );
  assert.equal(xray?.capturedAt, 0);
});

test("toRecallXraySnapshotFromLegacy propagates snapshot.source to servedBy", () => {
  // Codex P2 + Cursor Medium on #605: every converted result used to
  // be stamped with `servedBy: "hybrid"`, misattributing legacy
  // snapshots from a non-hybrid source (notably `recent_scan`).
  const recent = toRecallXraySnapshotFromLegacy(
    legacySnapshot({ source: "recent_scan" }),
  );
  assert.equal(recent?.results[0]?.servedBy, "recent-scan");
  assert.equal(recent?.results[1]?.servedBy, "recent-scan");

  for (const source of ["hot_qmd", "hot_embedding", "cold_fallback", "none"]) {
    const xray = toRecallXraySnapshotFromLegacy(legacySnapshot({ source }));
    assert.equal(xray?.results[0]?.servedBy, "hybrid", `source=${source}`);
  }
  const unknown = toRecallXraySnapshotFromLegacy(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    legacySnapshot({ source: "future_tier" as any }),
  );
  assert.equal(unknown?.results[0]?.servedBy, "hybrid");
});
