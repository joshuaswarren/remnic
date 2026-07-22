import assert from "node:assert/strict";
import { test } from "node:test";

import {
  filterRecallCandidates,
  isArtifactMemoryPath,
  isMeetingRecordPath,
  isNonRecallableMemoryPath,
} from "../orchestration/orchestrator-helpers.js";
import type { QmdSearchResult } from "../types.js";

// Regression for issue #1900: meeting records live inside the QMD collection
// root (full-text searchable) but must NEVER be surfaced through generic recall.
// They ride the SAME retrieval-policy predicate as artifacts, not a parallel
// filter, so `filterRecallCandidates` (the shared recall chokepoint) drops them.

function result(path: string): QmdSearchResult {
  return { docid: path, path, snippet: "", score: 1 };
}

test("isMeetingRecordPath matches meeting-record paths (including namespaced) only", () => {
  assert.equal(isMeetingRecordPath("meetings/2026-03-10/mtg-2026-03-10-abcdef01.md"), true);
  assert.equal(isMeetingRecordPath("/mem/meetings/2026-03-10/mtg-2026-03-10-abcdef01.md"), true);
  assert.equal(isMeetingRecordPath("namespaces/team/meetings/2026-03-10/mtg-x.md"), true);
  assert.equal(isMeetingRecordPath("facts/a.md"), false);
  assert.equal(isMeetingRecordPath("facts/team-meetings-notes.md"), false);
});

test("isNonRecallableMemoryPath unifies artifacts + meeting records", () => {
  assert.equal(isNonRecallableMemoryPath("artifacts/x.md"), true);
  assert.equal(isNonRecallableMemoryPath("meetings/2026-03-10/mtg-x.md"), true);
  assert.equal(isNonRecallableMemoryPath("facts/a.md"), false);
  // The artifact predicate itself is unchanged.
  assert.equal(isArtifactMemoryPath("meetings/2026-03-10/mtg-x.md"), false);
});

test("filterRecallCandidates drops meeting records alongside artifacts", () => {
  const candidates = [
    result("facts/a.md"),
    result("meetings/2026-03-10/mtg-2026-03-10-abcdef01.md"),
    result("artifacts/b.md"),
    result("decisions/c.md"),
  ];
  const kept = filterRecallCandidates(candidates, {
    namespacesEnabled: false,
    recallNamespaces: [],
    resolveNamespace: () => "",
    limit: 10,
  });
  assert.deepEqual(
    kept.map((r) => r.path),
    ["facts/a.md", "decisions/c.md"],
  );
});

test("filterRecallCandidates drops non-recallable paths BEFORE applying the limit", () => {
  // A meeting record sits within the first `limit` positions. Filter-before-cap
  // must still yield `limit` RECALLABLE results; a cap-before-filter bug would
  // spend a slot on the dropped record and return fewer.
  const candidates = [
    result("meetings/2026-03-10/mtg-2026-03-10-abcdef01.md"),
    result("facts/a.md"),
    result("facts/b.md"),
    result("facts/c.md"),
  ];
  const kept = filterRecallCandidates(candidates, {
    namespacesEnabled: false,
    recallNamespaces: [],
    resolveNamespace: () => "",
    limit: 2,
  });
  assert.equal(kept.length, 2, "the cap must be filled with recallable results, not consumed by the dropped record");
  assert.deepEqual(
    kept.map((r) => r.path),
    ["facts/a.md", "facts/b.md"],
  );
  assert.ok(
    kept.every((r) => !isNonRecallableMemoryPath(r.path)),
    "no non-recallable path may survive the cap",
  );
});
