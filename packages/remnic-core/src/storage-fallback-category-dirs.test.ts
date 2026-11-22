
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { StorageManager } from "./storage.js";
import {
  CATEGORY_DIR_MAP,
  RECALL_FALLBACK_DIRS,
  RECALL_NON_MEMORY_DIRS,
} from "./utils/category-dir.js";

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

const CATEGORY_CASES: ReadonlyArray<{ key: string; dir: string }> = [
  { key: "fact", dir: "facts" },
  ...Object.entries(CATEGORY_DIR_MAP).map(([key, dir]) => ({ key, dir })),
].filter(({ dir }) => !RECALL_NON_MEMORY_DIRS.has(dir));

test("collectActiveMemoryPaths source-of-truth: every RECALL_FALLBACK_DIRS entry is covered", () => {
  const expected = new Set(RECALL_FALLBACK_DIRS);
  const covered = new Set(CATEGORY_CASES.map((c) => c.dir));
  assert.deepEqual(
    [...covered].sort(),
    [...expected].sort(),
    "test cases must cover exactly RECALL_FALLBACK_DIRS",
  );
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
    await seedMemory(baseDir, "skills", "good-skill", "skill", "A valid skill memory.");

    await mkdir(path.join(baseDir, "principles"), { recursive: true });
    await writeFile(
      path.join(baseDir, "principles", "README.md"),
      "# Just a heading\n\nNo frontmatter here.\n",
      "utf-8",
    );
    await writeFile(
      path.join(baseDir, "principles", "broken.md"),
      "---\nid: broken\n(no closing delimiter)\n",
      "utf-8",
    );
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
    await seedMemory(nsA.baseDir, "relationships", "rel-a", "relationship", "NS A relationship.");
    await seedMemory(nsA.baseDir, "commitments", "com-a", "commitment", "NS A commitment.");
    await seedMemory(nsB.baseDir, "moments", "mom-b", "moment", "NS B moment.");

    const a = new Set((await nsA.storage.readAllMemories()).map((m) => m.frontmatter.id));
    const b = new Set((await nsB.storage.readAllMemories()).map((m) => m.frontmatter.id));

    assert.ok(a.has("rel-a") && a.has("com-a"), "namespace A must surface its memories");
    assert.ok(b.has("mom-b"), "namespace B must surface its memories");
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
    await seedMemory(baseDir, "facts", "real-fact", "fact", "A genuine fact.");

    for (const excluded of ["entities", "state", "artifacts", "identity", "config"]) {
      await mkdir(path.join(baseDir, excluded), { recursive: true });
      await writeFile(
        path.join(baseDir, excluded, "looks-like-memory.md"),
        memoryFile(`excluded-${excluded}`, "fact", `Should not be recalled (${excluded}).`),
        "utf-8",
      );
    }
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
    await seedMemory(baseDir, "facts", "real-fact", "fact", "A genuine fact.");

    // Real operational question-queue items (frontmatter { id, created,
    // priority, resolved }, body `<question>\n\n**Context:** ...`).
    const qId1 = await storage.writeQuestion("What is the user's timezone?", "ctx1", 0.9);
    const qId2 = await storage.writeQuestion("Does the user prefer dark mode?", "ctx2", 0.5);

    const queue = await storage.readQuestions();
    const queueIds = new Set(queue.map((q) => q.id));
    assert.ok(queueIds.has(qId1) && queueIds.has(qId2), "readQuestions() must still return the queue");

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

test("category dir symlinked outside memoryDir does NOT leak files into fallback recall", async (t) => {
  if (process.platform === "win32") {
    t.skip("directory symlink setup is platform-specific");
    return;
  }
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "engram-1497-symlink-dir-"));
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), "engram-1497-symlink-out-"));
  const storage = new StorageManager(baseDir);
  StorageManager.clearAllStaticCaches();
  storage.invalidateAllMemoriesCacheForDir();
  try {
    await seedMemory(baseDir, "facts", "real-fact", "fact", "A genuine in-store fact.");

    await writeFile(
      path.join(outsideDir, "leaked.md"),
      memoryFile("leaked-secret", "decision", "Out-of-store file must never be recalled."),
      "utf-8",
    );
    await symlink(outsideDir, path.join(baseDir, "decisions"), "dir");

    storage.invalidateAllMemoriesCacheForDir();
    const memories = await storage.readAllMemories();
    const foundIds = new Set(memories.map((m) => m.frontmatter.id));

    assert.ok(foundIds.has("real-fact"), "the genuine in-store fact must still be recalled");
    assert.ok(
      !foundIds.has("leaked-secret"),
      "a symlinked-out category dir must not leak files into recall",
    );
    assert.equal(memories.length, 1, "only the in-store memory should be returned");
  } finally {
    StorageManager.clearAllStaticCaches();
    await rm(baseDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});

