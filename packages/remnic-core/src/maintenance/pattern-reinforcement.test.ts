/**
 * Unit tests for the pattern-reinforcement maintenance job
 * (issue #687 PR 2/4).
 *
 * Uses an in-memory storage stub so tests focus on clustering /
 * supersession / idempotency behavior without booting a full
 * StorageManager. Storage round-trip for the new frontmatter fields is
 * covered separately in `storage.test.ts`-style coverage that
 * exercises `serializeFrontmatter` + `parseFrontmatter`.
 */

import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";

import {
  patternReinforcementKey,
  runPatternReinforcement,
  type PatternReinforcementStorage,
} from "./pattern-reinforcement.js";
import { StorageManager } from "../storage.js";
import type { MemoryFile, MemoryFrontmatter } from "../types.js";

interface StubWriteCall {
  memoryId: string;
  patch: Partial<MemoryFrontmatter>;
}

function makeMemory(overrides: Partial<MemoryFrontmatter> & { content?: string } = {}): MemoryFile {
  const { content, ...fmOverrides } = overrides;
  const id = fmOverrides.id ?? "m-default";
  return {
    path: `/tmp/mem/${id}.md`,
    content: content ?? "synthetic body",
    frontmatter: {
      id,
      category: "preference",
      created: "2026-01-01T00:00:00.000Z",
      updated: "2026-01-01T00:00:00.000Z",
      source: "test",
      confidence: 0.9,
      confidenceTier: "high",
      tags: [],
      ...fmOverrides,
    } as MemoryFrontmatter,
  };
}

function makeStorageStub(memories: MemoryFile[]): {
  stub: PatternReinforcementStorage;
  writes: StubWriteCall[];
} {
  const writes: StubWriteCall[] = [];
  // Mutate the in-memory list so re-runs see the previous patch
  // (mirrors real on-disk semantics needed by the idempotency test).
  const stub: PatternReinforcementStorage = {
    readAllMemories: async () => memories,
    writeMemoryFrontmatter: async (memory, patch) => {
      writes.push({ memoryId: memory.frontmatter.id, patch });
      memory.frontmatter = { ...memory.frontmatter, ...patch };
      return true;
    },
  };
  return { stub, writes };
}

const FROZEN_NOW = new Date("2026-04-25T12:00:00.000Z");
const frozenNow = () => FROZEN_NOW;

test("patternReinforcementKey lowercases, collapses whitespace, truncates to 200 chars", () => {
  assert.equal(patternReinforcementKey("  Hello   WORLD  "), "hello world");
  const long = "x".repeat(300);
  assert.equal(patternReinforcementKey(long).length, 200);
  assert.equal(
    patternReinforcementKey("Mixed\nCase\tWith\r\nLines"),
    "mixed case with lines",
  );
});

