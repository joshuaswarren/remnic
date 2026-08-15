import assert from "node:assert/strict";
import test from "node:test";

import {
  approximateTokenCount,
  renderMemorySummary,
  truncateToTokenBudget,
} from "../src/connectors/codex-materialize.js";
import type { MemoryFile } from "../src/types.js";

function makeMemory(content: string, id: string): MemoryFile {
  return {
    path: `/tmp/remnic-test/facts/${id}.md`,
    frontmatter: {
      id,
      category: "fact" as any,
      created: "2026-04-01T00:00:00Z",
      updated: "2026-04-01T00:00:00Z",
      source: "synthetic-test",
      confidence: 0.9,
      confidenceTier: "implied",
      tags: [],
    } as any,
    content,
  };
}

test("approximateTokenCount uses the shared script-aware estimate", () => {
  assert.equal(approximateTokenCount(""), 0);
  assert.equal(approximateTokenCount("one"), 1);
  assert.equal(approximateTokenCount("one two three"), 4);
  assert.equal(approximateTokenCount("日本語の記憶"), 6);
});

test("truncateToTokenBudget leaves small content alone", () => {
  const text = "one two three four";
  assert.equal(truncateToTokenBudget(text, 100), text);
});

test("truncateToTokenBudget drops trailing content over budget", () => {
  const text = "one two three four five six seven eight nine ten eleven twelve";
  const result = truncateToTokenBudget(text, 5);
  assert.ok(approximateTokenCount(result) <= 5);
  assert.match(result, /truncated/u);
});

test("renderMemorySummary stays under the configured token budget", () => {
  // Create a lot of long synthetic memories so the base rendering blows the
  // budget without truncation.
  const memories: MemoryFile[] = [];
  for (let i = 0; i < 200; i++) {
    memories.push(
      makeMemory(
        `synthetic memory payload item number ${i} with filler words intended to inflate the whitespace token count beyond the summary budget used by codex cli`,
        `syn-${i}`,
      ),
    );
  }

  const budget = 120;
  const rendered = renderMemorySummary({
    namespace: "token-ns",
    memories,
    rolloutSummaries: [],
    maxTokens: budget,
  });

  assert.ok(
    approximateTokenCount(rendered) <= budget,
    `rendered token count ${approximateTokenCount(rendered)} exceeds budget ${budget}`,
  );
});

test("truncateToTokenBudget reserves enough headroom for the truncation marker", () => {
  // Regression (Cursor Bugbot on #392): the line-preserving path used to
  // reserve only 1 token for a ~4-token marker, forcing the hard-cut
  // fallback that flattens the entire output. Verify the line-preserving
  // path actually preserves line structure when the budget is tight but
  // comfortable.
  const text = [
    "# header",
    "line one with filler",
    "line two with filler",
    "line three with filler",
    "line four with filler",
    "line five with filler",
  ].join("\n");
  const result = truncateToTokenBudget(text, 10);
  // Stays under budget — the marker's token cost is accounted for.
  assert.ok(
    approximateTokenCount(result) <= 10,
    `token count ${approximateTokenCount(result)} exceeds budget 10`,
  );
  // Line structure preserved (the result still contains a newline) — if
  // the old hard-cut fallback ran we'd see no newlines at all.
  assert.match(result, /\n/u);
});

test("renderMemorySummary honors maxTokens=0 by emitting no summary body", () => {
  // Regression (Codex on #392): maxTokens=0 used to be silently reset to the
  // 4500-token default. A zero-token budget must actually produce an empty
  // body.
  const rendered = renderMemorySummary({
    namespace: "zero-budget-ns",
    memories: [makeMemory("synthetic long enough memory body text", "zero-1")],
    rolloutSummaries: [],
    maxTokens: 0,
  });
  assert.equal(rendered, "");
});

test("renderMemorySummary with default budget stays under Codex's 5000-token cap", () => {
  const memories: MemoryFile[] = [];
  for (let i = 0; i < 50; i++) {
    memories.push(makeMemory(`synthetic memory line ${i} with a few filler tokens`, `syn-${i}`));
  }

  const rendered = renderMemorySummary({
    namespace: "default-budget-ns",
    memories,
    rolloutSummaries: [],
    maxTokens: 4500, // matches the config default
  });
  assert.ok(approximateTokenCount(rendered) < 5000);
});
