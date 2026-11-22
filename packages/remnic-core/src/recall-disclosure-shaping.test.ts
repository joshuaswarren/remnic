
import assert from "node:assert/strict";
import test from "node:test";

import { shapeMemorySummary } from "./access-service.js";
import type { MemoryFile } from "./types.js";
import { isRecallDisclosure, RECALL_DISCLOSURE_LEVELS } from "./types.js";

function buildMemoryFixture(content: string): MemoryFile {
  // Synthesized — no real user data per the public-repo policy.
  return {
    path: "/tmp/mem/abcd1234.md",
    content,
    frontmatter: {
      id: "abcd1234",
      category: "preference",
      created: "2026-04-25T00:00:00Z",
      updated: "2026-04-25T00:00:00Z",
      source: "test",
      confidence: 0.9,
      confidenceTier: "explicit",
      tags: ["fixture", "shape-test"],
    },
  };
}


test("shapeMemorySummary: chunk emits preview only — no content / rawExcerpts", () => {
  const memory = buildMemoryFixture("Synthetic full body text for chunk test.");
  const out = shapeMemorySummary(memory, "/tmp/mem", "chunk");
  assert.strictEqual(out.disclosure, "chunk");
  assert.ok(out.preview.length > 0);
  assert.strictEqual(out.content, undefined);
  assert.strictEqual(out.rawExcerpts, undefined);
});

test("shapeMemorySummary: section attaches the full memory body as `content`", () => {
  const body = "Section disclosure must surface the entire markdown body.";
  const memory = buildMemoryFixture(body);
  const out = shapeMemorySummary(memory, "/tmp/mem", "section");
  assert.strictEqual(out.disclosure, "section");
  assert.strictEqual(out.content, body);
  assert.strictEqual(out.rawExcerpts, undefined);
});

test("shapeMemorySummary: raw attaches both full content and the supplied raw excerpts", () => {
  const body = "Raw disclosure exposes content + transcript excerpts.";
  const memory = buildMemoryFixture(body);
  const excerpts = [
    { turnIndex: 0, role: "user", content: "synthetic-q", sessionId: "s-1" },
    { turnIndex: 1, role: "assistant", content: "synthetic-a", sessionId: "s-1" },
  ];
  const out = shapeMemorySummary(memory, "/tmp/mem", "raw", excerpts);
  assert.strictEqual(out.disclosure, "raw");
  assert.strictEqual(out.content, body);
  assert.deepStrictEqual(out.rawExcerpts, excerpts);
});

test("shapeMemorySummary: raw with empty excerpts attaches an empty array (LCM disabled)", () => {
  const memory = buildMemoryFixture("body");
  const out = shapeMemorySummary(memory, "/tmp/mem", "raw", []);
  assert.strictEqual(out.disclosure, "raw");
  assert.strictEqual(out.content, "body");
  assert.deepStrictEqual(out.rawExcerpts, []);
});

test("shapeMemorySummary: undefined disclosure (browse path) omits all three new fields", () => {
  const memory = buildMemoryFixture("browse projection");
  const out = shapeMemorySummary(memory, "/tmp/mem");
  assert.strictEqual(out.disclosure, undefined);
  assert.strictEqual(out.content, undefined);
  assert.strictEqual(out.rawExcerpts, undefined);
  assert.ok(out.preview.length > 0);
});

test("shapeMemorySummary: section depth ignores rawExcerpts even when supplied", () => {
  const memory = buildMemoryFixture("body");
  const out = shapeMemorySummary(memory, "/tmp/mem", "section", [
    { turnIndex: 0, role: "user", content: "x", sessionId: "s" },
  ]);
  assert.strictEqual(out.rawExcerpts, undefined);
});

// ──────────────────────────────────────────────────────────────────────
//
// ──────────────────────────────────────────────────────────────────────

test("CLI parity: isRecallDisclosure() rejects values the CLI must reject", () => {
  for (const bad of ["", "Chunk", "CHUNK", "full", "raw_excerpt", "tier", "section "]) {
    assert.strictEqual(isRecallDisclosure(bad), false, `bad=${JSON.stringify(bad)}`);
  }
});

test("CLI parity: every documented disclosure level is accepted", () => {
  for (const level of RECALL_DISCLOSURE_LEVELS) {
    assert.strictEqual(isRecallDisclosure(level), true);
  }
});

// ──────────────────────────────────────────────────────────────────────
//
// ──────────────────────────────────────────────────────────────────────

test("HTTP query-param parity: known levels round-trip through isRecallDisclosure", () => {
  const url = new URL("http://localhost/engram/v1/recall?disclosure=section");
  const value = url.searchParams.get("disclosure");
  assert.ok(value !== null);
  assert.strictEqual(isRecallDisclosure(value), true);
  assert.strictEqual(value, "section");
});

test("HTTP query-param parity: unknown level fails the guard so callers get a 4xx", () => {
  const url = new URL("http://localhost/engram/v1/recall?disclosure=full");
  const value = url.searchParams.get("disclosure");
  assert.ok(value !== null);
  assert.strictEqual(isRecallDisclosure(value), false);
});
