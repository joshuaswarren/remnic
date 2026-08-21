import assert from "node:assert/strict";
import { test } from "node:test";

import { PARALLEL_AGENT_WEIGHTS, mergeWithAgentResults } from "./retrieval-agents.js";
import type { ParallelSearchResult } from "./retrieval-agents.js";
import type { QmdSearchResult } from "./types.js";

const P = "/abs/mem/a.md";

function contextual(namespace: string | undefined, snippet: string, score: number): QmdSearchResult {
  return { docid: "a", path: P, namespace, snippet, score, transport: "hybrid" };
}

function direct(namespace: string | undefined, score: number): ParallelSearchResult {
  return { docid: "a", path: P, namespace, snippet: "", score, transport: "scoped_prefilter", agentSource: "direct" };
}

// (a) Same resolved namespace + same path → ONE merged entry, snippet + weighted score preserved.
test("collapses direct + contextual for same (namespace, path) via resolver", async () => {
  const merged = await mergeWithAgentResults(
    [contextual("shared", "ctx", 1)],
    [direct(undefined, 1)],
    [],
    PARALLEL_AGENT_WEIGHTS,
    10,
    undefined,
    () => "shared",
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].namespace, "shared");
  // Higher-weighted direct (1.0) wins the score but the contextual snippet is preserved.
  assert.equal(merged[0].score, 1 * PARALLEL_AGENT_WEIGHTS.direct);
  assert.equal(merged[0].snippet, "ctx");
});

// Regression guard for the bug: without namespace normalization the same memory
// would occupy two keys ("shared\0P" and "\0P") and be injected twice.
test("without resolver an unstamped direct hit double-counts (the bug the resolver fixes)", async () => {
  const withoutResolver = await mergeWithAgentResults(
    [contextual("shared", "ctx", 1)],
    [direct(undefined, 1)],
    [],
    PARALLEL_AGENT_WEIGHTS,
    10,
    undefined,
  );
  assert.equal(withoutResolver.length, 2);
});

// (b) Same path but DIFFERENT resolved namespaces stay DISTINCT.
test("keeps two same-path results under different namespaces distinct", async () => {
  const merged = await mergeWithAgentResults(
    [contextual("projA", "a", 1), contextual("projB", "b", 1)],
    [direct("projA", 1)],
    [],
    PARALLEL_AGENT_WEIGHTS,
    10,
    undefined,
    () => "projA",
  );
  assert.equal(merged.length, 2);
  const namespaces = merged.map((r) => r.namespace).sort();
  assert.deepEqual(namespaces, ["projA", "projB"]);
});

// (c) Results genuinely lacking any namespace behave as before (single "" bucket).
test("namespace-less results merge on path alone, unchanged behavior", async () => {
  const merged = await mergeWithAgentResults(
    [contextual(undefined, "ctx", 1)],
    [direct(undefined, 1)],
    [],
    PARALLEL_AGENT_WEIGHTS,
    10,
    undefined,
    () => "",
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].namespace ?? "", "");
});
