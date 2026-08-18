import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { RECALL_FALLBACK_DIRS } from "../../utils/category-dir.js";
import type { TimelineCategory } from "./types.js";
import { persistWeeklySnapshot } from "./weekly-persist.js";
import { buildWeeklyActivitySummary } from "./weekly.js";

const WEEK_START = "2026-07-13T00:00:00.000Z";
const WEEK_END = "2026-07-20T00:00:00.000Z";
const OTHER_WEEK_START = "2026-07-20T00:00:00.000Z";
const OTHER_WEEK_END = "2026-07-27T00:00:00.000Z";

const CATEGORIES: TimelineCategory[] = [
  { id: "development", name: "Development", color: "#333333", description: "d", order: 1 },
];

function summary(weekStartUtc = WEEK_START, weekEndUtc = WEEK_END) {
  return buildWeeklyActivitySummary([], {
    timezone: "UTC",
    weekStartUtc,
    weekEndUtc,
    categories: CATEGORIES,
  });
}

function withMemoryDir(fn: (memoryDir: string) => void): void {
  const memoryDir = mkdtempSync(path.join(tmpdir(), "remnic-weekly-persist-"));
  try {
    fn(memoryDir);
  } finally {
    rmSync(memoryDir, { recursive: true, force: true });
  }
}

function assertOutsideRecallRoots(filePath: string, memoryDir: string): void {
  const relative = path.relative(memoryDir, filePath);
  assert.ok(relative.startsWith(`activity${path.sep}weekly${path.sep}`));
  assert.ok(
    !RECALL_FALLBACK_DIRS.some((dir) => relative === dir || relative.startsWith(`${dir}${path.sep}`)),
  );
}

test("same inputs skip rewrite by content hash", () => {
  withMemoryDir((memoryDir) => {
    const input = {
      memoryDir,
      namespace: "team",
      summary: summary(),
      sourceRevision: "rev-1",
      configHash: "cfg-1",
    };
    const first = persistWeeklySnapshot(input);
    assert.equal(first.written, true);
    assertOutsideRecallRoots(first.path, memoryDir);
    const firstBytes = readFileSync(first.path, "utf8");
    const firstStat = statSync(first.path);
    const snapshot = JSON.parse(firstBytes) as { contentHash: string };
    assert.equal(typeof snapshot.contentHash, "string");
    assert.equal(snapshot.contentHash.length, 64);

    const second = persistWeeklySnapshot(input);
    assert.equal(second.written, false);
    assert.equal(second.path, first.path);
    assert.equal(readFileSync(first.path, "utf8"), firstBytes);
    assert.equal(statSync(first.path).mtimeMs, firstStat.mtimeMs);
  });
});

test("changed sourceRevision or configHash writes a new file and leaves other weeks", () => {
  withMemoryDir((memoryDir) => {
    const base = {
      memoryDir,
      namespace: "team",
      summary: summary(),
      sourceRevision: "rev-1",
      configHash: "cfg-1",
    };
    const original = persistWeeklySnapshot(base);
    const originalBytes = readFileSync(original.path, "utf8");

    const revised = persistWeeklySnapshot({ ...base, sourceRevision: "rev-2" });
    assert.notEqual(revised.path, original.path);
    assert.equal(revised.written, true);
    assert.equal(readFileSync(original.path, "utf8"), originalBytes);

    const reconfigured = persistWeeklySnapshot({ ...base, configHash: "cfg-2" });
    assert.notEqual(reconfigured.path, original.path);
    assert.notEqual(reconfigured.path, revised.path);
    assert.equal(readFileSync(original.path, "utf8"), originalBytes);

    const otherWeek = persistWeeklySnapshot({
      ...base,
      summary: summary(OTHER_WEEK_START, OTHER_WEEK_END),
    });
    assert.notEqual(otherWeek.path, original.path);
    assert.equal(readFileSync(original.path, "utf8"), originalBytes);
    assert.equal(JSON.parse(readFileSync(otherWeek.path, "utf8")).summary.weekStartUtc, OTHER_WEEK_START);
  });
});

test("snapshots are namespace scoped", () => {
  withMemoryDir((memoryDir) => {
    const shared = {
      memoryDir,
      summary: summary(),
      sourceRevision: "rev-1",
      configHash: "cfg-1",
    };
    const alpha = persistWeeklySnapshot({ ...shared, namespace: "alpha" });
    const beta = persistWeeklySnapshot({ ...shared, namespace: "beta" });
    assert.notEqual(alpha.path, beta.path);
    assert.equal(JSON.parse(readFileSync(alpha.path, "utf8")).namespace, "alpha");
    assert.equal(JSON.parse(readFileSync(beta.path, "utf8")).namespace, "beta");
    assert.equal(readdirSync(path.dirname(alpha.path)).length, 1);
    assert.equal(readdirSync(path.dirname(beta.path)).length, 1);
  });
});
