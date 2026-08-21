import test from "node:test";
import assert from "node:assert/strict";

import {
  renderMemoryMd,
  validateMemoryMd,
} from "../src/connectors/codex-materialize.js";
import type { MemoryFile } from "../src/types.js";

function makeMemory(overrides: {
  id?: string;
  category?: string;
  content?: string;
  tags?: string[];
}): MemoryFile {
  const id = overrides.id ?? `syn-${Math.random().toString(36).slice(2, 8)}`;
  return {
    path: `/tmp/remnic-test/facts/${id}.md`,
    frontmatter: {
      id,
      category: (overrides.category ?? "fact") as any,
      created: "2026-04-01T00:00:00Z",
      updated: "2026-04-01T00:00:00Z",
      source: "synthetic-test",
      confidence: 0.8,
      confidenceTier: "implied",
      tags: overrides.tags ?? [],
    } as any,
    content: overrides.content ?? "synthetic content",
  };
}

test("validateMemoryMd accepts rendered output with multiple categories", () => {
  const memories = [
    makeMemory({ id: "f-1", category: "fact", content: "Synthetic fact A.", tags: ["alpha"] }),
    makeMemory({ id: "p-1", category: "preference", content: "Synthetic preference A.", tags: ["beta"] }),
    makeMemory({ id: "c-1", category: "correction", content: "Synthetic correction A." }),
    makeMemory({ id: "d-1", category: "decision", content: "Synthetic decision A." }),
  ];

  const rendered = renderMemoryMd({
    namespace: "schema-ns",
    memories,
    rolloutSummaries: [
      {
        slug: "session-1",
        cwd: "/fake",
        rolloutPath: "/fake/rollout.jsonl",
        updatedAt: "2026-04-01T00:00:00Z",
        threadId: "synthetic-thread",
        body: "Synthetic recap.",
      },
    ],
  });

  const validation = validateMemoryMd(rendered);
  if (!validation.valid) {
    // Surface errors clearly on failure.
    assert.fail(`schema validation failed: ${validation.errors.join("; ")}`);
  }

  assert.match(rendered, /^# Task Group: schema-ns/u);
  assert.match(rendered, /^scope:\s+/mu);
  assert.match(rendered, /^applies_to:\s+/mu);
  assert.match(rendered, /^## Task 1:/mu);
  assert.match(rendered, /^### rollout_summary_files$/mu);
  assert.match(rendered, /^### keywords$/mu);
  assert.match(rendered, /^## User preferences$/mu);
  assert.match(rendered, /^## Reusable knowledge$/mu);
  assert.match(rendered, /^## Failures and how to do differently$/mu);
});

test("validateMemoryMd accepts the empty-namespace baseline rendering", () => {
  const rendered = renderMemoryMd({
    namespace: "empty-ns",
    memories: [],
    rolloutSummaries: [],
  });
  const validation = validateMemoryMd(rendered);
  assert.equal(validation.valid, true, validation.errors.join("; "));
  // Baseline task block must still be present so Codex's reader has
  // something to anchor on.
  assert.match(rendered, /^## Task 1:/mu);
});

test("validateMemoryMd rejects content missing the Task Group header", () => {
  const broken = [
    "scope: x",
    "applies_to: y",
    "",
    "## Task 1: x",
    "",
    "### rollout_summary_files",
    "- (none)",
    "",
    "### keywords",
    "- x",
    "",
    "## User preferences",
    "- x",
    "",
    "## Reusable knowledge",
    "- x",
    "",
    "## Failures and how to do differently",
    "- x",
    "",
  ].join("\n");
  const validation = validateMemoryMd(broken);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((e) => e.includes("Task Group")));
});

test("validateMemoryMd rejects content missing required bottom sections", () => {
  const broken = [
    "# Task Group: x",
    "scope: x",
    "applies_to: y",
    "",
    "## Task 1: x",
    "",
    "### rollout_summary_files",
    "- (none)",
    "",
    "### keywords",
    "- x",
    "",
  ].join("\n");
  const validation = validateMemoryMd(broken);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((e) => e.includes("User preferences")));
  assert.ok(validation.errors.some((e) => e.includes("Reusable knowledge")));
  assert.ok(validation.errors.some((e) => e.includes("Failures and how to do differently")));
});

test("validateMemoryMd rejects a task block missing required sub-headers", () => {
  const broken = [
    "# Task Group: x",
    "scope: x",
    "applies_to: y",
    "",
    "## Task 1: missing subheaders",
    "some body",
    "",
    "## User preferences",
    "- x",
    "",
    "## Reusable knowledge",
    "- x",
    "",
    "## Failures and how to do differently",
    "- x",
    "",
  ].join("\n");
  const validation = validateMemoryMd(broken);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((e) => e.includes("rollout_summary_files")));
  assert.ok(validation.errors.some((e) => e.includes("keywords")));
});
