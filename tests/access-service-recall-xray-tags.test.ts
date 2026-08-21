/**
 * Integration tests for per-result `tags` on `RecallXrayResult` and the
 * tag-filter trace in `snapshot.filters` (issue #689 PR 3/3).
 *
 * Acceptance criteria:
 *   1. `RecallXrayResult.tags` is populated from memory frontmatter when an
 *      X-ray recall runs with a tag filter.
 *   2. `snapshot.filters` contains a `tag-filter` entry showing the correct
 *      `considered` / `admitted` counts.
 *   3. Results excluded by the tag filter do not appear in `snapshot.results`.
 *   4. Per-result `tags` is propagated correctly through `cloneResult` in
 *      `buildXraySnapshot` / `RecallXrayBuilder`.
 *
 * These tests use lightweight orchestrator stubs (mirrors the pattern in
 * `tests/access-service-recall-xray.test.ts`) so no live QMD or OpenAI
 * connection is needed.
 */

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import { EngramAccessService } from "../src/access-service.js";
import { Orchestrator } from "../src/orchestrator.js";
import { XrayCaptureQueue } from "../packages/remnic-core/src/orchestration/xray-capture-queue.js";
import type { RecallXraySnapshot, RecallXrayResult } from "../src/recall-xray.js";
import { buildXraySnapshot } from "../src/recall-xray.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeXrayResult(
  overrides: Partial<RecallXrayResult> & { path: string; memoryId: string },
): RecallXrayResult {
  return {
    servedBy: "hybrid",
    scoreDecomposition: { final: 0.8 },
    admittedBy: ["importance-gate"],
    ...overrides,
  };
}

function fakeSnapshot(
  overrides: Partial<RecallXraySnapshot> = {},
): RecallXraySnapshot {
  const results = overrides.results ?? [];
  return {
    schemaVersion: "1",
    query: "q",
    snapshotId: "snap-1",
    capturedAt: 1_700_000_000_000,
    tierExplain: null,
    results,
    appliedResultLimit: results.length,
    appliedResults: results,
    headroomResults: [],
    filters: [],
    budget: { chars: 4096, used: 0 },
    ...overrides,
  };
}

/**
 * Build a stub orchestrator whose `getStorage` returns a fake StorageManager
 * that resolves `readMemoryByPath` from a provided map of path → tags.
 */
function stubOrchestrator(opts: {
  snapshot?: RecallXraySnapshot | null;
  pathToTags?: Record<string, string[]>;
}) {
  const state = {
    clearedSnapshot: 0,
    snapshot: opts.snapshot ?? null,
  };
  const pathToTags = opts.pathToTags ?? {};

  const orchestrator = {
    recallWithXrayCapture: Orchestrator.prototype.recallWithXrayCapture,
    runRecallWithXrayCapture: (Orchestrator.prototype as any).runRecallWithXrayCapture,
    xrayCaptureQueue: new XrayCaptureQueue(),
    config: {
      memoryDir: "/tmp/engram-xray-tags",
      namespacesEnabled: false,
      defaultNamespace: "global",
      sharedNamespace: "shared",
      principalFromSessionKeyMode: "prefix",
      principalFromSessionKeyRules: [],
      namespacePolicies: [],
      defaultRecallNamespaces: ["self"],
      searchBackend: "qmd",
      qmdEnabled: true,
      nativeKnowledge: undefined,
      recallBudgetChars: 4096,
    },
    recall: async (
      _prompt: string,
      _sessionKey: string | undefined,
      _options: Record<string, unknown>,
    ) => {
      return "ctx";
    },
    clearLastXraySnapshot: () => {
      state.clearedSnapshot += 1;
      state.snapshot = null;
    },
    getLastXraySnapshot: () => state.snapshot,
    setSnapshot: (snap: RecallXraySnapshot | null) => {
      state.snapshot = snap;
    },
    lastRecall: {
      get: () => null,
      getMostRecent: () => null,
    },
    getStorage: async (_namespace: string) => ({
      dir: "/tmp/engram-xray-tags",
      readMemoryByPath: async (p: string) => {
        const tags = pathToTags[p];
        if (!tags) return null;
        return {
          path: p,
          content: "some content",
          frontmatter: {
            id: path.basename(p, ".md"),
            category: "fact",
            created: "2026-01-01T00:00:00Z",
            updated: "2026-01-01T00:00:00Z",
            source: "extraction",
            confidence: 0.8,
            confidenceTier: "confident",
            tags,
          },
        };
      },
      getMemoryById: async () => null,
      getMemoryTimeline: async () => [],
    }),
  };
  (orchestrator as any).invokeRecall = (
    prompt: string,
    sessionKey: string | undefined,
    options: Record<string, unknown>,
  ) => orchestrator.recall(prompt, sessionKey, options);

  return { orchestrator, state };
}

