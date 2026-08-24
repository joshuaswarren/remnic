import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { parseConfig } from "../config.js";
import { NamespaceStorageRouter } from "../namespaces/storage.js";
import { StorageManager } from "../storage.js";
import { withTempDir } from "../testing/tmp-dir.js";
import {
  createJournalMemoryWriter,
  runJournalReviewExtraction,
  type JournalExtractionDeps,
} from "./journal-extract.js";

const FACT = "I decided to encrypt the journal write path.";
const MAGIC = Buffer.from("REMNIC-ENC");

function walkFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

function extractDeps(storage: StorageManager, category: "decision" | "fact" = "decision"): JournalExtractionDeps {
  return {
    extract: async () => ({
      facts: [
        {
          content: FACT,
          category,
          confidence: 0.9,
          tags: [],
          entityRef: undefined,
        },
      ],
      profileUpdates: [],
      entities: [],
      questions: [],
    }),
    writer: createJournalMemoryWriter(storage),
  };
}

test("journal writer encrypts on-disk bodies and never stores the fact as plaintext", async () => {
  await withTempDir(async (dir) => {
    const config = parseConfig({ memoryDir: dir });
    const storage = new StorageManager(config.memoryDir);
    await storage.ensureDirectories();
    storage.setSecureStoreRequired(true);
    storage.setSecureStoreKey(Buffer.alloc(32, 7));
    const result = await runJournalReviewExtraction({
      date: "2026-08-20",
      journalText: FACT,
      source: "memoryDir",
      journalConfig: { extractionMode: "review" },
      deps: extractDeps(storage),
    });
    assert.equal(result.completed, true);
    assert.equal(result.pendingReview, 1);
    const bodies = walkFiles(dir)
      .filter((file) => !file.includes(`${path.sep}state${path.sep}`))
      .map((file) => readFileSync(file));
    assert.ok(bodies.some((buf) => buf.subarray(0, MAGIC.length).equals(MAGIC)));
    assert.equal(
      bodies.some((buf) => buf.toString("utf8").includes(FACT)),
      false,
      "encrypted journal writes must not leave the fact as plaintext",
    );
  });
});

test("journal writer uses NamespaceStorageRouter.storageFor(defaultNamespace)", async () => {
  await withTempDir(async (dir) => {
    const config = parseConfig({ memoryDir: dir });
    const router = new NamespaceStorageRouter(config);
    const storage = await router.storageFor(config.defaultNamespace);
    await storage.ensureDirectories();
    const result = await runJournalReviewExtraction({
      date: "2026-08-20",
      journalText: FACT,
      source: "memoryDir",
      journalConfig: { extractionMode: "review" },
      deps: extractDeps(storage),
    });
    assert.equal(result.completed, true);
    assert.equal(result.pendingReview, 1);
    assert.ok(walkFiles(dir).some((file) => statSync(file).isFile()));
  });
});

test("tombstoned journal facts are skipped and not written as pending_review", async () => {
  await withTempDir(async (dir) => {
    const config = parseConfig({ memoryDir: dir });
    const storage = new StorageManager(config.memoryDir);
    await storage.ensureDirectories();
    storage.setTombstonesConfig({
      enabled: true,
      semanticMatch: false,
      semanticThreshold: 0.9,
      namespace: config.defaultNamespace,
    });
    const tombstoneId = await storage.appendTombstone({
      reason: "correction",
      createdBy: "user_correction",
      sourceMemoryId: "retired-journal-fact",
      rawContent: FACT,
    });
    assert.ok(tombstoneId);
    const before = walkFiles(dir);
    const result = await runJournalReviewExtraction({
      date: "2026-08-20",
      journalText: FACT,
      source: "memoryDir",
      journalConfig: { extractionMode: "review" },
      deps: extractDeps(storage, "fact"),
    });
    assert.equal(result.completed, true);
    assert.equal(result.pendingReview, 0);
    assert.equal(result.skipped, 1);
    const after = walkFiles(dir).filter((file) => !before.includes(file));
    const pending = after.filter((file) => file.includes("pending_review") || file.includes("pending-review"));
    assert.equal(pending.length, 0, "tombstoned content must not land as a new pending_review file");
  });
});
