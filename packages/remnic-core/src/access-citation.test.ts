import assert from "node:assert/strict";
import test from "node:test";

import {
  recordCitationUsage,
  type CitationUsageDependencies,
} from "./access-citation.js";

test("recordCitationUsage matches each citation to its cited path before fallback", async () => {
  let tracked: { ids: string[]; paths: string[] } | null = null;
  const deps: CitationUsageDependencies = {
    resolveNamespace: () => "main",
    getStorage: async () => ({
      findExistingMemoryPaths: async () =>
        new Map([["same-id", ["facts/other/same-id.md", "facts/cited/same-id.md"]]]),
    }),
    trackMemoryAccess: (ids, paths) => {
      tracked = { ids, paths };
    },
  };
  const result = await recordCitationUsage(deps, {
    namespace: "main",
    entries: [
      { path: "facts/cited/same-id.md", lineStart: 1, lineEnd: 1, note: "cited" },
      { path: "facts/other/same-id.md", lineStart: 1, lineEnd: 1, note: "other" },
    ],
    rolloutIds: [],
  });

  assert.deepEqual(result, { submitted: 2, matched: 2 });
  assert.deepEqual(tracked, {
    ids: ["same-id", "same-id"],
    paths: ["facts/cited/same-id.md", "facts/other/same-id.md"],
  });
});
