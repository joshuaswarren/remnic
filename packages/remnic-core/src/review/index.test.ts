import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { listReviewItems, performReview, type ReviewItem } from "./index.js";

async function makeMemoryDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-review-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function reviewMarkdown(
  id: string,
  reviewReason: ReviewItem["reviewReason"] = "low_confidence",
): string {
  return `---
id: ${id}
category: fact
confidence: 0.4
confidenceTier: low
source: test
created: 2026-05-17T00:00:00.000Z
reviewReason: ${reviewReason}
---
Candidate memory.`;
}

test("listReviewItems applies reason filtering before enforcing the limit", async (t) => {
  const memoryDir = await makeMemoryDir(t);
  const suggestionsDir = path.join(memoryDir, "suggestions");
  const reviewDir = path.join(memoryDir, "review");
  await mkdir(suggestionsDir, { recursive: true });
  await mkdir(reviewDir, { recursive: true });
  await writeFile(path.join(suggestionsDir, "first.md"), reviewMarkdown("suggestion-1", "suggestion"), "utf8");
  await writeFile(path.join(suggestionsDir, "second.md"), reviewMarkdown("suggestion-2", "suggestion"), "utf8");
  await writeFile(path.join(reviewDir, "contradiction.md"), reviewMarkdown("matching-review", "contradiction"), "utf8");

  const result = listReviewItems({
    memoryDir,
    reason: "contradiction",
    limit: 1,
  });

  assert.deepEqual(result.items.map((item) => item.id), ["matching-review"]);
  assert.equal(result.total, 1);
});

test("listReviewItems stops reading review files after satisfying the limit", async (t) => {
  const memoryDir = await makeMemoryDir(t);
  const suggestionsDir = path.join(memoryDir, "suggestions");
  await mkdir(suggestionsDir, { recursive: true });
  await writeFile(path.join(suggestionsDir, "001.md"), reviewMarkdown("suggestion-1", "suggestion"), "utf8");
  await writeFile(path.join(suggestionsDir, "002.md"), reviewMarkdown("suggestion-2", "suggestion"), "utf8");
  await writeFile(path.join(suggestionsDir, "003.md"), reviewMarkdown("suggestion-3", "suggestion"), "utf8");

  const originalReadFileSync = fs.readFileSync;
  let reviewFileReads = 0;
  fs.readFileSync = function readFileSyncWithCount(
    filePath: fs.PathOrFileDescriptor,
    options?: BufferEncoding | { encoding?: BufferEncoding | null; flag?: string } | null,
  ) {
    if (typeof filePath === "string" && filePath.startsWith(suggestionsDir) && filePath.endsWith(".md")) {
      reviewFileReads += 1;
    }
    return originalReadFileSync.call(fs, filePath, options as never);
  } as typeof fs.readFileSync;

  try {
    const result = listReviewItems({ memoryDir, limit: 1 });

    assert.equal(result.items.length, 1);
    assert.equal(result.total, 1);
    assert.equal(reviewFileReads, 1);
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
});

test("flag updates low-confidence category items returned by listReviewItems", async (t) => {
  const memoryDir = await makeMemoryDir(t);
  const factsDir = path.join(memoryDir, "facts", "2026-05-17");
  await mkdir(factsDir, { recursive: true });
  const memoryPath = path.join(factsDir, "low.md");
  await writeFile(memoryPath, reviewMarkdown("low-category-flag"), "utf8");

  assert.deepEqual(
    listReviewItems({ memoryDir }).items.map((item) => item.id),
    ["low-category-flag"],
  );

  const result = performReview(memoryDir, "low-category-flag", "flag");

  assert.equal(result.updatedPath, memoryPath);
  const updated = await readFile(memoryPath, "utf8");
  assert.match(updated, /flagged: true/);
  assert.match(updated, /flaggedAt: /);
});

test("approve raises low-confidence category item confidence in place", async (t) => {
  const memoryDir = await makeMemoryDir(t);
  const factsDir = path.join(memoryDir, "facts", "2026-05-17");
  await mkdir(factsDir, { recursive: true });
  const memoryPath = path.join(factsDir, "low.md");
  await writeFile(memoryPath, reviewMarkdown("low-category-approve"), "utf8");

  const result = performReview(memoryDir, "low-category-approve", "approve");

  assert.equal(result.updatedPath, memoryPath);
  const updated = await readFile(memoryPath, "utf8");
  assert.match(updated, /confidence: 0\.9/);
  assert.match(updated, /confidenceTier: high/);
  assert.equal(listReviewItems({ memoryDir }).items.some((item) => item.id === "low-category-approve"), false);
});

test("dismiss marks low-confidence category items without deleting memory files", async (t) => {
  const memoryDir = await makeMemoryDir(t);
  const factsDir = path.join(memoryDir, "facts", "2026-05-17");
  await mkdir(factsDir, { recursive: true });
  const memoryPath = path.join(factsDir, "low.md");
  await writeFile(memoryPath, reviewMarkdown("low-category-dismiss"), "utf8");

  const result = performReview(memoryDir, "low-category-dismiss", "dismiss");

  assert.equal(result.updatedPath, memoryPath);
  await stat(memoryPath);
  const updated = await readFile(memoryPath, "utf8");
  assert.match(updated, /reviewDismissed: true/);
  assert.equal(listReviewItems({ memoryDir }).items.some((item) => item.id === "low-category-dismiss"), false);
});

test("review actions do not mutate category memories that are not pending review", async (t) => {
  const memoryDir = await makeMemoryDir(t);
  const factsDir = path.join(memoryDir, "facts", "2026-05-17");
  await mkdir(factsDir, { recursive: true });
  const memoryPath = path.join(factsDir, "high.md");
  const original = `---
id: high-category
category: fact
confidence: 0.98
confidenceTier: high
source: test
created: 2026-05-17T00:00:00.000Z
---
Reviewed memory.`;
  await writeFile(memoryPath, original, "utf8");

  assert.deepEqual(listReviewItems({ memoryDir }).items, []);

  const result = performReview(memoryDir, "high-category", "approve");

  assert.equal(result.message, "Item not found");
  assert.equal(await readFile(memoryPath, "utf8"), original);
});

test("review listing and actions ignore symlinked review roots", async (t) => {
  const memoryDir = await makeMemoryDir(t);
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), "remnic-review-outside-"));
  t.after(() => rm(outsideDir, { recursive: true, force: true }));
  const outsidePath = path.join(outsideDir, "victim.md");
  await writeFile(outsidePath, reviewMarkdown("victim"), "utf8");

  try {
    await symlink(outsideDir, path.join(memoryDir, "review"), "dir");
  } catch {
    return;
  }

  assert.deepEqual(listReviewItems({ memoryDir }).items, []);
  const result = performReview(memoryDir, "victim", "dismiss");

  assert.equal(result.message, "Item not found");
  assert.equal(await readFile(outsidePath, "utf8"), reviewMarkdown("victim"));
});

