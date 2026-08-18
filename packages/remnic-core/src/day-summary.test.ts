/**
 * Day-summary composition tests — bidi isolation of user content (issue #2198).
 * All fixtures are synthetic — no real user data.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { formatDaySummaryMemories } from "./day-summary.js";
import type { MemoryFile } from "./types.js";

const FSI = "\u2068";
const PDI = "\u2069";

function makeMemory(content: string): MemoryFile {
  return {
    path: "/synthetic/mem.md",
    frontmatter: {
      id: "synthetic-mem",
      category: "fact",
      created: "2026-08-17T00:00:00.000Z",
      updated: "2026-08-17T00:00:00.000Z",
      source: "test",
      confidence: 0.9,
      confidenceTier: "explicit",
      tags: [],
    },
    content,
  };
}

test("formatDaySummaryMemories wraps RTL content in FSI/PDI isolates (issue #2198)", () => {
  const rtl = makeMemory("اجتماع الفريق غدا في العاشرة");
  const out = formatDaySummaryMemories([rtl]);

  const expected = `[synthetic-mem] (fact, 2026-08-17T00:00:00.000Z)\n${FSI}اجتماع الفريق غدا في العاشرة${PDI}`;
  assert.equal(out, expected);
});

test("formatDaySummaryMemories isolates LTR content too — labels stay outside the isolate", () => {
  const out = formatDaySummaryMemories([makeMemory("standup at ten")]);

  assert.ok(out.includes(`${FSI}standup at ten${PDI}`), "content wrapped in FSI/PDI");
  assert.ok(out.startsWith("[synthetic-mem] (fact,"), "Latin label precedes the isolate");
  assert.ok(!out.includes(`${PDI}[`), "label not inside the isolate");
});

test("formatDaySummaryMemories isolates each memory's content independently", () => {
  const out = formatDaySummaryMemories([
    makeMemory("first item"),
    makeMemory("عنصر ثان"),
  ]);

  const parts = out.split("\n\n");
  assert.equal(parts.length, 2);
  assert.ok(parts[0]!.includes(`${FSI}first item${PDI}`));
  assert.ok(parts[1]!.includes(`${FSI}عنصر ثان${PDI}`));
});

test("formatDaySummaryMemories raw-string passthrough is not wrapped", () => {
  const out = formatDaySummaryMemories("  plain string input  ");
  assert.equal(out, "plain string input");
});
