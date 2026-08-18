import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  memoryWorthOutcomeEligibleCategories,
  recordMemoryOutcome,
  toMemoryOutcomeObservation,
} from "./memory-worth-outcomes.js";
import { StorageManager } from "./storage.js";

/**
 * Issue #560 PR 3 — tests for the outcome signal pipeline.
 *
 * These tests pin the contract `recordMemoryOutcome` exposes to callers:
 *   - Successful increments land on the right counter and preserve
 *     unrelated frontmatter fields.
 *   - Legacy memories (no counters yet) start at 1 / 0 after the first
 *     success, not at some dedup-polluted value.
 *   - Non-eligible categories are rejected as ineligible, not silently
 *     written to.
 *   - Invalid paths / IDs / outcomes return an `{ok: false}` result, not a
 *     thrown exception, so a ledger drainer can aggregate failure reasons.
 */

async function writeFactFile(
  storage: StorageManager,
  body: string,
  extraFrontmatterLines: string[] = []
): Promise<{ id: string; filePath: string }> {
  const today = new Date().toISOString().slice(0, 10);
  const id = `fact-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const lines = [
    "---",
    `id: ${id}`,
    "category: fact",
    `created: ${new Date().toISOString()}`,
    `updated: ${new Date().toISOString()}`,
    "source: extraction",
    "confidence: 0.8",
    "confidenceTier: high",
    "tags: []",
    ...extraFrontmatterLines,
    "---",
  ];
  const factsDir = path.join((storage as unknown as { baseDir: string }).baseDir, "facts", today);
  await mkdir(factsDir, { recursive: true });
  const filePath = path.join(factsDir, `${id}.md`);
  await writeFile(filePath, `${lines.join("\n")}\n\n${body}\n`, "utf-8");
  return { id, filePath };
}

async function writeCorrectionFile(storage: StorageManager, body: string): Promise<{ id: string; filePath: string }> {
  const id = `correction-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const lines = [
    "---",
    `id: ${id}`,
    "category: correction",
    `created: ${new Date().toISOString()}`,
    `updated: ${new Date().toISOString()}`,
    "source: extraction",
    "confidence: 0.8",
    "confidenceTier: high",
    "tags: []",
    "---",
  ];
  const correctionsDir = path.join((storage as unknown as { baseDir: string }).baseDir, "corrections");
  await mkdir(correctionsDir, { recursive: true });
  const filePath = path.join(correctionsDir, `${id}.md`);
  await writeFile(filePath, `${lines.join("\n")}\n\n${body}\n`, "utf-8");
  return { id, filePath };
}

