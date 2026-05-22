/**
 * Integration tests for Temporal Memory Tree orchestrator integration (v8.2 PR 17)
 *
 * Tests the following scenarios from the design spec:
 * 1. Feature disabled → baseline behavior unchanged (no files written)
 * 2. Feature enabled → expected TMT nodes written during consolidation-like flow
 * 3. Fail-open: corrupted state files do not throw
 * 4. getMostRelevantNode skips TMT injection when recalling with no nodes
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";

import {
  TmtBuilder,
  tmtDir,
  dayNodePath,
  weekNodePath,
  personaNodePath,
  hourNodePath,
  serialiseTmtNode,
  type TmtConfig,
  type MemoryEntry,
  type SummarizeFn,
} from "../src/tmt.js";

async function makeTmp(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "engram-tmt-integration-"));
}

async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

const mockSummarize: SummarizeFn = async (memories, level) => {
  return `[${level}] Summarized ${memories.length} items.`;
};

const enabledCfg: TmtConfig = {
  temporalMemoryTreeEnabled: true,
  tmtHourlyMinMemories: 2,
  tmtSummaryMaxTokens: 300,
};

const disabledCfg: TmtConfig = {
  temporalMemoryTreeEnabled: false,
  tmtHourlyMinMemories: 2,
  tmtSummaryMaxTokens: 300,
};

function makeEntries(n: number, date: string, hour = 9): MemoryEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    path: `/mem/facts/${date}/fact-${i}.md`,
    id: `fact-${date}-${i}`,
    created: `${date}T${String(hour).padStart(2, "0")}:${String(i * 5).padStart(2, "0")}:00.000Z`,
    content: `Fact content ${i} from ${date}`,
  }));
}

// ── Integration: feature disabled ─────────────────────────────────────────────

test("TMT integration: disabled flag → no tmt/ directory created", async () => {
  const dir = await makeTmp();
  try {
    const builder = new TmtBuilder(dir, disabledCfg);
    const entries = makeEntries(5, "2026-02-22", 9);
    await builder.maybeRebuildNodes(entries, mockSummarize);
    assert.ok(!existsSync(tmtDir(dir)), "tmt/ should not be created when feature is disabled");
  } finally { await cleanup(dir); }
});

test("TMT integration: disabled flag → getMostRelevantNode returns null without side effects", async () => {
  const dir = await makeTmp();
  try {
    const builder = new TmtBuilder(dir, disabledCfg);
    const result = await builder.getMostRelevantNode();
    assert.equal(result, null, "getMostRelevantNode should return null when disabled");
    assert.ok(!existsSync(tmtDir(dir)), "no tmt dir should be created by getMostRelevantNode when disabled");
  } finally { await cleanup(dir); }
});

// ── Integration: feature enabled — full consolidation flow ────────────────────

test("TMT integration: enabled → all node levels written for a single day batch", async () => {
  const dir = await makeTmp();
  try {
    const builder = new TmtBuilder(dir, enabledCfg);
    const date = "2026-02-22";
    const entries = makeEntries(5, date, 10); // 5 memories, hour 10 (above threshold of 2)
    await builder.maybeRebuildNodes(entries, mockSummarize);

    // Hour node
    assert.ok(existsSync(hourNodePath(dir, date, "10")), "hour node should be written");
    // Day node
    assert.ok(existsSync(dayNodePath(dir, date)), "day node should be written");
    // Week node
    const { isoWeekKey } = await import("../src/tmt.js");
    const week = isoWeekKey(new Date(date));
    assert.ok(existsSync(weekNodePath(dir, week)), "week node should be written");
    // Persona node
    assert.ok(existsSync(personaNodePath(dir)), "persona node should be written");
  } finally { await cleanup(dir); }
});

test("TMT integration: active memory shrink rebuilds stale hour day and week nodes", async () => {
  const dir = await makeTmp();
  try {
    const builder = new TmtBuilder(dir, enabledCfg);
    const date = "2026-02-22";
    const initialEntries = makeEntries(5, date, 10);
    await builder.maybeRebuildNodes(initialEntries, mockSummarize);

    const shrunkEntries = makeEntries(3, date, 10);
    await builder.maybeRebuildNodes(shrunkEntries, mockSummarize);

    const { isoWeekKey } = await import("../src/tmt.js");
    const week = isoWeekKey(new Date(date));
    const hourNode = await (await import("node:fs/promises")).readFile(hourNodePath(dir, date, "10"), "utf8");
    const dayNode = await (await import("node:fs/promises")).readFile(dayNodePath(dir, date), "utf8");
    const weekNode = await (await import("node:fs/promises")).readFile(weekNodePath(dir, week), "utf8");
    assert.match(hourNode, /memoryCount: 3/);
    assert.match(dayNode, /memoryCount: 3/);
    assert.match(weekNode, /memoryCount: 3/);
  } finally { await cleanup(dir); }
});

test("TMT integration: enabled → getMostRelevantNode returns day node after build", async () => {
  const dir = await makeTmp();
  try {
    const builder = new TmtBuilder(dir, enabledCfg);
    const today = new Date().toISOString().slice(0, 10);
    const entries = makeEntries(5, today, 9);
    await builder.maybeRebuildNodes(entries, mockSummarize);

    const node = await builder.getMostRelevantNode();
    assert.ok(node !== null, "getMostRelevantNode should return a node");
    assert.equal(node!.level, "day");
    assert.ok(node!.summary.includes("Summarized"), "summary text should be from mock summarizer");
  } finally { await cleanup(dir); }
});

test("TMT integration: enabled → hour nodes skipped when below threshold", async () => {
  const dir = await makeTmp();
  try {
    const builder = new TmtBuilder(dir, { ...enabledCfg, tmtHourlyMinMemories: 5 });
    const date = "2026-02-22";
    const entries = makeEntries(3, date, 10); // only 3, threshold is 5
    await builder.maybeRebuildNodes(entries, mockSummarize);

    assert.ok(!existsSync(hourNodePath(dir, date, "10")), "hour node should NOT be written (below threshold)");
    // Day node should still be written (no threshold for day)
    assert.ok(existsSync(dayNodePath(dir, date)), "day node should still be written");
  } finally { await cleanup(dir); }
});

// ── Fail-open: corrupted state files ──────────────────────────────────────────

test("TMT integration: corrupted day node → rebuilt without throwing", async () => {
  const dir = await makeTmp();
  try {
    const builder = new TmtBuilder(dir, enabledCfg);
    const date = "2026-02-22";

    // Pre-create a corrupt day node
    const dateDir = path.join(tmtDir(dir), date);
    await mkdir(dateDir, { recursive: true });
    await writeFile(path.join(dateDir, "day.md"), "<<<CORRUPT>>>", "utf8");

    const entries = makeEntries(4, date, 9);
    // Should not throw — fail-open guarantees
    await assert.doesNotReject(
      () => builder.maybeRebuildNodes(entries, mockSummarize),
      "maybeRebuildNodes should not throw on corrupt day node",
    );
  } finally { await cleanup(dir); }
});

test("TMT integration: getMostRelevantNode on missing tmt dir → returns null without throwing", async () => {
  const dir = await makeTmp();
  try {
    const builder = new TmtBuilder(dir, enabledCfg);
    // Do not create any nodes
    const result = await builder.getMostRelevantNode();
    assert.equal(result, null, "should return null when tmt dir does not exist");
  } finally { await cleanup(dir); }
});

test("TMT integration: getMostRelevantNode on malformed day file → returns null without throwing", async () => {
  const dir = await makeTmp();
  try {
    const builder = new TmtBuilder(dir, enabledCfg);
    const today = new Date().toISOString().slice(0, 10);
    const dateDir = path.join(tmtDir(dir), today);
    await mkdir(dateDir, { recursive: true });
    // Write a day.md with empty frontmatter stripped content
    await writeFile(path.join(dateDir, "day.md"), "---\nlevel: day\n---\n\n", "utf8");

    const result = await builder.getMostRelevantNode();
    // Empty summary after stripping frontmatter → should fall through, not throw
    assert.ok(result === null, "should return null when summary is empty after frontmatter strip");
  } finally { await cleanup(dir); }
});

// ── Integration: multi-day batch ──────────────────────────────────────────────

test("TMT integration: memories across two weeks produce two week nodes", async () => {
  const dir = await makeTmp();
  try {
    const { isoWeekKey } = await import("../src/tmt.js");
    const builder = new TmtBuilder(dir, enabledCfg);
    // Use dates that are guaranteed to be in different calendar weeks regardless of timezone.
    // 2026-01-05 (Monday, week 02) and 2026-01-12 (Monday, week 03) are 7 days apart.
    // All entries use T12:00:00.000Z (noon UTC) to ensure local date matches UTC date in any timezone.
    const dateA = "2026-01-05";
    const dateB = "2026-01-12";
    const entriesA = [
      { path: "/m/a-0.md", id: "a-0", created: `${dateA}T12:00:00.000Z`, content: "a0" },
      { path: "/m/a-1.md", id: "a-1", created: `${dateA}T12:05:00.000Z`, content: "a1" },
      { path: "/m/a-2.md", id: "a-2", created: `${dateA}T12:10:00.000Z`, content: "a2" },
    ];
    const entriesB = [
      { path: "/m/b-0.md", id: "b-0", created: `${dateB}T12:00:00.000Z`, content: "b0" },
      { path: "/m/b-1.md", id: "b-1", created: `${dateB}T12:05:00.000Z`, content: "b1" },
      { path: "/m/b-2.md", id: "b-2", created: `${dateB}T12:10:00.000Z`, content: "b2" },
    ];

    await builder.maybeRebuildNodes([...entriesA, ...entriesB], mockSummarize);

    // Derive weeks from the entry created timestamps (same logic as TmtBuilder uses)
    const weekA = isoWeekKey(new Date(`${dateA}T12:00:00.000Z`));
    const weekB = isoWeekKey(new Date(`${dateB}T12:00:00.000Z`));
    assert.notEqual(weekA, weekB, `${dateA} and ${dateB} should be in different ISO weeks`);
    assert.ok(existsSync(weekNodePath(dir, weekA)), `week node for ${weekA} should exist`);
    assert.ok(existsSync(weekNodePath(dir, weekB)), `week node for ${weekB} should exist`);
  } finally { await cleanup(dir); }
});

test("TMT integration: empty memory array → no files written, no throw", async () => {
  const dir = await makeTmp();
  try {
    const builder = new TmtBuilder(dir, enabledCfg);
    await assert.doesNotReject(
      () => builder.maybeRebuildNodes([], mockSummarize),
      "should not throw for empty memory array",
    );
    assert.ok(!existsSync(tmtDir(dir)), "no tmt dir should be created for empty array");
  } finally { await cleanup(dir); }
});

// ── Serialization round-trip ──────────────────────────────────────────────────

test("TMT integration: serialiseTmtNode content survives a write/read round-trip", async () => {
  const dir = await makeTmp();
  try {
    const nodePath = path.join(dir, "round-trip.md");
    const { TmtNodeFrontmatter } = await import("../src/tmt.js" as any);
    const fm = {
      level: "day" as const,
      periodStart: "2026-02-22T00:00:00.000Z",
      periodEnd: "2026-02-22T23:59:59.999Z",
      memoryCount: 7,
      sourceIds: ["id-1", "id-2"],
      builtAt: "2026-02-22T12:00:00.000Z",
    };
    const content = serialiseTmtNode(fm, "A test summary with facts.");
    await writeFile(nodePath, content, "utf8");
    const readBack = await (await import("node:fs/promises")).readFile(nodePath, "utf8");
    assert.equal(content, readBack, "serialized content should survive write/read unchanged");
    assert.ok(readBack.includes("memoryCount: 7"));
    assert.ok(readBack.includes("A test summary with facts."));
  } finally { await cleanup(dir); }
});
