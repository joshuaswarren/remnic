/**
 * recall-recognition-index.test.ts — issue #2975 write-path maintenance slice.
 *
 * Pins: when recallRecognitionTier is on, a namespace write upserts the
 * memory id into state/index_recognition.json so loadRecognitionIndex
 * sees a fresh entry. Gate-off is zero index I/O. Descriptions are the
 * first non-empty body line (no recognition-trigger generation here).
 */
import assert from "node:assert/strict";
import { mock } from "node:test";
import os from "node:os";
import path from "node:path";
import { promises as fsp } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";

import { parseConfig } from "../config.js";
import { loadRecognitionIndex, recognitionIndexPath } from "../recall-recognition-tier.js";
import { PersistenceIndexCoordinator } from "./persistence-index.js";
import { maintainRecognitionIndexAfterWrite } from "./recall-recognition-index.js";
import type { MemoryFile, PluginConfig } from "../types.js";

async function tmpNamespace(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "remnic-recognition-index-"));
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fsp.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

test("acceptance: gate-off write is zero index I/O", async () => {
  const dir = await tmpNamespace();
  const spies = [
    mock.method(fsp, "readFile"),
    mock.method(fsp, "writeFile"),
    mock.method(fsp, "mkdir"),
    mock.method(fsp, "open"),
    mock.method(fsp, "rename"),
    mock.method(fsp, "rm"),
    mock.method(fsp, "unlink"),
    mock.method(fsp, "stat"),
    mock.method(fsp, "access"),
    mock.method(fsp, "readdir"),
  ];
  try {
    await maintainRecognitionIndexAfterWrite({
      memoryDir: dir,
      enabled: false,
      changes: [{ action: "upsert", id: "fact-001", content: "SSD inference chips in the lab rack.\nMore body." }],
    });
    for (const spy of spies) {
      assert.equal(spy.mock.calls.length, 0, `${String(spy.mock.calls.length)} unexpected fs calls on the off path`);
    }
    assert.equal(await exists(recognitionIndexPath(dir)), false);
    assert.equal(await loadRecognitionIndex(dir), null);
  } finally {
    for (const spy of spies) spy.mock.restore();
    await rm(dir, { recursive: true, force: true });
  }
});

test("acceptance: gate-on write upserts id so loadRecognitionIndex sees a fresh entry", async () => {
  const dir = await tmpNamespace();
  try {
    await maintainRecognitionIndexAfterWrite({
      memoryDir: dir,
      enabled: true,
      changes: [
        {
          action: "upsert",
          id: "fact-001",
          content: "SSD inference chips in the lab rack.\nRunning the model off a local tier.",
        },
      ],
    });
    const index = await loadRecognitionIndex(dir);
    assert.ok(index, "index must exist after an enabled write");
    assert.deepEqual(index.entries, [
      { id: "fact-001", description: "SSD inference chips in the lab rack." },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("incremental write updates an existing id in place and appends a new id", async () => {
  const dir = await tmpNamespace();
  try {
    await maintainRecognitionIndexAfterWrite({
      memoryDir: dir,
      enabled: true,
      changes: [{ action: "upsert", id: "m-001", content: "first line original" }],
    });
    await maintainRecognitionIndexAfterWrite({
      memoryDir: dir,
      enabled: true,
      changes: [
        { action: "upsert", id: "m-001", content: "first line rewritten\nbody" },
        { action: "upsert", id: "m-002", content: "second memory trigger" },
      ],
    });
    const index = await loadRecognitionIndex(dir);
    assert.deepEqual(index?.entries, [
      { id: "m-001", description: "first line rewritten" },
      { id: "m-002", description: "second memory trigger" },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("remove drops the id; blank ids are ignored without writing", async () => {
  const dir = await tmpNamespace();
  try {
    await maintainRecognitionIndexAfterWrite({
      memoryDir: dir,
      enabled: true,
      changes: [
        { action: "upsert", id: "keep", content: "kept" },
        { action: "upsert", id: "drop", content: "gone" },
      ],
    });
    await maintainRecognitionIndexAfterWrite({
      memoryDir: dir,
      enabled: true,
      changes: [{ action: "remove", id: "drop" }],
    });
    assert.deepEqual((await loadRecognitionIndex(dir))?.entries, [
      { id: "keep", description: "kept" },
    ]);

    const before = await fsp.readFile(recognitionIndexPath(dir), "utf8");
    await maintainRecognitionIndexAfterWrite({
      memoryDir: dir,
      enabled: true,
      changes: [{ action: "upsert", id: "   ", content: "blank id is dropped" }],
    });
    assert.equal(await fsp.readFile(recognitionIndexPath(dir), "utf8"), before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function memory(id: string, content: string): MemoryFile {
  return {
    path: `/tmp/${id}.md`,
    content,
    frontmatter: { id, category: "fact", created: "2026-08-25T00:00:00.000Z", updated: "2026-08-25T00:00:00.000Z", source: "test", confidence: 1, confidenceTier: "explicit", tags: [] },
  };
}

function stubCoordinator(config: PluginConfig) {
  return new PersistenceIndexCoordinator({
    config,
    contentHashIndex: null,
    contentHashIndexForStorage: async () => null,
    contentHashIndexesByStorageDir: new Map(),
    embeddingFallback: { isAvailable: async () => false } as never,
    graphIndexFor: () => {
      throw new Error("graph unused");
    },
    readAllMemoriesForNamespaces: async () => [],
    semanticDedupScopeFor: () => ({}),
  });
}

test("persist-path: enabled writes update the namespace index; disabled stays quiet", async () => {
  const dir = await tmpNamespace();
  const memories = new Map<string, MemoryFile>([
    ["fact-ssd", memory("fact-ssd", "Running the model off an SSD tier.\nDetails.")],
  ]);
  const storage = {
    dir,
    getMemoryById: async (id: string) => memories.get(id) ?? null,
    getMemoryByIdIncludingArchived: async (id: string) => memories.get(id) ?? null,
    readAllMemories: async () => [...memories.values()],
    readAllColdMemories: async () => [],
  };
  try {
    const off = stubCoordinator(parseConfig({}));
    await off.updateTemporalTagIndexes(storage as never, ["fact-ssd"]);
    assert.equal(await exists(recognitionIndexPath(dir)), false, "off-path persist must not mint an index");

    const on = stubCoordinator(parseConfig({ recallRecognitionTier: true }));
    await on.updateTemporalTagIndexes(storage as never, ["fact-ssd"]);
    const index = await loadRecognitionIndex(dir);
    assert.deepEqual(index?.entries, [
      { id: "fact-ssd", description: "Running the model off an SSD tier." },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
