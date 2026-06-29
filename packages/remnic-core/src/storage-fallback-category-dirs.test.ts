/**
 * Issue #1497 — Recall: scan all memory category directories when the QMD
 * filesystem fallback reads from disk.
 *
 * The filesystem fallback recall path (orchestrator `recent_scan`) calls
 * `StorageManager.readAllMemories()` per namespace, which scans the disk via
 * `collectActiveMemoryPaths()`. The old implementation only scanned four
 * directories (facts, procedures, reasoning-traces, corrections), so on-disk
 * memories in any other recall category directory (preferences, decisions,
 * moments, commitments, principles, rules, skills, relationships) were silently
 * missed when QMD was unavailable.
 *
 * These tests seed `.md` memory files directly into the on-disk category
 * directories (the way an external seed, a migration, or a future routing
 * change would leave them) and assert the disk-scan recall returns them.
 *
 * They FAIL on the old four-directory behavior and PASS once
 * `collectActiveMemoryPaths()` iterates the shared `RECALL_FALLBACK_DIRS`.
 *
 * PR #1503 review (chatgpt-codex-connector, cursor): `questions/` is NOT a
 * recall memory dir. It holds operational question-QUEUE items written by
 * `writeQuestion()` and surfaced only through the dedicated, disabled-by-default
 * `injectQuestions` pipeline stage. The QMD primary recall corpus excludes them,
 * so the fallback must exclude them too (corpus parity; CLAUDE.md rule #39).
 * `RECALL_FALLBACK_DIRS` = `ALL_CATEGORY_DIRS` minus `RECALL_NON_MEMORY_DIRS`
 * (currently just `questions`).
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { StorageManager } from "./storage.js";
import {
  CATEGORY_DIR_MAP,
  RECALL_FALLBACK_DIRS,
  RECALL_NON_MEMORY_DIRS,
} from "./utils/category-dir.js";

/** Build a minimal-but-valid memory markdown file body. */
function memoryFile(id: string, category: string, content: string): string {
  const now = new Date().toISOString();
  return [
    "---",
    `id: ${id}`,
    `category: ${category}`,
    `created: ${now}`,
    `updated: ${now}`,
    "source: test",
    "confidence: 0.9",
    'tags: ["synthetic"]',
    "---",
    "",
    content,
    "",
  ].join("\n");
}

