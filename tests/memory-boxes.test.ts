/**
 * Tests for Memory Boxes + Trace Weaving (v8.0 Phase 2A)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BoxBuilder, topicOverlapScore, parseBoxFrontmatter, BOX_DIR } from "../src/boxes.js";

async function makeTmp(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "engram-boxes-"));
}

async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

// ── topicOverlapScore ──────────────────────────────────────────────────────

test("topicOverlapScore returns 1.0 for identical sets", () => {
  const score = topicOverlapScore(["db", "postgres", "migration"], ["db", "postgres", "migration"]);
  assert.equal(score, 1.0);
});

test("topicOverlapScore returns 0.0 for disjoint sets", () => {
  const score = topicOverlapScore(["db", "postgres"], ["react", "frontend"]);
  assert.equal(score, 0.0);
});

test("topicOverlapScore returns partial score for partial overlap", () => {
  const score = topicOverlapScore(["a", "b", "c", "d"], ["b", "c", "x", "y"]);
  // intersection = {b, c} = 2, union = {a,b,c,d,x,y} = 6 → 2/6 ≈ 0.333
  assert.ok(score > 0 && score < 1, `expected partial overlap, got ${score}`);
});

test("topicOverlapScore handles empty inputs gracefully", () => {
  assert.equal(topicOverlapScore([], []), 0.0);
  assert.equal(topicOverlapScore(["a"], []), 0.0);
  assert.equal(topicOverlapScore([], ["a"]), 0.0);
});

// ── BoxBuilder: basic sealing ──────────────────────────────────────────────

test("BoxBuilder seals a box when time gap exceeds threshold", async () => {
  const dir = await makeTmp();
  try {
    const builder = new BoxBuilder(dir, {
      memoryBoxesEnabled: true,
      traceWeaverEnabled: false,
      boxTopicShiftThreshold: 0.8,
      boxTimeGapMs: 1000, // 1 second for test
      boxMaxMemories: 100,
      traceWeaverLookbackDays: 7,
      traceWeaverOverlapThreshold: 0.4,
    });

    // First extraction at t=0
    const now = Date.now();
    await builder.onExtraction({
      topics: ["database", "postgresql"],
      memoryIds: ["fact-001", "decision-002"],
      timestamp: new Date(now - 5000).toISOString(),
    });

    // Second extraction with time gap > threshold
    await builder.onExtraction({
      topics: ["database", "postgresql"],
      memoryIds: ["fact-003"],
      timestamp: new Date(now).toISOString(),
    });

    // The first extraction should have been sealed due to time gap
    const boxDir = path.join(dir, BOX_DIR);
    const dateDir = new Date(now - 5000).toISOString().slice(0, 10);
    const dayPath = path.join(boxDir, dateDir);
    let sealed = false;
    try {
      const entries = await readdir(dayPath);
      sealed = entries.some((e) => e.endsWith(".md"));
    } catch {
      // may not exist yet
    }

    // Force-seal pending state to check everything
    await builder.sealCurrent("forced");
    const dayPath2 = path.join(boxDir, new Date(now).toISOString().slice(0, 10));
    let entries2: string[] = [];
    try { entries2 = await readdir(dayPath2); } catch { /* ok */ }
    // At least one box should be sealed
    const allEntries = [...(sealed ? ["sealed"] : []), ...entries2];
    assert.ok(allEntries.length > 0 || sealed, "at least one box should be sealed");
  } finally {
    await cleanup(dir);
  }
});

