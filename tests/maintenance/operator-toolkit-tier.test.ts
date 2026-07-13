/**
 * Unit tests for the `summarizeTierDistribution` function added to
 * operator-toolkit.ts (issue #686 retention-completion).
 *
 * Exercises the tier-distribution Doctor check without booting a full
 * orchestrator. Uses a lightweight StorageManager stub.
 */

import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";

import { summarizeTierDistribution } from "../../packages/remnic-core/src/operator-toolkit.js";
import { StorageManager } from "../../packages/remnic-core/src/storage.js";
import type { MemoryFile, MemoryFrontmatter } from "../../packages/remnic-core/src/types.js";

function makeMemory(overrides: Partial<MemoryFrontmatter> & { filePath?: string } = {}): MemoryFile {
  const { filePath, ...fm } = overrides;
  return {
    path: filePath ?? `/tmp/mem/${fm.id ?? "m1"}.md`,
    content: "body",
    frontmatter: {
      id: "m1",
      category: "fact",
      created: "2026-01-01T00:00:00.000Z",
      updated: "2026-01-01T00:00:00.000Z",
      source: "test",
      ...fm,
    } as MemoryFrontmatter,
  };
}

function makeStorageStub(
  hot: MemoryFile[],
  cold: MemoryFile[] = [],
): StorageManager {
  return {
    dir: "/tmp/mem",
    readAllMemories: async () => hot,
    readAllColdMemories: async () => cold,
  } as unknown as StorageManager;
}

test("summarizeTierDistribution: key is 'tier_distribution'", async () => {
  const stub = makeStorageStub([]);
  const check = await summarizeTierDistribution(stub);
  assert.equal(check.key, "tier_distribution");
});

test("summarizeTierDistribution: status is always 'ok'", async () => {
  const stub = makeStorageStub([]);
  const check = await summarizeTierDistribution(stub);
  assert.equal(check.status, "ok");
});

test("summarizeTierDistribution: counts hot and cold separately", async () => {
  const hotMemories = [
    makeMemory({ id: "h1", filePath: "/tmp/mem/h1.md" }),
    makeMemory({ id: "h2", filePath: "/tmp/mem/h2.md" }),
  ];
  const coldMemories = [
    makeMemory({ id: "c1", filePath: "/tmp/mem/cold/c1.md" }),
  ];
  const stub = makeStorageStub(hotMemories, coldMemories);
  const check = await summarizeTierDistribution(stub);

  assert.ok(typeof check.details === "object" && check.details !== null);
  const details = check.details as Record<string, unknown>;
  assert.equal((details.byTier as Record<string, number>).hot, 2);
  assert.equal((details.byTier as Record<string, number>).cold, 1);
  assert.equal(details.total, 3);
});

test("summarizeTierDistribution: reports forgottenCount correctly", async () => {
  const hot = [
    makeMemory({ id: "a", status: "active" as any }),
    makeMemory({ id: "b", status: "forgotten" as any }),
    makeMemory({ id: "c", status: "forgotten" as any }),
  ];
  const stub = makeStorageStub(hot);
  const check = await summarizeTierDistribution(stub);

  const details = check.details as Record<string, unknown>;
  assert.equal(details.forgottenCount, 2);
});

test("summarizeTierDistribution: summary string contains hot and cold counts", async () => {
  const stub = makeStorageStub(
    [makeMemory({ id: "h1" }), makeMemory({ id: "h2" })],
    [makeMemory({ id: "c1" })],
  );
  const check = await summarizeTierDistribution(stub);
  assert.match(check.summary, /hot=2/);
  assert.match(check.summary, /cold=1/);
});

test("summarizeTierDistribution: mentions forgotten count when > 0", async () => {
  const stub = makeStorageStub([
    makeMemory({ id: "f1", status: "forgotten" as any }),
  ]);
  const check = await summarizeTierDistribution(stub);
  assert.match(check.summary, /forgotten=1/);
});

test("summarizeTierDistribution: no forgotten mention when count is 0", async () => {
  const stub = makeStorageStub([makeMemory({ id: "a" })]);
  const check = await summarizeTierDistribution(stub);
  assert.ok(!check.summary.includes("forgotten="), "should not mention forgotten when count is 0");
});

test("summarizeTierDistribution: recentMigrations=0 when no journal file", async () => {
  const stub = makeStorageStub([]);
  const check = await summarizeTierDistribution(stub);
  const details = check.details as Record<string, unknown>;
  assert.equal(details.recentMigrations, 0);
});

