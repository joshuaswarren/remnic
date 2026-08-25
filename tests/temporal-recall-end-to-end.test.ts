/**
 * End-to-end temporal recall round-trip test (issue #680).
 *
 * Acceptance criterion:
 *   - Ingest fact at T1, supersede it at T2.
 *   - recall with `asOf=T1` returns the original fact.
 *   - recall with no asOf returns the superseding fact only
 *     (the original is filtered out by the supersession gate).
 *
 * Uses a real Orchestrator with a tmpdir fixture memoryDir so the full
 * `orchestrator.recall()` path — including `boostSearchResults` with
 * `isValidAsOf` — is exercised.  QMD and embedding fallback are disabled
 * so the test stays self-contained and fast: recall falls back to the
 * hot-tier / recent-scan path which reads all memories from disk.
 */

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import { parseConfig } from "@remnic/core/config";
import { Orchestrator } from "@remnic/core/orchestrator";
import { StorageManager } from "@remnic/core/storage";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeOrchestrator(): Promise<{
  orchestrator: Orchestrator;
  storage: StorageManager;
  memoryDir: string;
}> {
  const memoryDir = await mkdtemp(
    path.join(os.tmpdir(), "engram-temporal-recall-e2e-"),
  );
  const config = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: false,
    embeddingFallbackEnabled: false,
    chunkingEnabled: false,
    // Keep supersession filter ON (default) so the no-asOf path filters
    // the superseded original, leaving only the successor.
    temporalSupersessionEnabled: true,
    temporalSupersessionIncludeInRecall: false,
  });
  const orchestrator = new Orchestrator(config);
  const storage = (orchestrator as unknown as { storage: StorageManager })
    .storage;
  return { orchestrator, storage, memoryDir };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("temporal recall: asOf=T1 returns original fact before supersession", async () => {
  const { orchestrator, storage } = await makeOrchestrator();

  // T1 = yesterday.  T2 = now.
  const T1 = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(); // yesterday
  const T2 = new Date().toISOString(); // now

  // Write the original fact with valid_at = T1.
  const { id: originalId } = await storage.writeMemory(
    "fact",
    "Alice lives in Boston.",
    { tags: ["alice", "location"] },
  );
  // Backdate valid_at to T1 by patching frontmatter.
  const allMemsAfterOriginal = await storage.readAllMemories();
  const originalMem = allMemsAfterOriginal.find(
    (m) => m.frontmatter.id === originalId,
  );
  assert.ok(originalMem, "original memory should exist");
  await storage.writeMemoryFrontmatter(originalMem, {
    valid_at: T1,
  });

  // Write the superseding fact with valid_at = T2; mark the original as
  // superseded with invalid_at = T2 to simulate the write path that issue
  // #680 PR 2/4 adds to temporal-supersession.ts.
  const { id: supersederId } = await storage.writeMemory(
    "fact",
    "Alice lives in San Francisco.",
    { tags: ["alice", "location"] },
  );
  const allMemsAfterSuperseeder = await storage.readAllMemories();
  const supersederMem = allMemsAfterSuperseeder.find(
    (m) => m.frontmatter.id === supersederId,
  );
  assert.ok(supersederMem, "superseder memory should exist");
  await storage.writeMemoryFrontmatter(supersederMem, {
    valid_at: T2,
  });
  // Mark original as superseded with invalid_at = T2.
  const updatedOriginal = allMemsAfterSuperseeder.find(
    (m) => m.frontmatter.id === originalId,
  );
  assert.ok(updatedOriginal, "original memory should still exist");
  await storage.writeMemoryFrontmatter(updatedOriginal, {
    status: "superseded",
    supersededBy: supersederId,
    supersededAt: T2,
    invalid_at: T2,
  });

  // Recall with asOf=T1: should surface the original (was valid at T1,
  // invalid_at=T2 so it is NOT yet invalidated at T1), and NOT the
  // superseder (valid_at=T2 so it starts after T1).
  const sessionKey = "test-session-680";
  await orchestrator.recall("Where does Alice live?", sessionKey, {
    asOf: T1,
  });
  const snapshotAtT1 = orchestrator.lastRecall.get(sessionKey);
  assert.ok(snapshotAtT1, "should have a recall snapshot for asOf=T1");
  const pathsAtT1 = snapshotAtT1.resultPaths ?? [];

  // The original memory file path should appear in results at T1.
  const originalPath = updatedOriginal.path;
  const supersederPath = supersederMem.path;

  assert.ok(
    pathsAtT1.some((p) => p === originalPath),
    `asOf=T1 recall should include original fact (${originalPath}), got: ${JSON.stringify(pathsAtT1)}`,
  );
  assert.ok(
    !pathsAtT1.some((p) => p === supersederPath),
    `asOf=T1 recall should NOT include superseder (valid_at=${T2} is after T1), got: ${JSON.stringify(pathsAtT1)}`,
  );
});

