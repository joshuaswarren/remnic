
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
  assert.equal(cluster.canonicalId, "m-5");
  assert.equal(cluster.count, 5);
  assert.deepEqual(cluster.sourceIds, ["m-1", "m-2", "m-3", "m-4", "m-5"]);
  assert.deepEqual(cluster.supersededIds.slice().sort(), ["m-1", "m-2", "m-3", "m-4"]);

  const canonicalWrite = writes.find((w) => w.memoryId === "m-5");
  assert.ok(canonicalWrite);
  assert.equal(canonicalWrite!.patch.reinforcement_count, 5);
  assert.equal(canonicalWrite!.patch.last_reinforced_at, FROZEN_NOW.toISOString());
  assert.equal(canonicalWrite!.patch.derived_via, "pattern-reinforcement");
  assert.deepEqual(canonicalWrite!.patch.derived_from, ["m-1", "m-2", "m-3", "m-4", "m-5"]);

  for (const id of ["m-1", "m-2", "m-3", "m-4"]) {
    const w = writes.find((w) => w.memoryId === id);
    assert.ok(w, `expected supersede write for ${id}`);
    assert.equal(w!.patch.status, "superseded");
    assert.equal(w!.patch.supersededBy, "m-5");
    assert.equal(w!.patch.supersededAt, FROZEN_NOW.toISOString());
  }

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
  assert.equal(writes.length, writesBefore);
});

test("runPatternReinforcement: established canonical grows when a single new duplicate arrives (Codex P1)", async () => {
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
  assert.equal(result.clusters[0]?.canonicalId, "m-new");
  assert.deepEqual(
    result.clusters[0]?.sourceIds.slice().sort(),
    ["m-canon", "m-new", "m-old1", "m-old2"],
  );
  const canonicalWrite = writes.find((w) => w.memoryId === "m-new");
  assert.ok(canonicalWrite);
  assert.equal(canonicalWrite!.patch.reinforcement_count, 4);
  const oldCanonWrite = writes.find((w) => w.memoryId === "m-canon");
  assert.ok(oldCanonWrite);
  assert.equal(oldCanonWrite!.patch.status, "superseded");
  assert.equal(oldCanonWrite!.patch.supersededBy, "m-new");
});

test("runPatternReinforcement: re-run with existing reinforcement_count does not bump when count unchanged", async () => {
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
  assert.equal(result.canonicalsUpdated, 0);
  assert.equal(result.clusters[0]?.reinforcementBumped, false);
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

  assert.equal(result.clustersFound, 1);
  assert.equal(result.clusters[0]?.canonicalId, "m-new3");
  assert.equal(result.clusters[0]?.count, 5);
  assert.deepEqual(result.clusters[0]?.sourceIds.slice().sort(), [
    "m-new1",
    "m-new2",
    "m-new3",
    "m-old1",
    "m-old2",
  ]);
  assert.deepEqual(
    result.clusters[0]?.supersededIds.slice().sort(),
    ["m-new1", "m-new2"],
  );
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


test("runPatternReinforcement: pickCanonical compares timestamps as instants, not strings", async () => {
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
  assert.deepEqual(result.clusters[0].supersededIds, ["m-older-z"]);
  const supersedeWrite = writes.find((w) => w.patch.status === "superseded");
  assert.ok(supersedeWrite);
  assert.equal(supersedeWrite.memoryId, "m-older-z");
});


test("runPatternReinforcement: identical text in different categories is NOT cross-superseded", async () => {
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

  assert.equal(result.clustersFound, 1);
  assert.equal(result.clusters[0].canonicalId, "m-pref-2");
  assert.deepEqual(result.clusters[0].supersededIds, ["m-pref-1"]);
  const decisionWrites = writes.filter((w) => w.memoryId === "m-decision");
  assert.equal(
    decisionWrites.length,
    0,
    `decision-category memory must not be touched; got ${JSON.stringify(decisionWrites)}`,
  );
});


test("runPatternReinforcement: pickCanonical compares ms-precision against second-precision correctly", async () => {
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
  assert.equal(result.clusters[0].canonicalId, "m-ms-precision");
});


test("runPatternReinforcement: refreshes canonical provenance when cluster membership rotates (Codex P2)", async () => {
  const dupContent = "membership rotation";
  const memories = [
    makeMemory({
      id: "m-canon",
      content: dupContent,
      updated: "2026-05-01T00:00:00Z",
      reinforcement_count: 3,
      last_reinforced_at: "2026-03-01T00:00:00.000Z",
      derived_via: "pattern-reinforcement",
      derived_from: ["m-canon", "m-stale", "m-old-superseded"],
    }),
    makeMemory({
      id: "m-old-superseded",
      content: dupContent,
      updated: "2026-02-01T00:00:00Z",
      status: "superseded",
      supersededBy: "m-canon",
    }),
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
  assert.equal(result.clusters[0]?.count, 3);
  assert.equal(result.clusters[0]?.reinforcementBumped, false);
  assert.equal(result.canonicalsUpdated, 1);
  assert.equal(result.clusters[0]?.canonicalId, "m-canon");
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
  assert.equal(canonicalWrite!.patch.last_reinforced_at, "2026-03-01T00:00:00.000Z");
  assert.equal(canonicalWrite!.patch.reinforcement_count, 3);
});

test("runPatternReinforcement: canonical growth still refreshes provenance and bumps count", async () => {
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


test("runPatternReinforcement: cluster count metric matches filtered sourceIds length (PR #730 Thread 1)", async () => {
  const dupContent = "cluster count alignment test";
  const memories = [
    makeMemory({ id: "m-1", content: dupContent, updated: "2026-01-01T00:00:00Z" }),
    makeMemory({ id: "m-2", content: dupContent, updated: "2026-02-01T00:00:00Z" }),
    makeMemory({ id: "m-3", content: dupContent, updated: "2026-03-01T00:00:00Z" }),
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
  assert.deepEqual(cluster.sourceIds.slice().sort(), ["m-1", "m-2", "m-3"]);
  assert.equal(cluster.count, cluster.sourceIds.length);
  assert.equal(cluster.count, 3);
});

test("runPatternReinforcement: provenance-only refresh preserves reinforcement_count + last_reinforced_at (PR #730 Thread 2)", async () => {
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
      derived_from: ["m-canon", "m-gone", "m-old"],
    }),
    makeMemory({
      id: "m-old",
      content: dupContent,
      updated: "2026-02-01T00:00:00Z",
      status: "superseded",
      supersededBy: "m-canon",
    }),
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
  assert.equal(result.clusters[0]?.reinforcementBumped, false);

  const canonicalWrite = writes.find((w) => w.memoryId === "m-canon");
  assert.ok(canonicalWrite, "canonical must be patched for membership change");

  assert.deepEqual(
    [...(canonicalWrite!.patch.derived_from ?? [])].sort(),
    ["m-canon", "m-new", "m-old"],
  );

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