test("summarizeTierDistribution: reads real journal file for recent migrations", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-toolkit-tier-"));
  try {
    const { mkdir, appendFile } = await import("node:fs/promises");
    const journalDir = path.join(dir, "state");
    await mkdir(journalDir, { recursive: true });
    const journalPath = path.join(journalDir, "tier-migration-journal.jsonl");

    // One recent entry (yesterday), one old entry (3 years ago)
    const yesterday = new Date(Date.now() - 1 * 86_400_000).toISOString();
    const ancient = new Date(Date.now() - 3 * 365 * 86_400_000).toISOString();

    await appendFile(journalPath, JSON.stringify({
      ts: yesterday, memoryId: "r1", fromTier: "hot", toTier: "cold",
      changed: true, reason: "value_below_threshold",
    }) + "\n", "utf-8");
    await appendFile(journalPath, JSON.stringify({
      ts: ancient, memoryId: "r2", fromTier: "hot", toTier: "cold",
      changed: true, reason: "value_below_threshold",
    }) + "\n", "utf-8");

    const storage = new StorageManager(dir);
    const check = await summarizeTierDistribution(storage);
    const details = check.details as Record<string, unknown>;

    // Only the recent entry (within 7 days) should count
    assert.equal(details.recentMigrations, 1);
    const topReasons = details.topDemotionReasons as Array<{ reason: string; count: number }>;
    assert.ok(topReasons.some((r) => r.reason === "value_below_threshold" && r.count >= 1));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("summarizeTierDistribution: ignores malformed truthy changed values in journal", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-toolkit-tier-"));
  try {
    const { mkdir, appendFile } = await import("node:fs/promises");
    const journalDir = path.join(dir, "state");
    await mkdir(journalDir, { recursive: true });
    const journalPath = path.join(journalDir, "tier-migration-journal.jsonl");
    const yesterday = new Date(Date.now() - 1 * 86_400_000).toISOString();

    await appendFile(journalPath, JSON.stringify({
      ts: yesterday, memoryId: "bad", fromTier: "hot", toTier: "cold",
      changed: "false", reason: "malformed",
    }) + "\n", "utf-8");

    const storage = new StorageManager(dir);
    const check = await summarizeTierDistribution(storage);
    const details = check.details as Record<string, unknown>;
    assert.equal(details.recentMigrations, 0);
    assert.deepEqual(details.topDemotionReasons, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("summarizeTierDistribution: gracefully handles storage read errors", async () => {
  const broken = {
    dir: "/tmp/nonexistent",
    readAllMemories: async () => { throw new Error("disk unreadable"); },
    readAllColdMemories: async () => [],
  } as unknown as StorageManager;

  // Must not throw — always returns an ok check
  const check = await summarizeTierDistribution(broken);
  assert.equal(check.key, "tier_distribution");
  assert.equal(check.status, "ok");
});

test("summarizeTierDistribution: runOperatorDoctor includes tier_distribution check", async () => {
  const { runOperatorDoctor } = await import(
    "../../packages/remnic-core/src/operator-toolkit.js"
  );
  const { parseConfig } = await import("../../packages/remnic-core/src/config.js");
  const { mkdir: mkdirFs, writeFile: writeFileFs } = await import("node:fs/promises");

  const testDir = await mkdtemp(path.join(os.tmpdir(), "remnic-doctor-tier-"));
  try {
    const memoryDir = path.join(testDir, "memory");
    const workspaceDir = path.join(testDir, "workspace");
    await mkdirFs(memoryDir, { recursive: true });
    await mkdirFs(workspaceDir, { recursive: true });

    const rawConfig = {
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir,
      qmdEnabled: false,
      transcriptEnabled: false,
      hourlySummariesEnabled: false,
      identityEnabled: false,
      identityContinuityEnabled: false,
      sharedContextEnabled: false,
      captureMode: "implicit",
    };
    const config = parseConfig(rawConfig);
    const configPath = path.join(testDir, "openclaw.json");
    await writeFileFs(configPath, JSON.stringify({
      plugins: { entries: { "openclaw-remnic": { config: rawConfig } } },
    }, null, 2), "utf-8");

    const orchestrator = {
      config,
      storage: new StorageManager(memoryDir),
      qmd: {
        async probe() { return false; },
        isAvailable() { return false; },
        async ensureCollection() { return "skipped" as const; },
        debugStatus() { return "disabled"; },
      },
      conversationIndexCoordinator: {
        async getHealth() {
          return { enabled: false, backend: "qmd" as const, status: "disabled" as const, chunkDocCount: 0, lastUpdateAt: null };
        },
        async rebuild() {
          return { chunks: 0, skipped: true, reason: "disabled", embedded: false, rebuilt: false };
        },
      },
    };

    const report = await runOperatorDoctor({ orchestrator, configPath });
    const tierCheck = report.checks.find((c) => c.key === "tier_distribution");
    assert.ok(tierCheck, "runOperatorDoctor should include a tier_distribution check");
    assert.equal(tierCheck?.status, "ok");
  } finally {
    await import("node:fs/promises").then(({ rm }) => rm(testDir, { recursive: true, force: true }));
  }
});
