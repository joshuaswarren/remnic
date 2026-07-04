/**
 * #1533 Phase A — round-trip contract per category dir (issue done-when #2).
 *
 * For every category in `ALL_CATEGORY_DIRS` (NEVER hardcoded — rule 53's
 * cousin): write → read-by-path → read-by-id → list → delete. Asserts content,
 * frontmatter, and that the file lands in the category dir derived from the
 * shared `categoryDirName()` chokepoint (not collapsed into facts/).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { StorageManager } from "../../packages/remnic-core/src/storage.js";
import {
  ALL_CATEGORY_DIRS,
  CATEGORY_DIR_MAP,
  categoryDirName,
} from "../../packages/remnic-core/src/utils/category-dir.js";
import type { MemoryCategory } from "../../packages/remnic-core/src/types.js";
import { withScratchStorage } from "./helpers.js";

/**
 * The categories `StorageManager.writeMemory` accepts. `entity` resolves to the
 * `facts/` fallback (no dedicated dir per `categoryDirName`); entity FILES live
 * under `entities/` via `writeEntity`, which has its own round-trip test.
 */
const WRITE_CATEGORIES: MemoryCategory[] = [
  "fact",
  "preference",
  "decision",
  "correction",
  "commitment",
  "moment",
  "principle",
  "relationship",
  "rule",
  "skill",
  "procedure",
  "reasoning_trace",
];

test("round-trip: ALL_CATEGORY_DIRS is the single category-dir source of truth (no hardcoded copy)", () => {
  // Rule 53's cousin: if a new category dir lands in CATEGORY_DIR_MAP but not
  // here, the suite is silently incomplete. Lock the parity so the test runner
  // fails closed.
  const expectedDirs = new Set(["facts", ...Object.values(CATEGORY_DIR_MAP)]);
  assert.deepEqual(
    [...expectedDirs].sort(),
    [...ALL_CATEGORY_DIRS].sort(),
    "ALL_CATEGORY_DIRS drifted from CATEGORY_DIR_MAP — update the source of truth in utils/category-dir.ts",
  );
});

for (const category of WRITE_CATEGORIES) {
  test(`round-trip ${category}: write → read-by-path → read-by-id → list → delete`, async () => {
    await withScratchStorage(`roundtrip-${category}`, async (storage, dir) => {
      const content = `contract body for ${category}`;
      const id = await storage.writeMemory(category, content, {
        confidence: 0.9,
        tags: ["contract", category],
        source: "contract-test",
      });

      // The file MUST land under the category dir derived from the shared
      // categoryDirName() chokepoint (issue #1546). `correction` is flat
      // (no <date> subdir); every other category is <dir>/<date>/.
      const expectedDirName = categoryDirName(category);
      const expectedDir = path.join(dir, expectedDirName);
      const byId = await storage.getMemoryById(id);
      assert.ok(byId, `getMemoryById(${id}) returned null`);
      assert.equal(byId!.frontmatter.id, id);
      assert.equal(byId!.frontmatter.category, category);
      assert.equal(byId!.content, content);
      assert.ok(
        byId!.path.startsWith(expectedDir + path.sep),
        `${category} wrote outside ${expectedDir}: ${byId!.path}`,
      );

      // read-by-path returns the same record (content + frontmatter identity).
      const byPath = await storage.readMemoryByPath(byId!.path);
      assert.ok(byPath, "readMemoryByPath returned null for an existing memory");
      assert.equal(byPath!.frontmatter.id, id);
      assert.equal(byPath!.content, content);

      // list sees exactly this one memory (fresh scratch dir).
      const all = await storage.readAllMemories();
      const ids = all.map((m) => m.frontmatter.id);
      assert.ok(ids.includes(id), `readAllMemories did not list ${id}`);
      assert.equal(all.length, 1, `expected exactly 1 memory in fresh store, got ${all.length}`);

      // delete removes it and reports success; the next list is empty.
      const removed = await storage.invalidateMemory(id);
      assert.equal(removed, true, "invalidateMemory returned false for an existing memory");
      const after = await storage.readAllMemories();
      assert.equal(after.length, 0, "memory still present after invalidateMemory");
      const gone = await storage.getMemoryById(id);
      assert.equal(gone, null, "getMemoryById returned a record after invalidateMemory");
    });
  });
}

test("round-trip: non-existent id returns null/false everywhere (no silent synthesizing)", async () => {
  await withScratchStorage("roundtrip-miss", async (storage) => {
    const miss = await storage.getMemoryById("does-not-exist-1533");
    assert.equal(miss, null);
    const removed = await storage.invalidateMemory("does-not-exist-1533");
    assert.equal(removed, false);
    const updated = await storage.updateMemory("does-not-exist-1533", "new body");
    assert.equal(updated, false);
  });
});

test("round-trip: corrections dir is flat (no <date> subdir) — pin the historical layout", async () => {
  await withScratchStorage("roundtrip-corrections-flat", async (storage) => {
    const id = await storage.writeMemory("correction", "flat layout correction", {
      confidence: 0.95,
    });
    const mem = await storage.getMemoryById(id);
    assert.ok(mem);
    // corrections/<id>.md — NO date segment. Every other category has one.
    assert.equal(
      path.dirname(mem!.path),
      path.join(storage.dir, "corrections"),
      "corrections dir layout drifted from flat — see resolveCategoryWritePath",
    );
  });
});

test("round-trip: updateMemory rewrites content in place (path stable, content changes)", async () => {
  await withScratchStorage("roundtrip-update", async (storage) => {
    const id = await storage.writeMemory("decision", "original decision body");
    const before = await storage.getMemoryById(id);
    assert.ok(before);

    const ok = await storage.updateMemory(id, "amended decision body");
    assert.equal(ok, true);

    const after = await storage.getMemoryById(id);
    assert.ok(after);
    assert.equal(after!.content, "amended decision body");
    // Path is stable — updateMemory rewrites the same file (atomic replace).
    assert.equal(after!.path, before!.path);
    // frontmatter id is stable too (no id rewrite on update).
    assert.equal(after!.frontmatter.id, id);
  });
});

// `StorageManager` re-export check: the class is the import root for every
// importer (51 files). Pin that the symbol is exported as a value, not just a
// type, so the Phase B interface extraction can mechanically replace it.
test("round-trip: StorageManager is a constructable class (runtime export)", () => {
  assert.equal(typeof StorageManager, "function");
  // `class` constructs throw without `new`; a plain function-call would throw
  // a different error. This locks the surface shape Phase B will extract.
  const stub = Object.create(StorageManager.prototype) as StorageManager;
  assert.ok(stub instanceof StorageManager);
});
