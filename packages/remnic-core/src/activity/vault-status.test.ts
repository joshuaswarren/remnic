import assert from "node:assert/strict";
import test from "node:test";

import { VAULT_PUBLISH_OUTCOMES, summarizeVaultPublish } from "./vault-status.js";
import type { VaultPublishResult } from "./vault-status.js";

test("summarizeVaultPublish counts a mixed list, sorts by path, and flags the error", () => {
  const status = summarizeVaultPublish([
    { path: "notes/e.md", outcome: "updated" },
    { path: "notes/d.md", outcome: "error", reason: "missing_file" },
    { path: "notes/a.md", outcome: "updated" },
    { path: "notes/c.md", outcome: "skipped", reason: "no_marker" },
    { path: "notes/b.md", outcome: "unchanged" },
  ]);
  assert.deepEqual(status.counts, { updated: 2, unchanged: 1, skipped: 1, error: 1 });
  assert.equal(status.hasError, true);
  assert.deepEqual(status.results, [
    { path: "notes/a.md", outcome: "updated" },
    { path: "notes/b.md", outcome: "unchanged" },
    { path: "notes/c.md", outcome: "skipped", reason: "no_marker" },
    { path: "notes/d.md", outcome: "error", reason: "missing_file" },
    { path: "notes/e.md", outcome: "updated" },
  ]);
});

test("empty input returns zeroed counts, no results, and hasError false", () => {
  const status = summarizeVaultPublish([]);
  assert.deepEqual(status.counts, { updated: 0, unchanged: 0, skipped: 0, error: 0 });
  for (const outcome of VAULT_PUBLISH_OUTCOMES) {
    assert.equal(status.counts[outcome], 0, `count key ${outcome} must exist at zero`);
  }
  assert.deepEqual(status.results, []);
  assert.equal(status.hasError, false);
});

test("unknown outcome throws TypeError listing the allow-list", () => {
  assert.throws(
    () => summarizeVaultPublish([{ path: "notes/a.md", outcome: "deleted" }]),
    (err: unknown) => {
      assert.ok(err instanceof TypeError);
      assert.match(err.message, /unknown vault publish outcome/);
      for (const outcome of VAULT_PUBLISH_OUTCOMES) {
        assert.ok(err.message.includes(outcome), `message lists ${outcome}`);
      }
      return true;
    },
  );
});

test("skipped without a reason throws TypeError", () => {
  assert.throws(
    () => summarizeVaultPublish([{ path: "notes/a.md", outcome: "skipped" }]),
    (err: unknown) => err instanceof TypeError && /reason/.test(err.message),
  );
});

test("error with a missing or whitespace-only reason throws TypeError", () => {
  assert.throws(
    () => summarizeVaultPublish([{ path: "notes/a.md", outcome: "error" }]),
    (err: unknown) => err instanceof TypeError && /reason/.test(err.message),
  );
  assert.throws(
    () => summarizeVaultPublish([{ path: "notes/a.md", outcome: "error", reason: "   " }]),
    (err: unknown) => err instanceof TypeError && /reason/.test(err.message),
  );
});

test("updated and unchanged must not carry a reason", () => {
  assert.throws(
    () => summarizeVaultPublish([{ path: "notes/a.md", outcome: "updated", reason: "no_marker" }]),
    (err: unknown) => err instanceof TypeError && /reason/.test(err.message),
  );
  assert.throws(
    () => summarizeVaultPublish([{ path: "notes/a.md", outcome: "unchanged", reason: "x" }]),
    (err: unknown) => err instanceof TypeError && /reason/.test(err.message),
  );
});

test("blank path throws RangeError", () => {
  assert.throws(
    () => summarizeVaultPublish([{ path: "", outcome: "updated" }]),
    (err: unknown) => err instanceof RangeError && /path/.test(err.message),
  );
  assert.throws(
    () => summarizeVaultPublish([{ path: " \t ", outcome: "updated" }]),
    (err: unknown) => err instanceof RangeError && /path/.test(err.message),
  );
});

test("duplicate paths are all preserved, not deduplicated", () => {
  const status = summarizeVaultPublish([
    { path: "notes/a.md", outcome: "updated" },
    { path: "notes/a.md", outcome: "skipped", reason: "no_marker" },
    { path: "notes/a.md", outcome: "updated" },
  ]);
  assert.equal(status.results.length, 3);
  assert.deepEqual(status.counts, { updated: 2, unchanged: 0, skipped: 1, error: 0 });
  assert.deepEqual(
    status.results.map((entry) => entry.outcome),
    ["updated", "updated", "skipped"],
  );
  assert.equal(status.hasError, false);
});

test("order is deterministic across shuffled input", () => {
  const base: VaultPublishResult[] = [
    { path: "days/2026-08-18.md", outcome: "error", reason: "missing_file" },
    { path: "days/2026-08-18.md", outcome: "updated" },
    { path: "days/2026-08-18.md", outcome: "skipped", reason: "no_marker" },
    { path: "days/2026-08-18.md", outcome: "skipped", reason: "duplicate_heading" },
    { path: "days/2026-08-17.md", outcome: "unchanged" },
    { path: "places/office.md", outcome: "updated" },
  ];
  const forward = summarizeVaultPublish(base);
  const reversed = summarizeVaultPublish([...base].reverse());
  assert.deepEqual(forward, reversed);
  assert.deepEqual(
    forward.results.map((entry) => `${entry.path}:${entry.outcome}:${entry.reason ?? ""}`),
    [
      "days/2026-08-17.md:unchanged:",
      "days/2026-08-18.md:updated:",
      "days/2026-08-18.md:skipped:duplicate_heading",
      "days/2026-08-18.md:skipped:no_marker",
      "days/2026-08-18.md:error:missing_file",
      "places/office.md:updated:",
    ],
  );
});

test("input is not mutated", () => {
  const input: VaultPublishResult[] = [
    { path: "notes/b.md", outcome: "updated" },
    { path: "notes/a.md", outcome: "skipped", reason: "no_marker" },
  ];
  const snapshot = structuredClone(input);
  summarizeVaultPublish(input);
  assert.deepEqual(input, snapshot);
});
