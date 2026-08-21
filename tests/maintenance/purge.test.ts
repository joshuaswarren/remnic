/**
 * Unit tests for `purgeMemories` (issue #686 retention-completion).
 *
 * Uses a lightweight in-memory storage stub so tests run without a
 * real QMD instance or filesystem writes (except the round-trip test).
 */

import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { access, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";

import { purgeMemories, type PurgeMemoriesOptions } from "../../packages/remnic-core/src/maintenance/purge.js";
import type { MemoryFile, MemoryFrontmatter } from "../../packages/remnic-core/src/types.js";
import type { StorageManager } from "../../packages/remnic-core/src/storage.js";
import type { SearchBackend } from "../../packages/remnic-core/src/search/port.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeMemory(overrides: Partial<MemoryFrontmatter> & { filePath?: string } = {}): MemoryFile {
  const { filePath, ...frontmatterOverrides } = overrides;
  return {
    path: filePath ?? `/tmp/mem/${frontmatterOverrides.id ?? "mem-1"}.md`,
    content: "synthetic body",
    frontmatter: {
      id: "mem-1",
      category: "fact",
      created: "2025-01-01T00:00:00.000Z",
      updated: "2025-01-01T00:00:00.000Z",
      source: "test",
      ...frontmatterOverrides,
    } as MemoryFrontmatter,
  };
}


function makeStorageStub(
  memories: { hot?: MemoryFile[]; cold?: MemoryFile[]; archived?: MemoryFile[] } = {},
): { stub: StorageManager; unlinked: string[] } {
  const unlinked: string[] = [];
  const stub = {
    dir: "/tmp/mem",
    readAllMemories: async () => memories.hot ?? [],
    readAllColdMemories: async () => memories.cold ?? [],
    readArchivedMemories: async () => memories.archived ?? [],
    invalidateAllMemoriesCache: () => {},
    deleteMemoryForMaintenance: async (memory: MemoryFile) => {
      unlinked.push(memory.path);
      return memory;
    },
  } as unknown as StorageManager;
  return { stub, unlinked };
}

function makeQmdStub(): {
  stub: SearchBackend & {
    updatedCollections: string[];
    signals: Array<AbortSignal | undefined>;
  };
  updatedCollections: string[];
  signals: Array<AbortSignal | undefined>;
} {
  const updatedCollections: string[] = [];
  const signals: Array<AbortSignal | undefined> = [];
  return {
    stub: {
      updatedCollections,
      signals,
      probe: async () => true,
      isAvailable: () => true,
      debugStatus: () => "",
      search: async () => [],
      searchGlobal: async () => [],
      bm25Search: async () => [],
      vectorSearch: async () => [],
      hybridSearch: async () => [],
      update: async () => {},
      updateCollection: async (c: string) => {
        updatedCollections.push(c);
      },
      updateCollectionStrict: async (c: string, execution?: { signal?: AbortSignal }) => {
        updatedCollections.push(c);
        signals.push(execution?.signal);
      },
      embed: async () => {},
      embedCollection: async () => {},
      ensureCollection: async () => "present" as const,
    },
    updatedCollections,
    signals,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

test("purgeMemories: dryRun=true returns candidates without deleting", async () => {
  const old = makeMemory({ id: "old-1", updated: "2024-01-01T00:00:00.000Z", filePath: "/tmp/cold/old-1.md" });
  const { stub } = makeStorageStub({ cold: [old] });

  const result = await purgeMemories({
    storage: stub,
    olderThanMs: 365 * 86_400_000, // 1 year
    tier: "cold",
    dryRun: true,
    now: () => new Date("2026-04-27T00:00:00.000Z"),
  });

  assert.equal(result.dryRun, true);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]?.id, "old-1");
  assert.equal(result.purgedCount, 0);
});

test("purgeMemories: rejects non-positive olderThanMs at module boundary", async () => {
  const { stub } = makeStorageStub();

  await assert.rejects(
    () =>
      purgeMemories({
        storage: stub,
        olderThanMs: 0,
        tier: "all",
        dryRun: false,
      }),
    /olderThanMs must be a finite positive number/,
  );
});

