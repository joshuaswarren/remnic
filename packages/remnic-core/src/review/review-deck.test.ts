import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { MEMORY_CORPUS_VERSION_SENTINEL } from "../memory-corpus-version.js";
import {
  ReviewDeckCursorError,
  buildReviewDeckPage,
  compareReviewDeckRows,
  computeReviewItemRevision,
  decodeReviewDeckCursor,
  encodeReviewDeckCursor,
  projectReviewDeckItem,
  type ReviewDeckCursorScope,
  type ReviewDeckSourceRow,
} from "./review-deck.js";
import { readReviewDeckRow, readReviewDeckSnapshot } from "./review-deck-snapshot.js";

const REASON_LABELS: ReadonlyArray<readonly [string, string]> = [
  ["low_confidence", "Low confidence"],
  ["suggestion", "Suggested memory"],
  ["tombstone_blocked", "Blocked by a deletion"],
  ["contradiction", "Conflicts with another memory"],
  ["duplicate", "Possible duplicate"],
];

async function makeMemoryDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-review-deck-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function sha256Hex(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function sourceRow(partial: Partial<ReviewDeckSourceRow> & Pick<ReviewDeckSourceRow, "itemId">): ReviewDeckSourceRow {
  return {
    filePath: `${partial.itemId}.md`,
    fileContent: partial.fileContent ?? "",
    revision: partial.revision ?? "rv1:0",
    content: partial.content ?? "",
    reviewReason: partial.reviewReason ?? "low_confidence",
    created: partial.created ?? "2026-05-17T00:00:00.000Z",
    ...partial,
  };
}

function scope(overrides: Partial<ReviewDeckCursorScope> = {}): ReviewDeckCursorScope {
  return {
    principalDigest: "principal-a",
    namespace: "ns-a",
    filterDigest: "filter-a",
    corpusVersion: "12",
    ...overrides,
  };
}

function queueMarkdown(fields: Record<string, string | number | boolean>, body = "Candidate memory."): string {
  const lines = Object.entries(fields).map(([key, value]) => `${key}: ${value}`);
  return `---\n${lines.join("\n")}\n---\n${body}`;
}

test("computeReviewItemRevision prefixes sha256 hex with rv1", () => {
  const fileContent = "id: example\n";
  assert.equal(computeReviewItemRevision(fileContent), `rv1:${sha256Hex(fileContent)}`);
});

test("projectReviewDeckItem maps every supported review reason", () => {
  for (const [reviewReason, reviewReasonLabel] of REASON_LABELS) {
    const row = sourceRow({
      itemId: `item-${reviewReason}`,
      reviewReason,
      content: "Body text",
      revision: "rv1:abc",
    });
    const item = projectReviewDeckItem(row, "ns-a");
    assert.equal(item.schemaVersion, 1);
    assert.equal(item.source, "review");
    assert.equal(item.itemId, row.itemId);
    assert.equal(item.sourceId, row.itemId);
    assert.equal(item.memoryId, row.itemId);
    assert.equal(item.reviewReason, reviewReason);
    assert.equal(item.reviewReasonLabel, reviewReasonLabel);
    assert.equal(item.namespace, "ns-a");
    assert.equal(item.revision, "rv1:abc");
    assert.deepEqual(item.allowedChoices, ["keep", "prepare_fix", "not_true"]);
    assert.deepEqual(item.choiceRisk, {
      keep: "reversible",
      prepare_fix: "reversible",
      not_true: "reversible",
    });
  }
});

test("projectReviewDeckItem title-cases unknown review reasons", () => {
  const item = projectReviewDeckItem(
    sourceRow({ itemId: "item-custom", reviewReason: "needs_human_look" }),
    "ns-a",
  );
  assert.equal(item.reviewReasonLabel, "Needs Human Look");
});

test("projectReviewDeckItem returns empty provenance when the row carries no evidence", () => {
  const item = projectReviewDeckItem(
    sourceRow({
      itemId: "bare",
      fileContent: queueMarkdown({ id: "bare", reviewReason: "low_confidence" }),
    }),
    "ns-a",
  );
  assert.deepEqual(item.provenance, []);
  assert.equal(item.supportCount, 0);
});

test("projectReviewDeckItem derives origin and related-id provenance without inventing extras", () => {
  const longExcerpt = "x".repeat(300);
  const fileContent = queueMarkdown({
    id: "with-evidence",
    source: "conversation",
    created: "2026-05-17T00:00:00.000Z",
    supports: "mem-support-1, mem-support-2",
    conflicts: "mem-conflict-1",
    context: longExcerpt,
  });
  const item = projectReviewDeckItem(
    sourceRow({
      itemId: "with-evidence",
      source: "conversation",
      created: "2026-05-17T00:00:00.000Z",
      context: longExcerpt,
      fileContent,
    }),
    "ns-a",
  );
  assert.equal(item.provenance.length, 4);
  assert.equal(item.supportCount, 2);
  const origin = item.provenance.find((entry) => entry.relation === "origin");
  assert.ok(origin);
  assert.equal(origin?.sourceDate, "2026-05-17T00:00:00.000Z");
  assert.equal(origin?.excerpt?.length, 240);
  assert.deepEqual(
    item.provenance.filter((entry) => entry.relation === "supports").map((entry) => entry.sourceMemoryId),
    ["mem-support-1", "mem-support-2"],
  );
  assert.deepEqual(
    item.provenance.filter((entry) => entry.relation === "conflicts").map((entry) => entry.sourceMemoryId),
    ["mem-conflict-1"],
  );
});

test("compareReviewDeckRows is total and returns 0 for equal keys", () => {
  const a = sourceRow({
    itemId: "same",
    blockedBy: "tomb-1",
    confidence: 0.2,
    created: "2026-01-01T00:00:00.000Z",
  });
  const b = sourceRow({
    itemId: "same",
    blockedBy: "tomb-1",
    confidence: 0.2,
    created: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(compareReviewDeckRows(a, b), 0);
  assert.equal(compareReviewDeckRows(b, a), 0);

  const blocked = sourceRow({ itemId: "z-blocked", blockedBy: "tomb-1", confidence: 0.9, created: "2026-06-01T00:00:00.000Z" });
  const low = sourceRow({ itemId: "m-low", confidence: 0.1, created: "2026-06-01T00:00:00.000Z" });
  const highOld = sourceRow({ itemId: "b-high", confidence: 0.8, created: "2026-01-01T00:00:00.000Z" });
  const highNew = sourceRow({ itemId: "a-high", confidence: 0.8, created: "2026-02-01T00:00:00.000Z" });

  assert.ok(compareReviewDeckRows(blocked, low) < 0);
  assert.ok(compareReviewDeckRows(low, blocked) > 0);
  assert.ok(compareReviewDeckRows(low, highOld) < 0);
  assert.ok(compareReviewDeckRows(highOld, highNew) < 0);
  assert.ok(compareReviewDeckRows(highNew, highOld) > 0);
});

test("compareReviewDeckRows treats absent confidence as 0.5 and is stable across repeated sorts", () => {
  const rows: ReviewDeckSourceRow[] = [
    sourceRow({ itemId: "c", created: "2026-03-01T00:00:00.000Z" }),
    sourceRow({ itemId: "a", created: "2026-03-01T00:00:00.000Z" }),
    sourceRow({ itemId: "b", confidence: 0.5, created: "2026-03-01T00:00:00.000Z" }),
    sourceRow({ itemId: "blocked", blockedBy: "tomb-1", confidence: 0.9, created: "2026-08-01T00:00:00.000Z" }),
    sourceRow({ itemId: "low", confidence: 0.1, created: "2026-08-01T00:00:00.000Z" }),
  ];
  const first = [...rows].sort(compareReviewDeckRows).map((row) => row.itemId);
  const second = [...rows].reverse().sort(compareReviewDeckRows).map((row) => row.itemId);
  const third = [...rows].sort(() => 0.5 - 0.25).sort(compareReviewDeckRows).map((row) => row.itemId);
  assert.deepEqual(first, ["blocked", "low", "a", "b", "c"]);
  assert.deepEqual(second, first);
  assert.deepEqual(third, first);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test("buildReviewDeckPage sorts the complete set before applying the cursor and limit", () => {
  const rows = [
    sourceRow({ itemId: "later-high", confidence: 0.9, created: "2026-04-01T00:00:00.000Z" }),
    sourceRow({ itemId: "mid", confidence: 0.4, created: "2026-04-01T00:00:00.000Z" }),
    sourceRow({ itemId: "early-low", confidence: 0.1, created: "2026-04-01T00:00:00.000Z" }),
    sourceRow({ itemId: "blocked", blockedBy: "tomb-1", confidence: 0.95, created: "2026-08-01T00:00:00.000Z" }),
    sourceRow({ itemId: "oldest-mid", confidence: 0.4, created: "2026-01-01T00:00:00.000Z" }),
  ];
  const pageScope = scope();
  const page = buildReviewDeckPage(rows, { scope: pageScope, limit: 2 });
  assert.equal(page.schemaVersion, 1);
  assert.equal(page.total, 5);
  assert.deepEqual(page.items.map((item) => item.itemId), ["blocked", "early-low"]);
  assert.ok(page.nextCursor);

  const page2 = buildReviewDeckPage(rows, { scope: pageScope, cursor: page.nextCursor, limit: 2 });
  assert.deepEqual(page2.items.map((item) => item.itemId), ["oldest-mid", "mid"]);
  assert.ok(page2.nextCursor);

  const page3 = buildReviewDeckPage(rows, { scope: pageScope, cursor: page2.nextCursor, limit: 2 });
  assert.deepEqual(page3.items.map((item) => item.itemId), ["later-high"]);
  assert.equal(page3.nextCursor, undefined);
});

test("buildReviewDeckPage limit 0 returns an empty page with the real total and no cursor", () => {
  const rows = [
    sourceRow({ itemId: "a", confidence: 0.1 }),
    sourceRow({ itemId: "b", confidence: 0.2 }),
  ];
  const page = buildReviewDeckPage(rows, { scope: scope(), limit: 0 });
  assert.deepEqual(page.items, []);
  assert.equal(page.total, 2);
  assert.equal(page.nextCursor, undefined);
});

test("decodeReviewDeckCursor rejects malformed, foreign, and stale cursors", () => {
  const home = scope();
  const cursor = encodeReviewDeckCursor(home, "0\t0.100000\t2026-01-01T00:00:00.000Z\ta");

  assert.equal(decodeReviewDeckCursor(cursor, home), "0\t0.100000\t2026-01-01T00:00:00.000Z\ta");

  assert.throws(() => decodeReviewDeckCursor("not-a-cursor", home), ReviewDeckCursorError);
  assert.throws(() => decodeReviewDeckCursor("", home), ReviewDeckCursorError);
  assert.throws(
    () => decodeReviewDeckCursor(encodeReviewDeckCursor(scope({ corpusVersion: "13" }), "k"), home),
    ReviewDeckCursorError,
  );
  assert.throws(
    () => decodeReviewDeckCursor(encodeReviewDeckCursor(scope({ namespace: "ns-b" }), "k"), home),
    ReviewDeckCursorError,
  );
  assert.throws(
    () => decodeReviewDeckCursor(encodeReviewDeckCursor(scope({ principalDigest: "principal-b" }), "k"), home),
    ReviewDeckCursorError,
  );
  assert.throws(
    () => decodeReviewDeckCursor(encodeReviewDeckCursor(scope({ filterDigest: "filter-b" }), "k"), home),
    ReviewDeckCursorError,
  );

  const tampered = Buffer.from(JSON.stringify({
    v: 2,
    p: home.principalDigest,
    n: home.namespace,
    f: home.filterDigest,
    c: home.corpusVersion,
    k: "k",
  })).toString("base64url");
  assert.throws(() => decodeReviewDeckCursor(tampered, home), ReviewDeckCursorError);
});

test("readReviewDeckSnapshot reads pending queue files only and reports corpus byte size", async (t) => {
  const memoryDir = await makeMemoryDir(t);
  const suggestionsDir = path.join(memoryDir, "suggestions", "nested");
  const reviewDir = path.join(memoryDir, "review");
  const factsDir = path.join(memoryDir, "facts", "2026-05-17");
  const stateDir = path.join(memoryDir, "state");
  await mkdir(suggestionsDir, { recursive: true });
  await mkdir(reviewDir, { recursive: true });
  await mkdir(factsDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(stateDir, MEMORY_CORPUS_VERSION_SENTINEL), "xxxxx", "utf8");

  await writeFile(
    path.join(suggestionsDir, "keep.md"),
    queueMarkdown({
      id: "keep-me",
      reviewReason: "suggestion",
      confidence: 0.2,
      created: "2026-01-01T00:00:00.000Z",
    }),
    "utf8",
  );
  await writeFile(
    path.join(reviewDir, "pending.md"),
    queueMarkdown({
      id: "pending-review",
      status: "pending_review",
      reviewReason: "low_confidence",
      confidence: 0.3,
      created: "2026-02-01T00:00:00.000Z",
    }),
    "utf8",
  );
  await writeFile(
    path.join(reviewDir, "dismissed.md"),
    queueMarkdown({
      id: "dismissed",
      reviewReason: "low_confidence",
      reviewDismissed: true,
    }),
    "utf8",
  );
  await writeFile(
    path.join(reviewDir, "active-status.md"),
    queueMarkdown({
      id: "active-status",
      status: "active",
      reviewReason: "low_confidence",
    }),
    "utf8",
  );
  await writeFile(
    path.join(factsDir, "category.md"),
    queueMarkdown({
      id: "category-active",
      status: "pending_review",
      reviewReason: "low_confidence",
      confidence: 0.05,
    }),
    "utf8",
  );

  const snapshot = readReviewDeckSnapshot({ memoryDir, namespace: "ns-a" });
  assert.equal(snapshot.corpusVersion, "5");
  assert.equal(snapshot.total, 2);
  assert.deepEqual(snapshot.rows.map((row) => row.itemId).sort(), ["keep-me", "pending-review"]);
  assert.equal(readReviewDeckRow({ memoryDir, itemId: "keep-me" })?.itemId, "keep-me");
  assert.equal(readReviewDeckRow({ memoryDir, itemId: "dismissed" }), null);
  assert.equal(readReviewDeckRow({ memoryDir, itemId: "category-active" }), null);
});

test("readReviewDeckSnapshot returns corpus version 0 when the sentinel is absent", async (t) => {
  const memoryDir = await makeMemoryDir(t);
  const snapshot = readReviewDeckSnapshot({ memoryDir, namespace: "ns-a" });
  assert.equal(snapshot.corpusVersion, "0");
  assert.equal(snapshot.total, 0);
  assert.deepEqual(snapshot.rows, []);
});
