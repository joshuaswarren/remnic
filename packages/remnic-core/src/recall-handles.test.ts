import assert from "node:assert/strict";
import test from "node:test";

import {
  appendHandle,
  DEFAULT_HANDLE_SNAPSHOT_DEPTH,
  HANDLE_DEFAULT_WIDTH,
  HANDLE_EXTENDED_WIDTH,
  handleFor,
  isHandleToken,
  normalizeHandle,
  parseHandles,
  parseIdOrHandle,
  renderHandle,
  renderHandlesForInjection,
  resolveHandle,
  stripHandles,
  type RecallSnapshotIds,
} from "./recall-handles.js";

// Deterministic handle for a fixed id, computed once for assertions.
const ID_A = "fact-1770469224307-eelr";
const HANDLE_A = handleFor(ID_A);

// ─── handleFor: determinism + width ───────────────────────────────────────

test("handleFor is deterministic for the same id", () => {
  assert.equal(handleFor(ID_A), handleFor(ID_A));
  assert.equal(handleFor(ID_A).length, HANDLE_DEFAULT_WIDTH);
});

test("handleFor yields a non-empty 4-hex string", () => {
  const got = handleFor("fact-1");
  assert.match(got, /^[0-9a-f]{4}$/);
  assert.equal(got, handleFor("fact-1"));
});

test("handleFor wider width is a prefix-preserving extension", () => {
  const h4 = handleFor(ID_A, 4);
  const h6 = handleFor(ID_A, 6);
  const h8 = handleFor(ID_A, 8);
  assert.equal(h6.slice(0, 4), h4);
  assert.equal(h8.slice(0, 6), h6);
  assert.equal(h4.length, 4);
  assert.equal(h6.length, 6);
});

test("handleFor clamps out-of-range widths", () => {
  assert.equal(handleFor(ID_A, 2), handleFor(ID_A, 4));
  assert.equal(handleFor(ID_A, 100), handleFor(ID_A, 8));
  assert.equal(handleFor(ID_A, Number.NaN), handleFor(ID_A, 4));
});

test("handleFor is derived from id, not content — stable across edits", () => {
  // Two ids that differ only by a suffix get different handles.
  assert.notEqual(handleFor("fact-1"), handleFor("fact-2"));
});

// ─── renderHandle / appendHandle ──────────────────────────────────────────

test("renderHandle produces the bracketed token", () => {
  assert.equal(renderHandle(ID_A), `[m:${HANDLE_A}]`);
});

test("appendHandle adds a single space before the handle and trims trailing ws", () => {
  assert.equal(
    appendHandle("API rate limit is 1000 rpm.   ", ID_A),
    `API rate limit is 1000 rpm. [m:${HANDLE_A}]`,
  );
});

// ─── renderHandlesForInjection: collision extension ───────────────────────

test("renderHandlesForInjection widens EVERY member of a colliding group to 6 chars", () => {
  // Engineer a collision: two synthetic ids whose sha256 prefix collides at 4
  // chars. Search a small id space for a real collision so the test is honest.
  let idA = "";
  let idB = "";
  const seen = new Map<string, string>();
  for (let i = 0; i < 200_000 && !idA; i += 1) {
    const id = `fact-${i}-probe`;
    const h = handleFor(id, 4);
    const prev = seen.get(h);
    if (prev && prev !== id) {
      idA = prev;
      idB = id;
    } else {
      seen.set(h, id);
    }
  }
  if (idA && idB) {
    const entries = renderHandlesForInjection([idA, idB]);
    assert.equal(entries.length, 2);
    // BOTH colliding members widen: leaving the first at 4 chars would make its
    // displayed handle ambiguous to resolve against the group (codex review).
    assert.equal(entries[0]!.width, HANDLE_EXTENDED_WIDTH);
    assert.equal(entries[1]!.width, HANDLE_EXTENDED_WIDTH);
    // Both rendered tokens are unique in the set (6-char handles differ).
    const tokens = entries.map((e) => e.handle);
    assert.equal(new Set(tokens).size, tokens.length);
    assert.notEqual(tokens[0], tokens[1]);
  }
});

test("renderHandlesForInjection: no collision → all default width, unique", () => {
  const ids = ["fact-1", "fact-2", "fact-3"];
  const entries = renderHandlesForInjection(ids);
  assert.equal(entries.length, 3);
  for (const e of entries) assert.equal(e.width, HANDLE_DEFAULT_WIDTH);
  const tokens = entries.map((e) => e.handle);
  assert.equal(new Set(tokens).size, tokens.length);
});

test("renderHandlesForInjection is idempotent and skips empty ids", () => {
  const ids = ["fact-1", "", "fact-2"];
  const e1 = renderHandlesForInjection(ids);
  const e2 = renderHandlesForInjection(ids);
  assert.deepEqual(e1, e2);
  assert.equal(e1.length, 2);
});

// ─── parseHandles ─────────────────────────────────────────────────────────

test("parseHandles extracts handles from prose, ignoring malformed", () => {
  const text = "see [m:4f2a] (also [m:1b9e2f]) — not [m:XYZ!] or [m:ab] done";
  assert.deepEqual(parseHandles(text), ["[m:4f2a]", "[m:1b9e2f]"]);
});