test("runPatternReinforcement: clusters duplicates, marks canonical + supersedes older", async () => {
  // 5 duplicates with the same normalized content across different
  // sessions/timestamps + 1 unique memory that should remain
  // untouched.
  const dupContent = "I prefer dark mode for all editors.";
  const dups = [
    makeMemory({ id: "m-1", content: dupContent, created: "2026-01-01T00:00:00Z", updated: "2026-01-01T00:00:00Z" }),
    makeMemory({ id: "m-2", content: dupContent, created: "2026-02-01T00:00:00Z", updated: "2026-02-01T00:00:00Z" }),
    makeMemory({ id: "m-3", content: dupContent, created: "2026-03-01T00:00:00Z", updated: "2026-03-01T00:00:00Z" }),
    makeMemory({ id: "m-4", content: dupContent, created: "2026-04-01T00:00:00Z", updated: "2026-04-01T00:00:00Z" }),
    makeMemory({ id: "m-5", content: dupContent, created: "2026-04-15T00:00:00Z", updated: "2026-04-15T00:00:00Z" }),
  ];
  const unique = makeMemory({
    id: "m-unique",
    content: "Completely different preference about tabs vs spaces.",
    created: "2026-03-10T00:00:00Z",
    updated: "2026-03-10T00:00:00Z",
  });
  const { stub, writes } = makeStorageStub([...dups, unique]);

  const result = await runPatternReinforcement(stub, {
    categories: ["preference", "fact", "decision"],
    minCount: 3,
    now: frozenNow,
  });

  assert.equal(result.clustersFound, 1);
  assert.equal(result.canonicalsUpdated, 1);
  assert.equal(result.duplicatesSuperseded, 4);
  assert.equal(result.clusters.length, 1);

  const cluster = result.clusters[0];
  // Most-recent member wins.
  assert.equal(cluster.canonicalId, "m-5");
  assert.equal(cluster.count, 5);
  assert.deepEqual(cluster.sourceIds, ["m-1", "m-2", "m-3", "m-4", "m-5"]);
  assert.deepEqual(cluster.supersededIds.slice().sort(), ["m-1", "m-2", "m-3", "m-4"]);

  // Canonical was patched with reinforcement metadata.
  const canonicalWrite = writes.find((w) => w.memoryId === "m-5");
  assert.ok(canonicalWrite);
  assert.equal(canonicalWrite!.patch.reinforcement_count, 5);
  assert.equal(canonicalWrite!.patch.last_reinforced_at, FROZEN_NOW.toISOString());
  assert.equal(canonicalWrite!.patch.derived_via, "pattern-reinforcement");
  assert.deepEqual(canonicalWrite!.patch.derived_from, ["m-1", "m-2", "m-3", "m-4", "m-5"]);

  // Each duplicate was marked superseded with supersededBy set.
  for (const id of ["m-1", "m-2", "m-3", "m-4"]) {
    const w = writes.find((w) => w.memoryId === id);
    assert.ok(w, `expected supersede write for ${id}`);
    assert.equal(w!.patch.status, "superseded");
    assert.equal(w!.patch.supersededBy, "m-5");
    assert.equal(w!.patch.supersededAt, FROZEN_NOW.toISOString());
  }

  // Unique memory was NOT touched.
  assert.ok(!writes.some((w) => w.memoryId === "m-unique"));
});

test("runPatternReinforcement: idempotent re-run does not double-bump reinforcement_count", async () => {
  const dupContent = "Same content, repeated";
  const memories = [
    makeMemory({ id: "m-a", content: dupContent, updated: "2026-01-01T00:00:00Z" }),
    makeMemory({ id: "m-b", content: dupContent, updated: "2026-02-01T00:00:00Z" }),
    makeMemory({ id: "m-c", content: dupContent, updated: "2026-03-01T00:00:00Z" }),
  ];
  const { stub, writes } = makeStorageStub(memories);

  const first = await runPatternReinforcement(stub, {
    categories: ["preference"],
    minCount: 3,
    now: frozenNow,
  });
  assert.equal(first.canonicalsUpdated, 1);
  assert.equal(first.duplicatesSuperseded, 2);
  assert.equal(first.clusters[0]?.reinforcementBumped, true);

  // Second run on the same corpus.  After the first run, the older
  // members are `superseded` — but the cluster STILL counts them
  // toward the threshold (Codex P1 fix), so the cluster is found
  // again with size 3 and no new active duplicates remain.  Because
  // `reinforcement_count` is already 3, the bump-only-on-change
  // guard keeps the run a no-op write-wise.
  const writesBefore = writes.length;
  const second = await runPatternReinforcement(stub, {
    categories: ["preference"],
    minCount: 3,
    now: frozenNow,
  });
  assert.equal(second.clustersFound, 1);
  assert.equal(second.canonicalsUpdated, 0);
  assert.equal(second.duplicatesSuperseded, 0);
  assert.equal(second.clusters[0]?.reinforcementBumped, false);
  // No additional writes.
  assert.equal(writes.length, writesBefore);
});