test("purgeMemories: skips memories newer than olderThanMs", async () => {
  const recent = makeMemory({ id: "recent", updated: "2026-04-01T00:00:00.000Z", filePath: "/tmp/cold/recent.md" });
  const { stub } = makeStorageStub({ cold: [recent] });

  const result = await purgeMemories({
    storage: stub,
    olderThanMs: 365 * 86_400_000,
    tier: "cold",
    dryRun: true,
    now: () => new Date("2026-04-27T00:00:00.000Z"),
  });

  assert.equal(result.candidates.length, 0);
});

test("purgeMemories: tier=cold only targets cold-path files", async () => {
  const hot = makeMemory({ id: "hot-1", updated: "2024-01-01T00:00:00.000Z", filePath: "/tmp/mem/hot-1.md" });
  const cold = makeMemory({ id: "cold-1", updated: "2024-01-01T00:00:00.000Z", filePath: "/tmp/mem/cold/cold-1.md" });
  const { stub } = makeStorageStub({ hot: [hot], cold: [cold] });

  const result = await purgeMemories({
    storage: stub,
    olderThanMs: 100 * 86_400_000,
    tier: "cold",
    dryRun: true,
    now: () => new Date("2026-04-27T00:00:00.000Z"),
  });

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]?.id, "cold-1");
});

test("purgeMemories: tier=all includes hot, cold, and archived", async () => {
  const hot = makeMemory({ id: "hot-1", updated: "2024-01-01T00:00:00.000Z", filePath: "/tmp/mem/hot-1.md" });
  const cold = makeMemory({ id: "cold-1", updated: "2024-01-01T00:00:00.000Z", filePath: "/tmp/mem/cold/cold-1.md" });
  const arch = makeMemory({ id: "arch-1", updated: "2024-01-01T00:00:00.000Z", filePath: "/tmp/mem/archive/arch-1.md" });
  const { stub } = makeStorageStub({ hot: [hot], cold: [cold], archived: [arch] });

  const result = await purgeMemories({
    storage: stub,
    olderThanMs: 100 * 86_400_000,
    tier: "all",
    dryRun: true,
    now: () => new Date("2026-04-27T00:00:00.000Z"),
  });

  const ids = result.candidates.map((c) => c.id).sort();
  assert.deepEqual(ids, ["arch-1", "cold-1", "hot-1"]);
});

test("purgeMemories: forgottenOnly=true skips non-forgotten memories", async () => {
  const forgotten = makeMemory({ id: "f1", updated: "2024-01-01T00:00:00.000Z", status: "forgotten" as any, filePath: "/tmp/mem/cold/f1.md" });
  const active = makeMemory({ id: "a1", updated: "2024-01-01T00:00:00.000Z", status: "active" as any, filePath: "/tmp/mem/cold/a1.md" });
  const { stub } = makeStorageStub({ cold: [forgotten, active] });

  const result = await purgeMemories({
    storage: stub,
    olderThanMs: 100 * 86_400_000,
    tier: "cold",
    forgottenOnly: true,
    dryRun: true,
    now: () => new Date("2026-04-27T00:00:00.000Z"),
  });

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]?.id, "f1");
});