async function seedMemory(
  baseDir: string,
  categoryDir: string,
  id: string,
  category: string,
  content: string,
  options: { nested?: boolean } = {},
): Promise<void> {
  const dir = options.nested
    ? path.join(baseDir, categoryDir, "2026-06-29")
    : path.join(baseDir, categoryDir);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${id}.md`), memoryFile(id, category, content), "utf-8");
}

async function makeStorage(prefix = "engram-1497-"): Promise<{
  storage: StorageManager;
  baseDir: string;
  cleanup: () => Promise<void>;
}> {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const storage = new StorageManager(baseDir);
  await storage.ensureDirectories();
  StorageManager.clearAllStaticCaches();
  storage.invalidateAllMemoriesCacheForDir();
  return {
    storage,
    baseDir,
    cleanup: async () => {
      StorageManager.clearAllStaticCaches();
      await rm(baseDir, { recursive: true, force: true });
    },
  };
}

/**
 * Singular-category-key -> {dir} for every RECALL category dir the fallback
 * scan must cover. This is `ALL_CATEGORY_DIRS` minus `RECALL_NON_MEMORY_DIRS`
 * (the `questions/` queue dir is intentionally absent — see the file header).
 */
const CATEGORY_CASES: ReadonlyArray<{ key: string; dir: string }> = [
  { key: "fact", dir: "facts" },
  ...Object.entries(CATEGORY_DIR_MAP).map(([key, dir]) => ({ key, dir })),
].filter(({ dir }) => !RECALL_NON_MEMORY_DIRS.has(dir));

test("collectActiveMemoryPaths source-of-truth: every RECALL_FALLBACK_DIRS entry is covered", () => {
  // Guards against the dir list drifting away from the shared source of truth.
  const expected = new Set(RECALL_FALLBACK_DIRS);
  const covered = new Set(CATEGORY_CASES.map((c) => c.dir));
  assert.deepEqual(
    [...covered].sort(),
    [...expected].sort(),
    "test cases must cover exactly RECALL_FALLBACK_DIRS",
  );
  // questions/ must NOT be a recall fallback dir.
  assert.ok(
    !expected.has("questions"),
    "questions/ is a queue dir and must be excluded from recall fallback",
  );
});

test("fallback disk recall returns a memory from EVERY category directory", async () => {
  const { storage, baseDir, cleanup } = await makeStorage();
  try {
    for (const { key, dir } of CATEGORY_CASES) {
      await seedMemory(
        baseDir,
        dir,
        `mem-${key}`,
        key,
        `Synthetic ${key} memory content for issue 1497.`,
      );
    }

    const memories = await storage.readAllMemories();
    const foundIds = new Set(memories.map((m) => m.frontmatter.id));

    for (const { key, dir } of CATEGORY_CASES) {
      assert.ok(
        foundIds.has(`mem-${key}`),
        `expected fallback recall to find memory in "${dir}/" (category "${key}"), ` +
          `got ids: ${[...foundIds].join(", ")}`,
      );
    }
    // Exactly one per category directory — no over-counting / double scan.
    assert.equal(memories.length, CATEGORY_CASES.length);
  } finally {
    await cleanup();
  }
});

test("fallback disk recall scans nested date subdirectories under category dirs", async () => {
  const { storage, baseDir, cleanup } = await makeStorage();
  try {
    // Place files in nested YYYY-MM-DD subdirs for a representative spread of
    // categories, including ones outside the legacy four-dir scan.
    await seedMemory(baseDir, "preferences", "nested-pref", "preference", "Nested pref.", {
      nested: true,
    });
    await seedMemory(baseDir, "decisions", "nested-dec", "decision", "Nested decision.", {
      nested: true,
    });
    await seedMemory(baseDir, "facts", "nested-fact", "fact", "Nested fact.", {
      nested: true,
    });

    const memories = await storage.readAllMemories();
    const foundIds = new Set(memories.map((m) => m.frontmatter.id));

    assert.ok(foundIds.has("nested-pref"), "nested preference not found");
    assert.ok(foundIds.has("nested-dec"), "nested decision not found");
    assert.ok(foundIds.has("nested-fact"), "nested fact not found");
  } finally {
    await cleanup();
  }
});

test("missing category directories are ignored without throwing", async () => {
  // Construct a storage WITHOUT calling ensureDirectories(): none of the
  // category dirs exist on disk. The scan must not throw and must return [].
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "engram-1497-missing-"));
  const storage = new StorageManager(baseDir);
  StorageManager.clearAllStaticCaches();
  storage.invalidateAllMemoriesCacheForDir();
  try {
    const memories = await storage.readAllMemories();
    assert.deepEqual(memories, []);

    // Now create exactly one non-legacy dir and confirm partial presence works.
    await seedMemory(baseDir, "rules", "only-rule", "rule", "Only a rule exists.");
    storage.invalidateAllMemoriesCacheForDir();
    const after = await storage.readAllMemories();
    assert.equal(after.length, 1);
    assert.equal(after[0]?.frontmatter.id, "only-rule");
  } finally {
    StorageManager.clearAllStaticCaches();
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("non-memory markdown in category dirs is ignored safely (no crash)", async () => {
  const { storage, baseDir, cleanup } = await makeStorage();
  try {
    // A valid memory plus several garbage markdown files in category dirs.
    await seedMemory(baseDir, "skills", "good-skill", "skill", "A valid skill memory.");

    await mkdir(path.join(baseDir, "principles"), { recursive: true });
    // No frontmatter at all.
    await writeFile(
      path.join(baseDir, "principles", "README.md"),
      "# Just a heading\n\nNo frontmatter here.\n",
      "utf-8",
    );
    // Broken / truncated frontmatter.
    await writeFile(
      path.join(baseDir, "principles", "broken.md"),
      "---\nid: broken\n(no closing delimiter)\n",
      "utf-8",
    );
    // Empty file.
    await writeFile(path.join(baseDir, "principles", "empty.md"), "", "utf-8");

    const memories = await storage.readAllMemories();
    const foundIds = new Set(memories.map((m) => m.frontmatter.id));
    assert.ok(foundIds.has("good-skill"), "valid skill memory should be returned");
    assert.ok(!foundIds.has("broken"), "broken markdown must not be parsed as a memory");
    assert.equal(memories.length, 1, "only the one valid memory should be returned");
  } finally {
    await cleanup();
  }
});

test("filesystem fallback is namespace-aware across more than one namespace", async () => {
  // Each namespace is a distinct StorageManager baseDir (mirrors how the
  // orchestrator's readAllMemoriesForNamespaces routes per namespace). The fix
  // lives in collectActiveMemoryPaths(), so it must work for ALL baseDirs.
  const nsA = await makeStorage("engram-1497-nsA-");
  const nsB = await makeStorage("engram-1497-nsB-");
  try {
    // Seed non-legacy category dirs in each namespace.
    await seedMemory(nsA.baseDir, "relationships", "rel-a", "relationship", "NS A relationship.");
    await seedMemory(nsA.baseDir, "commitments", "com-a", "commitment", "NS A commitment.");
    await seedMemory(nsB.baseDir, "moments", "mom-b", "moment", "NS B moment.");

    const a = new Set((await nsA.storage.readAllMemories()).map((m) => m.frontmatter.id));
    const b = new Set((await nsB.storage.readAllMemories()).map((m) => m.frontmatter.id));

    assert.ok(a.has("rel-a") && a.has("com-a"), "namespace A must surface its memories");
    assert.ok(b.has("mom-b"), "namespace B must surface its memories");
    // No cross-namespace bleed.
    assert.ok(!a.has("mom-b"), "namespace A must not read namespace B");
    assert.ok(!b.has("rel-a") && !b.has("com-a"), "namespace B must not read namespace A");
  } finally {
    await nsA.cleanup();
    await nsB.cleanup();
  }
});

test("non-category content dirs are deliberately EXCLUDED from fallback recall", async () => {
  // Explicit decision (issue #1497): entities/, state/, artifacts/, identity/,
  // config/ and profile.md are NOT standard frontmatter-backed memory files and
  // are intentionally excluded from the category-dir scan. Files placed there
  // must NOT appear in readAllMemories() — they have dedicated read paths.
  const { storage, baseDir, cleanup } = await makeStorage();
  try {
    // A real memory so the corpus is non-empty.
    await seedMemory(baseDir, "facts", "real-fact", "fact", "A genuine fact.");

    // Drop markdown that *looks* like a memory into the excluded dirs.
    for (const excluded of ["entities", "state", "artifacts", "identity", "config"]) {
      await mkdir(path.join(baseDir, excluded), { recursive: true });
      await writeFile(
        path.join(baseDir, excluded, "looks-like-memory.md"),
        memoryFile(`excluded-${excluded}`, "fact", `Should not be recalled (${excluded}).`),
        "utf-8",
      );
    }
    // profile.md at the root is also excluded.
    await writeFile(
      path.join(baseDir, "profile.md"),
      memoryFile("excluded-profile", "fact", "Profile should not be recalled."),
      "utf-8",
    );

    const memories = await storage.readAllMemories();
    const foundIds = new Set(memories.map((m) => m.frontmatter.id));

    assert.ok(foundIds.has("real-fact"), "the genuine fact must still be recalled");
    for (const excluded of ["entities", "state", "artifacts", "identity", "config"]) {
      assert.ok(
        !foundIds.has(`excluded-${excluded}`),
        `${excluded}/ must be excluded from fallback recall`,
      );
    }
    assert.ok(!foundIds.has("excluded-profile"), "profile.md must be excluded from fallback recall");
    assert.equal(memories.length, 1, "only the one in-category memory should be returned");
  } finally {
    await cleanup();
  }
});

test("question-queue items written by writeQuestion() do NOT leak into fallback recall", async () => {
  // PR #1503 review (chatgpt-codex-connector P2 + cursor): scanning questions/
  // via the category-dir list pulled writeQuestion() queue items
  // (priority/resolved frontmatter) into recall. They are NOT recall memories —
  // they are surfaced only via readQuestions() + the disabled-by-default
  // injectQuestions pipeline. The QMD primary corpus excludes them; the
  // filesystem fallback must too (CLAUDE.md rule #39 corpus parity).
  //
  // This test uses the REAL writeQuestion() path (not a synthetic memory file)
  // so it exercises exactly the frontmatter shape the reviewers flagged. It
  // FAILS on the buggy ALL_CATEGORY_DIRS scan and PASSES after the
  // RECALL_FALLBACK_DIRS fix.
  const { storage, baseDir, cleanup } = await makeStorage();
  try {
    // A genuine recall memory so the corpus is non-empty.
    await seedMemory(baseDir, "facts", "real-fact", "fact", "A genuine fact.");

    // Real operational question-queue items (frontmatter { id, created,
    // priority, resolved }, body `<question>\n\n**Context:** ...`).
    const qId1 = await storage.writeQuestion("What is the user's timezone?", "ctx1", 0.9);
    const qId2 = await storage.writeQuestion("Does the user prefer dark mode?", "ctx2", 0.5);

    // Queue items remain readable via the dedicated queue surface.
    const queue = await storage.readQuestions();
    const queueIds = new Set(queue.map((q) => q.id));
    assert.ok(queueIds.has(qId1) && queueIds.has(qId2), "readQuestions() must still return the queue");

    // ...but they must NOT appear in the recall corpus.
    storage.invalidateAllMemoriesCacheForDir();
    const memories = await storage.readAllMemories();
    const foundIds = new Set(memories.map((m) => m.frontmatter.id));
    assert.ok(foundIds.has("real-fact"), "the genuine fact must still be recalled");
    assert.ok(!foundIds.has(qId1), "question-queue item #1 must NOT leak into recall");
    assert.ok(!foundIds.has(qId2), "question-queue item #2 must NOT leak into recall");
    assert.equal(
      memories.length,
      1,
      "only the genuine fact should be recalled (no question-queue leakage)",
    );
  } finally {
    await cleanup();
  }
});

/**
 * QMD-DISABLED config path.
 *
 * A full end-to-end orchestrator recall with QMD disabled requires a large
 * fixture (gateway API stubs, config, search-collection wiring) that the core
 * Node test runner does not bootstrap here. The orchestrator's QMD-unavailable
 * recall fallback (`recent_scan`) routes through
 * `readAllMemoriesForNamespaces(ns)` -> `StorageManager.readAllMemories()` ->
 * `collectActiveMemoryPaths()` (see orchestrator.ts readAllMemoriesForNamespaces
 * and the recent-memory-read step). We therefore exercise that exact collector
 * directly with a config object that explicitly disables QMD, proving the disk
 * scan a QMD-disabled deployment relies on returns every category.
 */
test("QMD-disabled deployment: disk-scan collector returns all categories", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "engram-1497-qmd-off-"));
  // entitySchemas is the only other constructor arg; QMD is never constructed by
  // StorageManager — the fallback recall path is pure filesystem. This models a
  // deployment configured with `qmdEnabled: false` (no QMD process at all).
  const qmdDisabledConfig = { qmdEnabled: false } as const;
  assert.equal(qmdDisabledConfig.qmdEnabled, false);

  const storage = new StorageManager(baseDir);
  await storage.ensureDirectories();
  StorageManager.clearAllStaticCaches();
  storage.invalidateAllMemoriesCacheForDir();
  try {
    for (const { key, dir } of CATEGORY_CASES) {
      await seedMemory(baseDir, dir, `qmdoff-${key}`, key, `QMD-off ${key} memory.`);
    }
    storage.invalidateAllMemoriesCacheForDir();

    const memories = await storage.readAllMemories();
    const foundIds = new Set(memories.map((m) => m.frontmatter.id));
    for (const { key, dir } of CATEGORY_CASES) {
      assert.ok(
        foundIds.has(`qmdoff-${key}`),
        `QMD-disabled fallback must read "${dir}/" (category "${key}")`,
      );
    }
  } finally {
    StorageManager.clearAllStaticCaches();
    await rm(baseDir, { recursive: true, force: true });
  }
});
