import test from "node:test";
import assert from "node:assert/strict";
import { planExactDuplicateDeletions } from "../src/cli.js";

test("planExactDuplicateDeletions deletes exact duplicate bodies", () => {
  const plan = planExactDuplicateDeletions([
    {
      path: "/m/facts/a.md",
      content: "same content",
      frontmatter: { id: "a", confidence: 0.8, updated: "2026-02-24T10:00:00.000Z" },
    },
    {
      path: "/m/facts/b.md",
      content: "same content",
      frontmatter: { id: "b", confidence: 0.95, updated: "2026-02-24T09:00:00.000Z" },
    },
    {
      path: "/m/facts/c.md",
      content: "unique content",
      frontmatter: { id: "c", confidence: 0.9, updated: "2026-02-24T11:00:00.000Z" },
    },
  ]);

  assert.equal(plan.groups, 1);
  assert.equal(plan.duplicates, 1);
  assert.deepEqual(plan.keepPaths, ["/m/facts/b.md"]);
  assert.deepEqual(plan.deletePaths, ["/m/facts/a.md"]);
});

test("planExactDuplicateDeletions keeps newest when confidence ties", () => {
  const plan = planExactDuplicateDeletions([
    {
      path: "/m/facts/a.md",
      content: "repeat me",
      frontmatter: { id: "a", confidence: 0.9, updated: "2026-02-24T10:00:00.000Z" },
    },
    {
      path: "/m/facts/b.md",
      content: "repeat me",
      frontmatter: { id: "b", confidence: 0.9, updated: "2026-02-24T11:00:00.000Z" },
    },
    {
      path: "/m/facts/c.md",
      content: "repeat me",
      frontmatter: { id: "c", confidence: 0.9, updated: "2026-02-24T09:00:00.000Z" },
    },
  ]);

  assert.equal(plan.groups, 1);
  assert.equal(plan.duplicates, 2);
  assert.deepEqual(plan.keepPaths, ["/m/facts/b.md"]);
  assert.deepEqual(plan.deletePaths.sort(), ["/m/facts/a.md", "/m/facts/c.md"]);
});