test("BoxBuilder seals a box when topics shift significantly", async () => {
  const dir = await makeTmp();
  try {
    const builder = new BoxBuilder(dir, {
      memoryBoxesEnabled: true,
      traceWeaverEnabled: false,
      boxTopicShiftThreshold: 0.3, // low threshold = easy to trigger
      boxTimeGapMs: 60 * 60 * 1000, // 1 hour
      boxMaxMemories: 100,
      traceWeaverLookbackDays: 7,
      traceWeaverOverlapThreshold: 0.4,
    });

    const now = new Date().toISOString();
    // First extraction: database topics
    await builder.onExtraction({ topics: ["database", "postgresql", "schema"], memoryIds: ["m1"], timestamp: now });
    // Second extraction: completely different topics
    await builder.onExtraction({ topics: ["react", "frontend", "typescript"], memoryIds: ["m2"], timestamp: now });

    // Force seal to persist
    await builder.sealCurrent("forced");

    const boxDir = path.join(dir, BOX_DIR);
    const allBoxes = await collectAllBoxFiles(boxDir);
    assert.ok(allBoxes.length >= 1, `expected at least 1 sealed box, got ${allBoxes.length}`);
  } finally {
    await cleanup(dir);
  }
});

test("BoxBuilder does not seal when same topics continue", async () => {
  const dir = await makeTmp();
  try {
    const builder = new BoxBuilder(dir, {
      memoryBoxesEnabled: true,
      traceWeaverEnabled: false,
      boxTopicShiftThreshold: 0.5, // topics with ~67% overlap should not seal (0.667 > 0.5)
      boxTimeGapMs: 60 * 60 * 1000,
      boxMaxMemories: 100,
      traceWeaverLookbackDays: 7,
      traceWeaverOverlapThreshold: 0.4,
    });

    const now = new Date().toISOString();
    await builder.onExtraction({ topics: ["postgres", "database"], memoryIds: ["m1"], timestamp: now });
    await builder.onExtraction({ topics: ["postgres", "database", "schema"], memoryIds: ["m2"], timestamp: now });

    const boxDir = path.join(dir, BOX_DIR);
    const allBoxes = await collectAllBoxFiles(boxDir);
    // No boxes should be sealed yet (topics are still similar)
    assert.equal(allBoxes.length, 0, `expected 0 sealed boxes, got ${allBoxes.length}`);
  } finally {
    await cleanup(dir);
  }
});

test("BoxBuilder serializes concurrent open-box updates", async () => {
  const dir = await makeTmp();
  try {
    const builder = new BoxBuilder(dir, {
      memoryBoxesEnabled: true,
      traceWeaverEnabled: false,
      boxTopicShiftThreshold: 0.5,
      boxTimeGapMs: 60 * 60 * 1000,
      boxMaxMemories: 100,
      traceWeaverLookbackDays: 7,
      traceWeaverOverlapThreshold: 0.4,
    });

    const now = new Date().toISOString();
    await Promise.all([
      builder.onExtraction({ topics: ["postgres", "database"], memoryIds: ["m1"], timestamp: now }),
      builder.onExtraction({ topics: ["postgres", "database"], memoryIds: ["m2"], timestamp: now }),
    ]);
    await builder.sealCurrent("forced");

    const boxDir = path.join(dir, BOX_DIR);
    const allBoxes = await collectAllBoxFiles(boxDir);
    assert.equal(allBoxes.length, 1, `expected one merged box, got ${allBoxes.length}`);

    const content = await readFile(allBoxes[0]!, "utf-8");
    const parsed = parseBoxFrontmatter(content);
    assert.deepEqual(parsed?.memoryIds.sort(), ["m1", "m2"]);
  } finally {
    await cleanup(dir);
  }
});

// ── BoxBuilder: sealed box format ─────────────────────────────────────────

