import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";

import { StorageManager } from "./storage.js";
import { summarizeMemoryWorthLegacyCounters } from "./operator-toolkit.js";

/**
 * Issue #560 PR 1 — Memory Worth counters: frontmatter schema + storage round-trip.
 *
 * These tests pin the on-disk contract for the `mw_success` and `mw_fail`
 * frontmatter fields. They live in the core package (not the root tests/
 * directory) so they co-locate with storage.ts, where the parser/serializer
 * they cover resides.
 *
 * Scope per PR 1:
 *   - Round-trip: explicit counters survive write → read intact.
 *   - Legacy memories without the fields read cleanly (no crash) and return
 *     `undefined` from the parser (matching the accessCount pattern).
 *   - `remnic doctor` legacy-count correctly partitions instrumented from
 *     uninstrumented memories.
 *   - Negative values are rejected on write (silent clamping would mask
 *     miscounts in the feedback pipeline added by PR 3).
 *
 * Out of scope (later PRs in issue #560):
 *   - computeMemoryWorth() scoring helper (PR 2)
 *   - Outcome-signal pipeline that increments the counters (PR 3)
 *   - Recall filter gated on the computed score (PR 4)
 *   - Benchmark + default flip (PR 5)
 */

/**
 * Build a fact file on disk with a bare-bones frontmatter plus arbitrary
 * extra lines. Used to synthesize legacy and instrumented memories without
 * going through `writeMemory`, which doesn't expose mw_* options (by design —
 * those are set by the outcome pipeline in PR 3, not at creation time).
 */
async function writeFactFile(
  storage: StorageManager,
  body: string,
  extraFrontmatterLines: string[] = [],
): Promise<string> {
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
  await writeFile(path.join(factsDir, `${id}.md`), `${lines.join("\n")}\n\n${body}\n`, "utf-8");
  return id;
}

/**
 * Write a bare-bones correction file. Corrections are NOT eligible for Memory
 * Worth instrumentation, so the doctor audit must exclude them from both the
 * legacy and instrumented tallies.
 */
async function writeCorrectionFile(storage: StorageManager, body: string): Promise<string> {
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
  const correctionsDir = path.join(
    (storage as unknown as { baseDir: string }).baseDir,
    "corrections",
  );
  await mkdir(correctionsDir, { recursive: true });
  await writeFile(path.join(correctionsDir, `${id}.md`), `${lines.join("\n")}\n\n${body}\n`, "utf-8");
  return id;
}