test("temporal recall: no asOf returns superseder, not the superseded original", async () => {
  const { orchestrator, storage } = await makeOrchestrator();

  const T1 = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const T2 = new Date().toISOString();

  // Write original + superseder (same setup as above).
  const { id: originalId } = await storage.writeMemory(
    "fact",
    "Bob works at Initech.",
    { tags: ["bob", "employer"] },
  );
  const allAfterOriginal = await storage.readAllMemories();
  const originalMem = allAfterOriginal.find(
    (m) => m.frontmatter.id === originalId,
  );
  assert.ok(originalMem);
  await storage.writeMemoryFrontmatter(originalMem, { valid_at: T1 });

  const { id: supersederId } = await storage.writeMemory(
    "fact",
    "Bob works at Initrode.",
    { tags: ["bob", "employer"] },
  );
  const allAfterSuperseeder = await storage.readAllMemories();
  const supersederMem = allAfterSuperseeder.find(
    (m) => m.frontmatter.id === supersederId,
  );
  assert.ok(supersederMem);
  await storage.writeMemoryFrontmatter(supersederMem, { valid_at: T2 });

  const updatedOriginal = allAfterSuperseeder.find(
    (m) => m.frontmatter.id === originalId,
  );
  assert.ok(updatedOriginal);
  await storage.writeMemoryFrontmatter(updatedOriginal, {
    status: "superseded",
    supersededBy: supersederId,
    supersededAt: T2,
    invalid_at: T2,
  });

  // Recall without asOf: supersession filter drops the original;
  // superseder should be present.
  const sessionKey = "test-session-680-no-asof";
  await orchestrator.recall("Where does Bob work?", sessionKey, {});
  const snapshot = orchestrator.lastRecall.get(sessionKey);
  assert.ok(snapshot, "should have a recall snapshot for no-asOf");
  const paths = snapshot.resultPaths ?? [];

  assert.ok(
    paths.some((p) => p === supersederMem.path),
    `no-asOf recall should include the superseder (${supersederMem.path}), got: ${JSON.stringify(paths)}`,
  );
  assert.ok(
    !paths.some((p) => p === updatedOriginal.path),
    `no-asOf recall should NOT include the superseded original (${updatedOriginal.path}), got: ${JSON.stringify(paths)}`,
  );
});

test("temporal recall: fact with no invalid_at is valid at any asOf after valid_at", async () => {
  const { orchestrator, storage } = await makeOrchestrator();

  const T1 = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(); // 1 week ago
  const queryTs = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(); // 3 days ago

  const { id: memId } = await storage.writeMemory("fact", "Carol prefers dark mode.", {
    tags: ["carol", "preference"],
  });
  const allMems = await storage.readAllMemories();
  const mem = allMems.find((m) => m.frontmatter.id === memId);
  assert.ok(mem);
  // Backdate valid_at to T1 (one week ago); no invalid_at means always-valid.
  await storage.writeMemoryFrontmatter(mem, { valid_at: T1 });

  const sessionKey = "test-session-680-no-invalid";
  await orchestrator.recall("What does Carol prefer?", sessionKey, {
    asOf: queryTs,
  });
  const snapshot = orchestrator.lastRecall.get(sessionKey);
  assert.ok(snapshot, "should have a recall snapshot");
  const paths = snapshot.resultPaths ?? [];

  assert.ok(
    paths.some((p) => p === mem.path),
    `fact with no invalid_at should be valid at any asOf after its valid_at, got: ${JSON.stringify(paths)}`,
  );
});
