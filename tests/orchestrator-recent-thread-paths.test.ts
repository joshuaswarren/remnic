import test from "node:test";
import assert from "node:assert/strict";

import {
  appendMemoryToGraphContext,
  buildMemoryPathById,
  resolvePersistedMemoryRelativePath,
  resolveRecentThreadMemoryPaths,
} from "../src/orchestrator.js";
import type { MemoryFile } from "../src/types.js";

function makeMemory(path: string, id: string): MemoryFile {
  return {
    path,
    content: "x",
    frontmatter: {
      id,
      category: "fact",
      confidence: 0.8,
      confidenceTier: "explicit",
      created: "2026-02-22T10:00:00.000Z",
      updated: "2026-02-22T10:00:00.000Z",
      tags: [],
      source: "extraction",
      status: "active",
    },
  };
}

test("resolveRecentThreadMemoryPaths uses real memory paths from allMemsForGraph", () => {
  const storageDir = "/tmp/memory";
  const allMems: MemoryFile[] = [
    makeMemory("/tmp/memory/facts/2026-02-22/fact-a.md", "fact-a"),
    makeMemory("/tmp/memory/corrections/correction-b.md", "correction-b"),
    makeMemory("/tmp/memory/facts/2026-02-21/fact-c.md", "fact-c"),
  ];

  const recent = resolveRecentThreadMemoryPaths({
    threadEpisodeIds: ["fact-a", "correction-b", "fact-c", "current-id"],
    currentMemoryId: "current-id",
    allMemsForGraph: allMems,
    storageDir,
    maxRecent: 3,
  });

  assert.deepEqual(recent, [
    "facts/2026-02-22/fact-a.md",
    "corrections/correction-b.md",
    "facts/2026-02-21/fact-c.md",
  ]);
});

test("resolveRecentThreadMemoryPaths drops unknown IDs instead of fabricating facts/ paths", () => {
  const storageDir = "/tmp/memory";
  const allMems: MemoryFile[] = [makeMemory("/tmp/memory/corrections/correction-b.md", "correction-b")];

  const recent = resolveRecentThreadMemoryPaths({
    threadEpisodeIds: ["missing-id", "correction-b"],
    currentMemoryId: "current-id",
    allMemsForGraph: allMems,
    storageDir,
    maxRecent: 3,
  });

  assert.deepEqual(recent, ["corrections/correction-b.md"]);
});

test("resolveRecentThreadMemoryPaths returns [] when maxRecent is 0", () => {
  const storageDir = "/tmp/memory";
  const allMems: MemoryFile[] = [
    makeMemory("/tmp/memory/facts/2026-02-22/fact-a.md", "fact-a"),
    makeMemory("/tmp/memory/corrections/correction-b.md", "correction-b"),
  ];

  const recent = resolveRecentThreadMemoryPaths({
    threadEpisodeIds: ["fact-a", "correction-b"],
    currentMemoryId: "current-id",
    allMemsForGraph: allMems,
    storageDir,
    maxRecent: 0,
  });

  assert.deepEqual(recent, []);
});

test("resolveRecentThreadMemoryPaths can use prebuilt path map without rescanning memories", () => {
  const pathById = new Map<string, string>([
    ["fact-a", "facts/2026-02-22/fact-a.md"],
    ["correction-b", "corrections/correction-b.md"],
  ]);
  const recent = resolveRecentThreadMemoryPaths({
    threadEpisodeIds: ["fact-a", "correction-b"],
    currentMemoryId: "current-id",
    allMemsForGraph: null,
    pathById,
    storageDir: "/tmp/memory",
    maxRecent: 2,
  });

  assert.deepEqual(recent, ["facts/2026-02-22/fact-a.md", "corrections/correction-b.md"]);
});

test("resolvePersistedMemoryRelativePath prefers persisted path over fallback", () => {
  const memoryId = "fact-123";
  const storageDir = "/tmp/memory";
  const relPath = "facts/2026-02-21/fact-123.md";
  const pathById = buildMemoryPathById(
    [makeMemory(`/tmp/memory/${relPath}`, memoryId)],
    storageDir,
  );
  const resolved = resolvePersistedMemoryRelativePath({
    memoryId,
    pathById,
    category: "fact",
  });

  assert.equal(resolved, relPath);
});