test("runPatternReinforcement: established canonical grows when a single new duplicate arrives (Codex P1)", async () => {
  // Models the exact post-first-run scenario the Codex review flagged:
  // canonical + 2 already-superseded members + 1 brand-new active
  // duplicate.  The new duplicate must be absorbed and the count
  // bumped to 4, even though the active sub-cluster size is only 2.
  const dupContent = "established pattern";
  const memories = [
    makeMemory({
      id: "m-old1",
      content: dupContent,
      updated: "2026-01-01T00:00:00Z",
      status: "superseded",
      supersededBy: "m-canon",
    }),
    makeMemory({
      id: "m-old2",
      content: dupContent,
      updated: "2026-02-01T00:00:00Z",
      status: "superseded",
      supersededBy: "m-canon",
    }),
    makeMemory({
      id: "m-canon",
      content: dupContent,
      updated: "2026-03-01T00:00:00Z",
      reinforcement_count: 3,
      last_reinforced_at: "2026-03-01T00:00:00.000Z",
      derived_via: "pattern-reinforcement",
      derived_from: ["m-canon", "m-old1", "m-old2"],
    }),
    // A brand-new active duplicate from a later session.
    makeMemory({
      id: "m-new",
      content: dupContent,
      updated: "2026-04-15T00:00:00Z",
    }),
  ];
  const { stub, writes } = makeStorageStub(memories);

  const result = await runPatternReinforcement(stub, {
    categories: ["preference"],
    minCount: 3,
    now: frozenNow,
  });

  assert.equal(result.clustersFound, 1);
  assert.equal(result.canonicalsUpdated, 1);
  assert.equal(result.duplicatesSuperseded, 1);
  assert.equal(result.clusters[0]?.count, 4);
  assert.equal(result.clusters[0]?.reinforcementBumped, true);
  // The most-recent active member becomes the new canonical.
  assert.equal(result.clusters[0]?.canonicalId, "m-new");
  // Source-ids include every member of the historical cluster.
  assert.deepEqual(
    result.clusters[0]?.sourceIds.slice().sort(),
    ["m-canon", "m-new", "m-old1", "m-old2"],
  );
  // The new active member was patched as canonical with count=4.
  const canonicalWrite = writes.find((w) => w.memoryId === "m-new");
  assert.ok(canonicalWrite);
  assert.equal(canonicalWrite!.patch.reinforcement_count, 4);
  // The previous canonical (still active before the run) was
  // superseded.
  const oldCanonWrite = writes.find((w) => w.memoryId === "m-canon");
  assert.ok(oldCanonWrite);
  assert.equal(oldCanonWrite!.patch.status, "superseded");
  assert.equal(oldCanonWrite!.patch.supersededBy, "m-new");
});

test("runPatternReinforcement: re-run with existing reinforcement_count does not bump when count unchanged", async () => {
  // Simulate a corpus where the canonical was previously reinforced
  // at count=3 and a later run sees the same cluster of 3 active
  // memories. (Edge case: status filter would normally have shrunk
  // the active set to 1, but if upstream policy un-supersedes some,
  // the bump-only-on-change guard still holds.)
  const dupContent = "stable cluster";
  const memories = [
    makeMemory({
      id: "m-x",
      content: dupContent,
      updated: "2026-01-01T00:00:00Z",
    }),
    makeMemory({
      id: "m-y",
      content: dupContent,
      updated: "2026-02-01T00:00:00Z",
    }),
    makeMemory({
      id: "m-z",
      content: dupContent,
      updated: "2026-03-01T00:00:00Z",
      reinforcement_count: 3,
      last_reinforced_at: "2026-03-01T00:00:00.000Z",
      derived_via: "pattern-reinforcement",
      derived_from: ["m-x", "m-y", "m-z"],
    }),
  ];
  const { stub, writes } = makeStorageStub(memories);

  const result = await runPatternReinforcement(stub, {
    categories: ["preference"],
    minCount: 3,
    now: frozenNow,
  });

  assert.equal(result.clustersFound, 1);
  // Reinforcement count is identical (3), so we MUST NOT bump.
  assert.equal(result.canonicalsUpdated, 0);
  assert.equal(result.clusters[0]?.reinforcementBumped, false);
  // No write to the canonical for reinforcement; supersede writes
  // for the older two ARE expected since they were still active.
  const canonicalWrites = writes.filter((w) => w.memoryId === "m-z");
  assert.equal(canonicalWrites.length, 0);
});

test("runPatternReinforcement: respects minCount threshold", async () => {
  const dupContent = "pair of duplicates";
  const memories = [
    makeMemory({ id: "m-1", content: dupContent, updated: "2026-01-01T00:00:00Z" }),
    makeMemory({ id: "m-2", content: dupContent, updated: "2026-02-01T00:00:00Z" }),
  ];
  const { stub, writes } = makeStorageStub(memories);

  const result = await runPatternReinforcement(stub, {
    categories: ["preference"],
    minCount: 3,
    now: frozenNow,
  });

  assert.equal(result.clustersFound, 0);
  assert.equal(writes.length, 0);
});