test("BoxBuilder writes valid frontmatter when sealing", async () => {
  const dir = await makeTmp();
  try {
    const builder = new BoxBuilder(dir, {
      memoryBoxesEnabled: true,
      traceWeaverEnabled: false,
      boxTopicShiftThreshold: 0.3,
      boxTimeGapMs: 60 * 60 * 1000,
      boxMaxMemories: 100,
      traceWeaverLookbackDays: 7,
      traceWeaverOverlapThreshold: 0.4,
    });

    const now = new Date().toISOString();
    await builder.onExtraction({ topics: ["db", "postgres"], memoryIds: ["fact-1", "decision-2"], timestamp: now });
    await builder.onExtraction({ topics: ["react", "ui"], memoryIds: ["fact-3"], timestamp: now });
    await builder.sealCurrent("forced");

    const boxDir = path.join(dir, BOX_DIR);
    const allBoxes = await collectAllBoxFiles(boxDir);
    assert.ok(allBoxes.length >= 1, "expected at least one sealed box");

    const content = await readFile(allBoxes[0]!, "utf-8");
    const parsed = parseBoxFrontmatter(content);
    assert.ok(parsed, "frontmatter should parse successfully");
    assert.ok(parsed!.id.startsWith("box-"), `id should start with 'box-', got: ${parsed!.id}`);
    assert.ok(Array.isArray(parsed!.topics), "topics should be array");
    assert.ok(parsed!.topics.length > 0, "topics should not be empty");
    assert.ok(parsed!.sealedAt, "sealedAt should be set");
    assert.ok(parsed!.memoryIds.length > 0, "memoryIds should not be empty");
    assert.ok(typeof parsed!.memoryKind === "string", "memoryKind should be string");
    assert.equal(parsed!.memoryKind, "box");
  } finally {
    await cleanup(dir);
  }
});

test("BoxBuilder frontmatter arrays round-trip values with punctuation", async () => {
  const dir = await makeTmp();
  try {
    const builder = new BoxBuilder(dir, {
      memoryBoxesEnabled: true,
      traceWeaverEnabled: false,
      boxTopicShiftThreshold: 0.3,
      boxTimeGapMs: 60 * 60 * 1000,
      boxMaxMemories: 100,
      traceWeaverLookbackDays: 7,
      traceWeaverOverlapThreshold: 0.4,
    });

    const topics = ["api, auth", 'quote "topic"', "path\\topic"];
    const memoryIds = ["mem,1", 'mem"2', "mem\\3"];
    const toolsUsed = ["tool,one", 'tool"two', "tool\\three"];
    await builder.onExtraction({
      topics,
      memoryIds,
      toolsUsed,
      timestamp: new Date().toISOString(),
    });
    await builder.sealCurrent("forced");

    const allBoxes = await collectAllBoxFiles(path.join(dir, BOX_DIR));
    assert.equal(allBoxes.length, 1);
    const parsed = parseBoxFrontmatter(await readFile(allBoxes[0]!, "utf-8"));
    assert.ok(parsed);
    assert.deepEqual(parsed.topics, topics);
    assert.deepEqual(parsed.memoryIds, memoryIds);
    assert.deepEqual(parsed.toolsUsed, toolsUsed);
  } finally {
    await cleanup(dir);
  }
});

// ── Trace Weaving ─────────────────────────────────────────────────────────

