import assert from "node:assert/strict";
import test from "node:test";

import { parseNavigateLinkType } from "./recall-navigate-link.js";
import { selectTraverseNeighbors } from "./recall-navigate-traverse.js";

test("every navigation relation parses", () => {
  for (const type of ["supports", "contradicts", "elaborates", "causes", "caused_by"]) {
    assert.deepEqual(parseNavigateLinkType(type), { ok: true, type });
  }
});

// Persisted MemoryLinkType values must parse too: real frontmatter carries
// them, and a traversal over stored links loses those neighbors otherwise.
test("persisted MemoryLinkType values parse", () => {
  for (const type of ["follows", "references", "related"]) {
    assert.deepEqual(parseNavigateLinkType(type), { ok: true, type });
  }
});

test("unknown or empty link types are refused", () => {
  assert.deepEqual(parseNavigateLinkType("supersedesX"), { ok: false, error: "unknown_link" });
  assert.deepEqual(parseNavigateLinkType(""), { ok: false, error: "unknown_link" });
  assert.deepEqual(parseNavigateLinkType("Supports"), { ok: false, error: "unknown_link" });
});


// Round 3: the stepper's navigation contract accepts supersedes, so the
// shared selector vocabulary must too.
test("supersedes parses and filters", () => {
  assert.deepEqual(parseNavigateLinkType("supersedes"), { ok: true, type: "supersedes" });
  const result = selectTraverseNeighbors({
    links: [
      { targetId: "m-1", linkType: "supersedes" },
      { targetId: "m-2", linkType: "supports" },
    ],
    relation: "supersedes",
  });
  assert.ok(result.ok);
  assert.deepEqual(result.neighbors, [{ targetId: "m-1", linkType: "supersedes" }]);
});
