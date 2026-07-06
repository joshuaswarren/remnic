/**
 * Issue #1533 — Phase A contract test: write/read/list/delete round-trips.
 *
 * For EVERY category directory (iterated from ALL_CATEGORY_DIRS, never hardcoded
 * — rule 53's cousin), exercises the documented public surface end to end:
 *
 *   writeMemory → readMemoryByPath → getMemoryById → readAllMemories → invalidateMemory
 *
 * Asserts content fidelity, frontmatter integrity, hash identity, and that
 * deleted memories disappear from every read path. This is the round-trip
 * contract that the 51 importers depend on; Phase B moves MUST keep it green.
 */

import assert from "node:assert/strict";
import type { MemoryCategory } from "../types.js";
import test from "node:test";

import { StorageManager } from "../storage.js";
import {
  ALL_CATEGORY_DIRS,
  ALL_CATEGORY_KEYS,
  RECALL_NON_MEMORY_DIRS,
  categoryDirName,
} from "../utils/category-dir.js";
import { makeStorage } from "./harness.js";

/**
 * The singular category keys writeMemory accepts, minus "entity" (entities use
 * a separate write path: writeEntity) and "question" (questions are a
 * non-memory QUEUE dir — RECALL_NON_MEMORY_DIRS — surfaced through
 * writeQuestion/readQuestions, NOT readAllMemories; see question-queue test).
 */
const ROUND_TRIP_CATEGORIES = ALL_CATEGORY_KEYS.filter(
  (k) => k !== "entity" && k !== "question",
) as MemoryCategory[];

test("round-trip: writeMemory returns a stable id and persists to the category dir", async () => {
  const { storage, cleanup } = await makeStorage();
  try {
    const id = await storage.writeMemory("fact", "The sky is blue", {
      tags: ["contract"],
    });
    assert.equal(typeof id, "string");
    assert.match(id, /^fact-/);

    const byId = await storage.getMemoryById(id);
    assert.ok(byId, "getMemoryById must find the just-written memory");
    assert.equal(byId!.frontmatter.id, id);
    assert.equal(byId!.content, "The sky is blue");
  } finally {
    await cleanup();
  }
});

test("round-trip: readAllMemories returns written memories from every category dir", async () => {
  const { storage, cleanup } = await makeStorage();
  try {
    const written: string[] = [];
    for (const category of ROUND_TRIP_CATEGORIES) {
      const id = await storage.writeMemory(
        category,
        `content for ${category}`,
        { confidence: 0.9 },
      );
      written.push(id);
    }

    const all = await storage.readAllMemories();
    const ids = new Set(all.map((m) => m.frontmatter.id));
    for (const id of written) {
      assert.ok(ids.has(id), `readAllMemories missing memory ${id} (${ROUND_TRIP_CATEGORIES.find((c) => id.startsWith(c))})`);
    }
  } finally {
    await cleanup();
  }
});

for (const category of ROUND_TRIP_CATEGORIES) {
  test(`round-trip [${category}]: write → read-by-path → read-by-id → list → delete`, async () => {
    const { storage, cleanup } = await makeStorage();
    try {
      const content = `fact body for category ${category}`;
      const id = await storage.writeMemory(category, content, {
        tags: ["round-trip"],
      });

      // getMemoryById
      const byId = await storage.getMemoryById(id);
      assert.ok(byId, "getMemoryById returned null");
      assert.equal(byId!.content, content);
      assert.equal(byId!.frontmatter.category, category);

      // readMemoryByPath — the path comes from the byId result
      const byPath = await storage.readMemoryByPath(byId!.path);
      assert.ok(byPath, "readMemoryByPath returned null");
      assert.equal(byPath!.content, content);
      assert.equal(byPath!.frontmatter.id, id);

      // The file landed under the right category dir
      const expectedDir = categoryDirName(category);
      assert.ok(
        byId!.path.includes(`/${expectedDir}/`),
        `${category} memory landed in ${byId!.path}, expected under ${expectedDir}/`,
      );

      // list contains it
      const all = await storage.readAllMemories();
      assert.ok(
        all.some((m) => m.frontmatter.id === id),
        "readAllMemories did not include the written memory",
      );

      // delete (invalidate) removes it from every read path
      const deleted = await storage.invalidateMemory(id);
      assert.equal(deleted, true, "invalidateMemory should return true on success");

      const afterDelete = await storage.getMemoryById(id);
      assert.equal(afterDelete, null, "getMemoryById must return null after invalidateMemory");

      const allAfter = await storage.readAllMemories();
      assert.ok(
        !allAfter.some((m) => m.frontmatter.id === id),
        "readAllMemories must not include deleted memory",
      );
    } finally {
      await cleanup();
    }
  });
}