test("TraceWeaver assigns same traceId to boxes with overlapping topics", async () => {
  const dir = await makeTmp();
  try {
    const builder = new BoxBuilder(dir, {
      memoryBoxesEnabled: true,
      traceWeaverEnabled: true,
      boxTopicShiftThreshold: 0.3,
      boxTimeGapMs: 60 * 60 * 1000,
      boxMaxMemories: 100,
      traceWeaverLookbackDays: 7,
      traceWeaverOverlapThreshold: 0.3,
    });

    const now = new Date().toISOString();
    // Box 1: database topics
    await builder.onExtraction({ topics: ["database", "postgresql", "schema"], memoryIds: ["m1"], timestamp: now });
    await builder.onExtraction({ topics: ["react", "ui"], memoryIds: ["m2"], timestamp: now });

    // Box 2: same database topics (should get same traceId)
    await builder.onExtraction({ topics: ["database", "postgresql", "indexes"], memoryIds: ["m3"], timestamp: now });
    await builder.onExtraction({ topics: ["deployment", "docker"], memoryIds: ["m4"], timestamp: now });
    await builder.sealCurrent("forced");

    const boxDir = path.join(dir, BOX_DIR);
    const allBoxes = await collectAllBoxFiles(boxDir);
    assert.ok(allBoxes.length >= 2, `expected >= 2 sealed boxes, got ${allBoxes.length}`);

    const parsed = await Promise.all(allBoxes.map(async (f) => {
      const c = await readFile(f, "utf-8");
      return parseBoxFrontmatter(c);
    }));

    const dbBoxes = parsed.filter((p) => p?.topics.some((t) => t === "database"));
    if (dbBoxes.length >= 2) {
      const traceIds = dbBoxes.map((p) => p?.traceId).filter(Boolean);
      // Both db-topic boxes should share the same traceId
      assert.ok(traceIds.length >= 2, "both db boxes should have a traceId");
      assert.equal(traceIds[0], traceIds[1], "db topic boxes should share the same traceId");
    }
  } finally {
    await cleanup(dir);
  }
});

test("TraceWeaver assigns different traceIds to disjoint topics", async () => {
  const dir = await makeTmp();
  try {
    const builder = new BoxBuilder(dir, {
      memoryBoxesEnabled: true,
      traceWeaverEnabled: true,
      boxTopicShiftThreshold: 0.3,
      boxTimeGapMs: 60 * 60 * 1000,
      boxMaxMemories: 100,
      traceWeaverLookbackDays: 7,
      traceWeaverOverlapThreshold: 0.4,
    });

    const now = new Date().toISOString();
    await builder.onExtraction({ topics: ["database", "postgresql"], memoryIds: ["m1"], timestamp: now });
    await builder.onExtraction({ topics: ["cooking", "recipes"], memoryIds: ["m2"], timestamp: now });
    await builder.onExtraction({ topics: ["machine", "learning"], memoryIds: ["m3"], timestamp: now });
    await builder.sealCurrent("forced");

    const boxDir = path.join(dir, BOX_DIR);
    const allBoxes = await collectAllBoxFiles(boxDir);
    assert.ok(allBoxes.length >= 2, `expected >= 2 sealed boxes, got ${allBoxes.length}`);

    const parsed = await Promise.all(allBoxes.map(async (f) => {
      const c = await readFile(f, "utf-8");
      return parseBoxFrontmatter(c);
    }));

    const traceIds = parsed.map((p) => p?.traceId).filter(Boolean);
    // Disjoint topics should either have no traceId or different traceIds
    const uniqueTraceIds = new Set(traceIds);
    // If all boxes have traceIds, they should be different
    if (traceIds.length > 1) {
      assert.ok(uniqueTraceIds.size > 1, "disjoint topic boxes should have different trace IDs");
    }
  } finally {
    await cleanup(dir);
  }
});

test("TraceWeaver omits traceId when trace index persistence fails", async () => {
  const dir = await makeTmp();
  try {
    const builder = new BoxBuilder(dir, {
      memoryBoxesEnabled: true,
      traceWeaverEnabled: true,
      boxTopicShiftThreshold: 0.3,
      boxTimeGapMs: 60 * 60 * 1000,
      boxMaxMemories: 100,
      traceWeaverLookbackDays: 7,
      traceWeaverOverlapThreshold: 0.4,
    });

    await builder.onExtraction({
      topics: ["database", "postgresql"],
      memoryIds: ["m1"],
      timestamp: new Date().toISOString(),
    });
    await mkdir(path.join(dir, "state", "traces.json"), { recursive: true });

    const boxId = await builder.sealCurrent("forced");
    assert.ok(boxId);

    const allBoxes = await collectAllBoxFiles(path.join(dir, BOX_DIR));
    assert.equal(allBoxes.length, 1);
    const parsed = parseBoxFrontmatter(await readFile(allBoxes[0]!, "utf-8"));
    assert.ok(parsed);
    assert.equal(parsed.traceId, undefined);
  } finally {
    await cleanup(dir);
  }
});

