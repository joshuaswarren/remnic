import test from "node:test";
import assert from "node:assert/strict";

import { consolidatePreferences } from "./preference-consolidator.js";
import type { MemoryFile } from "../types.js";

function memory(content: string): MemoryFile {
  return {
    path: "/synthetic.md",
    content,
    frontmatter: {
      id: `memory-${content}`,
      category: "fact",
      confidence: 0.8,
      status: "active",
      created: "2026-01-01T00:00:00.000Z",
    },
  } as MemoryFile;
}

test("consolidatePreferences preserves never-use facts as negative preferences", () => {
  const result = consolidatePreferences([
    memory("The user never uses Docker for deployments."),
  ]);

  assert.equal(result.preferences.length, 1);
  assert.equal(
    result.preferences[0]?.statement,
    "The user would not prefer Docker for deployments",
  );
});

test("consolidatePreferences preserves does-not-use facts as negative preferences", () => {
  const result = consolidatePreferences([
    memory("The user does not use React for dashboards."),
  ]);

  assert.equal(result.preferences.length, 1);
  assert.equal(
    result.preferences[0]?.statement,
    "The user would not prefer React for dashboards",
  );
  assert.equal(
    result.preferences[0]?.statement.includes("prefers to use"),
    false,
  );
});
