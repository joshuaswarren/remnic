/**
 * CLI-surface tests for `remnic purge` (issue #686 retention-completion).
 *
 * Tests the `parseDurationToMs` helper (which is private to cli.ts) via
 * the public `purgeMemories` module, and exercises the confirm-guard + dry-run
 * semantics directly through the purge core module since the Commander action
 * layer requires a full orchestrator.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { purgeMemories } from "../../packages/remnic-core/src/maintenance/purge.js";
import { hasDestructivePurgeFailures, parseDurationToMs } from "../../packages/remnic-core/src/cli.js";
import type { MemoryFile, MemoryFrontmatter } from "../../packages/remnic-core/src/types.js";
import type { StorageManager } from "../../packages/remnic-core/src/storage.js";

function makeMemory(overrides: Partial<MemoryFrontmatter> & { filePath?: string } = {}): MemoryFile {
  const { filePath, ...fm } = overrides;
  return {
    path: filePath ?? `/tmp/mem/${fm.id ?? "m1"}.md`,
    content: "body",
    frontmatter: {
      id: "m1",
      category: "fact",
      created: "2024-01-01T00:00:00.000Z",
      updated: "2024-01-01T00:00:00.000Z",
      source: "test",
      ...fm,
    } as MemoryFrontmatter,
  };
}

function makeStorageStub(cold: MemoryFile[]): StorageManager {
  return {
    dir: "/tmp/mem",
    readAllMemories: async () => [],
    readAllColdMemories: async () => cold,
    readArchivedMemories: async () => [],
    invalidateAllMemoriesCache: () => {},
  } as unknown as StorageManager;
}

// ── --confirm guard: dryRun must default to true (fail-safe) ──────────────

test("purge: ISO duration parser includes month components in mixed durations", () => {
  assert.equal(parseDurationToMs("P1Y6M"), (365 + 180) * 86_400_000);
  assert.equal(parseDurationToMs("P2Y3M10D"), (730 + 90 + 10) * 86_400_000);
  assert.equal(parseDurationToMs("P52W"), 52 * 7 * 86_400_000);
  assert.equal(parseDurationToMs("P1Y2W"), (365 + 14) * 86_400_000);
  assert.equal(parseDurationToMs("P0Y90D"), 90 * 86_400_000);
  assert.equal(parseDurationToMs("PT720H"), 720 * 60 * 60 * 1000);
});

test("purge: ISO duration parser rejects partial durations", () => {
  assert.equal(parseDurationToMs("P1Yjunk"), null);
  assert.equal(parseDurationToMs("P"), null);
  assert.equal(parseDurationToMs("PT"), null);
  assert.equal(parseDurationToMs("P1YT"), null);
  assert.equal(parseDurationToMs("P30DT"), null);
  assert.equal(parseDurationToMs("P0Y0M0W0DT0H0M0S"), null);
});

test("purge: exit failure classifier ignores best-effort maintenance errors", () => {
  assert.equal(
    hasDestructivePurgeFailures([
      { id: "(purge-audit)" },
      { id: "(fact-hash-index)" },
    ]),
    false,
  );
  assert.equal(
    hasDestructivePurgeFailures([
      { id: "(qmd-update)" },
    ]),
    true,
  );
  assert.equal(
    hasDestructivePurgeFailures([
      { id: "(purge-audit)" },
      { id: "failed-delete-id" },
    ]),
    true,
  );
});

test("purge: dryRun defaults to true — no files are deleted without explicit opt-in", async () => {
  const old = makeMemory({ id: "old", updated: "2024-01-01T00:00:00.000Z", filePath: "/tmp/cold/old.md" });
  const stub = makeStorageStub([old]);

  // Omit dryRun entirely — the module default must protect against accidental deletion
  const result = await purgeMemories({
    storage: stub,
    olderThanMs: 10 * 86_400_000,
    now: () => new Date("2026-04-27T00:00:00.000Z"),
  });

  assert.equal(result.dryRun, true);
  assert.equal(result.purgedCount, 0);
  assert.ok(result.candidates.length >= 1, "candidates should still be listed in dry-run");
});

test("purge: dryRun=true does not remove files even when candidates exist", async () => {
  const old = makeMemory({ id: "old2", updated: "2024-06-01T00:00:00.000Z", filePath: "/tmp/cold/old2.md" });
  const stub = makeStorageStub([old]);

  const result = await purgeMemories({
    storage: stub,
    olderThanMs: 100 * 86_400_000,
    tier: "cold",
    dryRun: true,
    now: () => new Date("2026-04-27T00:00:00.000Z"),
  });

  assert.equal(result.dryRun, true);
  assert.equal(result.purgedCount, 0);
  assert.equal(result.candidates.length, 1);
});

// ── tier filter semantics ─────────────────────────────────────────────────

test("purge: tier=cold default — hot-tier files not included", async () => {
  const hot = makeMemory({ id: "hot1", updated: "2020-01-01T00:00:00.000Z", filePath: "/tmp/mem/facts/hot1.md" });
  const cold = makeMemory({ id: "cold1", updated: "2020-01-01T00:00:00.000Z", filePath: "/tmp/mem/cold/cold1.md" });
  const stub = {
    dir: "/tmp/mem",
    readAllMemories: async () => [hot],
    readAllColdMemories: async () => [cold],
    readArchivedMemories: async () => [],
    invalidateAllMemoriesCache: () => {},
  } as unknown as StorageManager;

  const result = await purgeMemories({
    storage: stub,
    olderThanMs: 100 * 86_400_000,
    tier: "cold",
    dryRun: true,
    now: () => new Date("2026-04-27T00:00:00.000Z"),
  });

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]?.id, "cold1");
});

// ── forgottenOnly semantics ───────────────────────────────────────────────

test("purge: forgottenOnly=true — active cold memories excluded", async () => {
  const active = makeMemory({ id: "act", updated: "2024-01-01T00:00:00.000Z", status: "active" as any, filePath: "/tmp/cold/act.md" });
  const forgotten = makeMemory({ id: "fgt", updated: "2024-01-01T00:00:00.000Z", status: "forgotten" as any, filePath: "/tmp/cold/fgt.md" });
  const stub = makeStorageStub([active, forgotten]);

  const result = await purgeMemories({
    storage: stub,
    olderThanMs: 100 * 86_400_000,
    tier: "cold",
    forgottenOnly: true,
    dryRun: true,
    now: () => new Date("2026-04-27T00:00:00.000Z"),
  });

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]?.id, "fgt");
});

// ── candidate metadata ────────────────────────────────────────────────────

test("purge: candidate has correct ageMs", async () => {
  const now = new Date("2026-04-27T00:00:00.000Z");
  const updatedAt = "2026-01-01T00:00:00.000Z"; // 116 days before now
  const old = makeMemory({ id: "aged", updated: updatedAt, filePath: "/tmp/cold/aged.md" });
  const stub = makeStorageStub([old]);

  const result = await purgeMemories({
    storage: stub,
    olderThanMs: 100 * 86_400_000,
    tier: "cold",
    dryRun: true,
    now: () => now,
  });

  assert.equal(result.candidates.length, 1);
  const c = result.candidates[0]!;
  const expectedAgeMs = now.getTime() - Date.parse(updatedAt);
  assert.ok(
    Math.abs(c.ageMs - expectedAgeMs) < 1000,
    `ageMs ${c.ageMs} should be ~${expectedAgeMs}`,
  );
  assert.equal(c.updatedOrCreated, updatedAt);
});

// ── result shape ──────────────────────────────────────────────────────────

test("purge: result contains tier and olderThanMs echoed back", async () => {
  const stub = makeStorageStub([]);
  const result = await purgeMemories({
    storage: stub,
    olderThanMs: 30 * 86_400_000,
    tier: "all",
    dryRun: true,
    now: () => new Date("2026-04-27T00:00:00.000Z"),
  });

  assert.equal(result.tier, "all");
  assert.equal(result.olderThanMs, 30 * 86_400_000);
});