test("purgeMemories: dryRun=false (hard-delete) removes files and updates QMD", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-purge-harddelete-"));
  try {
    const { StorageManager } = await import("../../packages/remnic-core/src/storage.js");
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    // Write a real memory
    const rawFact = "Synthetic fact to purge.";
    const { id: id } = await storage.writeMemory("fact", rawFact, {
      source: "test",
    });
    assert.equal(await storage.hasFactContentHash(rawFact), true, "fact hash should exist before purge");
    const memories = await storage.readAllMemories();
    const memFile = memories.find((m) => m.frontmatter.id === id);
    assert.ok(memFile, "memory must exist on disk");

    // Manually backdate it by writing updated timestamp to past
    await storage.writeMemoryFrontmatter(memFile!, {
      updated: "2020-01-01T00:00:00.000Z",
    });

    const { updatedCollections, stub: qmd } = makeQmdStub();

    const result = await purgeMemories({
      storage,
      olderThanMs: 365 * 86_400_000,
      tier: "all",
      dryRun: false,
      qmd: qmd as any,
      hotCollection: "openclaw-engram",
      coldCollection: "openclaw-engram-cold",
      now: () => new Date("2026-04-27T00:00:00.000Z"),
    });

    assert.equal(result.dryRun, false);
    assert.ok(result.purgedCount >= 1, "at least one memory should be purged");
    assert.equal(result.alreadyAbsentCount, 0);

    // File should be gone
    const afterMemories = await storage.readAllMemories();
    const stillExists = afterMemories.find((m) => m.frontmatter.id === id);
    assert.ok(!stillExists, "purged memory should not be on disk");
    assert.equal(await storage.hasFactContentHash(rawFact), false, "purged fact hash should be removed");

    // QMD collection should have been updated
    assert.ok(updatedCollections.length >= 1, "QMD updateCollection should be called");

    // Audit ledger should be written
    const ledgerPath = path.join(dir, "state", "observation-ledger", "purge-audit.jsonl");
    const ledgerRaw = await readFile(ledgerPath, "utf-8");
    assert.ok(ledgerRaw.includes(id), "purge audit ledger should contain the purged memory id");
    const events = ledgerRaw
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { event: string }).event);
    assert.ok(events.includes("PURGE_DELETE_INTENT"), "purge audit ledger should contain an intent event");
    assert.ok(events.includes("PURGE_HARD_DELETE"), "purge audit ledger should contain a success event");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("purgeMemories: missing file records already-absent outcome and refreshes QMD", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-purge-failed-unlink-"));
  try {
    const missing = makeMemory({
      id: "missing-delete",
      updated: "2020-01-01T00:00:00.000Z",
      filePath: path.join(dir, "cold", "missing-delete.md"),
    });
    const stub = {
      dir,
      deleteMemoryForMaintenance: async () => {
        const error = Object.assign(new Error("missing file"), { code: "ENOENT" });
        throw error;
      },
      readAllMemories: async () => [],
      readAllColdMemories: async () => [missing],
      readArchivedMemories: async () => [],
      invalidateAllMemoriesCacheForDir: () => {},
    } as unknown as StorageManager;
    const { updatedCollections, stub: qmd } = makeQmdStub();

    const result = await purgeMemories({
      storage: stub,
      olderThanMs: 365 * 86_400_000,
      tier: "cold",
      dryRun: false,
      qmd: qmd as any,
      coldCollection: "cold-test",
      now: () => new Date("2026-04-27T00:00:00.000Z"),
    });

    assert.equal(result.purgedCount, 0);
    assert.equal(result.alreadyAbsentCount, 1);
    assert.equal(result.candidates.length, 1);
    assert.deepEqual(updatedCollections, ["cold-test"]);
    const ledgerPath = path.join(dir, "state", "observation-ledger", "purge-audit.jsonl");
    const entries = (await readFile(ledgerPath, "utf-8"))
      .trim()
      .split("\n")
      .map((line) => {
        const entry = JSON.parse(line) as { event: string; memoryId: string };
        return { event: entry.event, memoryId: entry.memoryId };
      });
    assert.deepEqual(entries, [
      { event: "PURGE_DELETE_INTENT", memoryId: "missing-delete" },
      { event: "PURGE_ALREADY_ABSENT", memoryId: "missing-delete" },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("purgeMemories: audit ledger failure is reported without blocking hard-delete", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-purge-audit-first-"));
  try {
    const { StorageManager } = await import("../../packages/remnic-core/src/storage.js");
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const { id: id } = await storage.writeMemory("fact", "Do not delete without audit.", {
      source: "test",
    });
    const [memory] = await storage.readAllMemories();
    assert.ok(memory, "expected memory to exist");
    await storage.writeMemoryFrontmatter(memory, {
      updated: "2020-01-01T00:00:00.000Z",
    });

    const ledgerDir = path.join(dir, "state", "observation-ledger");
    await mkdir(path.dirname(ledgerDir), { recursive: true });
    await writeFile(ledgerDir, "not a directory", "utf-8");

    const result = await purgeMemories({
      storage,
      olderThanMs: 365 * 86_400_000,
      tier: "all",
      dryRun: false,
      now: () => new Date("2026-04-27T00:00:00.000Z"),
    });

    const stillThere = await storage.getMemoryById(id);
    assert.equal(stillThere, null, "memory should still be purged when audit logging fails");
    await assert.rejects(() => access(memory.path), "memory file should be deleted");
    assert.equal(result.purgedCount, 1);
    assert.equal(result.errorCount, 2);
    assert.ok(result.errors.some((error) => error.id === "(purge-audit)"), "audit failure should be visible");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("purgeMemories: archive purges invalidate archive tier without refreshing hot/cold QMD collections", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-purge-archive-"));
  try {
    const archivedPath = path.join(dir, "archive", "2024-01-01", "arch-1.md");
    await mkdir(path.dirname(archivedPath), { recursive: true });
    await writeFile(archivedPath, "archived memory", "utf-8");
    const archived = makeMemory({
      id: "arch-1",
      updated: "2020-01-01T00:00:00.000Z",
      status: "archived" as any,
      filePath: archivedPath,
    });
    const invalidatedTiers: string[] = [];
    const storage = {
      deleteMemoryForMaintenance: async (memory: MemoryFile) => {
        await unlink(memory.path);
        return memory;
      },
      dir,
      readAllMemories: async () => [],
      readAllColdMemories: async () => [],
      readArchivedMemories: async () => [archived],
      invalidateMemoryCachesForTiers: (tiers: Iterable<"hot" | "cold" | "archive">) => {
        invalidatedTiers.push(...tiers);
      },
    } as unknown as StorageManager;
    const controller = new AbortController();
    const { updatedCollections, signals, stub: qmd } = makeQmdStub();

    const result = await purgeMemories({
      storage,
      olderThanMs: 365 * 86_400_000,
      tier: "all",
      dryRun: false,
      qmd: qmd as any,
      hotCollection: "hot-test",
      coldCollection: "cold-test",
      signal: controller.signal,
      now: () => new Date("2026-04-27T00:00:00.000Z"),
    });

    assert.equal(result.purgedCount, 1);
    assert.deepEqual(invalidatedTiers, ["archive"]);
    assert.deepEqual(updatedCollections, []);
    assert.deepEqual(signals, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("purgeMemories: default dryRun is true", async () => {
  const old = makeMemory({ id: "old-default", updated: "2024-01-01T00:00:00.000Z", filePath: "/tmp/mem/cold/old-default.md" });
  const { stub } = makeStorageStub({ cold: [old] });

  const result = await purgeMemories({
    storage: stub,
    olderThanMs: 100 * 86_400_000,
    now: () => new Date("2026-04-27T00:00:00.000Z"),
  } as PurgeMemoriesOptions);

  assert.equal(result.dryRun, true, "purge must default to dry-run to prevent accidental deletion");
});

test("purgeMemories: skips memories with no parseable timestamp", async () => {
  const noTs = makeMemory({ id: "no-ts", filePath: "/tmp/mem/cold/no-ts.md" });
  // Remove timestamps entirely
  (noTs.frontmatter as any).created = "";
  (noTs.frontmatter as any).updated = "";
  const { stub } = makeStorageStub({ cold: [noTs] });

  const result = await purgeMemories({
    storage: stub,
    olderThanMs: 1,
    tier: "cold",
    dryRun: true,
    now: () => new Date("2026-04-27T00:00:00.000Z"),
  });

  assert.equal(result.candidates.length, 0);
});