test("symlinked entry nested inside a category dir does NOT leak into fallback recall", async (t) => {
  if (process.platform === "win32") {
    t.skip("directory symlink setup is platform-specific");
    return;
  }
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "engram-1497-symlink-entry-"));
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), "engram-1497-symlink-entry-out-"));
  const storage = new StorageManager(baseDir);
  StorageManager.clearAllStaticCaches();
  storage.invalidateAllMemoriesCacheForDir();
  try {
    await seedMemory(baseDir, "facts", "real-fact", "fact", "A genuine in-store fact.");

    await writeFile(
      path.join(outsideDir, "leaked.md"),
      memoryFile("nested-leak", "fact", "Out-of-store nested file must never be recalled."),
      "utf-8",
    );
    await symlink(outsideDir, path.join(baseDir, "facts", "escape"), "dir");

    storage.invalidateAllMemoriesCacheForDir();
    const memories = await storage.readAllMemories();
    const foundIds = new Set(memories.map((m) => m.frontmatter.id));

    assert.ok(foundIds.has("real-fact"), "the genuine in-store fact must still be recalled");
    assert.ok(
      !foundIds.has("nested-leak"),
      "a symlinked entry escaping the store must not leak files into recall",
    );
    assert.equal(memories.length, 1, "only the in-store memory should be returned");
  } finally {
    StorageManager.clearAllStaticCaches();
    await rm(baseDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});

test("a guarded/skipped sibling entry does NOT drop nested in-store memories", async (t) => {
  if (process.platform === "win32") {
    t.skip("directory symlink setup is platform-specific");
    return;
  }
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "engram-1497-sibling-"));
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), "engram-1497-sibling-out-"));
  const storage = new StorageManager(baseDir);
  StorageManager.clearAllStaticCaches();
  storage.invalidateAllMemoriesCacheForDir();
  try {
    const factsDir = path.join(baseDir, "facts");
    await mkdir(factsDir, { recursive: true });
    // A top-level in-store memory and a nested in-store memory in the SAME
    // category dir that also holds the symlinked-out sibling.
    await writeFile(
      path.join(factsDir, "top.md"),
      memoryFile("top-fact", "fact", "Top-level in-store fact."),
      "utf-8",
    );
    await seedMemory(baseDir, "facts", "deep-fact", "fact", "Deeply nested in-store fact.", {
      nested: true,
    });

    await writeFile(
      path.join(outsideDir, "leaked.md"),
      memoryFile("leaked-secret", "fact", "Out-of-store file must never be recalled."),
      "utf-8",
    );
    await symlink(outsideDir, path.join(factsDir, "escape"), "dir");

    storage.invalidateAllMemoriesCacheForDir();
    const memories = await storage.readAllMemories();
    const foundIds = new Set(memories.map((m) => m.frontmatter.id));

    assert.ok(foundIds.has("top-fact"), "the top-level in-store fact must be recalled");
    assert.ok(
      foundIds.has("deep-fact"),
      "the nested in-store fact must still be recalled past a skipped sibling",
    );
    assert.ok(!foundIds.has("leaked-secret"), "the symlinked-out file must not leak");
    assert.equal(memories.length, 2, "exactly the two in-store memories should be returned");
  } finally {
    StorageManager.clearAllStaticCaches();
    await rm(baseDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});

test("QMD-disabled deployment: disk-scan collector returns all categories", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "engram-1497-qmd-off-"));
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