// ---------------------------------------------------------------------------
// Unit: RecallXrayResult.tags passes through buildXraySnapshot
// ---------------------------------------------------------------------------

test("buildXraySnapshot: tags field is preserved on RecallXrayResult", () => {
  const result = fakeXrayResult({
    memoryId: "fact-1",
    path: "/mem/fact-1.md",
    tags: ["alice", "location"],
  });
  const snapshot = buildXraySnapshot({
    query: "q",
    results: [result],
  });
  assert.ok(snapshot.results.length === 1);
  assert.deepEqual(snapshot.results[0].tags, ["alice", "location"]);
});

test("serializeRecallResults resolves cold collection paths through recorded recall namespaces", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-cold-recall-"));
  const defaultDir = path.join(memoryDir, "default");
  const projectDir = path.join(memoryDir, "project-cold");
  const coldPath = path.join(
    projectDir,
    "cold",
    "facts",
    "2026-03-11",
    "fact-cold.md",
  );
  const memory = {
    path: coldPath,
    content: "project cold recall memory",
    frontmatter: {
      id: "fact-cold",
      category: "fact",
      created: "2026-03-11T12:00:00.000Z",
      updated: "2026-03-11T12:00:00.000Z",
      source: "extraction",
      confidence: 0.8,
      confidenceTier: "confident",
    },
  };
  const storageFor = (dir: string, readablePath?: string) => ({
    dir,
    readMemoryByPath: async (candidatePath: string) =>
      readablePath && path.resolve(candidatePath) === path.resolve(readablePath)
        ? memory
        : null,
    getMemoryById: async () => null,
    getMemoryTimeline: async () => [],
  });
  const storages = new Map<string, ReturnType<typeof storageFor>>([
    ["default", storageFor(defaultDir)],
    ["shared", storageFor(path.join(memoryDir, "shared"))],
    ["project-cold", storageFor(projectDir, coldPath)],
  ]);
  const orchestrator = {
    config: {
      memoryDir,
      namespacesEnabled: true,
      defaultNamespace: "default",
      sharedNamespace: "shared",
      namespacePolicies: [],
      defaultRecallNamespaces: ["default"],
      qmdCollection: "openclaw-engram",
      qmdColdCollection: "openclaw-engram-cold",
      recallCrossNamespaceBudgetEnabled: false,
      recallCrossNamespaceBudgetWindowMs: 60_000,
      recallCrossNamespaceBudgetSoftLimit: 10,
      recallCrossNamespaceBudgetHardLimit: 20,
      recallAuditAnomalyDetectionEnabled: false,
    },
    getStorage: async (namespace: string) => {
      const storage = storages.get(namespace);
      if (!storage) throw new Error(`missing storage: ${namespace}`);
      return storage;
    },
    lcmEngine: null,
  };
  const service = new EngramAccessService(orchestrator as never) as any;

  const results = await service.serializeRecallResults(
    {
      sessionKey: "session-1",
      recordedAt: "2026-03-11T12:00:00.000Z",
      queryHash: "hash",
      queryLen: 5,
      memoryIds: ["fact-cold"],
      namespace: "default",
      recallNamespaces: ["project-cold"],
      resultPaths: ["openclaw-engram-cold/facts/2026-03-11/fact-cold.md"],
    },
    "chunk",
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].id, "fact-cold");
  assert.equal(results[0].path, coldPath);
});

test("buildXraySnapshot: tags field is absent when not provided", () => {
  const result = fakeXrayResult({
    memoryId: "fact-2",
    path: "/mem/fact-2.md",
    // no tags field
  });
  const snapshot = buildXraySnapshot({
    query: "q",
    results: [result],
  });
  assert.equal(snapshot.results[0].tags, undefined);
});

test("buildXraySnapshot: empty tags array is not attached (absent, not [])", () => {
  const result = fakeXrayResult({
    memoryId: "fact-3",
    path: "/mem/fact-3.md",
    tags: [],
  });
  const snapshot = buildXraySnapshot({
    query: "q",
    results: [result],
  });
  // cloneResult drops empty tag arrays — undefined not []
  assert.equal(snapshot.results[0].tags, undefined);
});

test("buildXraySnapshot: whitespace-only tags are stripped; non-empty ones survive", () => {
  const result = fakeXrayResult({
    memoryId: "fact-4",
    path: "/mem/fact-4.md",
    tags: ["  ", "tag-a", "  tag-b  ", ""],
  });
  const snapshot = buildXraySnapshot({
    query: "q",
    results: [result],
  });
  assert.deepEqual(snapshot.results[0].tags, ["tag-a", "tag-b"]);
});

