import test from "node:test";
import assert from "node:assert/strict";
import {
  findSimilarClusters,
  buildConsolidationPrompt,
  parseConsolidationResponse,
} from "../src/semantic-consolidation.ts";
import type { MemoryFile } from "../src/types.ts";

function makeMemory(overrides: Partial<MemoryFile> & { id?: string; category?: string; content?: string; status?: string }): MemoryFile {
  const id = overrides.id ?? `fact-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const category = overrides.category ?? "fact";
  return {
    path: `/memory/facts/${id}.md`,
    frontmatter: {
      id,
      category: category as any,
      created: "2026-03-20T10:00:00Z",
      updated: "2026-03-20T10:00:00Z",
      source: "extraction",
      confidence: 0.8,
      confidenceTier: "implied",
      tags: [],
      ...(overrides.status ? { status: overrides.status as any } : {}),
      ...(overrides.frontmatter ?? {}),
    } as any,
    content: overrides.content ?? "some memory content",
  };
}

// ─── findSimilarClusters ─────────────────────────────────────────────────────

test("findSimilarClusters returns empty for no memories", () => {
  const clusters = findSimilarClusters([], {
    threshold: 0.8,
    minClusterSize: 3,
    excludeCategories: [],
    maxPerRun: 100,
  });
  assert.equal(clusters.length, 0);
});

test("findSimilarClusters groups similar memories by token overlap above threshold", () => {
  // Three memories with very similar content (high overlap)
  const memories = [
    makeMemory({ id: "fact-001", content: "Joshua prefers TypeScript for backend development projects" }),
    makeMemory({ id: "fact-002", content: "Joshua prefers TypeScript for backend development work" }),
    makeMemory({ id: "fact-003", content: "Joshua prefers TypeScript for backend development tasks" }),
  ];

  const clusters = findSimilarClusters(memories, {
    threshold: 0.5,
    minClusterSize: 3,
    excludeCategories: [],
    maxPerRun: 100,
  });

  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].memories.length, 3);
  assert.equal(clusters[0].category, "fact");
});

test("findSimilarClusters respects minClusterSize", () => {
  // Only 2 similar memories but minClusterSize = 3
  const memories = [
    makeMemory({ id: "fact-001", content: "Joshua prefers TypeScript for backend development projects" }),
    makeMemory({ id: "fact-002", content: "Joshua prefers TypeScript for backend development work" }),
  ];

  const clusters = findSimilarClusters(memories, {
    threshold: 0.5,
    minClusterSize: 3,
    excludeCategories: [],
    maxPerRun: 100,
  });

  assert.equal(clusters.length, 0);
});

test("findSimilarClusters excludes specified categories", () => {
  const memories = [
    makeMemory({ id: "corr-001", category: "correction", content: "Joshua prefers TypeScript for backend development" }),
    makeMemory({ id: "corr-002", category: "correction", content: "Joshua prefers TypeScript for backend development work" }),
    makeMemory({ id: "corr-003", category: "correction", content: "Joshua prefers TypeScript for backend development tasks" }),
  ];

  const clusters = findSimilarClusters(memories, {
    threshold: 0.5,
    minClusterSize: 3,
    excludeCategories: ["correction"],
    maxPerRun: 100,
  });

  assert.equal(clusters.length, 0);
});

test("findSimilarClusters respects maxPerRun limit", () => {
  // Create two groups of 3 similar memories each
  const memories = [
    makeMemory({ id: "fact-001", content: "Joshua prefers TypeScript for backend development projects" }),
    makeMemory({ id: "fact-002", content: "Joshua prefers TypeScript for backend development work" }),
    makeMemory({ id: "fact-003", content: "Joshua prefers TypeScript for backend development tasks" }),
    makeMemory({ id: "fact-004", content: "The application uses PostgreSQL database for storage layer" }),
    makeMemory({ id: "fact-005", content: "The application uses PostgreSQL database for storage system" }),
    makeMemory({ id: "fact-006", content: "The application uses PostgreSQL database for storage backend" }),
  ];

  // maxPerRun=3 should stop after the first cluster
  const clusters = findSimilarClusters(memories, {
    threshold: 0.5,
    minClusterSize: 3,
    excludeCategories: [],
    maxPerRun: 3,
  });

  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].memories.length, 3);
});

test("findSimilarClusters skips archived/non-active memories", () => {
  const memories = [
    makeMemory({ id: "fact-001", content: "Joshua prefers TypeScript for backend development projects", status: "archived" }),
    makeMemory({ id: "fact-002", content: "Joshua prefers TypeScript for backend development work", status: "archived" }),
    makeMemory({ id: "fact-003", content: "Joshua prefers TypeScript for backend development tasks", status: "archived" }),
  ];

  const clusters = findSimilarClusters(memories, {
    threshold: 0.5,
    minClusterSize: 3,
    excludeCategories: [],
    maxPerRun: 100,
  });

  assert.equal(clusters.length, 0);
});

test("findSimilarClusters does not cluster dissimilar memories", () => {
  const memories = [
    makeMemory({ id: "fact-001", content: "Joshua prefers TypeScript for backend development" }),
    makeMemory({ id: "fact-002", content: "The weather in Austin is hot during summer months" }),
    makeMemory({ id: "fact-003", content: "Docker containers provide isolation for microservices" }),
  ];

  const clusters = findSimilarClusters(memories, {
    threshold: 0.8,
    minClusterSize: 3,
    excludeCategories: [],
    maxPerRun: 100,
  });

  assert.equal(clusters.length, 0);
});

// ─── buildConsolidationPrompt ────────────────────────────────────────────────

test("buildConsolidationPrompt includes all memory contents", () => {
  const cluster = {
    category: "fact",
    memories: [
      makeMemory({ id: "fact-001", content: "Joshua likes TypeScript" }),
      makeMemory({ id: "fact-002", content: "Joshua prefers TypeScript for backends" }),
    ],
    overlapScore: 0.85,
  };

  const prompt = buildConsolidationPrompt(cluster);

  assert.ok(prompt.includes("Joshua likes TypeScript"));
  assert.ok(prompt.includes("Joshua prefers TypeScript for backends"));
  assert.ok(prompt.includes("fact-001"));
  assert.ok(prompt.includes("fact-002"));
  assert.ok(prompt.includes('"fact"'));
  assert.ok(prompt.includes("2 memories"));
});

test("buildConsolidationPrompt includes category and IDs", () => {
  const cluster = {
    category: "preference",
    memories: [
      makeMemory({ id: "pref-001", category: "preference", content: "User prefers dark mode" }),
      makeMemory({ id: "pref-002", category: "preference", content: "User likes dark mode theme" }),
      makeMemory({ id: "pref-003", category: "preference", content: "User wants dark mode enabled" }),
    ],
    overlapScore: 0.9,
  };

  const prompt = buildConsolidationPrompt(cluster);

  assert.ok(prompt.includes('"preference"'));
  assert.ok(prompt.includes("pref-001"));
  assert.ok(prompt.includes("pref-002"));
  assert.ok(prompt.includes("pref-003"));
  assert.ok(prompt.includes("3 memories"));
});

// ─── parseConsolidationResponse ──────────────────────────────────────────────

test("parseConsolidationResponse trims whitespace", () => {
  const response = "  The consolidated memory content here.  \n\n";
  const result = parseConsolidationResponse(response);
  assert.equal(result, "The consolidated memory content here.");
});
