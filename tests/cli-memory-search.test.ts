import test from "node:test";
import assert from "node:assert/strict";

import {
  filterNormalMemorySearchResults,
  isNormalRetrievalVisibleMemory,
} from "../src/cli.js";
import type { MemoryFile, MemoryFrontmatter, QmdSearchResult } from "../src/types.js";

function makeMemory(
  id: string,
  overrides: Partial<MemoryFrontmatter> = {},
): MemoryFile {
  return {
    path: `/tmp/memory/facts/${id}.md`,
    content: `${id} content`,
    frontmatter: {
      id,
      category: "fact",
      created: "2026-02-01T00:00:00.000Z",
      updated: "2026-02-01T00:00:00.000Z",
      source: "test",
      confidence: 0.9,
      confidenceTier: "explicit",
      tags: [],
      ...overrides,
    } as MemoryFrontmatter,
  };
}

function makeSearchResult(id: string): QmdSearchResult {
  return {
    path: `/tmp/memory/facts/${id}.md`,
    docid: id,
    snippet: `${id} snippet`,
    score: 0.9,
  };
}

test("normal memory search filtering drops forgotten and stale missing QMD hits", async () => {
  const memories = new Map<string, MemoryFile>([
    ["/tmp/memory/facts/active.md", makeMemory("active", { status: "active" })],
    [
      "/tmp/memory/facts/forgotten.md",
      makeMemory("forgotten", {
        status: "forgotten",
        forgottenAt: "2026-04-25T12:00:00.000Z",
      }),
    ],
  ]);

  const filtered = await filterNormalMemorySearchResults(
    [
      makeSearchResult("forgotten"),
      makeSearchResult("missing"),
      makeSearchResult("active"),
    ],
    {
      readMemoryByPath: async (path) => memories.get(path) ?? null,
    },
  );

  assert.deepEqual(filtered.map((result) => result.docid), ["active"]);
});

test("normal retrieval visibility treats only forgotten status as hidden", () => {
  assert.equal(
    isNormalRetrievalVisibleMemory(makeMemory("forgotten", { status: "forgotten" })),
    false,
  );
  assert.equal(
    isNormalRetrievalVisibleMemory(makeMemory("archived", { status: "archived" })),
    true,
  );
  assert.equal(isNormalRetrievalVisibleMemory(makeMemory("active")), true);
});

test("normal retrieval visibility hides support passport cards and audits", () => {
  for (const tag of ["support-passport-card", "support-passport-audit"]) {
    assert.equal(
      isNormalRetrievalVisibleMemory(makeMemory(tag, { status: "active", tags: [tag] })),
      false,
      tag,
    );
  }
});