// ---------------------------------------------------------------------------
// Integration: recallXray with tags filter — tag-filter trace + per-result tags
// ---------------------------------------------------------------------------

test("recallXray with tags filter: tag-filter trace appears in snapshot.filters with correct counts", async () => {
  // Two results in the raw snapshot: one tagged [alice, location],
  // one tagged [bob, work].  Filter for tag=alice.
  const snap = fakeSnapshot({
    results: [
      fakeXrayResult({
        memoryId: "fact-alice",
        path: "/mem/fact-alice.md",
      }),
      fakeXrayResult({
        memoryId: "fact-bob",
        path: "/mem/fact-bob.md",
      }),
    ],
  });

  const { orchestrator, state } = stubOrchestrator({
    snapshot: snap,
    pathToTags: {
      "/mem/fact-alice.md": ["alice", "location"],
      "/mem/fact-bob.md": ["bob", "work"],
    },
  });

  // Inject the snap AFTER recall fires (simulates real capture path).
  const originalRecall = orchestrator.recall;
  orchestrator.recall = async (...args: Parameters<typeof orchestrator.recall>) => {
    const result = await originalRecall.apply(orchestrator, args as Parameters<typeof originalRecall>);
    state.snapshot = snap;
    return result;
  };

  const service = new EngramAccessService(orchestrator as never);
  const response = await service.recallXray({ query: "alice location", tags: ["alice"] });

  assert.equal(response.snapshotFound, true);
  assert.ok(response.snapshot);

  const { snapshot: resultSnapshot } = response;
  assert.ok(resultSnapshot);

  // Only alice's result should remain.
  assert.equal(resultSnapshot.results.length, 1);
  assert.equal(resultSnapshot.results[0].memoryId, "fact-alice");

  // tag-filter trace must be present.
  const tagTrace = resultSnapshot.filters.find((f) => f.name === "tag-filter");
  assert.ok(tagTrace, "tag-filter trace should be present in snapshot.filters");
  assert.equal(tagTrace.considered, 2, "considered should be 2 (both results)");
  assert.equal(tagTrace.admitted, 1, "admitted should be 1 (only alice matches)");
});

test("recallXray with tags=all mode: admits only results matching all tags", async () => {
  const snap = fakeSnapshot({
    results: [
      fakeXrayResult({ memoryId: "mem-ab", path: "/mem/mem-ab.md" }),
      fakeXrayResult({ memoryId: "mem-a",  path: "/mem/mem-a.md" }),
      fakeXrayResult({ memoryId: "mem-b",  path: "/mem/mem-b.md" }),
    ],
  });

  const { orchestrator, state } = stubOrchestrator({
    snapshot: snap,
    pathToTags: {
      "/mem/mem-ab.md": ["tag-a", "tag-b"],
      "/mem/mem-a.md": ["tag-a"],
      "/mem/mem-b.md": ["tag-b"],
    },
  });

  const originalRecall = orchestrator.recall;
  orchestrator.recall = async (...args: Parameters<typeof orchestrator.recall>) => {
    const result = await originalRecall.apply(orchestrator, args as Parameters<typeof originalRecall>);
    state.snapshot = snap;
    return result;
  };

  const service = new EngramAccessService(orchestrator as never);
  const response = await service.recallXray({
    query: "both tags",
    tags: ["tag-a", "tag-b"],
    tagMatch: "all",
  });

  assert.equal(response.snapshotFound, true);
  const snapshot = response.snapshot;
  assert.ok(snapshot);

  // Only mem-ab has BOTH tags.
  assert.equal(snapshot.results.length, 1);
  assert.equal(snapshot.results[0].memoryId, "mem-ab");

  const tagTrace = snapshot.filters.find((f) => f.name === "tag-filter");
  assert.ok(tagTrace);
  assert.equal(tagTrace.considered, 3);
  assert.equal(tagTrace.admitted, 1);
  assert.match(tagTrace.reason ?? "", /match=all/);
});

test("recallXray with no tags filter: no tag-filter trace emitted", async () => {
  const snap = fakeSnapshot({
    results: [
      fakeXrayResult({ memoryId: "mem-1", path: "/mem/mem-1.md" }),
    ],
  });

  const { orchestrator, state } = stubOrchestrator({
    snapshot: snap,
    pathToTags: { "/mem/mem-1.md": ["x"] },
  });

  const originalRecall = orchestrator.recall;
  orchestrator.recall = async (...args: Parameters<typeof orchestrator.recall>) => {
    const result = await originalRecall.apply(orchestrator, args as Parameters<typeof originalRecall>);
    state.snapshot = snap;
    return result;
  };

  const service = new EngramAccessService(orchestrator as never);
  const response = await service.recallXray({ query: "no tag filter" });

  assert.equal(response.snapshotFound, true);
  const snapshot = response.snapshot;
  assert.ok(snapshot);

  const tagTrace = snapshot.filters.find((f) => f.name === "tag-filter");
  assert.equal(tagTrace, undefined, "no tag-filter trace should appear when no filter is requested");
  assert.equal(snapshot.results.length, 1, "all results should be present");
});

