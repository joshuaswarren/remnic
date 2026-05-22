import assert from "node:assert/strict";
import test from "node:test";

import type { SchemaTierPage } from "../../fixtures/schema-tiers/index.js";
import { extractRankedPageIds } from "./retrieval-page-ids.js";

function page(id: string): SchemaTierPage {
  return {
    id,
    owner: "alice",
    namespace: "personal",
    title: id,
    canonicalTitle: id,
    type: "note",
    createdAt: "2026-01-01T00:00:00.000Z",
    aliases: [],
    frontmatter: {},
    timeline: [],
    seeAlso: [],
    body: "fixture",
    dirtySignals: [],
  };
}

test("extractRankedPageIds preserves dotted and slash-delimited IDs", () => {
  const pages = [
    page("project.alpha/task-1"),
    page("project.alpha/task-2"),
  ];

  assert.deepEqual(
    extractRankedPageIds(
      "recall hit\npage_id: project.alpha/task-2\npage_id: project.alpha/task-1",
      pages,
    ),
    ["project.alpha/task-2", "project.alpha/task-1"],
  );
});

test("extractRankedPageIds ignores trailing punctuation on known IDs", () => {
  const pages = [
    page("task-1"),
    page("project.alpha/task-2"),
  ];

  assert.deepEqual(
    extractRankedPageIds(
      "recall hit\npage_id: task-1,\npage_id: project.alpha/task-2)",
      pages,
    ),
    ["task-1", "project.alpha/task-2"],
  );
});

test("extractRankedPageIds ignores leading wrappers on known IDs", () => {
  const pages = [
    page("task-1"),
    page("project.alpha/task-2"),
  ];

  assert.deepEqual(
    extractRankedPageIds(
      'recall hit\npage_id: "task-1"\npage_id: (project.alpha/task-2)',
      pages,
    ),
    ["task-1", "project.alpha/task-2"],
  );
});

test("extractRankedPageIds resolves known IDs case-insensitively", () => {
  const pages = [page("Project.Alpha/Task-1")];

  assert.deepEqual(
    extractRankedPageIds("page_id: PROJECT.ALPHA/TASK-1", pages),
    ["Project.Alpha/Task-1"],
  );
});

test("extractRankedPageIds ignores page_id substrings inside larger keys", () => {
  const pages = [page("task-1"), page("task-2")];

  assert.deepEqual(
    extractRankedPageIds(
      "homepage_id: task-1\nprevious_page_id: task-2\npage_id: task-2",
      pages,
    ),
    ["task-2"],
  );
});

test("extractRankedPageIds keeps unknown IDs in recall order", () => {
  const pages = [page("known")];

  assert.deepEqual(
    extractRankedPageIds("page_id: unknown.value,\npage_id: known", pages),
    ["unknown.value", "known"],
  );
});

test("extractRankedPageIds keeps duplicate hits as occupied ranking slots", () => {
  const pages = [page("expected")];

  assert.deepEqual(
    extractRankedPageIds(
      "page_id: wrong\npage_id: wrong\npage_id: expected",
      pages,
    ),
    ["wrong", "wrong", "expected"],
  );
});

test("extractRankedPageIds does not rescan markers inside extracted values", () => {
  const pages = [page("known")];

  assert.deepEqual(
    extractRankedPageIds("page_id: some-page_id:-thing\npage_id: known", pages),
    ["some-page_id:-thing", "known"],
  );
});

test("extractRankedPageIds does not let a blank marker consume the next marker", () => {
  const pages = [page("expected")];

  assert.deepEqual(
    extractRankedPageIds("page_id:\npage_id: expected", pages),
    ["expected"],
  );
});
