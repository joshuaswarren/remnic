import assert from "node:assert/strict";
import test from "node:test";

import { buildCitationGuidance, parseOaiMemCitation } from "./citations.js";

function citationBlock(entries: string[]): string {
  return [
    "<oai-mem-citation>",
    "<citation_entries>",
    ...entries,
    "</citation_entries>",
    "<rollout_ids>",
    "rollout-1",
    "</rollout_ids>",
    "</oai-mem-citation>",
  ].join("\n");
}

test("parseOaiMemCitation skips zero-based and reversed line ranges", () => {
  const parsed = parseOaiMemCitation(citationBlock([
    "memory.md:0-1|note=[zero start]",
    "memory.md:1-0|note=[zero end]",
    "memory.md:10-1|note=[reversed]",
    "memory.md:1-1|note=[single]",
    "memory.md:1-5|note=[range]",
  ]));

  assert.deepEqual(
    parsed?.entries.map((entry) => ({
      path: entry.path,
      lineStart: entry.lineStart,
      lineEnd: entry.lineEnd,
      note: entry.note,
    })),
    [
      { path: "memory.md", lineStart: 1, lineEnd: 1, note: "single" },
      { path: "memory.md", lineStart: 1, lineEnd: 5, note: "range" },
    ],
  );
  assert.deepEqual(parsed?.rolloutIds, ["rollout-1"]);
});

test("buildCitationGuidance omits metadata with invalid line ranges", () => {
  const guidance = buildCitationGuidance([
    {
      memoryId: "bad-zero",
      path: "bad-zero.md",
      lineStart: 0,
      lineEnd: 1,
      rolloutId: "bad-rollout",
      noteDefault: "invalid",
    },
    {
      memoryId: "bad-reversed",
      path: "bad-reversed.md",
      lineStart: 10,
      lineEnd: 1,
      noteDefault: "invalid",
    },
    {
      memoryId: "good",
      path: "good.md",
      lineStart: 1,
      lineEnd: 3,
      rolloutId: "good-rollout",
      noteDefault: "valid",
    },
  ]);

  assert.match(guidance, /good\.md:1-3\|note=\[valid\]/);
  assert.match(guidance, /good-rollout/);
  assert.doesNotMatch(guidance, /bad-zero/);
  assert.doesNotMatch(guidance, /bad-reversed/);
  assert.doesNotMatch(guidance, /bad-rollout/);
});