test("runPatternReinforcement: skips out-of-scope categories", async () => {
  const dupContent = "procedural duplicate";
  const memories = [
    makeMemory({ id: "p-1", category: "procedure" as MemoryFrontmatter["category"], content: dupContent, updated: "2026-01-01T00:00:00Z" }),
    makeMemory({ id: "p-2", category: "procedure" as MemoryFrontmatter["category"], content: dupContent, updated: "2026-02-01T00:00:00Z" }),
    makeMemory({ id: "p-3", category: "procedure" as MemoryFrontmatter["category"], content: dupContent, updated: "2026-03-01T00:00:00Z" }),
  ];
  const { stub, writes } = makeStorageStub(memories);

  const result = await runPatternReinforcement(stub, {
    categories: ["preference", "fact", "decision"],
    minCount: 3,
    now: frozenNow,
  });

  assert.equal(result.clustersFound, 0);
  assert.equal(writes.length, 0);
});

test("runPatternReinforcement: excludes support-passport private records", async () => {
  const content = "Give me advance notice before plans change.";
  const passport = makeMemory({
    id: "passport-card",
    content,
    tags: ["support-passport-card"],
  });
  const publicPreference = makeMemory({ id: "public-preference", content });
  const { stub, writes } = makeStorageStub([passport, publicPreference]);

  const result = await runPatternReinforcement(stub, {
    categories: ["preference"],
    minCount: 2,
    now: frozenNow,
  });

  assert.equal(result.clustersFound, 0);
  assert.deepEqual(writes, []);
});

test("runPatternReinforcement: counts both active and already-superseded members; only writes to active duplicates", async () => {
  const dupContent = "mixed status cluster";
  const memories = [
    makeMemory({
      id: "m-old1",
      content: dupContent,
      updated: "2026-01-01T00:00:00Z",
      status: "superseded",
      supersededBy: "m-prior",
    }),
    makeMemory({
      id: "m-old2",
      content: dupContent,
      updated: "2026-02-01T00:00:00Z",
      status: "superseded",
      supersededBy: "m-prior",
    }),
    makeMemory({
      id: "m-new1",
      content: dupContent,
      updated: "2026-03-01T00:00:00Z",
    }),
    makeMemory({
      id: "m-new2",
      content: dupContent,
      updated: "2026-04-01T00:00:00Z",
    }),
    makeMemory({
      id: "m-new3",
      content: dupContent,
      updated: "2026-04-15T00:00:00Z",
    }),
  ];
  const { stub, writes } = makeStorageStub(memories);

  const result = await runPatternReinforcement(stub, {
    categories: ["preference"],
    minCount: 3,
    now: frozenNow,
  });

  // All 5 cluster members count toward the threshold (Codex P1).
  assert.equal(result.clustersFound, 1);
  assert.equal(result.clusters[0]?.canonicalId, "m-new3");
  assert.equal(result.clusters[0]?.count, 5);
  // sourceIds includes every member, active and superseded.
  assert.deepEqual(result.clusters[0]?.sourceIds.slice().sort(), [
    "m-new1",
    "m-new2",
    "m-new3",
    "m-old1",
    "m-old2",
  ]);
  // Only the active duplicates were newly superseded — pre-existing
  // superseded memories are not re-touched.
  assert.deepEqual(
    result.clusters[0]?.supersededIds.slice().sort(),
    ["m-new1", "m-new2"],
  );
  // Already-superseded memories are NOT written to.
  assert.ok(!writes.some((w) => w.memoryId === "m-old1"));
  assert.ok(!writes.some((w) => w.memoryId === "m-old2"));
});

test("runPatternReinforcement: empty categories short-circuits with no work", async () => {
  const memories = [
    makeMemory({ id: "m-1", content: "anything", updated: "2026-01-01T00:00:00Z" }),
    makeMemory({ id: "m-2", content: "anything", updated: "2026-02-01T00:00:00Z" }),
    makeMemory({ id: "m-3", content: "anything", updated: "2026-03-01T00:00:00Z" }),
  ];
  const { stub, writes } = makeStorageStub(memories);

  const result = await runPatternReinforcement(stub, {
    categories: [],
    minCount: 3,
    now: frozenNow,
  });
  assert.equal(result.clustersFound, 0);
  assert.equal(writes.length, 0);
});