test("success on a legacy memory increments mw_success from implicit 0", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-mw-outcome-success-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const { id, filePath } = await writeFactFile(storage, "Legacy fact pre-dating instrumentation.");

    const result = await recordMemoryOutcome(storage, {
      memoryPath: filePath,
      outcome: "success",
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.memoryId, id);
      assert.equal(result.mw_success, 1);
      assert.equal(result.mw_fail, 0);
    }

    const after = await storage.getMemoryById(id);
    assert.ok(after);
    assert.equal(after!.frontmatter.mw_success, 1);
    assert.equal(after!.frontmatter.mw_fail, 0);
    // Unrelated fields must survive the mutation.
    assert.equal(after!.frontmatter.category, "fact");
    assert.equal(after!.frontmatter.confidence, 0.8);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("failure on a legacy memory increments mw_fail from implicit 0", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-mw-outcome-failure-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const { id, filePath } = await writeFactFile(storage, "Legacy fact destined for a failure.");

    const result = await recordMemoryOutcome(storage, {
      memoryPath: filePath,
      outcome: "failure",
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.mw_success, 0);
      assert.equal(result.mw_fail, 1);
    }

    const after = await storage.getMemoryById(id);
    assert.equal(after!.frontmatter.mw_success, 0);
    assert.equal(after!.frontmatter.mw_fail, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("consecutive outcomes accumulate independently", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-mw-outcome-accum-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const { id, filePath } = await writeFactFile(storage, "Accumulating outcomes.", ["mw_success: 2", "mw_fail: 0"]);

    await recordMemoryOutcome(storage, { memoryPath: filePath, outcome: "success" });
    await recordMemoryOutcome(storage, { memoryPath: filePath, outcome: "failure" });
    const final = await recordMemoryOutcome(storage, {
      memoryPath: filePath,
      outcome: "failure",
    });

    assert.equal(final.ok, true);
    if (final.ok) {
      assert.equal(final.mw_success, 3);
      assert.equal(final.mw_fail, 2);
    }

    const after = await storage.getMemoryById(id);
    assert.equal(after!.frontmatter.mw_success, 3);
    assert.equal(after!.frontmatter.mw_fail, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("non-fact category returns ineligible_category, does NOT write", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-mw-outcome-ineligible-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const { id, filePath } = await writeCorrectionFile(storage, "A correction, not a fact.");

    const result = await recordMemoryOutcome(storage, {
      memoryPath: filePath,
      outcome: "success",
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "ineligible_category");
    }

    // The frontmatter must be completely untouched.
    const after = await storage.getMemoryById(id);
    assert.ok(after);
    assert.equal(after!.frontmatter.mw_success, undefined);
    assert.equal(after!.frontmatter.mw_fail, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("unknown memory id returns not_found, does not throw", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-mw-outcome-missing-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const result = await recordMemoryOutcome(storage, {
      memoryPath: path.join(dir, "facts", "2026-01-01", "nonexistent-id.md"),
      outcome: "success",
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "not_found");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("invalid outcome string returns invalid_outcome", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-mw-outcome-bad-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const { filePath } = await writeFactFile(storage, "Fact.");

    const result = await recordMemoryOutcome(storage, {
      memoryPath: filePath,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      outcome: "maybe" as any,
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "invalid_outcome");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("path without .md suffix returns invalid_path", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-mw-outcome-badpath-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const result = await recordMemoryOutcome(storage, {
      memoryPath: "not-a-memory-file",
      outcome: "success",
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "invalid_path");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("directory-prefixed path without .md suffix also rejected", async () => {
  // Bugbot/codex P2: previously, conditional .md check let a deep path
  // like /tmp/facts/2026-01-01/not-a-memory through (basename strips the
  // dirs, so `basename === memoryPath` was false and the .md guard was
  // skipped). With the fix the check runs unconditionally on the raw
  // input.
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-mw-outcome-deep-badpath-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const result = await recordMemoryOutcome(storage, {
      memoryPath: "/tmp/facts/2026-01-01/not-a-memory",
      outcome: "success",
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "invalid_path");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent outcomes for the same memory do NOT lose updates", async () => {
  // Codex P1: two concurrent recordMemoryOutcome calls must each persist
  // a +1 instead of reading the same snapshot and overwriting. The module
  // enforces per-ID serialization, so 10 parallel successes must land as
  // mw_success = 10, not something < 10.
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-mw-outcome-concurrent-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const { id, filePath } = await writeFactFile(storage, "Concurrency target.");

    const N = 10;
    const calls = Array.from({ length: N }, () =>
      recordMemoryOutcome(storage, { memoryPath: filePath, outcome: "success" })
    );
    const results = await Promise.all(calls);

    // Every call must succeed.
    for (const r of results) assert.equal(r.ok, true);

    // The persisted counter must reflect every increment, not a subset.
    const after = await storage.getMemoryById(id);
    assert.ok(after);
    assert.equal(after!.frontmatter.mw_success, N);
    assert.equal(after!.frontmatter.mw_fail, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("eligible-category set is exactly {fact, procedure}", () => {
  // Pinning this keeps PR 3 in lockstep with the PR 1 doctor allowlist in
  // operator-toolkit.ts (MEMORY_WORTH_ELIGIBLE_CATEGORIES). If either side
  // expands, this test and the doctor test must both be updated.
  // `procedure` joined in issue #2370: the procedure library-health loop
  // retires on failure-dominant mw_* counters, so injected procedures must
  // accrue outcomes.
  const eligible = memoryWorthOutcomeEligibleCategories();
  assert.equal(eligible.size, 2);
  assert.ok(eligible.has("fact"));
  assert.ok(eligible.has("procedure"));
});

// ---------------------------------------------------------------------------
// Issue #2345 — pure MemoryOutcomeObservation view (no writes, no counters)
// ---------------------------------------------------------------------------

test("outcome facts with time and join data become observations", () => {
  const view = toMemoryOutcomeObservation({
    memoryId: "fact-1",
    namespace: "test-ns",
    outcome: "success",
    observedAt: "2026-08-12T00:00:00.000Z",
    joinId: "act-1",
  });
  assert.equal(view.status, "observed");
  if (view.status === "observed") {
    assert.equal(view.observation.schemaVersion, 1);
    assert.equal(view.observation.observedAt, "2026-08-12T00:00:00.000Z");
    assert.equal(view.observation.joinId, "act-1");
    // Round-trips through public types (undefined optionals drop in JSON).
    const roundTripped = JSON.parse(JSON.stringify(view.observation)) as Record<string, unknown>;
    assert.equal(roundTripped.schemaVersion, 1);
    assert.equal(roundTripped.memoryId, "fact-1");
    assert.equal(roundTripped.joinId, "act-1");
  }
});

test("counter-only rows stay missing_observation and never guess an action", () => {
  const noTime = toMemoryOutcomeObservation({
    memoryId: "fact-1",
    namespace: "test-ns",
    outcome: "success",
    joinId: "act-1",
  });
  assert.deepEqual(noTime, { status: "missing_observation", memoryId: "fact-1", reason: "missing_observed_at" });

  const noJoin = toMemoryOutcomeObservation({
    memoryId: "fact-2",
    namespace: "test-ns",
    outcome: "failure",
    observedAt: new Date("2026-08-12T00:00:00.000Z"),
  });
  assert.deepEqual(noJoin, { status: "missing_observation", memoryId: "fact-2", reason: "missing_join_data" });
});
