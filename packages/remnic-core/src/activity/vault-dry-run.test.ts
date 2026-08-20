import assert from "node:assert/strict";
import test from "node:test";

import { planVaultDryRun } from "./vault-dry-run.js";
import type { VaultDryRunInput } from "./vault-dry-run.js";
import { VAULT_PUBLISH_OUTCOMES } from "./vault-status.js";

test("planVaultDryRun predicts a mixed batch with correct per-file outcomes and counts", () => {
  const status = planVaultDryRun([
    { path: "notes/b.md", currentText: "same", nextText: "same" },
    { path: "notes/a.md", currentText: null, nextText: "new body" },
    { path: "notes/c.md", currentText: "old", nextText: "new" },
    { path: "notes/d.md", currentText: "text", nextText: null, skipReason: "no_marker" },
  ]);
  assert.deepEqual(status.counts, { updated: 1, unchanged: 1, skipped: 2, error: 0 });
  assert.equal(status.hasError, false);
  assert.deepEqual(status.results, [
    { path: "notes/a.md", outcome: "skipped", reason: "missing_file" },
    { path: "notes/b.md", outcome: "unchanged" },
    { path: "notes/c.md", outcome: "updated" },
    { path: "notes/d.md", outcome: "skipped", reason: "no_marker" },
  ]);
});

// The real publisher refuses to create missing notes (missing_file), so a
// dry run must predict that skip rather than promise an update.
test("a missing note predicts the publisher's skip, not a create", () => {
  const status = planVaultDryRun([{ path: "new.md", currentText: null, nextText: "body" }]);
  assert.deepEqual(status.counts, { updated: 0, unchanged: 0, skipped: 1, error: 0 });
  assert.deepEqual(status.results, [{ path: "new.md", outcome: "skipped", reason: "missing_file" }]);
});

test("byte-identical text is unchanged", () => {
  const status = planVaultDryRun([{ path: "same.md", currentText: "line\nline\n", nextText: "line\nline\n" }]);
  assert.deepEqual(status.counts, { updated: 0, unchanged: 1, skipped: 0, error: 0 });
  assert.deepEqual(status.results, [{ path: "same.md", outcome: "unchanged" }]);
});

test("a whitespace-only difference is updated, not unchanged", () => {
  const status = planVaultDryRun([
    { path: "trailing.md", currentText: "body", nextText: "body " },
    { path: "newline.md", currentText: "body\n", nextText: "body" },
  ]);
  assert.deepEqual(status.counts, { updated: 2, unchanged: 0, skipped: 0, error: 0 });
});

test("nextText null with a reason is skipped carrying that exact reason", () => {
  const status = planVaultDryRun([
    { path: "skip.md", currentText: "text", nextText: null, skipReason: "no_marker" },
  ]);
  assert.deepEqual(status.results, [{ path: "skip.md", outcome: "skipped", reason: "no_marker" }]);
  assert.equal(status.counts.skipped, 1);
});

test("nextText null without a reason throws TypeError naming skipReason", () => {
  assert.throws(
    () => planVaultDryRun([{ path: "skip.md", currentText: "text", nextText: null }]),
    (err: unknown) => err instanceof TypeError && /skipReason/.test(err.message),
  );
  assert.throws(
    () => planVaultDryRun([{ path: "skip.md", currentText: "text", nextText: null, skipReason: "   " }]),
    (err: unknown) => err instanceof TypeError && /skipReason/.test(err.message),
  );
});

test("skipReason with a non-null nextText throws TypeError", () => {
  assert.throws(
    () => planVaultDryRun([{ path: "conflict.md", currentText: "a", nextText: "b", skipReason: "no_marker" }]),
    (err: unknown) => err instanceof TypeError && /skipReason/.test(err.message),
  );
});

test("blank path throws RangeError naming path", () => {
  assert.throws(
    () => planVaultDryRun([{ path: "", currentText: "a", nextText: "a" }]),
    (err: unknown) => err instanceof RangeError && /path/.test(err.message),
  );
  assert.throws(
    () => planVaultDryRun([{ path: "   ", currentText: "a", nextText: "a" }]),
    (err: unknown) => err instanceof RangeError && /path/.test(err.message),
  );
});

test("unused outcome keys are present at zero", () => {
  const status = planVaultDryRun([{ path: "only.md", currentText: "a", nextText: "a" }]);
  for (const outcome of VAULT_PUBLISH_OUTCOMES) {
    assert.ok(outcome in status.counts, `count key ${outcome} must exist`);
    assert.equal(status.counts[outcome], outcome === "unchanged" ? 1 : 0);
  }
});

test("input is not mutated", () => {
  const inputs: VaultDryRunInput[] = [
    { path: "a.md", currentText: "old", nextText: "new" },
    { path: "b.md", currentText: "x", nextText: null, skipReason: "no_marker" },
  ];
  const snapshot = JSON.parse(JSON.stringify(inputs));
  planVaultDryRun(inputs);
  assert.deepEqual(inputs, snapshot);
});

// Round 3: undefined and non-string text fields are malformed input, never a
// prediction. Two undefined fields used to compare equal and report unchanged.
test("undefined and non-string text fields throw rather than predict", () => {
  for (const bad of [
    { path: "a.md", currentText: undefined as unknown as string, nextText: "x" },
    { path: "a.md", currentText: "x", nextText: undefined as unknown as string },
    { path: "a.md", currentText: 5 as unknown as string, nextText: "x" },
    { path: "a.md", currentText: "x", nextText: {} as unknown as string },
    { path: "a.md", currentText: undefined as unknown as string, nextText: undefined as unknown as string },
  ]) {
    assert.throws(() => planVaultDryRun([bad]), /must be a string or null/);
  }
});