test("frontmatter round-trip preserves reinforcement_count + last_reinforced_at + derived_via=pattern-reinforcement", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-pr-roundtrip-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const { id: written } = await storage.writeMemory(
      "fact",
      "Pattern-reinforcement round-trip body",
      { confidence: 0.9, tags: ["test"] },
    );
    assert.ok(written, "writeMemory must succeed");
    const id = written!;

    const all1 = await storage.readAllMemories();
    const target = all1.find((m) => m.frontmatter.id === id);
    assert.ok(target, "freshly-written memory must be visible");

    const ok = await storage.writeMemoryFrontmatter(target!, {
      reinforcement_count: 5,
      last_reinforced_at: "2026-04-25T12:00:00.000Z",
      derived_from: ["m-a", "m-b", "m-c", "m-d", "m-e"],
      derived_via: "pattern-reinforcement",
    });
    assert.ok(ok);

    // Force a fresh read off disk.
    storage.invalidateAllMemoriesCacheForDir();
    const all2 = await storage.readAllMemories();
    const reread = all2.find((m) => m.frontmatter.id === id);
    assert.ok(reread, "memory must still be readable after patch");
    assert.equal(reread!.frontmatter.reinforcement_count, 5);
    assert.equal(reread!.frontmatter.last_reinforced_at, "2026-04-25T12:00:00.000Z");
    assert.equal(reread!.frontmatter.derived_via, "pattern-reinforcement");
    assert.deepEqual(
      reread!.frontmatter.derived_from,
      ["m-a", "m-b", "m-c", "m-d", "m-e"],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("storage rejects non-positive or non-integer reinforcement_count on write", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-pr-validate-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const { id: id } = await storage.writeMemory("fact", "Body for validation test.", {
      confidence: 0.9,
      tags: [],
    });
    assert.ok(id);

    await assert.rejects(
      () => storage.updateMemoryFrontmatter(id!, { reinforcement_count: 0 }),
      /reinforcement_count/,
    );
    await assert.rejects(
      () => storage.updateMemoryFrontmatter(id!, { reinforcement_count: -1 }),
      /reinforcement_count/,
    );
    await assert.rejects(
      () => storage.updateMemoryFrontmatter(id!, { reinforcement_count: 1.5 }),
      /reinforcement_count/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ─── PR #730 Codex P2: instant-based timestamp comparison ────────────────────

test("runPatternReinforcement: pickCanonical compares timestamps as instants, not strings", async () => {
  // The newer memory (in real time) uses a `+02:00` offset that is
  // lexicographically smaller than the older memory's `Z` suffix.  A
  // string-compare would mis-pick the older entry as canonical.
  // Both refer to the same instant viewed from different offsets:
  //   newer:  2026-04-26T12:00:00+02:00  → 2026-04-26T10:00:00Z
  //   older:  2026-04-26T09:00:00Z       → 2026-04-26T09:00:00Z
  // So the `+02:00`-tagged memory IS newer in instant space.
  const dupContent = "Pattern reinforcement timestamp test.";
  const memories = [
    makeMemory({
      id: "m-older-z",
      content: dupContent,
      created: "2026-04-26T09:00:00Z",
      updated: "2026-04-26T09:00:00Z",
    }),
    makeMemory({
      id: "m-newer-offset",
      content: dupContent,
      created: "2026-04-26T12:00:00+02:00",
      updated: "2026-04-26T12:00:00+02:00",
    }),
  ];
  const { stub, writes } = makeStorageStub(memories);

  const result = await runPatternReinforcement(stub, {
    categories: ["preference"],
    minCount: 2,
    now: frozenNow,
  });

  assert.equal(result.clustersFound, 1);
  assert.equal(result.clusters[0].canonicalId, "m-newer-offset");
  // The OLDER (Z-suffix) memory must be the one superseded.
  assert.deepEqual(result.clusters[0].supersededIds, ["m-older-z"]);
  // The supersede write targets the older memory.
  const supersedeWrite = writes.find((w) => w.patch.status === "superseded");
  assert.ok(supersedeWrite);
  assert.equal(supersedeWrite.memoryId, "m-older-z");
});

// ─── PR #730 Codex P2: cluster keys partition by category ────────────────────

test("runPatternReinforcement: identical text in different categories is NOT cross-superseded", async () => {
  // Same text in both `preference` and `decision`.  Without category
  // partitioning the two would collide into one cluster of size 2 and
  // one of them would be superseded — silently erasing a category-
  // specific memory.
  const text = "Strict no-bundle policy for optional packages.";
  const memories = [
    makeMemory({
      id: "m-pref-1",
      category: "preference",
      content: text,
      created: "2026-04-25T10:00:00Z",
      updated: "2026-04-25T10:00:00Z",
    }),
    makeMemory({
      id: "m-pref-2",
      category: "preference",
      content: text,
      created: "2026-04-26T10:00:00Z",
      updated: "2026-04-26T10:00:00Z",
    }),
    makeMemory({
      id: "m-decision",
      category: "decision",
      content: text,
      created: "2026-04-26T11:00:00Z",
      updated: "2026-04-26T11:00:00Z",
    }),
  ];
  const { stub, writes } = makeStorageStub(memories);

  const result = await runPatternReinforcement(stub, {
    categories: ["preference", "decision"],
    minCount: 2,
    now: frozenNow,
  });

  // Only the preference cluster (2 members) qualifies — the decision
  // entry is alone in its category bucket.
  assert.equal(result.clustersFound, 1);
  assert.equal(result.clusters[0].canonicalId, "m-pref-2");
  assert.deepEqual(result.clusters[0].supersededIds, ["m-pref-1"]);
  // Crucially: the decision-category memory was NOT touched.
  const decisionWrites = writes.filter((w) => w.memoryId === "m-decision");
  assert.equal(
    decisionWrites.length,
    0,
    `decision-category memory must not be touched; got ${JSON.stringify(decisionWrites)}`,
  );
});

// ─── PR #730 Codex P2: timestamp comparison handles mixed precision/format ────

test("runPatternReinforcement: pickCanonical compares ms-precision against second-precision correctly", async () => {
  // Same-instant memories with different ISO precision: a pure
  // string-compare would order `2026-04-26T10:00:00Z` BEFORE
  // `2026-04-26T10:00:00.000Z` (shorter sort first), but both encode
  // the same instant.  The newer timestamp must still win.
  const dupContent = "Mixed precision timestamps.";
  const memories = [
    makeMemory({
      id: "m-second-precision",
      content: dupContent,
      created: "2026-04-25T09:00:00Z",
      updated: "2026-04-25T09:00:00Z",
    }),
    makeMemory({
      id: "m-ms-precision",
      content: dupContent,
      created: "2026-04-26T09:00:00.500Z",
      updated: "2026-04-26T09:00:00.500Z",
    }),
  ];
  const { stub } = makeStorageStub(memories);

  const result = await runPatternReinforcement(stub, {
    categories: ["preference"],
    minCount: 2,
    now: frozenNow,
  });

  assert.equal(result.clustersFound, 1);
  // The ms-precision memory is genuinely newer (next day); confirm
  // instant comparison preserves that across precision differences.
  assert.equal(result.clusters[0].canonicalId, "m-ms-precision");
});

// ─── PR #730 Codex P2: refresh canonical when membership changes ─────────────

test("runPatternReinforcement: refreshes canonical provenance when cluster membership rotates (Codex P2)", async () => {
  // Models a stable canonical whose provenance was set with one
  // member set, then a different member set arrives in a later run
  // (same total size, different identities).  The canonical's
  // `derived_from` must be refreshed even though
  // `reinforcement_count` is unchanged — otherwise the on-disk
  // provenance silently drifts away from the actual contributors.
  const dupContent = "membership rotation";
  const memories = [
    // Canonical sits at count=3 with stale provenance pointing at
    // members that no longer all exist (m-stale was archived
    // out-of-band; we simulate that by omitting it from the corpus).
    // The canonical remains the most-recent active member.
    makeMemory({
      id: "m-canon",
      content: dupContent,
      updated: "2026-05-01T00:00:00Z",
      reinforcement_count: 3,
      last_reinforced_at: "2026-03-01T00:00:00.000Z",
      derived_via: "pattern-reinforcement",
      derived_from: ["m-canon", "m-stale", "m-old-superseded"],
    }),
    // A still-active older duplicate that was always part of the
    // cluster but never made canonical.
    makeMemory({
      id: "m-old-superseded",
      content: dupContent,
      updated: "2026-02-01T00:00:00Z",
      status: "superseded",
      supersededBy: "m-canon",
    }),
    // A new active duplicate from a later session, but still older
    // than the canonical so the canonical does NOT pivot.
    makeMemory({
      id: "m-new-active",
      content: dupContent,
      updated: "2026-04-15T00:00:00Z",
    }),
  ];
  const { stub, writes } = makeStorageStub(memories);

  const result = await runPatternReinforcement(stub, {
    categories: ["preference"],
    minCount: 3,
    now: frozenNow,
  });

  assert.equal(result.clustersFound, 1);
  // Cluster size unchanged (3) but membership differs.
  assert.equal(result.clusters[0]?.count, 3);
  // The reinforcement counter did NOT bump (still 3) — the canonical
  // was refreshed purely because membership changed.
  assert.equal(result.clusters[0]?.reinforcementBumped, false);
  assert.equal(result.canonicalsUpdated, 1);
  // Canonical did NOT pivot — m-canon is still the most-recent
  // active member.
  assert.equal(result.clusters[0]?.canonicalId, "m-canon");
  // The freshly-written canonical's `derived_from` reflects the
  // current cluster membership only — no stale ID.
  const canonicalWrite = writes.find(
    (w) => w.memoryId === "m-canon" && w.patch.derived_via === "pattern-reinforcement",
  );
  assert.ok(
    canonicalWrite,
    "canonical must be patched even when reinforcement_count is unchanged",
  );
  assert.deepEqual(
    [...(canonicalWrite!.patch.derived_from ?? [])].sort(),
    ["m-canon", "m-new-active", "m-old-superseded"],
  );
  // On a provenance-only refresh (count unchanged), `last_reinforced_at`
  // is preserved from the existing value — it must NOT be re-stamped to
  // the current run time, keeping the field monotonic (PR #730, Codex P2).
  assert.equal(canonicalWrite!.patch.last_reinforced_at, "2026-03-01T00:00:00.000Z");
  // Similarly, `reinforcement_count` is carried forward unchanged.
  assert.equal(canonicalWrite!.patch.reinforcement_count, 3);
});

test("runPatternReinforcement: canonical growth still refreshes provenance and bumps count", async () => {
  // Existing canonical at count=3 with provenance.  Two new
  // duplicates arrive.  Cluster size grows to 5; provenance must
  // expand to include them.
  const dupContent = "growing cluster";
  const memories = [
    makeMemory({
      id: "m-old1",
      content: dupContent,
      updated: "2026-01-01T00:00:00Z",
      status: "superseded",
      supersededBy: "m-canon",
    }),
    makeMemory({
      id: "m-old2",
      content: dupContent,
      updated: "2026-02-01T00:00:00Z",
      status: "superseded",
      supersededBy: "m-canon",
    }),
    makeMemory({
      id: "m-canon",
      content: dupContent,
      updated: "2026-03-01T00:00:00Z",
      reinforcement_count: 3,
      last_reinforced_at: "2026-03-01T00:00:00.000Z",
      derived_via: "pattern-reinforcement",
      derived_from: ["m-canon", "m-old1", "m-old2"],
    }),
    makeMemory({
      id: "m-new1",
      content: dupContent,
      updated: "2026-04-10T00:00:00Z",
    }),
    makeMemory({
      id: "m-new2",
      content: dupContent,
      updated: "2026-04-20T00:00:00Z",
    }),
  ];
  const { stub, writes } = makeStorageStub(memories);

  const result = await runPatternReinforcement(stub, {
    categories: ["preference"],
    minCount: 3,
    now: frozenNow,
  });
  assert.equal(result.clusters[0]?.count, 5);
  assert.equal(result.clusters[0]?.reinforcementBumped, true);
  const canonicalWrite = writes.find(
    (w) => w.memoryId === "m-new2" && w.patch.derived_via === "pattern-reinforcement",
  );
  assert.ok(canonicalWrite);
  assert.equal(canonicalWrite!.patch.reinforcement_count, 5);
  assert.deepEqual(
    [...(canonicalWrite!.patch.derived_from ?? [])].sort(),
    ["m-canon", "m-new1", "m-new2", "m-old1", "m-old2"],
  );
});

// ─── PR #730 thread fixes ─────────────────────────────────────────────────────

test("runPatternReinforcement: cluster count metric matches filtered sourceIds length (PR #730 Thread 1)", async () => {
  // When some cluster members lack a valid string ID (e.g. id is undefined
  // or empty), the raw `cluster.length` diverges from `sourceIds.length`.
  // The telemetry `count` field and `reinforcement_count` on disk must both
  // reflect the filtered valid-ID set — not the unfiltered cluster array.
  const dupContent = "cluster count alignment test";
  const memories = [
    makeMemory({ id: "m-1", content: dupContent, updated: "2026-01-01T00:00:00Z" }),
    makeMemory({ id: "m-2", content: dupContent, updated: "2026-02-01T00:00:00Z" }),
    makeMemory({ id: "m-3", content: dupContent, updated: "2026-03-01T00:00:00Z" }),
    // A member whose ID is explicitly undefined — it must still be eligible
    // (has valid category/status) but must NOT appear in sourceIds.
    {
      path: "/tmp/mem/no-id.md",
      content: dupContent,
      frontmatter: {
        id: undefined as unknown as string,
        category: "preference" as MemoryFrontmatter["category"],
        created: "2026-04-01T00:00:00Z",
        updated: "2026-04-01T00:00:00Z",
        source: "test",
        confidence: 0.9,
        confidenceTier: "high" as MemoryFrontmatter["confidenceTier"],
        tags: [],
      } as MemoryFrontmatter,
    } as MemoryFile,
  ];
  const { stub } = makeStorageStub(memories);

  const result = await runPatternReinforcement(stub, {
    categories: ["preference"],
    minCount: 3,
    now: frozenNow,
  });

  assert.equal(result.clustersFound, 1);
  const cluster = result.clusters[0];
  assert.ok(cluster);
  // sourceIds excludes the id-less member — only 3 valid IDs.
  assert.deepEqual(cluster.sourceIds.slice().sort(), ["m-1", "m-2", "m-3"]);
  // count must align with sourceIds.length, NOT the raw cluster array
  // length (which would be 4).
  assert.equal(cluster.count, cluster.sourceIds.length);
  assert.equal(cluster.count, 3);
});

test("runPatternReinforcement: provenance-only refresh preserves reinforcement_count + last_reinforced_at (PR #730 Thread 2)", async () => {
  // Models the scenario where cluster membership rotates (one member
  // archived externally, a new duplicate arrived) but the total count
  // stays the same.  On this provenance-only refresh the canonical's
  // `reinforcement_count` and `last_reinforced_at` must be carried
  // forward unchanged — only `derived_from` (and `derived_via`) should
  // be updated.  Previously the code wrote `last_reinforced_at: nowIso`
  // unconditionally, resetting the field on every provenance refresh
  // (PR #730 review, Codex P2).
  const dupContent = "provenance monotonic test";
  const EXISTING_REINFORCED_AT = "2026-01-15T08:00:00.000Z";
  const EXISTING_COUNT = 3;
  const memories = [
    makeMemory({
      id: "m-canon",
      content: dupContent,
      updated: "2026-04-01T00:00:00Z",
      reinforcement_count: EXISTING_COUNT,
      last_reinforced_at: EXISTING_REINFORCED_AT,
      derived_via: "pattern-reinforcement",
      // Stale provenance: includes m-gone (no longer in corpus).
      derived_from: ["m-canon", "m-gone", "m-old"],
    }),
    // m-gone has been archived out-of-band — omitted from corpus.
    makeMemory({
      id: "m-old",
      content: dupContent,
      updated: "2026-02-01T00:00:00Z",
      status: "superseded",
      supersededBy: "m-canon",
    }),
    // m-new arrived in this run — same total cluster size (3), different
    // membership.
    makeMemory({
      id: "m-new",
      content: dupContent,
      updated: "2026-03-10T00:00:00Z",
    }),
  ];
  const { stub, writes } = makeStorageStub(memories);

  const result = await runPatternReinforcement(stub, {
    categories: ["preference"],
    minCount: 3,
    now: frozenNow,
  });

  assert.equal(result.clustersFound, 1);
  assert.equal(result.canonicalsUpdated, 1);
  // Count unchanged — bumped must be false.
  assert.equal(result.clusters[0]?.reinforcementBumped, false);

  const canonicalWrite = writes.find((w) => w.memoryId === "m-canon");
  assert.ok(canonicalWrite, "canonical must be patched for membership change");

  // The provenance fields must be updated to reflect the new membership.
  assert.deepEqual(
    [...(canonicalWrite!.patch.derived_from ?? [])].sort(),
    ["m-canon", "m-new", "m-old"],
  );

  // CRITICAL: `reinforcement_count` and `last_reinforced_at` must be
  // preserved from the existing values — not reset to nowIso / newCount.
  assert.equal(
    canonicalWrite!.patch.reinforcement_count,
    EXISTING_COUNT,
    "reinforcement_count must not change on provenance-only refresh",
  );
  assert.equal(
    canonicalWrite!.patch.last_reinforced_at,
    EXISTING_REINFORCED_AT,
    "last_reinforced_at must not be re-stamped on provenance-only refresh",
  );
});
