import test from "node:test";
import assert from "node:assert/strict";
import { planAggressiveDuplicateDeletions } from "../src/cli.js";

test("planAggressiveDuplicateDeletions dedupes case/punctuation/markdown variants", () => {
  const plan = planAggressiveDuplicateDeletions([
    {
      path: "/m/facts/a.md",
      content: "API Rate Limit: 1000 requests/minute.",
      frontmatter: { id: "a", confidence: 0.8, updated: "2026-02-24T10:00:00.000Z" },
    },
    {
      path: "/m/facts/b.md",
      content: "api rate limit 1000 requests minute",
      frontmatter: { id: "b", confidence: 0.95, updated: "2026-02-24T09:00:00.000Z" },
    },
    {
      path: "/m/facts/c.md",
      content: "[API rate limit](https://example.com): 1000 requests/minute",
      frontmatter: { id: "c", confidence: 0.9, updated: "2026-02-24T11:00:00.000Z" },
    },
  ]);

  assert.equal(plan.groups, 1);
  assert.equal(plan.duplicates, 2);
  assert.deepEqual(plan.keepPaths, ["/m/facts/b.md"]);
  assert.deepEqual(plan.deletePaths.sort(), ["/m/facts/a.md", "/m/facts/c.md"]);
});

test("planAggressiveDuplicateDeletions keeps semantically different entries apart", () => {
  const plan = planAggressiveDuplicateDeletions([
    {
      path: "/m/facts/a.md",
      content: "API rate limit is 1000 requests per minute",
      frontmatter: { id: "a", confidence: 0.9, updated: "2026-02-24T10:00:00.000Z" },
    },
    {
      path: "/m/facts/b.md",
      content: "API rate limit is 2000 requests per minute",
      frontmatter: { id: "b", confidence: 0.9, updated: "2026-02-24T11:00:00.000Z" },
    },
  ]);

  assert.equal(plan.groups, 0);
  assert.equal(plan.duplicates, 0);
  assert.deepEqual(plan.keepPaths, []);
  assert.deepEqual(plan.deletePaths, []);
});