test("round-trip: mw_success / mw_fail survive write → readAllMemories", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-mw-roundtrip-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const id = await writeFactFile(storage, "Production DB uses pgBouncer.", [
      "mw_success: 3",
      "mw_fail: 1",
    ]);

    const memories = await storage.readAllMemories();
    const written = memories.find((m) => m.frontmatter.id === id);
    assert.ok(written, "fact must be discoverable after write");
    assert.equal(written!.frontmatter.mw_success, 3);
    assert.equal(written!.frontmatter.mw_fail, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("round-trip: explicit zero counters are preserved (distinguishable from absent)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-mw-zero-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const id = await writeFactFile(storage, "Observed zero successes.", [
      "mw_success: 0",
      "mw_fail: 0",
    ]);

    const memories = await storage.readAllMemories();
    const written = memories.find((m) => m.frontmatter.id === id);
    assert.ok(written);
    assert.equal(written!.frontmatter.mw_success, 0, "explicit 0 must round-trip as 0, not undefined");
    assert.equal(written!.frontmatter.mw_fail, 0, "explicit 0 must round-trip as 0, not undefined");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy memory without mw fields reads cleanly — fields are undefined", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-mw-legacy-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const id = await writeFactFile(storage, "Legacy fact pre-dating Memory Worth counters.");

    const memories = await storage.readAllMemories();
    const written = memories.find((m) => m.frontmatter.id === id);
    assert.ok(written, "legacy fact must still be readable");
    assert.equal(written!.frontmatter.mw_success, undefined);
    assert.equal(written!.frontmatter.mw_fail, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("corrupt counter values (negative / non-integer) parse back as undefined, not corrupt numbers", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-mw-corrupt-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const id = await writeFactFile(storage, "Fact with hand-edited corrupt counters.", [
      "mw_success: -2",
      "mw_fail: 1.5",
    ]);

    const memories = await storage.readAllMemories();
    const written = memories.find((m) => m.frontmatter.id === id);
    assert.ok(written);
    // Corrupt values must NOT round-trip — they fail safely to undefined so
    // downstream scoring isn't poisoned. See parseMemoryWorthCounterField.
    assert.equal(written!.frontmatter.mw_success, undefined);
    assert.equal(written!.frontmatter.mw_fail, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("doctor legacy-count: mixed corpus partitions correctly", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-mw-doctor-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    // Two legacy facts, one instrumented fact, one correction. The correction
    // must be excluded from both legacy and instrumented tallies because
    // Memory Worth is a per-fact signal (see MEMORY_WORTH_ELIGIBLE_CATEGORIES).
    await writeFactFile(storage, "Legacy fact A.");
    await writeFactFile(storage, "Legacy fact B.");
    await writeFactFile(storage, "Instrumented fact.", ["mw_success: 2", "mw_fail: 0"]);
    await writeCorrectionFile(storage, "Out-of-scope correction — must not count.");

    const check = await summarizeMemoryWorthLegacyCounters(storage);
    assert.equal(check.key, "memory_worth_legacy");
    assert.equal(check.status, "ok", "legacy memories must never fail the doctor check");
    const details = check.details as {
      legacy: number;
      instrumented: number;
      total: number;
      ineligible: number;
    };
    assert.equal(details.legacy, 2);
    assert.equal(details.instrumented, 1);
    assert.equal(details.total, 3, "total reflects only eligible (fact) memories");
    assert.equal(details.ineligible, 1, "correction is counted as ineligible, not legacy");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("doctor legacy-count: non-fact memories never count as legacy", async () => {
  // Regression guard: a pure-correction corpus must report zero legacy and
  // zero instrumented, not N legacy. Without the category filter, operators
  // would see the legacy bucket permanently inflated even when every fact is
  // fully instrumented.
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-mw-doctor-corrections-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    await writeCorrectionFile(storage, "Correction 1.");
    await writeCorrectionFile(storage, "Correction 2.");

    const check = await summarizeMemoryWorthLegacyCounters(storage);
    const details = check.details as {
      legacy: number;
      instrumented: number;
      total: number;
      ineligible: number;
    };
    assert.equal(details.legacy, 0, "corrections must not inflate the legacy bucket");
    assert.equal(details.instrumented, 0);
    assert.equal(details.total, 0);
    assert.equal(details.ineligible, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("doctor legacy-count: empty memory dir reports zero without warning", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-mw-doctor-empty-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const check = await summarizeMemoryWorthLegacyCounters(storage);
    assert.equal(check.status, "ok");
    const details = check.details as {
      legacy: number;
      instrumented: number;
      total: number;
      ineligible: number;
    };
    assert.equal(details.total, 0);
    assert.equal(details.legacy, 0);
    assert.equal(details.instrumented, 0);
    assert.equal(details.ineligible, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Negative-value rejection on serialize.
//
// The serializer throws on invalid counter values, but `writeMemory` never
// supplies mw fields (they're set by the PR 3 pipeline through spread-based
// updates on an existing frontmatter). Exercise the validator via an update
// path: write a fact, then attempt to update its frontmatter with a negative
// counter. The failure must surface rather than silently clamp.
// ---------------------------------------------------------------------------

test("negative mw_success on update throws rather than silently clamping", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-mw-negative-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const id = await writeFactFile(storage, "Fact to be poisoned with a bad counter.");

    // updateMemoryFrontmatter routes through serializeFrontmatter, so the
    // validator will reject the write.
    await assert.rejects(
      async () =>
        storage.updateMemoryFrontmatter(id, {
          mw_success: -1,
        }),
      /mw_success/,
      "writing a negative Memory Worth counter must throw",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("non-integer mw_fail on update throws rather than silently truncating", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-mw-float-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const id = await writeFactFile(storage, "Fact to be poisoned with a float counter.");

    await assert.rejects(
      async () =>
        storage.updateMemoryFrontmatter(id, {
          mw_fail: 2.5,
        }),
      /mw_fail/,
      "writing a non-integer Memory Worth counter must throw",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