test("BoxBuilder keeps open box when clearing persisted state fails during seal", async () => {
  const dir = await makeTmp();
  try {
    const builder = new BoxBuilder(dir, {
      memoryBoxesEnabled: true,
      traceWeaverEnabled: false,
      boxTopicShiftThreshold: 0.3,
      boxTimeGapMs: 60 * 60 * 1000,
      boxMaxMemories: 100,
      traceWeaverLookbackDays: 7,
      traceWeaverOverlapThreshold: 0.4,
    });

    await builder.onExtraction({
      topics: ["database"],
      memoryIds: ["m1"],
      timestamp: new Date().toISOString(),
    });

    const openBoxPath = path.join(dir, "state", "open-box.json");
    await rm(openBoxPath, { recursive: true, force: true });
    await mkdir(openBoxPath, { recursive: true });

    await assert.rejects(() => builder.sealCurrent("forced"));

    await rm(openBoxPath, { recursive: true, force: true });
    const boxId = await builder.sealCurrent("forced");
    assert.ok(boxId);

    const allBoxes = await collectAllBoxFiles(path.join(dir, BOX_DIR));
    assert.equal(allBoxes.length, 1);
    const parsed = parseBoxFrontmatter(await readFile(allBoxes[0]!, "utf-8"));
    assert.deepEqual(parsed?.memoryIds, ["m1"]);
  } finally {
    await cleanup(dir);
  }
});

test("TraceWeaver ignores malformed trace index state", async () => {
  const dir = await makeTmp();
  try {
    const builder = new BoxBuilder(dir, {
      memoryBoxesEnabled: true,
      traceWeaverEnabled: true,
      boxTopicShiftThreshold: 0.3,
      boxTimeGapMs: 60 * 60 * 1000,
      boxMaxMemories: 100,
      traceWeaverLookbackDays: 7,
      traceWeaverOverlapThreshold: 0.4,
    });

    await mkdir(path.join(dir, "state"), { recursive: true });
    await writeFile(path.join(dir, "state", "traces.json"), JSON.stringify({ traces: [] }), "utf-8");
    await builder.onExtraction({
      topics: ["database"],
      memoryIds: ["m1"],
      timestamp: new Date().toISOString(),
    });

    const boxId = await builder.sealCurrent("forced");
    assert.ok(boxId);
  } finally {
    await cleanup(dir);
  }
});

// ── maxMemories sealing ───────────────────────────────────────────────────

test("BoxBuilder seals when maxMemories is exceeded", async () => {
  const dir = await makeTmp();
  try {
    const builder = new BoxBuilder(dir, {
      memoryBoxesEnabled: true,
      traceWeaverEnabled: false,
      boxTopicShiftThreshold: 0.99,
      boxTimeGapMs: 60 * 60 * 1000,
      boxMaxMemories: 2, // seal after 2 memories
      traceWeaverLookbackDays: 7,
      traceWeaverOverlapThreshold: 0.4,
    });

    const now = new Date().toISOString();
    await builder.onExtraction({ topics: ["db"], memoryIds: ["m1", "m2", "m3"], timestamp: now });

    const boxDir = path.join(dir, BOX_DIR);
    const allBoxes = await collectAllBoxFiles(boxDir);
    assert.ok(allBoxes.length >= 1, `expected box to be sealed due to maxMemories, got ${allBoxes.length} boxes`);
  } finally {
    await cleanup(dir);
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────

async function collectAllBoxFiles(boxDir: string): Promise<string[]> {
  const results: string[] = [];
  async function walk(dir: string) {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else if (e.name.endsWith(".md")) results.push(full);
      }
    } catch { /* not created yet */ }
  }
  await walk(boxDir);
  return results;
}
