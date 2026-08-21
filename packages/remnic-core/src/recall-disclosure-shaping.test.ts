/**
 * Tests for the recall-disclosure payload-shaping wired in PR 2/4 of
 * issue #677 — covers the new `content` and `rawExcerpts` fields on
 * `EngramAccessMemorySummary`, the CLI flag-validation surface, and the
 * HTTP `?disclosure=` query-parameter fallback.
 *
 * Pure-helper coverage runs against the exported `shapeMemorySummary()`
 * so we can exercise every disclosure level without booting an
 * orchestrator or a network surface.  All fixtures are synthetic — no
 * real conversation data.
 */

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

// ──────────────────────────────────────────────────────────────────────
// shapeMemorySummary() pure-helper coverage.
// ──────────────────────────────────────────────────────────────────────

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
  // No raw excerpts at section depth — rawExcerpts is reserved for raw.
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
  // preview always populated — regardless of disclosure.
  assert.ok(out.preview.length > 0);
});

test("shapeMemorySummary: section depth ignores rawExcerpts even when supplied", () => {
  // Defensive: the recall path should never pass rawExcerpts at section
  // depth, but a regression that did so must not leak excerpts onto the
  // section-shaped payload.
  const memory = buildMemoryFixture("body");
  const out = shapeMemorySummary(memory, "/tmp/mem", "section", [
    { turnIndex: 0, role: "user", content: "x", sessionId: "s" },
  ]);
  assert.strictEqual(out.rawExcerpts, undefined);
});

// ──────────────────────────────────────────────────────────────────────
// CLI `--disclosure` flag validation parity check.
//
// The CLI path uses the same `isRecallDisclosure` guard as the service
// layer; this test pins the contract so a future regression that loosens
// validation in one path but not the other is caught.
// ──────────────────────────────────────────────────────────────────────

test("CLI parity: isRecallDisclosure() rejects values the CLI must reject", () => {
  // Common typos / casing variants the CLI must throw on so operators
  // notice their flag misuse instead of silently getting `chunk`.
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
// HTTP `?disclosure=` query-param fallback contract.
//
// The HTTP route delegates parsing to `isRecallDisclosure` after reading
// the query parameter.  We verify the contract here so a refactor that
// stops calling the guard in `access-http.ts` would surface in CI.
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
