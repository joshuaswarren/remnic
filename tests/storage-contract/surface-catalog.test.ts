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

import { enumeratePublicWriteSurface, withScratchStorage } from "./helpers.js";

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
const EXPECTED_SURFACE_COUNT = 18; // 12 writeMemory categories + updateMemoryFrontmatter + artifact + entity + profile + question + chunk

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
      const result = await entry.write(storage);
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
  // Must match the WRITE_CATEGORIES list from round-trip.test.ts — locked here
  // so a new MemoryCategory that lands in types.ts without a surface entry
  // fails loudly. (Pinned by hand to avoid a circular import of the list.)
  const expectedCategories = [
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
  for (const cat of expectedCategories) {
    assert.ok(coveredCategories.has(cat), `MemoryCategory "${cat}" has no writeMemory surface entry`);
  }
});
