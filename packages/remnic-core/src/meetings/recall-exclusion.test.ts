import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isArtifactMemoryPath,
  isMeetingRecordPath,
} from "../orchestration/orchestrator-helpers.js";
import {
  filterRecallCandidates,
  isGenericRecallExcludedPath,
} from "../orchestration/generic-recall-paths.js";
import type { QmdSearchResult } from "../types.js";


function result(path: string): QmdSearchResult {
  return { docid: path, path, snippet: "", score: 1 };
}

test("isMeetingRecordPath matches only the full meeting-record shape", () => {
  assert.equal(isMeetingRecordPath("meetings/2026-03-10/mtg-2026-03-10-abcdef01.md"), true);
  assert.equal(isMeetingRecordPath("/mem/meetings/2026-03-10/mtg-2026-03-10-abcdef01.md"), true);
  assert.equal(isMeetingRecordPath("namespaces/team/meetings/2026-03-10/mtg-2026-03-10-abcdef01.md"), true);
  assert.equal(isMeetingRecordPath("namespaces/meetings/facts/a.md"), false);
  assert.equal(isMeetingRecordPath("namespaces/meetings/preferences/p.md"), false);
  assert.equal(isMeetingRecordPath("meetings/2026-03-10/notes.md"), false);
  assert.equal(isMeetingRecordPath("facts/a.md"), false);
  assert.equal(isMeetingRecordPath("facts/team-meetings-notes.md"), false);
});

test("isGenericRecallExcludedPath unifies artifacts + meeting records", () => {
  assert.equal(isGenericRecallExcludedPath("artifacts/x.md"), true);
  assert.equal(isGenericRecallExcludedPath("meetings/2026-03-10/mtg-2026-03-10-abcdef01.md"), true);
  assert.equal(isGenericRecallExcludedPath("facts/a.md"), false);
  assert.equal(isGenericRecallExcludedPath("namespaces/meetings/facts/a.md"), false);
  assert.equal(isArtifactMemoryPath("meetings/2026-03-10/mtg-2026-03-10-abcdef01.md"), false);
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
    kept.every((r) => !isGenericRecallExcludedPath(r.path)),
    "no non-recallable path may survive the cap",
  );
});
