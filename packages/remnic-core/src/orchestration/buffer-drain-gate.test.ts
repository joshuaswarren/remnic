/**
 * `skipClaimedSession` gate: a buffer without a claim registry never reports a
 * claim (the legacy/test-double shape), and a claimed session settles as
 * skipped without running an extraction.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { skipClaimedSession } from "./buffer-drain-gate.js";
import type { ExtractionRunResult } from "./extraction-run.js";

test("a buffer without isSessionClaimed is never treated as claimed", () => {
  const settled: ExtractionRunResult[] = [];
  const result = skipClaimedSession({} as Parameters<typeof skipClaimedSession>[0], "sess-1", (r) => settled.push(r));
  assert.equal(result, false);
  assert.deepEqual(settled, []);
});

test("an unclaimed session with the method proceeds", () => {
  const settled: ExtractionRunResult[] = [];
  const result = skipClaimedSession({ isSessionClaimed: () => false }, "sess-1", (r) => settled.push(r));
  assert.equal(result, false);
  assert.deepEqual(settled, []);
});

test("a claimed session settles as skipped without extracting", () => {
  const settled: ExtractionRunResult[] = [];
  const result = skipClaimedSession({ isSessionClaimed: () => true }, "sess-1", (r) => settled.push(r));
  assert.equal(result, true);
  assert.equal(settled.length, 1);
  assert.equal(settled[0].status, "skipped");
  assert.equal(settled[0].reason, "claimed_by_buffer_drain");
});
