/**
 * #1533 Phase A — public write-surface catalog (issue done-when #1 + the
 * #1522 coordination note). The surface enumerator lives in `./helpers.ts` and
 * is shared with #1522's catalog-touch fitness test. This file locks:
 *
 *   1. The COUNT of public write entry points — a new write path MUST be added
 *      to `enumeratePublicWriteSurface` or this test fails. That prevents a new
 *      storage write from silently bypassing #1522's fitness check.
 *   2. Each entry's `write(storage)` actually persists (no silent no-op for
 *      the contract-body inputs) — the round-trip is the contract.
 *   3. The names are unique + stable (deterministic fitness-test messages).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { ALL_MEMORY_CATEGORIES, enumeratePublicWriteSurface, withScratchStorage } from "./helpers.js";

/**
 * The LOCKED count of CATALOGUED memory-content write entry points — the
 * surface #1522's catalog-touch fitness test guards. When a new memory write
 * lands on StorageManager, add it to `enumeratePublicWriteSurface` (helpers.ts)
 * and bump this number so a new write path cannot silently bypass #1522's
 * fitness check.
 *
 * NOTE: this enumerates MEMORY-CONTENT writes (files under the memory store
 * that #1522's chokepoint records). State/summary JSON writes — saveBuffer,
 * writeSummary — write outside the memory catalog and are intentionally NOT
 * catalogued here; they are a separate surface.
 */
const EXPECTED_SURFACE_COUNT = 21; // 13 writeMemory categories (incl. entity) + updateMemoryFrontmatter + updateMemory + writeMemoryFrontmatter + artifact + entity(writeEntity) + profile + question + chunk

test("surface catalog: enumeratePublicWriteSurface returns the locked count", () => {
  const surface = enumeratePublicWriteSurface();
  assert.equal(
    surface.length,
    EXPECTED_SURFACE_COUNT,
    `catalogued memory-content write surface drifted: expected ${EXPECTED_SURFACE_COUNT}, got ${surface.length}. ` +
      "Add the new write entry point to enumeratePublicWriteSurface in tests/storage-contract/helpers.ts " +
      "so #1522's catalog-touch fitness test covers it, then bump EXPECTED_SURFACE_COUNT.",
  );
});

test("surface catalog: entry names are unique (deterministic fitness-test messages)", () => {
  const surface = enumeratePublicWriteSurface();
  const names = surface.map((e) => e.name);
  assert.equal(new Set(names).size, names.length, `duplicate surface names: ${names.join(", ")}`);
});

test("surface catalog: every entry covers all 6 kinds (memory/artifact/entity/profile/question/chunk)", () => {
  const surface = enumeratePublicWriteSurface();
  const kinds = new Set(surface.map((e) => e.kind));
  // If a kind disappears the enumerator drifted from the StorageManager shape.
  for (const expected of ["memory", "artifact", "entity", "profile", "question", "chunk"] as const) {
    assert.ok(kinds.has(expected), `surface catalog lost the "${expected}" kind`);
  }
});

test("surface catalog: every entry's write() persists against a fresh store", async () => {
  const surface = enumeratePublicWriteSurface();
  for (const entry of surface) {
    await withScratchStorage(`surface-${entry.name}`, async (storage) => {
      // `write` and OUTSIDE any catalog-touch window. Calling setup then write
      // mirrors how #1522's fitness test will consume the surface, and keeps
      // this persistence contract test honest about which call persisted.
      const setupContext = entry.setup ? await entry.setup(storage) : undefined;
      const result = await entry.write(storage, setupContext);
      // writeEntity returns "" on invalid input but our contract-body input
      // is always valid, so every entry must return a non-empty id/path.
      assert.ok(
        typeof result === "string" && result.length > 0,
        `${entry.name}.write() returned empty — surface entry does not persist against a fresh store`,
      );
    });
  }
});

test("surface catalog: writeMemory entries cover EVERY MemoryCategory (no category silently untested)", async () => {
  const surface = enumeratePublicWriteSurface();
  // Only the per-category `writeMemory(<category>)` entries assert category
  // coverage — other memory-kind writes (e.g. updateMemoryFrontmatter) are
  // not category writes and must not be forced into this shape.
  const memoryEntries = surface.filter((e) => /^writeMemory\((.+)\)$/.test(e.name));
  const coveredCategories = new Set(
    memoryEntries.map((e) => {
      // name shape: "writeMemory(<category>)"
      const match = e.name.match(/^writeMemory\((.+)\)$/);
      assert.ok(match, `unexpected memory entry name: ${e.name}`);
      return match![1];
    }),
  );
  // Fail-closed against the MemoryCategory union: ALL_MEMORY_CATEGORIES is
  // type-checked via `satisfies Record<MemoryCategory, unknown>` in helpers.ts,
  // so adding a category to the union without listing it is a compile error
  // there — and this test then enforces every listed category has a
  // writeMemory(<category>) surface entry. A hand-written array here could
  // silently miss a new category; this cannot.
  const expectedCategories = ALL_MEMORY_CATEGORIES;
  for (const cat of expectedCategories) {
    assert.ok(coveredCategories.has(cat), `MemoryCategory "${cat}" has no writeMemory surface entry`);
  }
});
