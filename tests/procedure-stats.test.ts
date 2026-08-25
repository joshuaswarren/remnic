/**
 * Tests for the procedural stats surface (issue #567 PR 5/5).
 */
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import { StorageManager } from "@remnic/core/storage";
import { parseConfig } from "../packages/remnic-core/src/config.ts";
import { buildProcedureMarkdownBody } from "../packages/remnic-core/src/procedural/procedure-types.ts";
import {
  computeProcedureStats,
  formatProcedureStatsText,
} from "../packages/remnic-core/src/procedural/procedure-stats.ts";

test("computeProcedureStats returns zeroed counts for an empty storage", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-proc-stats-empty-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const config = parseConfig({
      memoryDir: dir,
      openaiApiKey: "test-key",
      procedural: { enabled: true },
    });

    const report = await computeProcedureStats({
      storage,
      config,
      nowMs: Date.parse("2026-04-20T12:00:00Z"),
    });

    assert.equal(report.schemaVersion, 1);
    assert.equal(report.counts.total, 0);
    assert.equal(report.counts.active, 0);
    assert.equal(report.counts.pending_review, 0);
    assert.equal(report.recent.lastWriteAt, null);
    assert.equal(report.recent.writesLast7Days, 0);
    assert.equal(report.recent.minerSourced, 0);
    assert.equal(report.config.enabled, true);
    assert.equal(report.generatedAt, "2026-04-20T12:00:00.000Z");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("computeProcedureStats tallies procedures by status and recency", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-proc-stats-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    // Seed three procedures: two from the miner (one active, one pending),
    // one user-authored active. Then one non-procedure for the "only count
    // procedures" invariant.
    const body = buildProcedureMarkdownBody([
      { order: 1, intent: "Step one" },
      { order: 2, intent: "Step two" },
    ]);

    await storage.writeMemory("procedure", `Active miner proc\n\n${body}`, {
      source: "procedure-miner",
      status: "active",
      tags: ["deploy"],
    });
    await storage.writeMemory("procedure", `Pending miner proc\n\n${body}`, {
      source: "procedure-miner",
      status: "pending_review",
      tags: ["ship"],
    });
    await storage.writeMemory("procedure", `Hand-authored proc\n\n${body}`, {
      source: "user",
      status: "active",
      tags: ["release"],
    });
    // Non-procedure category — must NOT appear in counts.
    await storage.writeMemory("fact", "some fact", {
      source: "user",
      status: "active",
      tags: [],
    });

    const config = parseConfig({
      memoryDir: dir,
      openaiApiKey: "test-key",
      procedural: {
        enabled: true,
        minOccurrences: 3,
        successFloor: 0.75,
        recallMaxProcedures: 2,
      },
    });

    // Fix `nowMs` ~ 1 minute after the writes. All three procedures should
    // land in the "last 7 days" window.
    const report = await computeProcedureStats({
      storage,
      config,
      nowMs: Date.now() + 60_000,
    });

    assert.equal(report.counts.total, 3);
    assert.equal(report.counts.active, 2);
    assert.equal(report.counts.pending_review, 1);
    assert.equal(report.counts.rejected, 0);
    assert.equal(report.counts.other, 0);
    assert.equal(report.recent.minerSourced, 2);
    assert.equal(
      report.recent.writesLast7Days,
      3,
      "all three writes are within the 7-day window",
    );
    assert.ok(
      report.recent.lastWriteAt !== null,
      "lastWriteAt should be set when procedures exist",
    );
    // Config snapshot reflects caller-supplied values.
    assert.equal(report.config.enabled, true);
    assert.equal(report.config.minOccurrences, 3);
    assert.equal(report.config.successFloor, 0.75);
    assert.equal(report.config.recallMaxProcedures, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("computeProcedureStats writesLast7Days uses a half-open window (CLAUDE.md rule 35)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-proc-stats-window-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const body = buildProcedureMarkdownBody([
      { order: 1, intent: "Only step" },
      { order: 2, intent: "Second step" },
    ]);
    await storage.writeMemory("procedure", `Single proc\n\n${body}`, {
      source: "user",
      status: "active",
      tags: [],
    });

    const config = parseConfig({
      memoryDir: dir,
      openaiApiKey: "test-key",
      procedural: { enabled: true },
    });

    // nowMs == write timestamp. With `createdMs < nowMs` the write must NOT
    // count (the window is [now-7d, now), half-open).
    const reports = await storage.readAllMemories();
    const procMemory = reports.find(
      (r) => r.frontmatter.category === "procedure",
    );
    assert.ok(procMemory, "procedure was persisted");
    const writeMs = Date.parse(procMemory.frontmatter.created);
    assert.ok(Number.isFinite(writeMs));

    const onBoundary = await computeProcedureStats({
      storage,
      config,
      nowMs: writeMs,
    });
    assert.equal(
      onBoundary.recent.writesLast7Days,
      0,
      "writes exactly at nowMs are outside the half-open window",
    );

    const oneMillisLater = await computeProcedureStats({
      storage,
      config,
      nowMs: writeMs + 1,
    });
    assert.equal(oneMillisLater.recent.writesLast7Days, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("computeProcedureStats counts archived procedures (Codex P2 on #611)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-proc-stats-archived-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const body = buildProcedureMarkdownBody([
      { order: 1, intent: "Step A" },
      { order: 2, intent: "Step B" },
    ]);

    // One live active procedure…
    await storage.writeMemory("procedure", `Live active\n\n${body}`, {
      source: "user",
      status: "active",
      tags: [],
    });
    // …and one that we then archive via `archiveMemory`.
    await storage.writeMemory(
      "procedure",
      `To archive\n\n${body}`,
      {
        source: "user",
        status: "active",
        tags: [],
      },
    );
    // Find the just-written procedure file and archive it.
    const live = await storage.readAllMemories();
    const toArchive = live.find(
      (m) =>
        m.frontmatter.category === "procedure" &&
        m.content.includes("To archive"),
    );
    assert.ok(toArchive, "procedure to archive must exist on disk");
    await storage.archiveMemory(toArchive);

    const config = parseConfig({
      memoryDir: dir,
      openaiApiKey: "test-key",
      procedural: { enabled: true },
    });

    const report = await computeProcedureStats({ storage, config });
    // Both procedures should count. `readAllMemories` alone would have
    // missed the archived one.
    assert.equal(report.counts.total, 2);
    assert.equal(report.counts.active, 1);
    assert.equal(report.counts.archived, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("computeProcedureStats recency uses latest of created/updated (Codex P2 on #611)", async () => {
  // Synthetic MemoryFile-shaped entries so we can pin both timestamps.
  // Rather than set up a real edit cycle in StorageManager (which would
  // only produce `updated >= created`), we mock a storage stub.
  const mkEntry = (id: string, created: string, updated: string) => ({
    path: `/tmp/${id}.md`,
    content: "",
    frontmatter: {
      id,
      category: "procedure" as const,
      created,
      updated,
      source: "user",
      confidence: 1,
      confidenceTier: "high" as const,
      tags: [] as string[],
    },
  });

  const fakeStorage = {
    readAllMemories: async () => [
      // `updated` is MORE RECENT than `created`; the report must key off
      // `updated`, not `created`, so this row lands in the 7-day window.
      mkEntry(
        "procA",
        "2026-04-10T00:00:00.000Z",
        "2026-04-20T10:00:00.000Z",
      ),
    ],
    readArchivedMemories: async () => [],
  } as unknown as StorageManager;

  const config = parseConfig({
    openaiApiKey: "sk-test",
    procedural: { enabled: true },
  });

  const report = await computeProcedureStats({
    storage: fakeStorage,
    config,
    nowMs: Date.parse("2026-04-20T12:00:00.000Z"),
  });

  assert.equal(
    report.recent.lastWriteAt,
    "2026-04-20T10:00:00.000Z",
    "lastWriteAt must reflect the most recent of created/updated",
  );
  assert.equal(
    report.recent.writesLast7Days,
    1,
    "row updated 2h ago must be inside the 7-day window",
  );
});

test("formatProcedureStatsText is deterministic for a known report", () => {
  const text = formatProcedureStatsText({
    schemaVersion: 1,
    generatedAt: "2026-04-20T12:00:00.000Z",
    counts: {
      total: 2,
      active: 1,
      pending_review: 1,
      rejected: 0,
      quarantined: 0,
      superseded: 0,
      archived: 0,
      other: 0,
    },
    recent: {
      lastWriteAt: "2026-04-19T23:59:59.000Z",
      writesLast7Days: 2,
      minerSourced: 1,
    },
    lastMaintenanceAt: "2026-04-20T06:00:00.000Z",
    needsRepairFlags: 1,
    config: {
      enabled: true,
      minOccurrences: 3,
      successFloor: 0.75,
      autoPromoteOccurrences: 8,
      autoPromoteEnabled: false,
      lookbackDays: 14,
      recallMaxProcedures: 2,
    },
  });

  assert.match(text, /Procedural memory stats \(schema v1\)/);
  assert.match(text, /total:\s+2/);
  assert.match(text, /pending_review:\s+1/);
  assert.match(text, /enabled:\s+true/);
  assert.match(text, /lastWriteAt:\s+2026-04-19T23:59:59\.000Z/);
  assert.match(text, /lastMaintenanceAt:\s+2026-04-20T06:00:00\.000Z/);
  assert.match(text, /needsRepairFlags:\s+1/);
  // No ANSI escapes — CLI output is deterministic and pipe-safe.
  assert.doesNotMatch(text, /\u001b\[/);
});
