/**
 * Write-path tests for consolidation provenance (issue #561 PR 2).
 *
 * PR 1 added read/write round-trip for `derived_from` and `derived_via` on
 * memory frontmatter.  PR 2 wires the fields into the `writeMemory()`
 * options surface and adds the `snapshotForProvenance()` helper that
 * captures a page-version of a source memory and returns a matching
 * `"<relative-path>:<versionId>"` entry.
 *
 * These tests cover the storage-level contract directly so the PR-2 wiring
 * can be validated without spinning up the full orchestrator.  The
 * orchestrator-level call site is exercised structurally in
 * `orchestrator-consolidation-provenance-wiring.test.ts`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { StorageManager } from "@remnic/core/storage";
import type { VersioningConfig } from "@remnic/core";

function versioningConfig(): VersioningConfig {
  return { enabled: true, maxVersionsPerPage: 10, sidecarDir: ".versions" };
}

test("writeMemory persists derivedFrom + derivedVia through to frontmatter", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-derived-write-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const { id: id } = await storage.writeMemory("fact", "consolidated payload", {
      source: "semantic-consolidation",
      derivedFrom: ["facts/a.md:2", "facts/b.md:5"],
      derivedVia: "merge",
    });

    const all = await storage.readAllMemories();
    const memory = all.find((m) => m.frontmatter.id === id);
    assert.ok(memory, "memory should be readable");
    assert.deepEqual(memory.frontmatter.derived_from, [
      "facts/a.md:2",
      "facts/b.md:5",
    ]);
    assert.equal(memory.frontmatter.derived_via, "merge");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeMemory omits derived_from when the array is empty", async () => {
  // Empty `derivedFrom` arrays must not serialize as `derived_from: []`
  // because that would be rejected by the validator on subsequent reads.
  // PR 2 coerces the empty case back to undefined.
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-derived-empty-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const { id: id } = await storage.writeMemory("fact", "payload without sources", {
      source: "extraction",
      derivedFrom: [],
    });

    const all = await storage.readAllMemories();
    const memory = all.find((m) => m.frontmatter.id === id);
    assert.ok(memory);
    assert.equal(memory.frontmatter.derived_from, undefined);
    assert.equal(memory.frontmatter.derived_via, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeMemory emits derived_via alone when page-versioning is unavailable", async () => {
  // Review feedback (PR #624 codex): `derived_via` must stand alone so
  // downstream logic can still identify consolidation outputs by operator
  // even when page-versioning is disabled and no `derived_from` entries
  // could be captured.  The storage layer intentionally does NOT enforce
  // a `derived_via requires derived_from` invariant.
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-derived-orphan-via-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const { id: id } = await storage.writeMemory("fact", "orphan consolidation output", {
      source: "semantic-consolidation",
      derivedVia: "merge",
      // deliberately omit derivedFrom to simulate versioning-disabled case
    });

    const all = await storage.readAllMemories();
    const memory = all.find((m) => m.frontmatter.id === id);
    assert.ok(memory);
    assert.equal(memory.frontmatter.derived_from, undefined);
    assert.equal(memory.frontmatter.derived_via, "merge");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeMemory accepts all three ConsolidationOperator values via derivedVia", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-derived-ops-write-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const operators: Array<"split" | "merge" | "update"> = ["split", "merge", "update"];
    const writtenIds: Record<string, string> = {};
    for (const op of operators) {
      const { id: id } = await storage.writeMemory("fact", `${op} payload`, {
        source: "semantic-consolidation",
        derivedFrom: [`facts/source-${op}.md:1`],
        derivedVia: op,
      });
      writtenIds[op] = id;
    }

    const all = await storage.readAllMemories();
    for (const op of operators) {
      const memory = all.find((m) => m.frontmatter.id === writtenIds[op]);
      assert.ok(memory, `memory for operator ${op} should load`);
      assert.equal(memory.frontmatter.derived_via, op);
      assert.deepEqual(memory.frontmatter.derived_from, [`facts/source-${op}.md:1`]);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("snapshotForProvenance captures a version and returns a valid derived_from entry", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-provenance-snapshot-"));
  try {
    const storage = new StorageManager(dir);
    storage.setVersioningConfig(versioningConfig());
    await storage.ensureDirectories();

    // Write a source memory.  The first write snapshots any existing
    // content (none yet) so the file itself starts un-versioned; the
    // snapshot below creates version 1.
    const { id: sourceId } = await storage.writeMemory("fact", "source body", {
      source: "extraction",
    });
    const all = await storage.readAllMemories();
    const source = all.find((m) => m.frontmatter.id === sourceId);
    assert.ok(source);

    const entry = await storage.snapshotForProvenance(source.path);
    assert.ok(entry, "snapshot entry should be returned when versioning is enabled");
    // Entry must match the derived_from format: "<relpath>:<version>"
    assert.match(entry, /^facts\/.+\.md:\d+$/u);

    // The snapshot file must exist on disk at the sidecar path.
    const [rel, version] = entry.split(":");
    const relWithoutExt = rel.replace(/\.md$/, "");
    const sidecarFile = path.join(
      dir,
      ".versions",
      relWithoutExt.replace(/\//g, "__"),
      `${version}.md`,
    );
    const snapshotContent = await readFile(sidecarFile, "utf-8");
    assert.ok(snapshotContent.includes("source body"), "snapshot file must preserve source body");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("snapshotForProvenance returns null when versioning is disabled", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-provenance-disabled-"));
  try {
    const storage = new StorageManager(dir);
    // Intentionally skip setVersioningConfig — versioning stays disabled.
    await storage.ensureDirectories();

    const { id: sourceId } = await storage.writeMemory("fact", "source body", {
      source: "extraction",
    });
    const all = await storage.readAllMemories();
    const source = all.find((m) => m.frontmatter.id === sourceId);
    assert.ok(source);

    const entry = await storage.snapshotForProvenance(source.path);
    assert.equal(entry, null, "should return null when versioning disabled");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("snapshotForProvenance returns null when the file does not exist", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-provenance-missing-"));
  try {
    const storage = new StorageManager(dir);
    storage.setVersioningConfig(versioningConfig());
    await storage.ensureDirectories();

    const nonExistent = path.join(dir, "facts", "2026-04-20", "fact-does-not-exist.md");
    const entry = await storage.snapshotForProvenance(nonExistent);
    assert.equal(entry, null, "missing files must snapshot to null");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("round-trip: writeMemory with snapshotForProvenance entries survives read", async () => {
  // End-to-end: snapshot two sources, write a canonical memory that
  // references them via derivedFrom, read the canonical memory back and
  // verify the entries survived serialization + parsing.  This is the
  // happy-path contract the consolidation pipeline depends on.
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-provenance-roundtrip-"));
  try {
    const storage = new StorageManager(dir);
    storage.setVersioningConfig(versioningConfig());
    await storage.ensureDirectories();

    const { id: srcAId } = await storage.writeMemory("fact", "alpha source body", {
      source: "extraction",
    });
    const { id: srcBId } = await storage.writeMemory("fact", "bravo source body", {
      source: "extraction",
    });

    const allBefore = await storage.readAllMemories();
    const srcA = allBefore.find((m) => m.frontmatter.id === srcAId);
    const srcB = allBefore.find((m) => m.frontmatter.id === srcBId);
    assert.ok(srcA);
    assert.ok(srcB);

    const entryA = await storage.snapshotForProvenance(srcA.path);
    const entryB = await storage.snapshotForProvenance(srcB.path);
    assert.ok(entryA);
    assert.ok(entryB);

    const { id: canonicalId } = await storage.writeMemory("fact", "canonical merged body", {
      source: "semantic-consolidation",
      derivedFrom: [entryA, entryB],
      derivedVia: "merge",
    });

    const allAfter = await storage.readAllMemories();
    const canonical = allAfter.find((m) => m.frontmatter.id === canonicalId);
    assert.ok(canonical);
    assert.deepEqual(canonical.frontmatter.derived_from, [entryA, entryB]);
    assert.equal(canonical.frontmatter.derived_via, "merge");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