test("review listing and actions ignore symlinked category roots", async (t) => {
  const memoryDir = await makeMemoryDir(t);
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), "remnic-review-category-outside-"));
  t.after(() => rm(outsideDir, { recursive: true, force: true }));
  const outsideDateDir = path.join(outsideDir, "2026-05-17");
  await mkdir(outsideDateDir, { recursive: true });
  const outsidePath = path.join(outsideDateDir, "victim.md");
  await writeFile(outsidePath, reviewMarkdown("category-victim"), "utf8");

  try {
    await symlink(outsideDir, path.join(memoryDir, "facts"), "dir");
  } catch {
    return;
  }

  assert.deepEqual(listReviewItems({ memoryDir }).items, []);
  const result = performReview(memoryDir, "category-victim", "flag");

  assert.equal(result.message, "Item not found");
  assert.equal(await readFile(outsidePath, "utf8"), reviewMarkdown("category-victim"));
});

test("review actions can use the same custom confidence threshold as listReviewItems", async (t) => {
  const memoryDir = await makeMemoryDir(t);
  const factsDir = path.join(memoryDir, "facts", "2026-05-17");
  await mkdir(factsDir, { recursive: true });
  const memoryPath = path.join(factsDir, "medium.md");
  await writeFile(
    memoryPath,
    `---
id: medium-category
category: fact
confidence: 0.82
confidenceTier: medium
source: test
created: 2026-05-17T00:00:00.000Z
---
Medium confidence memory.`,
    "utf8",
  );

  assert.deepEqual(
    listReviewItems({ memoryDir, confidenceThreshold: 0.9 }).items.map((item) => item.id),
    ["medium-category"],
  );
  assert.equal(performReview(memoryDir, "medium-category", "approve").message, "Item not found");

  const result = performReview(memoryDir, "medium-category", "approve", {
    confidenceThreshold: 0.9,
  });

  assert.equal(result.updatedPath, memoryPath);
  const updated = await readFile(memoryPath, "utf8");
  assert.match(updated, /confidence: 0\.9/);
  assert.match(updated, /confidenceTier: high/);
});

test("approve promotes to the source basename when no target exists", async (t) => {
  const memoryDir = await makeMemoryDir(t);
  const reviewDir = path.join(memoryDir, "review");
  await mkdir(reviewDir, { recursive: true });
  const reviewPath = path.join(reviewDir, "candidate.md");
  await writeFile(reviewPath, reviewMarkdown("review-no-collision"), "utf8");

  const result = performReview(memoryDir, "review-no-collision", "approve");

  const today = new Date().toISOString().split("T")[0];
  const expectedPath = path.join(memoryDir, "facts", today, "candidate.md");
  assert.equal(result.updatedPath, expectedPath);
  assert.match(await readFile(expectedPath, "utf8"), /confidence: 0\.9/);
  await assert.rejects(stat(reviewPath), /ENOENT/);
});

test("approve does not overwrite an existing promoted memory with the same basename", async (t) => {
  const memoryDir = await makeMemoryDir(t);
  const reviewDir = path.join(memoryDir, "review");
  await mkdir(reviewDir, { recursive: true });
  const reviewPath = path.join(reviewDir, "candidate.md");
  await writeFile(reviewPath, reviewMarkdown("review/collision"), "utf8");

  const today = new Date().toISOString().split("T")[0];
  const targetDir = path.join(memoryDir, "facts", today);
  await mkdir(targetDir, { recursive: true });
  const collisionPath = path.join(targetDir, "candidate.md");
  await writeFile(collisionPath, "original promoted memory", "utf8");

  const result = performReview(memoryDir, "review/collision", "approve");

  assert.notEqual(result.updatedPath, collisionPath);
  assert.match(path.basename(result.updatedPath ?? ""), /^candidate-review-collision(?:-\d+)?\.md$/);
  assert.equal(await readFile(collisionPath, "utf8"), "original promoted memory");

  const promotedContent = await readFile(result.updatedPath!, "utf8");
  assert.match(promotedContent, /confidence: 0\.9/);
  assert.match(promotedContent, /confidenceTier: high/);
  await assert.rejects(stat(reviewPath), /ENOENT/);
});