test("recallXray: any-match (default) admits result with at least one matching tag", async () => {
  const snap = fakeSnapshot({
    results: [
      fakeXrayResult({ memoryId: "mem-xy", path: "/mem/mem-xy.md" }),
      fakeXrayResult({ memoryId: "mem-z",  path: "/mem/mem-z.md" }),
    ],
  });

  const { orchestrator, state } = stubOrchestrator({
    snapshot: snap,
    pathToTags: {
      "/mem/mem-xy.md": ["x", "y"],
      "/mem/mem-z.md":  ["z"],
    },
  });

  const originalRecall = orchestrator.recall;
  orchestrator.recall = async (...args: Parameters<typeof orchestrator.recall>) => {
    const result = await originalRecall.apply(orchestrator, args as Parameters<typeof originalRecall>);
    state.snapshot = snap;
    return result;
  };

  const service = new EngramAccessService(orchestrator as never);
  // Filter for "x" OR "z" — both results should pass (any-match).
  const response = await service.recallXray({
    query: "any match test",
    tags: ["x", "z"],
    // tagMatch defaults to "any"
  });

  assert.equal(response.snapshotFound, true);
  const snapshot = response.snapshot;
  assert.ok(snapshot);

  // Both mem-xy (has x) and mem-z (has z) pass the any-match filter.
  assert.equal(snapshot.results.length, 2);

  const tagTrace = snapshot.filters.find((f) => f.name === "tag-filter");
  assert.ok(tagTrace);
  assert.equal(tagTrace.considered, 2);
  assert.equal(tagTrace.admitted, 2);
});

// ---------------------------------------------------------------------------
// Integration: end-to-end with real fixture memoryDir
// ---------------------------------------------------------------------------

test("recallXray with real storage fixture: per-result tags populated from frontmatter", async () => {
  const memoryDir = await mkdtemp(
    path.join(os.tmpdir(), "engram-xray-tags-e2e-"),
  );

  // Write two memory files directly using StorageManager.
  const { StorageManager } = await import("../src/storage.js");
  const storage = new StorageManager(memoryDir);

  const { id: idA } = await storage.writeMemory("fact", "Eve is a cryptographer.", {
    tags: ["eve", "cryptography"],
  });
  const { id: idB } = await storage.writeMemory("fact", "Frank is a botanist.", {
    tags: ["frank", "botany"],
  });

  const allMems = await storage.readAllMemories();
  const memA = allMems.find((m) => m.frontmatter.id === idA);
  const memB = allMems.find((m) => m.frontmatter.id === idB);
  assert.ok(memA && memB, "both memories should exist");

  // Build a fake snapshot that references the real paths.
  const snap = fakeSnapshot({
    results: [
      fakeXrayResult({ memoryId: idA, path: memA.path }),
      fakeXrayResult({ memoryId: idB, path: memB.path }),
    ],
  });

  const { orchestrator, state } = stubOrchestrator({
    snapshot: snap,
    // Override getStorage to return the real storage instance.
  });

  // Patch getStorage to return the real storage.
  (orchestrator as Record<string, unknown>).getStorage = async () => storage;

  const originalRecall = orchestrator.recall;
  orchestrator.recall = async (...args: Parameters<typeof orchestrator.recall>) => {
    const result = await originalRecall.apply(orchestrator, args as Parameters<typeof originalRecall>);
    state.snapshot = snap;
    return result;
  };

  const service = new EngramAccessService(orchestrator as never);
  const response = await service.recallXray({
    query: "cryptographer",
    tags: ["cryptography"],
  });

  assert.equal(response.snapshotFound, true);
  const snapshot = response.snapshot;
  assert.ok(snapshot);

  // Only Eve's memory should pass the tag filter.
  assert.equal(snapshot.results.length, 1);
  assert.equal(snapshot.results[0].memoryId, idA);

  // tag-filter trace present with correct counts.
  const tagTrace = snapshot.filters.find((f) => f.name === "tag-filter");
  assert.ok(tagTrace, "tag-filter trace should be present");
  assert.equal(tagTrace.considered, 2);
  assert.equal(tagTrace.admitted, 1);
});
