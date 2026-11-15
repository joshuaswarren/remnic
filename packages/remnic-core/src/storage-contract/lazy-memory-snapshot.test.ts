/**
 * COS-666d: loading the corpus built a key-sorted JSON snapshot of every memory
 * (`createMemorySnapshot`), 5-6.6 s of synchronous main-thread work at ~120k
 * facts on every cache rebuild, for a value only `moveMemoryToPath` reads. The
 * snapshot is now derived from the raw file text the loader already keeps, at
 * the moment a tier move needs it, and means the same thing: the memory as it
 * was loaded.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { StorageManager } from "../storage.js";
import type { MemoryFile } from "../types.js";
import { resetStaticCaches } from "./harness.js";

/** Calls to the snapshot serializer: JSON.stringify with a replacer function. */
async function countSnapshotCalls<T>(fn: () => Promise<T>): Promise<{ result: T; calls: number }> {
  const real = JSON.stringify;
  let calls = 0;
  JSON.stringify = ((...args: unknown[]) => {
    if (typeof args[1] === "function") calls++;
    return (real as (...a: unknown[]) => string)(...args);
  }) as typeof JSON.stringify;
  try {
    return { result: await fn(), calls };
  } finally {
    JSON.stringify = real;
  }
}

async function withStorage(run: (storage: StorageManager, dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-lazy-snapshot-"));
  try {
    resetStaticCaches();
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    await run(storage, dir);
  } finally {
    resetStaticCaches();
    await rm(dir, { recursive: true, force: true });
  }
}

test("reading the corpus builds no snapshots", async () => {
  await withStorage(async (storage) => {
    for (let i = 0; i < 12; i++) await storage.writeMemory("fact", `lazy snapshot fact ${i}`);
    resetStaticCaches();
    const { result, calls } = await countSnapshotCalls(() => storage.readAllMemories());
    assert.equal(result.length, 12);
    assert.equal(calls, 0, "no snapshot may be built while loading the corpus");
    const byPath = await countSnapshotCalls(() => storage.readMemoryByPath(result[0].path));
    assert.ok(byPath.result);
    assert.equal(byPath.calls, 0);
  });
});

test("a tier move still succeeds for a loaded memory the caller mutated, and builds the snapshot only then", async () => {
  await withStorage(async (storage) => {
    const { id } = await storage.writeMemory("fact", "original disk content");
    const memory = (await storage.readAllMemories()).find((m) => m.frontmatter.id === id);
    assert.ok(memory);
    memory.content = "caller mutated unpersisted content";
    const targetPath = storage.buildTierMemoryPath(memory, "cold");
    const { result, calls } = await countSnapshotCalls(() => storage.moveMemoryToPath(memory, targetPath));
    assert.equal(result, true);
    assert.ok(calls > 0, "the move compares snapshots");
    assert.ok((await readFile(targetPath, "utf8")).includes("original disk content"));
  });
});

test("a tier move refuses when the file changed on disk since it was loaded", async () => {
  await withStorage(async (storage) => {
    const { id } = await storage.writeMemory("fact", "unmodified content");
    const memory = (await storage.readAllMemories()).find((m) => m.frontmatter.id === id);
    assert.ok(memory);
    const disk = await readFile(memory.path, "utf8");
    await writeFile(memory.path, disk.replace("unmodified content", "external edit on disk"));
    await assert.rejects(
      () => storage.moveMemoryToPath(memory, storage.buildTierMemoryPath(memory, "cold")),
      /changed before its tier move/,
    );
  });
});

test("a tier move ignores a rewrite that only reorders frontmatter keys (the snapshot is key-order independent)", async () => {
  await withStorage(async (storage) => {
    const { id } = await storage.writeMemory("fact", "reordered frontmatter");
    const memory = (await storage.readAllMemories()).find((m) => m.frontmatter.id === id);
    assert.ok(memory);
    const disk = await readFile(memory.path, "utf8");
    const [, front, body] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(disk) ?? [];
    assert.ok(front && body !== undefined, "memory file has frontmatter");
    await writeFile(memory.path, `---\n${front.split("\n").reverse().join("\n")}\n---\n${body}`);
    assert.equal(await storage.moveMemoryToPath(memory, storage.buildTierMemoryPath(memory, "cold")), true);
  });
});

test("a memory with no retained file text falls back to an eager snapshot", async () => {
  await withStorage(async (storage) => {
    const { id } = await storage.writeMemory("fact", "no raw text");
    const loaded = (await storage.readAllMemories()).find((m) => m.frontmatter.id === id);
    assert.ok(loaded);
    // A handcrafted object has no retained raw document and was never loaded: the old fallback
    // compares `frontmatter.updated` only, so the same state moves and a changed one is refused.
    const copy: MemoryFile = { path: loaded.path, frontmatter: { ...loaded.frontmatter }, content: loaded.content };
    assert.equal(await storage.moveMemoryToPath(copy, storage.buildTierMemoryPath(copy, "cold")), true);
  });
});
