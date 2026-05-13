/**
 * Tests for issue #680 — explicit fact lifecycle (`valid_at` / `invalid_at`).
 *
 * These tests cover the four contract layers:
 *   1. Storage round-trip: emit → parse → exact match.
 *   2. Read-time fallback: legacy memories without `valid_at` default to
 *      `created` so they participate in `as_of` filtering without backfill.
 *   3. Supersession integration: when fact A supersedes fact B, B's
 *      `invalid_at` is populated from A's `valid_at` (or `persistedCreatedAt`).
 *   4. `as_of` filter semantics: half-open interval, exclusive upper bound,
 *      and exact-boundary behavior (CLAUDE.md gotcha #35).
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { StorageManager } from "./storage.js";
import { applyTemporalSupersession } from "./temporal-supersession.js";
import {
  effectiveInvalidAt,
  effectiveValidAt,
  isValidAsOf,
  parseAsOfTimestamp,
} from "./temporal-validity.js";
import type { MemoryFrontmatter } from "./types.js";

const TEST_ENTITY = "project-x";

async function makeStorage(): Promise<{
  storage: StorageManager;
  cleanup: () => Promise<void>;
}> {
  const memoryDir = await mkdtemp(
    path.join(os.tmpdir(), "engram-temporal-validity-"),
  );
  const storage = new StorageManager(memoryDir);
  await storage.ensureDirectories();
  StorageManager.clearAllStaticCaches();
  storage.invalidateAllMemoriesCacheForDir();
  return {
    storage,
    cleanup: async () => {
      StorageManager.clearAllStaticCaches();
      await rm(memoryDir, { recursive: true, force: true });
    },
  };
}

async function readFrontmatterById(
  storage: StorageManager,
  id: string,
): Promise<MemoryFrontmatter | null> {
  storage.invalidateAllMemoriesCacheForDir();
  const mems = await storage.readAllMemories();
  return mems.find((m) => m.frontmatter.id === id)?.frontmatter ?? null;
}

// ---------------------------------------------------------------------------
// 1. Storage round-trip
// ---------------------------------------------------------------------------

test("storage: valid_at / invalid_at round-trip exactly when set", async () => {
  const { storage, cleanup } = await makeStorage();
  try {
    const validAt = "2025-01-01T00:00:00.000Z";
    const invalidAt = "2026-01-01T00:00:00.000Z";
    const id = await storage.writeMemory("fact", "project X is based in Austin", {
      entityRef: TEST_ENTITY,
      structuredAttributes: { city: "Austin" },
      source: "test",
      confidence: 0.9,
      tags: [],
    });
    // Patch in the explicit lifecycle stamps via writeMemoryFrontmatter so
    // we exercise the same write path the supersession pipeline uses.
    storage.invalidateAllMemoriesCacheForDir();
    const all = await storage.readAllMemories();
    const memFile = all.find((m) => m.frontmatter.id === id);
    assert.ok(memFile, "wrote fact must be readable");
    await storage.writeMemoryFrontmatter(memFile, {
      valid_at: validAt,
      invalid_at: invalidAt,
    });

    const parsed = await readFrontmatterById(storage, id);
    assert.equal(parsed?.valid_at, validAt);
    assert.equal(parsed?.invalid_at, invalidAt);
  } finally {
    await cleanup();
  }
});

test("storage: writeMemory persists explicit validAt as valid_at", async () => {
  const { storage, cleanup } = await makeStorage();
  try {
    const id = await storage.writeMemory(
      "fact",
      "project X launched from the source transcript",
      {
        entityRef: TEST_ENTITY,
        source: "test",
        confidence: 0.9,
        tags: [],
        validAt: "2025-03-04T05:06:07Z",
      },
    );

    const fm = await readFrontmatterById(storage, id);
    assert.equal(fm?.valid_at, "2025-03-04T05:06:07.000Z");
  } finally {
    await cleanup();
  }
});

test("storage: writeMemory rejects invalid validAt values", async () => {
  const { storage, cleanup } = await makeStorage();
  try {
    await assert.rejects(
      () =>
        storage.writeMemory("fact", "invalid source timestamp", {
          source: "test",
          confidence: 0.9,
          tags: [],
          validAt: "2025-02-31T00:00:00Z",
        }),
      /validAt must be a valid ISO timestamp/,
    );
  } finally {
    await cleanup();
  }
});

test("storage: legacy memories without valid_at parse as undefined (no backfill)", async () => {
  const { storage, cleanup } = await makeStorage();
  try {
    const id = await storage.writeMemory("fact", "legacy memory", {
      entityRef: TEST_ENTITY,
      source: "test",
      confidence: 0.9,
      tags: [],
    });
    const fm = await readFrontmatterById(storage, id);
    assert.equal(fm?.valid_at, undefined);
    assert.equal(fm?.invalid_at, undefined);
    // Read-time fallback fills in `created` so the as-of filter still works.
    assert.equal(effectiveValidAt(fm!), fm!.created);
    assert.equal(effectiveInvalidAt(fm!), undefined);
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// 2. Read-time fallback
// ---------------------------------------------------------------------------

test("effectiveValidAt: explicit valid_at wins over created", () => {
  const fm = {
    valid_at: "2025-06-01T00:00:00.000Z",
    created: "2024-01-01T00:00:00.000Z",
  };
  assert.equal(effectiveValidAt(fm), "2025-06-01T00:00:00.000Z");
});

test("effectiveValidAt: whitespace-only valid_at falls back to created", () => {
  const fm = { valid_at: "   ", created: "2024-01-01T00:00:00.000Z" };
  assert.equal(effectiveValidAt(fm), "2024-01-01T00:00:00.000Z");
});

// ---------------------------------------------------------------------------
// 3. Supersession integration
// ---------------------------------------------------------------------------

test("supersession: new fact propagates valid_at to old fact's invalid_at", async () => {
  const { storage, cleanup } = await makeStorage();
  try {
    const oldId = await storage.writeMemory(
      "fact",
      "project X is based in Austin",
      {
        entityRef: TEST_ENTITY,
        structuredAttributes: { city: "Austin" },
        source: "test",
        confidence: 0.9,
        tags: [],
      },
    );
    await new Promise((r) => setTimeout(r, 5));
    const newId = await storage.writeMemory(
      "fact",
      "project X relocated to NYC",
      {
        entityRef: TEST_ENTITY,
        structuredAttributes: { city: "NYC" },
        source: "test",
        confidence: 0.9,
        tags: [],
      },
    );

    // Patch source-validity timestamps onto both facts so supersession orders
    // by authored/source time rather than by test wall-clock write time.
    storage.invalidateAllMemoriesCacheForDir();
    const all = await storage.readAllMemories();
    const oldFile = all.find((m) => m.frontmatter.id === oldId);
    const newFile = all.find((m) => m.frontmatter.id === newId);
    assert.ok(oldFile);
    assert.ok(newFile);
    await storage.writeMemoryFrontmatter(oldFile, {
      valid_at: "2026-04-25T11:00:00.000Z",
    });
    const newValidAt = "2026-04-25T12:00:00.000Z";
    await storage.writeMemoryFrontmatter(newFile, { valid_at: newValidAt });

    const result = await applyTemporalSupersession({
      storage,
      newMemoryId: newId,
      entityRef: TEST_ENTITY,
      structuredAttributes: { city: "NYC" },
      createdAt: new Date().toISOString(),
      enabled: true,
    });
    assert.deepEqual(result.supersededIds, [oldId]);

    const oldFm = await readFrontmatterById(storage, oldId);
    assert.equal(oldFm?.status, "superseded");
    assert.equal(
      oldFm?.invalid_at,
      newValidAt,
      "old fact's invalid_at must equal new fact's valid_at",
    );
  } finally {
    await cleanup();
  }
});

test("supersession: older source-valid replay fact does not supersede newer source-valid fact written first", async () => {
  const { storage, cleanup } = await makeStorage();
  try {
    const newerValidAt = "2025-01-02T00:00:00.000Z";
    const olderValidAt = "2025-01-01T00:00:00.000Z";

    const newerId = await storage.writeMemory(
      "fact",
      "project X moved to NYC",
      {
        entityRef: TEST_ENTITY,
        structuredAttributes: { city: "NYC" },
        source: "test",
        confidence: 0.9,
        tags: [],
        validAt: newerValidAt,
      },
    );
    await new Promise((r) => setTimeout(r, 5));
    const olderId = await storage.writeMemory(
      "fact",
      "project X was previously based in Austin",
      {
        entityRef: TEST_ENTITY,
        structuredAttributes: { city: "Austin" },
        source: "test",
        confidence: 0.9,
        tags: [],
        validAt: olderValidAt,
      },
    );

    const result = await applyTemporalSupersession({
      storage,
      newMemoryId: olderId,
      entityRef: TEST_ENTITY,
      structuredAttributes: { city: "Austin" },
      createdAt: new Date().toISOString(),
      enabled: true,
    });
    assert.deepEqual(result.supersededIds, []);

    const newerFm = await readFrontmatterById(storage, newerId);
    const olderFm = await readFrontmatterById(storage, olderId);
    assert.equal(newerFm?.status ?? "active", "active");
    assert.equal(newerFm?.supersededBy, undefined);
    assert.equal(newerFm?.invalid_at, undefined);
    assert.equal(olderFm?.status ?? "active", "active");
  } finally {
    await cleanup();
  }
});

test("supersession: when superseder has no valid_at, falls back to persisted created", async () => {
  const { storage, cleanup } = await makeStorage();
  try {
    const oldId = await storage.writeMemory(
      "fact",
      "project X is based in Austin",
      {
        entityRef: TEST_ENTITY,
        structuredAttributes: { city: "Austin" },
        source: "test",
        confidence: 0.9,
        tags: [],
      },
    );
    await new Promise((r) => setTimeout(r, 5));
    const newId = await storage.writeMemory(
      "fact",
      "project X relocated to NYC",
      {
        entityRef: TEST_ENTITY,
        structuredAttributes: { city: "NYC" },
        source: "test",
        confidence: 0.9,
        tags: [],
      },
    );

    await applyTemporalSupersession({
      storage,
      newMemoryId: newId,
      entityRef: TEST_ENTITY,
      structuredAttributes: { city: "NYC" },
      createdAt: new Date().toISOString(),
      enabled: true,
    });

    const oldFm = await readFrontmatterById(storage, oldId);
    const newFm = await readFrontmatterById(storage, newId);
    assert.ok(oldFm?.invalid_at, "invalid_at must be set");
    assert.equal(
      oldFm?.invalid_at,
      newFm?.created,
      "fallback uses superseder's created when no valid_at is set",
    );
  } finally {
    await cleanup();
  }
});

test("supersession: existing invalid_at is preserved (idempotent)", async () => {
  const { storage, cleanup } = await makeStorage();
  try {
    const oldId = await storage.writeMemory("fact", "old fact", {
      entityRef: TEST_ENTITY,
      structuredAttributes: { city: "Austin" },
      source: "test",
      confidence: 0.9,
      tags: [],
    });
    // Pre-set a manual invalid_at on the old fact.
    storage.invalidateAllMemoriesCacheForDir();
    const all = await storage.readAllMemories();
    const oldFile = all.find((m) => m.frontmatter.id === oldId);
    assert.ok(oldFile);
    const manualInvalidAt = "2024-12-31T00:00:00.000Z";
    await storage.writeMemoryFrontmatter(oldFile, {
      invalid_at: manualInvalidAt,
    });

    await new Promise((r) => setTimeout(r, 5));
    const newId = await storage.writeMemory("fact", "new fact", {
      entityRef: TEST_ENTITY,
      structuredAttributes: { city: "NYC" },
      source: "test",
      confidence: 0.9,
      tags: [],
    });

    await applyTemporalSupersession({
      storage,
      newMemoryId: newId,
      entityRef: TEST_ENTITY,
      structuredAttributes: { city: "NYC" },
      createdAt: new Date().toISOString(),
      enabled: true,
    });

    const oldFm = await readFrontmatterById(storage, oldId);
    assert.equal(
      oldFm?.invalid_at,
      manualInvalidAt,
      "manual invalid_at must not be overwritten",
    );
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// 4. as_of filter semantics
// ---------------------------------------------------------------------------

test("isValidAsOf: half-open interval [valid_at, invalid_at)", () => {
  const fm = {
    valid_at: "2025-01-01T00:00:00.000Z",
    invalid_at: "2025-12-31T00:00:00.000Z",
    created: "2025-01-01T00:00:00.000Z",
  };
  // Before valid_at — not yet authoritative.
  assert.equal(isValidAsOf(fm, Date.parse("2024-12-31T23:59:59.999Z")), false);
  // Exactly at valid_at — authoritative (lower bound is inclusive).
  assert.equal(isValidAsOf(fm, Date.parse("2025-01-01T00:00:00.000Z")), true);
  // Mid-range — authoritative.
  assert.equal(isValidAsOf(fm, Date.parse("2025-06-15T12:00:00.000Z")), true);
  // Exactly at invalid_at — NOT authoritative (upper bound exclusive,
  // CLAUDE.md gotcha #35).
  assert.equal(isValidAsOf(fm, Date.parse("2025-12-31T00:00:00.000Z")), false);
  // After invalid_at — not authoritative.
  assert.equal(isValidAsOf(fm, Date.parse("2026-01-01T00:00:00.000Z")), false);
});

test("isValidAsOf: timezone-suffixed ISO strings compare via Date.parse, not lexicographic", () => {
  // Two strings that order differently lexicographically vs as Dates.
  // 2025-01-01T00:00:00+02:00 == 2024-12-31T22:00:00Z
  const fm = {
    valid_at: "2025-01-01T00:00:00+02:00",
    created: "2025-01-01T00:00:00+02:00",
  };
  // 2024-12-31T23:00:00Z is AFTER 2025-01-01T00:00:00+02:00 (== 22:00Z).
  assert.equal(isValidAsOf(fm, Date.parse("2024-12-31T23:00:00Z")), true);
  // 2024-12-31T21:00:00Z is BEFORE 2025-01-01T00:00:00+02:00.
  assert.equal(isValidAsOf(fm, Date.parse("2024-12-31T21:00:00Z")), false);
});

test("isValidAsOf: legacy memory without valid_at uses created as fallback", () => {
  const fm = { created: "2025-01-01T00:00:00.000Z" };
  assert.equal(isValidAsOf(fm, Date.parse("2024-12-01T00:00:00Z")), false);
  assert.equal(isValidAsOf(fm, Date.parse("2025-06-01T00:00:00Z")), true);
});

test("isValidAsOf: malformed valid_at conservatively excludes the fact", () => {
  const fm = { valid_at: "not-a-date", created: "totally-also-not-a-date" };
  assert.equal(isValidAsOf(fm, Date.parse("2025-06-01T00:00:00Z")), false);
});

test("parseAsOfTimestamp: rejects empty strings, non-strings, and malformed timestamps", () => {
  assert.throws(() => parseAsOfTimestamp(undefined), RangeError);
  assert.throws(() => parseAsOfTimestamp(""), RangeError);
  assert.throws(() => parseAsOfTimestamp("   "), RangeError);
  assert.throws(() => parseAsOfTimestamp("not-a-date"), RangeError);
  assert.throws(() => parseAsOfTimestamp(1234), RangeError);
  // Valid: parses and returns ms.
  assert.equal(
    parseAsOfTimestamp("2025-01-01T00:00:00.000Z"),
    Date.parse("2025-01-01T00:00:00.000Z"),
  );
});
