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
import { mkdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import type { MemoryCategory } from "../types.js";
import test from "node:test";

import { StorageManager } from "../storage.js";
import { SecureStoreLockedError } from "../secure-store/secure-fs.js";
import {
  ALL_CATEGORY_DIRS,
  ALL_CATEGORY_KEYS,
  CATEGORY_DIR_MAP,
  RECALL_NON_MEMORY_DIRS,
  categoryDirName,
} from "../utils/category-dir.js";
import { makeStorage, rawMemoryMarkdown } from "./harness.js";

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
    const { id: id } = await storage.writeMemory("fact", "The sky is blue", {
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
      const { id: id } = await storage.writeMemory(
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
      const { id: id } = await storage.writeMemory(category, content, {
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

test("round-trip: invalidation does not record commit proof by default", async () => {
  const { storage, cleanup } = await makeStorage();
  try {
    const { id } = await storage.writeMemory("fact", "proof source");
    const snapshot = await storage.getMemoryById(id);
    assert.ok(snapshot);

    assert.equal(await storage.invalidateMemory(id), true);
    assert.equal(await storage.hasCommittedInvalidation(snapshot), false);
    const explicitOff = await storage.writeMemory("fact", "proof source with explicit off");
    const explicitSnapshot = await storage.getMemoryById(explicitOff.id);
    assert.ok(explicitSnapshot);
    assert.equal(
      await storage.invalidateMemory(explicitOff.id, undefined, { recordCommitProof: false }),
      true,
    );
    assert.equal(await storage.hasCommittedInvalidation(explicitSnapshot), false);
  } finally {
    await cleanup();
  }
});

test("round-trip: invalidation commit proof survives restart and rejects a changed snapshot", async () => {
  const { storage, baseDir, cleanup } = await makeStorage();
  try {
    const { id } = await storage.writeMemory("fact", "proof source", {
      tags: ["proof"],
    });
    const snapshot = await storage.getMemoryById(id);
    assert.ok(snapshot);

    assert.equal(await storage.invalidateMemory(id, undefined, { recordCommitProof: true }), true);
    assert.equal(await storage.hasCommittedInvalidation(snapshot), true);

    const restarted = new StorageManager(baseDir);
    assert.equal(await restarted.hasCommittedInvalidation(snapshot), true);
    assert.equal(
      await restarted.hasCommittedInvalidation({
        ...snapshot,
        frontmatter: {
          ...snapshot.frontmatter,
          accessCount: 99,
          lastAccessed: "2026-08-09T12:00:00.000Z",
        },
      }),
      true,
    );
    assert.equal(
      await restarted.hasCommittedInvalidation({
        ...snapshot,
        content: "changed source",
      }),
      false,
    );
  } finally {
    await cleanup();
  }
});
test("round-trip: a post-delete failure retains the committed invalidation proof", async () => {
  const { storage, cleanup } = await makeStorage();
  try {
    const { id } = await storage.writeMemory("fact", "proof survives post-delete failure");
    const snapshot = await storage.getMemoryById(id);
    assert.ok(snapshot);
    const managedStorage = storage as unknown as {
      deleteManagedStorageFile: (filePath: string) => Promise<boolean>;
      rebuildTombstoneBlockedCaptureAfterInvalidation: (ownedMarker?: string) => Promise<void>;
    };
    const originalDelete = managedStorage.deleteManagedStorageFile;
    managedStorage.deleteManagedStorageFile = async (filePath) => originalDelete.call(storage, filePath);
    managedStorage.rebuildTombstoneBlockedCaptureAfterInvalidation = async () => {
      throw new Error("synthetic post-delete failure");
    };

    assert.equal(
      await storage.invalidateMemory(id, snapshot, { recordCommitProof: true }),
      false,
    );
    assert.equal(await storage.readMemoryByPath(snapshot.path), null);
    assert.equal(await storage.hasCommittedInvalidation(snapshot), true);
  } finally {
    await cleanup();
  }
});

test("round-trip: dependency propagation queue rejects symlinks in root, parent, and target paths", async () => {
  const { storage, baseDir, cleanup } = await makeStorage("remnic-dependency-queue-symlink-");
  const rootLink = path.join(path.dirname(baseDir), `${path.basename(baseDir)}-root-link`);
  const parentTarget = path.join(path.dirname(baseDir), `${path.basename(baseDir)}-parent-target`);
  const parentLink = path.join(baseDir, "queue-parent-link");
  const targetFile = path.join(path.dirname(baseDir), `${path.basename(baseDir)}-target.json`);
  const targetLink = path.join(baseDir, "queue-target-link.json");
  const payload = JSON.stringify({ value: "synthetic" });
  try {
    await symlink(baseDir, rootLink, "dir");
    const storageWithSymlinkRoot = storage as unknown as { baseDir: string };
    const originalBaseDir = storageWithSymlinkRoot.baseDir;
    try {
      storageWithSymlinkRoot.baseDir = rootLink;
      const rootQueuePath = path.join(rootLink, "state", "dependency-propagation", "ready", "job.json");
      await assert.rejects(() => storage.readDependencyPropagationQueueFile(rootQueuePath));
      await assert.rejects(() => storage.writeDependencyPropagationQueueFile(rootQueuePath, payload));
    } finally {
      storageWithSymlinkRoot.baseDir = originalBaseDir;
    }

    await mkdir(parentTarget, { recursive: true });
    await symlink(parentTarget, parentLink, "dir");
    const parentQueuePath = path.join(parentLink, "job.json");
    await assert.rejects(() => storage.readDependencyPropagationQueueFile(parentQueuePath));
    await assert.rejects(() => storage.writeDependencyPropagationQueueFile(parentQueuePath, payload));

    await writeFile(targetFile, payload, "utf8");
    await symlink(targetFile, targetLink);
    await assert.rejects(() => storage.readDependencyPropagationQueueFile(targetLink));
    await assert.rejects(() => storage.writeDependencyPropagationQueueFile(targetLink, payload));
  } finally {
    await rm(rootLink, { recursive: true, force: true });
    await rm(parentLink, { recursive: true, force: true });
    await rm(parentTarget, { recursive: true, force: true });
    await rm(targetLink, { force: true });
    await rm(targetFile, { force: true });
    await cleanup();
  }
});

test("dependency propagation queue storage encrypts payload and fails closed while locked", async () => {
  const { storage, baseDir, cleanup } = await makeStorage("remnic-dependency-queue-storage-");
  const queuePath = path.join(baseDir, "state", "dependency-propagation", "ready", "job.json");
  const payload = JSON.stringify({ secret: "synthetic queue payload" });
  const key = Buffer.alloc(32, 37);
  try {
    storage.setSecureStoreRequired(true);
    storage.setSecureStoreKey(key);
    await storage.writeDependencyPropagationQueueFile(queuePath, payload);

    const raw = await readFile(queuePath, "utf8");
    assert.doesNotMatch(raw, /synthetic queue payload/);

    const unlocked = new StorageManager(baseDir);
    unlocked.setSecureStoreRequired(true);
    unlocked.setSecureStoreKey(key);
    assert.equal(await unlocked.readDependencyPropagationQueueFile(queuePath), payload);

    const locked = new StorageManager(baseDir);
    locked.setSecureStoreRequired(true);
    await assert.rejects(
      () => locked.readDependencyPropagationQueueFile(queuePath),
      SecureStoreLockedError,
    );
    await assert.rejects(
      () => locked.writeDependencyPropagationQueueFile(queuePath, payload),
      SecureStoreLockedError,
    );
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

test("round-trip: archive fallback skips a bad file and returns readable siblings", async () => {
  const { storage, baseDir, cleanup } = await makeStorage("remnic-archive-fallback-");
  try {
    const archiveDir = path.join(baseDir, "archive", "2026-08-10");
    await mkdir(archiveDir, { recursive: true });
    await writeFile(
      path.join(archiveDir, "readable.md"),
      rawMemoryMarkdown("archived-readable", "fact", "readable archive content"),
      "utf-8",
    );
    await writeFile(path.join(archiveDir, "broken.md"), "not markdown", "utf-8");

    const archived = await storage.readArchivedMemories();
    assert.deepEqual(
      archived.map((memory) => memory.frontmatter.id),
      ["archived-readable"],
    );
  } finally {
    await cleanup();
  }
});

test("round-trip: ALL_CATEGORY_DIRS is exactly facts + every CATEGORY_DIR_MAP value", () => {
  // ALL_CATEGORY_DIRS must contain directory NAMES (facts, decisions, ...) not
  // singular keys (fact, decision, ...). This guards the parity between
  // categoryDirName() and the scan roots — a divergence would silently drop
  // a category from recall.
  const expected = new Set(["facts", ...Object.values(CATEGORY_DIR_MAP)]);
  assert.deepEqual(new Set(ALL_CATEGORY_DIRS), expected);
  // No singular keys leaked in
  for (const dir of ALL_CATEGORY_DIRS) {
    assert.ok(!Object.hasOwn(CATEGORY_DIR_MAP, dir),
      `${dir} is a singular category key, not a directory name`);
  }
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
    // Directory mtimes are only a cross-process hint and may be coarser than
    // the cache timestamp. Same-process resolution must invalidate directly.
    await utimes(path.join(storage.dir, "questions"), new Date(0), new Date(0));

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
