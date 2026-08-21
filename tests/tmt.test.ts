/**
 * Tests for Temporal Memory Tree (v8.2 PR 17)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  tmtDir,
  hourNodePath,
  dayNodePath,
  weekNodePath,
  personaNodePath,
  serialiseTmtNode,
  parseIsoDate,
  parseIsoHour,
  isoWeekKey,
  capTmtSummaryInputs,
  type TmtNodeFrontmatter,
} from "../src/tmt.js";

async function makeTmp(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "engram-tmt-"));
}
async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

// ── Path helpers ─────────────────────────────────────────────────────────────

test("tmtDir returns baseDir/tmt", () => {
  assert.equal(tmtDir("/mem"), "/mem/tmt");
});

test("hourNodePath returns correct path", () => {
  assert.equal(
    hourNodePath("/mem", "2026-02-22", "14"),
    "/mem/tmt/2026-02-22/hour-14.md",
  );
});

test("dayNodePath returns correct path", () => {
  assert.equal(dayNodePath("/mem", "2026-02-22"), "/mem/tmt/2026-02-22/day.md");
});

test("weekNodePath returns correct path", () => {
  assert.equal(weekNodePath("/mem", "2026-08"), "/mem/tmt/week-2026-08.md");
});

test("personaNodePath returns correct path", () => {
  assert.equal(personaNodePath("/mem"), "/mem/tmt/persona.md");
});

// ── ISO helpers ───────────────────────────────────────────────────────────────

test("parseIsoDate extracts YYYY-MM-DD", () => {
  assert.equal(parseIsoDate("2026-02-22T14:30:00.000Z"), "2026-02-22");
});

test("parseIsoHour extracts HH", () => {
  assert.equal(parseIsoHour("2026-02-22T14:30:00.000Z"), "14");
});

test("isoWeekKey returns correct week", () => {
  const key = isoWeekKey(new Date("2026-02-22"));
  assert.match(key, /^\d{4}-\d{2}$/);
  assert.equal(key, "2026-08"); // 2026-02-22 is in week 08
});

test("capTmtSummaryInputs limits oversized content per level", () => {
  const oversized = Array.from({ length: 300 }, (_, i) => `entry-${i} ${"x".repeat(5000)}`);
  const capped = capTmtSummaryInputs(oversized, "hour");
  assert.ok(capped.length > 0);
  assert.ok(capped.length <= 64);
  const totalChars = capped.join("\n\n").length;
  assert.ok(totalChars <= 48_000);
  assert.ok(capped.every((item) => item.length <= 2_000));
});

// ── Serialisation ─────────────────────────────────────────────────────────────

test("serialiseTmtNode produces valid markdown with YAML frontmatter", () => {
  const fm: TmtNodeFrontmatter = {
    level: "hour",
    periodStart: "2026-02-22T14:00:00.000Z",
    periodEnd: "2026-02-22T15:00:00.000Z",
    memoryCount: 5,
    sourceIds: ["abc", "def"],
    builtAt: "2026-02-22T15:01:00.000Z",
  };
  const result = serialiseTmtNode(fm, "User worked on engram TMT feature.");
  assert.ok(result.startsWith("---\n"));
  assert.ok(result.includes("level: hour"));
  assert.ok(result.includes("memoryCount: 5"));
  assert.ok(result.includes('sourceIds: ["abc", "def"]'));
  assert.ok(result.includes("User worked on engram TMT feature."));
});

// ── TmtBuilder integration ────────────────────────────────────────────────────

const mockSummarize: import("../src/tmt.js").SummarizeFn = async (memories, _level) => {
  return `Summary of ${memories.length} memories.`;
};

const defaultCfg: import("../src/tmt.js").TmtConfig = {
  temporalMemoryTreeEnabled: true,
  tmtHourlyMinMemories: 2,
  tmtSummaryMaxTokens: 300,
};

function makeEntries(n: number, date = "2026-02-22", hourOffset = 0): import("../src/tmt.js").MemoryEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    path: `/mem/facts/${date}/fact-${i}.md`,
    id: `fact-${i}`,
    created: `${date}T${String(hourOffset).padStart(2, "0")}:${String(i * 3).padStart(2, "0")}:00.000Z`,
    content: `Memory content ${i}`,
  }));
}

test("TmtBuilder: disabled flag → no files written", async () => {
  const dir = await makeTmp();
  try {
    const builder = new (await import("../src/tmt.js")).TmtBuilder(dir, {
      ...defaultCfg,
      temporalMemoryTreeEnabled: false,
    });
    await builder.maybeRebuildNodes(makeEntries(5), mockSummarize);
    const { existsSync } = await import("node:fs");
    assert.ok(!existsSync(path.join(dir, "tmt")), "tmt dir should not exist");
  } finally { await cleanup(dir); }
});

test("TmtBuilder: builds hour node when min memories threshold met", async () => {
  const dir = await makeTmp();
  try {
    const { TmtBuilder } = await import("../src/tmt.js");
    const builder = new TmtBuilder(dir, defaultCfg);
    const entries = makeEntries(3, "2026-02-22", 14); // 3 memories in hour 14
    await builder.maybeRebuildNodes(entries, mockSummarize);
    const { existsSync } = await import("node:fs");
    const nodePath = path.join(dir, "tmt", "2026-02-22", "hour-14.md");
    assert.ok(existsSync(nodePath), "hour node should be written");
    const content = await (await import("node:fs/promises")).readFile(nodePath, "utf8");
    assert.ok(content.includes("level: hour"));
    assert.ok(content.includes("memoryCount: 3"));
    assert.ok(content.includes("Summary of 3 memories."));
  } finally { await cleanup(dir); }
});

test("TmtBuilder: skips hour node when below min memories threshold", async () => {
  const dir = await makeTmp();
  try {
    const { TmtBuilder } = await import("../src/tmt.js");
    const builder = new TmtBuilder(dir, defaultCfg); // threshold = 2
    const entries = makeEntries(1, "2026-02-22", 10); // only 1 memory
    await builder.maybeRebuildNodes(entries, mockSummarize);
    const { existsSync } = await import("node:fs");
    assert.ok(!existsSync(path.join(dir, "tmt", "2026-02-22", "hour-10.md")));
  } finally { await cleanup(dir); }
});

test("TmtBuilder: builds day node", async () => {
  const dir = await makeTmp();
  try {
    const { TmtBuilder } = await import("../src/tmt.js");
    const builder = new TmtBuilder(dir, defaultCfg);
    const entries = makeEntries(5, "2026-02-22", 9);
    await builder.maybeRebuildNodes(entries, mockSummarize);
    const nodePath = path.join(dir, "tmt", "2026-02-22", "day.md");
    const { existsSync } = await import("node:fs");
    assert.ok(existsSync(nodePath), "day node should be written");
    const content = await (await import("node:fs/promises")).readFile(nodePath, "utf8");
    assert.ok(content.includes("level: day"));
    assert.ok(content.includes("memoryCount: 5"));
  } finally { await cleanup(dir); }
});

test("TmtBuilder: getMostRelevantNode returns null when no nodes exist", async () => {
  const dir = await makeTmp();
  try {
    const { TmtBuilder } = await import("../src/tmt.js");
    const builder = new TmtBuilder(dir, defaultCfg);
    const node = await builder.getMostRelevantNode();
    assert.equal(node, null);
  } finally { await cleanup(dir); }
});

test("TmtBuilder: getMostRelevantNode returns day node content after build", async () => {
  const dir = await makeTmp();
  try {
    const { TmtBuilder } = await import("../src/tmt.js");
    const builder = new TmtBuilder(dir, defaultCfg);
    const today = new Date().toISOString().slice(0, 10);
    const entries = makeEntries(5, today, 9);
    await builder.maybeRebuildNodes(entries, mockSummarize);
    const node = await builder.getMostRelevantNode();
    assert.ok(node !== null);
    assert.equal(node.level, "day");
    assert.ok(node.summary.includes("Summary of"));
  } finally { await cleanup(dir); }
});

test("TmtBuilder: disabled → getMostRelevantNode returns null", async () => {
  const dir = await makeTmp();
  try {
    const { TmtBuilder } = await import("../src/tmt.js");
    const builder = new TmtBuilder(dir, { ...defaultCfg, temporalMemoryTreeEnabled: false });
    const node = await builder.getMostRelevantNode();
    assert.equal(node, null);
  } finally { await cleanup(dir); }
});

// ── Week + Persona rollup ─────────────────────────────────────────────────────

test("TmtBuilder: builds week node when memories share an ISO week", async () => {
  const dir = await makeTmp();
  try {
    const { TmtBuilder, weekNodePath, isoWeekKey } = await import("../src/tmt.js");
    const builder = new TmtBuilder(dir, defaultCfg);
    // Use a fixed past date so the week key is stable
    const date = "2026-02-22";
    const entries = makeEntries(5, date, 9);
    await builder.maybeRebuildNodes(entries, mockSummarize);

    const week = isoWeekKey(new Date(date));
    const nodePath = weekNodePath(dir, week);
    const { existsSync } = await import("node:fs");
    assert.ok(existsSync(nodePath), `week node should be written at ${nodePath}`);
    const content = await (await import("node:fs/promises")).readFile(nodePath, "utf8");
    assert.ok(content.includes("level: week"), "week node should have level: week");
    assert.ok(content.includes("memoryCount: 5"), "week node should reflect memory count");
  } finally { await cleanup(dir); }
});

test("TmtBuilder: week node is rebuilt when memory count increases", async () => {
  const dir = await makeTmp();
  try {
    const { TmtBuilder, weekNodePath, isoWeekKey } = await import("../src/tmt.js");
    const date = "2026-02-22";
    const week = isoWeekKey(new Date(date));

    const builder = new TmtBuilder(dir, defaultCfg);
    await builder.maybeRebuildNodes(makeEntries(3, date, 9), mockSummarize);

    const nodePath = weekNodePath(dir, week);
    const first = await (await import("node:fs/promises")).readFile(nodePath, "utf8");
    assert.ok(first.includes("memoryCount: 3"));

    // Add 2 more memories and rebuild
    await builder.maybeRebuildNodes(makeEntries(5, date, 9), mockSummarize);
    const second = await (await import("node:fs/promises")).readFile(nodePath, "utf8");
    assert.ok(second.includes("memoryCount: 5"), "week node should be rebuilt with updated count");
  } finally { await cleanup(dir); }
});

test("TmtBuilder: builds persona node when week nodes exist", async () => {
  const dir = await makeTmp();
  try {
    const { TmtBuilder, personaNodePath } = await import("../src/tmt.js");
    const builder = new TmtBuilder(dir, defaultCfg);
    const date = "2026-02-22";
    const entries = makeEntries(5, date, 9);
    await builder.maybeRebuildNodes(entries, mockSummarize);

    const nodePath = personaNodePath(dir);
    const { existsSync } = await import("node:fs");
    assert.ok(existsSync(nodePath), "persona node should be written");
    const content = await (await import("node:fs/promises")).readFile(nodePath, "utf8");
    assert.ok(content.includes("level: persona"), "persona node should have level: persona");
  } finally { await cleanup(dir); }
});