test("resolvePersistedMemoryRelativePath falls back when memory ID is missing", () => {
  const ts = Date.parse("2026-02-22T12:00:00.000Z");
  const memoryId = `fact-${ts}-9999`;
  const resolved = resolvePersistedMemoryRelativePath({
    memoryId,
    pathById: new Map(),
    category: "fact",
  });

  assert.equal(resolved, `facts/2026-02-22/${memoryId}.md`);
});

test("resolvePersistedMemoryRelativePath uses corrections directory for correction category", () => {
  const memoryId = "correction-1763850000000-zzzz";
  const resolved = resolvePersistedMemoryRelativePath({
    memoryId,
    pathById: new Map(),
    category: "correction",
  });

  assert.equal(resolved, `corrections/${memoryId}.md`);
});

test("resolvePersistedMemoryRelativePath routes a decision into decisions/<date>/ (issue #1546)", () => {
  const ts = Date.parse("2026-02-22T12:00:00.000Z");
  const memoryId = `decision-${ts}-abcd`;
  const resolved = resolvePersistedMemoryRelativePath({
    memoryId,
    pathById: new Map(),
    category: "decision",
  });

  // The fallback dir must match StorageManager.writeMemory's category-dir
  // routing so graph edges point at the file's real location.
  assert.equal(resolved, `decisions/2026-02-22/${memoryId}.md`);
});

test("resolvePersistedMemoryRelativePath preserves reasoning-traces/ subtree", () => {
  const ts = Date.parse("2026-02-22T12:00:00.000Z");
  const memoryId = `reasoning_trace-${ts}-wxyz`;
  const resolved = resolvePersistedMemoryRelativePath({
    memoryId,
    pathById: new Map(),
    category: "reasoning_trace",
  });

  assert.equal(resolved, `reasoning-traces/2026-02-22/${memoryId}.md`);
});

test("appendMemoryToGraphContext adds newly written memory for same-run graph linking", () => {
  const allMems: MemoryFile[] = [];
  appendMemoryToGraphContext({
    allMemsForGraph: allMems,
    storageDir: "/tmp/memory",
    memoryRelPath: "facts/2026-02-22/fact-a.md",
    memoryId: "fact-a",
    category: "fact",
    content: "alpha",
    entityRef: "project-openclaw",
  });

  assert.equal(allMems.length, 1);
  assert.equal(allMems[0].path, "/tmp/memory/facts/2026-02-22/fact-a.md");
  assert.equal(allMems[0].frontmatter.id, "fact-a");
  assert.equal(allMems[0].frontmatter.entityRef, "project-openclaw");
});

test("appendMemoryToGraphContext is no-op when graph context list is unavailable", () => {
  assert.doesNotThrow(() => {
    appendMemoryToGraphContext({
      allMemsForGraph: null,
      storageDir: "/tmp/memory",
      memoryRelPath: "facts/2026-02-22/fact-a.md",
      memoryId: "fact-a",
      category: "fact",
      content: "alpha",
      entityRef: "project-openclaw",
    });
  });
});

test("resolveRecentThreadMemoryPaths skips pending_review memories so no predecessor edge references an unfaithful memory (#1635)", () => {
  const storageDir = "/tmp/memory";
  const allMems: MemoryFile[] = [
    makeMemory("/tmp/memory/facts/2026-02-22/active.md", "active"),
    {
      ...makeMemory("/tmp/memory/facts/2026-02-22/pending.md", "pending"),
      frontmatter: {
        ...makeMemory("/tmp/memory/facts/2026-02-22/pending.md", "pending")
          .frontmatter,
        status: "pending_review",
      },
    },
  ];

  const recent = resolveRecentThreadMemoryPaths({
    threadEpisodeIds: ["active", "pending", "current-id"],
    currentMemoryId: "current-id",
    allMemsForGraph: allMems,
    storageDir,
    maxRecent: 3,
  });

  // The pending_review id is present in the (legacy) thread episode set and
  // IS locatable in allMemsForGraph, but it must be excluded so no graph
  // predecessor edge is ever built to an unfaithful memory.
  assert.deepEqual(recent, ["facts/2026-02-22/active.md"]);
});
