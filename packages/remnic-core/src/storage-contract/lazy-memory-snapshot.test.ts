/**
 * COS-666d: loading the corpus built a key-sorted JSON snapshot of every memory
 * (`createMemorySnapshot`), 5-6.6 s of synchronous main-thread work at ~120k
 * facts on every cache rebuild, for a value only `moveMemoryToPath` reads. The
 * snapshot is now derived from the raw file text the loader already keeps, at
 * the moment a tier move needs it, and means the same thing: the memory as it
 * was loaded.
 */

import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { StorageManager } from "../storage.js";
import type { MemoryFile } from "../types.js";
import { resetStaticCaches } from "./harness.js";

/** Calls to the snapshot serializer: the only JSON.stringify here that is given a replacer function. */
async function countSnapshotCalls<T>(fn: () => Promise<T>): Promise<{ result: T; calls: number }> {
  const spy = mock.method(JSON, "stringify");
  try {
    const result = await fn();
    return { result, calls: spy.mock.calls.filter((call) => call.arguments[1] instanceof Function).length };
  } finally {
    spy.mock.restore();
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
    const closing = disk.indexOf("\n---\n", 4);
    assert.ok(disk.startsWith("---\n") && closing > 0, "memory file has frontmatter");
    const front = disk.slice(4, closing);
    const body = disk.slice(closing + 5);
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

test("a loaded archive-path memory whose file has no status still moves (loaded status is archived)", async () => {
  await withStorage(async (storage, dir) => {
    const { id } = await storage.writeMemory("fact", "archived without status");
    const source = (await storage.readAllMemories()).find((m) => m.frontmatter.id === id);
    assert.ok(source);
    const archivedPath = path.join(dir, "archive", "2026-01-01", `${id}.md`);
    await mkdir(path.dirname(archivedPath), { recursive: true });
    await rename(source.path, archivedPath);
    resetStaticCaches();
    const memory = (await storage.readArchivedMemories()).find((m) => m.frontmatter.id === id);
    assert.ok(memory);
    assert.equal(memory.frontmatter.status, "archived");
    assert.equal(await storage.moveMemoryToPath(memory, storage.buildTierMemoryPath(memory, "cold")), true);
  });
});

test("a tier move ignores caller edits to a loaded memory's frontmatter, not just its content", async () => {
  await withStorage(async (storage) => {
    const { id } = await storage.writeMemory("fact", "frontmatter edited by caller", { tags: ["kept"] });
    const memory = (await storage.readAllMemories()).find((m) => m.frontmatter.id === id);
    assert.ok(memory);
    memory.frontmatter.tags = [...memory.frontmatter.tags, "caller-only"];
    memory.frontmatter.confidence = 0.01;
    memory.frontmatter.created = "2000-01-01T00:00:00.000Z";
    memory.frontmatter.updated = "2000-01-02T00:00:00.000Z";
    assert.equal(await storage.moveMemoryToPath(memory, storage.buildTierMemoryPath(memory, "cold")), true);
  });
});

test("a file with no created or updated is refused on every move, not only when the clock ticks", async () => {
  await withStorage(async (storage) => {
    const memories: MemoryFile[] = [];
    for (let i = 0; i < 12; i++) {
      const { id } = await storage.writeMemory("fact", `no timestamps ${i}`);
      const file = (await storage.readAllMemories()).find((m) => m.frontmatter.id === id);
      assert.ok(file);
      const disk = await readFile(file.path, "utf8");
      await writeFile(file.path, disk.replace(/^(created|updated): .*\n/gm, ""));
    }
    resetStaticCaches();
    for (const m of await storage.readAllMemories()) if (m.content.startsWith("no timestamps")) memories.push(m);
    assert.equal(memories.length, 12);
    await new Promise((resolve) => setTimeout(resolve, 5)); // a fresh parse now stamps a later millisecond
    for (const memory of memories) {
      await assert.rejects(
        () => storage.moveMemoryToPath(memory, storage.buildTierMemoryPath(memory, "cold")),
        /changed before its tier move/,
      );
    }
  });
});

test("a loaded memory under an entities path moves: the snapshot normalizes with the file's content", async () => {
  await withStorage(async (storage, dir) => {
    const { id } = await storage.writeMemory("fact", "**Type:** vendor\n\nan entity-like note");
    const source = (await storage.readAllMemories()).find((m) => m.frontmatter.id === id);
    assert.ok(source);
    const entityPath = path.join(dir, "facts", "entities", `${id}.md`);
    await mkdir(path.dirname(entityPath), { recursive: true });
    await rename(source.path, entityPath);
    resetStaticCaches();
    const memory = (await storage.readAllMemories()).find((m) => m.frontmatter.id === id);
    assert.ok(memory);
    assert.ok(memory.frontmatter.tags.includes("vendor"), "loaded tags carry the type read from the content");
    assert.equal(await storage.moveMemoryToPath(memory, storage.buildTierMemoryPath(memory, "cold")), true);
  });
});

test("an indented created or updated key counts as present: caller edits to it do not refuse the move", async () => {
  await withStorage(async (storage) => {
    const { id } = await storage.writeMemory("fact", "indented timestamp keys");
    const file = (await storage.readAllMemories()).find((m) => m.frontmatter.id === id);
    assert.ok(file);
    const disk = await readFile(file.path, "utf8");
    await writeFile(file.path, disk.replace(/^(created|updated):/gm, "  $1:"));
    resetStaticCaches();
    const memory = (await storage.readAllMemories()).find((m) => m.frontmatter.id === id);
    assert.ok(memory);
    memory.frontmatter.created = "2000-01-01T00:00:00.000Z";
    memory.frontmatter.updated = "2000-01-02T00:00:00.000Z";
    assert.equal(await storage.moveMemoryToPath(memory, storage.buildTierMemoryPath(memory, "cold")), true);
  });
});