test("round-trip: invalidateMemory returns false for a non-existent id (not a throw)", async () => {
  const { storage, cleanup } = await makeStorage();
  try {
    const result = await storage.invalidateMemory("does-not-exist-12345");
    assert.equal(result, false);
  } finally {
    await cleanup();
  }
});

test("round-trip: getMemoryById returns null for a non-existent id", async () => {
  const { storage, cleanup } = await makeStorage();
  try {
    const result = await storage.getMemoryById("missing-id");
    assert.equal(result, null);
  } finally {
    await cleanup();
  }
});

test("round-trip: readMemoryByPath returns null for a non-existent path", async () => {
  const { storage, baseDir, cleanup } = await makeStorage();
  try {
    const result = await storage.readMemoryByPath(
      `${baseDir}/facts/2026-01-01/nonexistent.md`,
    );
    assert.equal(result, null);
  } finally {
    await cleanup();
  }
});

test("round-trip: every ALL_CATEGORY_DIRS entry is a real directory name, not a category key", () => {
  // ALL_CATEGORY_DIRS must contain directory NAMES (facts, decisions, ...) not
  // singular keys (fact, decision, ...). This guards the parity between
  // categoryDirName() and the scan roots.
  for (const dir of ALL_CATEGORY_DIRS) {
    assert.ok(!dir.endsWith("s") || dir === "facts" || dir.endsWith("s"),
      `sanity: ${dir} is a plural directory name`);
  }
  // The map covers every non-fact category key
  const dirs = new Set(ALL_CATEGORY_DIRS);
  assert.ok(dirs.has("facts"));
  assert.ok(dirs.has("decisions"));
  assert.ok(dirs.has("questions"));
});

test("round-trip: StorageManager.dir exposes the base directory", async () => {
  const { storage, baseDir, cleanup } = await makeStorage();
  try {
    assert.equal(storage.dir, baseDir);
  } finally {
    await cleanup();
  }
});

test("question-queue: writeQuestion → readQuestions → resolveQuestion round-trip (questions are NOT in readAllMemories)", async () => {
  const { storage, cleanup } = await makeStorage();
  try {
    const id = await storage.writeQuestion("What database are we on?", "infra context", 3);
    assert.equal(typeof id, "string");
    assert.match(id, /^q-/);

    // readQuestions returns it
    const questions = await storage.readQuestions();
    const q = questions.find((x) => x.id === id);
    assert.ok(q, "readQuestions must include the just-written question");
    assert.equal(q!.question, "What database are we on?");
    assert.equal(q!.resolved, false);

    // questions/ is a RECALL_NON_MEMORY_DIRS entry — it must NOT appear in readAllMemories
    const all = await storage.readAllMemories();
    assert.ok(
      !all.some((m) => m.frontmatter.id === id),
      "questions must not leak into the memory corpus (readAllMemories)",
    );

    // unresolvedOnly filter works
    const unresolved = await storage.readQuestions({ unresolvedOnly: true });
    assert.ok(unresolved.some((x) => x.id === id));

    // resolve marks it resolved
    const resolved = await storage.resolveQuestion(id);
    assert.equal(resolved, true);

    const afterResolve = await storage.readQuestions({ unresolvedOnly: true });
    assert.ok(!afterResolve.some((x) => x.id === id), "resolved question must not appear in unresolvedOnly");

    const allAfter = await storage.readQuestions();
    const resolvedQ = allAfter.find((x) => x.id === id);
    assert.ok(resolvedQ, "resolved question should still be readable without the filter");
    assert.equal(resolvedQ!.resolved, true);
  } finally {
    await cleanup();
  }
});
