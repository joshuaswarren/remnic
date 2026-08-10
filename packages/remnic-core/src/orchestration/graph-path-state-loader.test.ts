import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { GraphPathStateLoader } from "./graph-path-state-loader.js";
import type { MemoryFile } from "../types.js";
import type { StorageManager } from "../index.js";

type LoaderInternals = {
  archivePathIndexes?: Map<string, { version: string; pathsByBasename: Map<string, string[]> }>;
  buildArchivePathIndex: (
    storageRoot: string,
    version: string,
    deadlineAtMs: number | null | undefined,
  ) => Promise<{ version: string; pathsByBasename: Map<string, string[]> } | null>;
};

function memory(filePath: string, content: string, id = "node"): MemoryFile {
  return {
    path: filePath,
    content,
    frontmatter: {
      id,
      category: "fact",
      created: "2026-01-01T00:00:00.000Z",
      updated: "2026-01-01T00:00:00.000Z",
      source: "test",
      confidence: 1,
      status: "archived",
    },
  } as MemoryFile;
}

function fakeStorage(
  root: string,
  archivePath: string,
  result: MemoryFile,
  versionRef: { value: string } = { value: "v1" },
): StorageManager {
  return {
    dir: root,
    getCorpusScanVersion: async () => versionRef.value,
    readMemoryByPath: async (filePath: string) =>
      filePath === archivePath ? result : null,
  } as unknown as StorageManager;
}

test("does not return archive state when the memory id mismatches", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-graph-loader-id-"));
  try {
    const archivePath = path.join(root, "archive", "2026-01-01", "node.md");
    await mkdir(path.dirname(archivePath), { recursive: true });
    await writeFile(archivePath, "archive", "utf8");
    const storage = fakeStorage(
      root,
      archivePath,
      memory(archivePath, "mismatch", "other"),
    );
    const loader = new GraphPathStateLoader();

    assert.equal(await loader.readNode(storage, "node.md", null, true), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not share a deadline-bound archive build with a later caller", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-graph-loader-timeout-"));
  try {
    const archivePath = path.join(root, "archive", "2026-01-01", "node.md");
    const result = memory(archivePath, "success");
    const storage = fakeStorage(root, archivePath, result);
    const loader = new GraphPathStateLoader();
    const internals = loader as unknown as LoaderInternals;
    internals.buildArchivePathIndex = async (_storageRoot, version, deadlineAtMs) => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      if (typeof deadlineAtMs === "number" && Date.now() >= deadlineAtMs) return null;
      return { version, pathsByBasename: new Map([["node.md", [archivePath]]]) };
    };

    const timedOut = loader.readNode(storage, "node.md", Date.now() + 5, true);
    await new Promise((resolve) => setTimeout(resolve, 1));
    const successful = loader.readNode(storage, "node.md", Date.now() + 100, true);
    const [timedOutResult, successfulResult] = await Promise.all([timedOut, successful]);

    assert.equal(timedOutResult, null);

    assert.equal(successfulResult?.content, "success");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("evicts prior archive indexes for the same storage root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-graph-loader-cache-"));
  try {
    const versionRef = { value: "v1" };
    const archivePath = path.join(root, "archive", "2026-01-01", "node.md");
    const storage = fakeStorage(root, archivePath, memory(archivePath, "unused"), versionRef);
    const loader = new GraphPathStateLoader();
    const internals = loader as unknown as LoaderInternals;

    await loader.readNode(storage, "node.md", null, true);
    versionRef.value = "v2";
    await loader.readNode(storage, "node.md", null, true);

    assert.equal(internals.archivePathIndexes?.size, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keys archive indexes by canonical storage root after symlink retarget", async () => {
  if (process.platform === "win32") return;
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-graph-loader-symlink-"));
  try {
    const physicalA = path.join(root, "a");
    const physicalB = path.join(root, "b");
    const link = path.join(root, "link");
    const archiveA = path.join(physicalA, "archive", "2026-01-01", "node.md");
    const archiveB = path.join(physicalB, "archive", "2026-01-01", "node.md");
    await mkdir(path.dirname(archiveA), { recursive: true });
    await mkdir(path.dirname(archiveB), { recursive: true });
    await writeFile(archiveA, "a", "utf8");
    await writeFile(archiveB, "b", "utf8");
    await symlink(physicalA, link);

    const loader = new GraphPathStateLoader();
    const storage = fakeStorage(link, archiveA, memory(archiveA, "a"));
    const first = await loader.readNode(storage, "node.md", null, true);
    assert.equal(first?.content, "a");

    await rm(link);
    await symlink(physicalB, link);
    storage.readMemoryByPath = async (filePath: string) =>
      filePath === archiveB ? memory(archiveB, "b") : null;
    const second = await loader.readNode(storage, "node.md", null, true);
    assert.equal(second?.content, "b");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