test("parseHandles handles mid-sentence and punctuation-adjacent tokens", () => {
  assert.deepEqual(parseHandles("[m:4f2a], [m:1b9e]; [m:0c7d]."), [
    "[m:4f2a]",
    "[m:1b9e]",
    "[m:0c7d]",
  ]);
});

test("parseHandles preserves duplicates and order", () => {
  assert.deepEqual(parseHandles("[m:4f2a] and again [m:4f2a]"), [
    "[m:4f2a]",
    "[m:4f2a]",
  ]);
});

test("parseHandles returns [] for non-string / empty", () => {
  assert.deepEqual(parseHandles(""), []);
});

// ─── normalizeHandle / isHandleToken ──────────────────────────────────────

test("normalizeHandle accepts bracketed, prefixed, and bare hex forms", () => {
  assert.equal(normalizeHandle("[m:4f2a]"), "4f2a");
  assert.equal(normalizeHandle("m:4f2a"), "4f2a");
  assert.equal(normalizeHandle("4f2a"), "4f2a");
  assert.equal(normalizeHandle("[M:4F2A]"), "4f2a"); // case-insensitive
});

test("normalizeHandle rejects non-handles", () => {
  assert.equal(normalizeHandle("fact-1-abc"), null);
  assert.equal(normalizeHandle("[m:xyz!]"), null);
  assert.equal(normalizeHandle("[m:ab]"), null); // too short
  assert.equal(normalizeHandle(""), null);
});

test("isHandleToken mirrors normalizeHandle", () => {
  assert.equal(isHandleToken("[m:4f2a]"), true);
  assert.equal(isHandleToken("fact-1"), false);
});

test("parseIdOrHandle classifies refs", () => {
  const h = parseIdOrHandle("[m:4f2a]");
  assert.equal(h.isHandle, true);
  assert.equal(h.value, "4f2a");
  const id = parseIdOrHandle("fact-1");
  assert.equal(id.isHandle, false);
  assert.equal(id.value, "fact-1");
});

// ─── stripHandles ─────────────────────────────────────────────────────────

test("stripHandles removes tokens and tidies spacing", () => {
  assert.equal(
    stripHandles("API limit 1000 rpm. [m:4f2a] Also [m:1b9e]."),
    "API limit 1000 rpm. Also.",
  );
  assert.equal(stripHandles("no handles here"), "no handles here");
  assert.equal(stripHandles(""), "");
});

// ─── resolveHandle ────────────────────────────────────────────────────────

function snap(...ids: string[]): RecallSnapshotIds {
  return { memoryIds: ids };
}

test("resolveHandle: hit returns the exact memoryId", () => {
  const res = resolveHandle(HANDLE_A, [snap(ID_A, "fact-other")]);
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.memoryId, ID_A);
});

test("resolveHandle: miss is tagged not_found, never guessed", () => {
  const res = resolveHandle("dead", [snap("fact-1")]);
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.reason, "not_found");
});

test("resolveHandle: ambiguous collision across snapshots lists candidates", () => {
  // Two distinct ids that share the same 4-char handle, in different snapshots.
  let idA = "";
  let idB = "";
  const seen = new Map<string, string>();
  for (let i = 0; i < 200_000 && !idA; i += 1) {
    const id = `fact-${i}-amb`;
    const h = handleFor(id, 4);
    const prev = seen.get(h);
    if (prev && prev !== id) {
      idA = prev;
      idB = id;
    } else {
      seen.set(h, id);
    }
  }
  if (idA && idB) {
    const res = resolveHandle(handleFor(idA, 4), [snap(idA), snap(idB)]);
    assert.equal(res.ok, false);
    if (!res.ok && res.reason === "ambiguous") {
      assert.ok(res.candidates.includes(idA));
      assert.ok(res.candidates.includes(idB));
    }
  }
});

test("resolveHandle: snapshot depth is respected (older-than-N → miss)", () => {
  // ID_A only in the 6th snapshot; depth 5 must miss.
  const snapshots = [
    snap("other-1"),
    snap("other-2"),
    snap("other-3"),
    snap("other-4"),
    snap("other-5"),
    snap(ID_A),
  ];
  const within = resolveHandle(HANDLE_A, snapshots, DEFAULT_HANDLE_SNAPSHOT_DEPTH);
  assert.equal(within.ok, false); // depth 5 skips the 6th
  if (!within.ok) assert.equal(within.reason, "not_found");
  // Widening depth finds it.
  const found = resolveHandle(HANDLE_A, snapshots, 6);
  assert.equal(found.ok, true);
});

test("resolveHandle: a non-handle input is not_found, not a throw", () => {
  const res = resolveHandle("fact-1", [snap("fact-1")]);
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.reason, "not_found");
});

test("resolveHandle: newest-first ordering prefers the most recent recall", () => {
  // Same id appears in two snapshots; resolution still yields a single match.
  const res = resolveHandle(HANDLE_A, [snap(ID_A), snap(ID_A)]);
  assert.equal(res.ok, true);
});
