/**
 * Phase 2B: HiMem – Episode/Note dual store tests
 *
 * Tests for classifyMemoryKind() and reconsolidateNotes() logic.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyMemoryKind,
  type MemoryKind,
} from "../src/himem.js";

// ── classifyMemoryKind ─────────────────────────────────────────────────────

test("classifyMemoryKind: temporal/event language → episode", () => {
  const kind = classifyMemoryKind(
    "User deployed the service to production on Tuesday.",
    [],
    "event",
  );
  assert.equal(kind, "episode");
});

test("classifyMemoryKind: stable preference language → note", () => {
  const kind = classifyMemoryKind(
    "User prefers dark mode in all editors.",
    [],
    "preference",
  );
  assert.equal(kind, "note");
});

test("classifyMemoryKind: decision/constraint language → note", () => {
  const kind = classifyMemoryKind(
    "The project must never use jQuery.",
    [],
    "constraint",
  );
  assert.equal(kind, "note");
});

test("classifyMemoryKind: past tense event with date → episode", () => {
  const kind = classifyMemoryKind(
    "User fixed the auth bug yesterday and pushed to main.",
    ["auth", "bugfix"],
    "decision",
  );
  // Has 'yesterday' — temporal marker → episode
  assert.equal(kind, "episode");
});

test("classifyMemoryKind: generic fact without temporal/stable markers → episode (safe default)", () => {
  const kind = classifyMemoryKind(
    "The app uses PostgreSQL.",
    ["database"],
    "fact",
  );
  // No strong signal either way → episode (safe fallback)
  assert.equal(kind, "episode");
});

test("classifyMemoryKind: 'always' keyword → note", () => {
  const kind = classifyMemoryKind(
    "User always tests in the staging environment before production.",
    [],
    "habit",
  );
  assert.equal(kind, "note");
});

test("classifyMemoryKind: goal/want language → note", () => {
  const kind = classifyMemoryKind(
    "User wants to migrate all services to Kubernetes by end of year.",
    [],
    "goal",
  );
  assert.equal(kind, "note");
});

test("classifyMemoryKind: 'said' / 'mentioned' present but not primary actor → episode", () => {
  const kind = classifyMemoryKind(
    "User mentioned that the deploy failed on Friday.",
    [],
    "event",
  );
  assert.equal(kind, "episode");
});

// ── NOTE_SIGNALS content check (neutral category) ─────────────────────────
// These tests use category="fact" (not in NOTE_CATEGORIES or EPISODE_CATEGORIES)
// to exercise the content-signal code path rather than the category override.

test("NOTE_SIGNALS: 'prefers' in content with neutral category → note", () => {
  const kind = classifyMemoryKind(
    "The team prefers TypeScript for all new projects.",
    [],
    "fact",
  );
  assert.equal(kind, "note");
});

test("NOTE_SIGNALS: 'always' in content with neutral category → note", () => {
  const kind = classifyMemoryKind(
    "The user always runs tests before committing.",
    [],
    "fact",
  );
  assert.equal(kind, "note");
});

test("NOTE_SIGNALS: past tense 'preferred' in content with neutral category → note", () => {
  const kind = classifyMemoryKind(
    "The user preferred dark mode in all editors.",
    [],
    "fact",
  );
  assert.equal(kind, "note");
});

test("NOTE_SIGNALS: 'needed' in content with neutral category → note", () => {
  const kind = classifyMemoryKind(
    "The system needed SSO for all enterprise customers.",
    [],
    "fact",
  );
  assert.equal(kind, "note");
});

// ── MemoryKind type safety ─────────────────────────────────────────────────

test("classifyMemoryKind returns only 'episode' or 'note'", () => {
  const validKinds: MemoryKind[] = ["episode", "note"];
  const result = classifyMemoryKind("Some fact.", [], "fact");
  assert.ok(validKinds.includes(result), `unexpected kind: ${result}`);
});
