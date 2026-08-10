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
test("bounds archive indexes across distinct storage roots", async () => {
  const loader = new GraphPathStateLoader();
  const internals = loader as unknown as LoaderInternals;
  const roots: string[] = [];
  internals.buildArchivePathIndex = async (storageRoot, version) => ({
    version,
    pathsByBasename: new Map([
      ["node.md", [path.join(storageRoot, "archive", "node.md")]],
    ]),
  });

  try {
    for (let index = 0; index < 33; index += 1) {
      const root = await mkdtemp(path.join(os.tmpdir(), "remnic-graph-loader-bound-"));
      roots.push(root);
      const archivePath = path.join(root, "archive", "node.md");
      const storage = fakeStorage(root, archivePath, memory(archivePath, String(index)));
      const result = await loader.readNode(storage, "node.md", null, true);
      assert.equal(result?.content, String(index));
    }

    assert.equal(internals.archivePathIndexes?.size, 32);
  } finally {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  }
});

test("rejects a symlinked configured storage root before scanning its target", async () => {
  if (process.platform === "win32") return;
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-graph-loader-symlink-"));
  try {
    const target = path.join(root, "target");
    const link = path.join(root, "link");
    const directPath = path.join(target, "node.md");
    const archivePath = path.join(target, "archive", "2026-01-01", "node.md");
    await mkdir(path.dirname(archivePath), { recursive: true });
    await writeFile(directPath, "direct", "utf8");
    await writeFile(archivePath, "archive", "utf8");
    await symlink(target, link);

    let readCount = 0;
    let versionCount = 0;
    const storage = {
      dir: link,
      getCorpusScanVersion: async () => {
        versionCount += 1;
        return "v1";
      },
      readMemoryByPath: async () => {
        readCount += 1;
        return memory(directPath, "target");
      },
    } as unknown as StorageManager;

    const loader = new GraphPathStateLoader();

    assert.equal(await loader.readNode(storage, "node.md", null, true), null);
    assert.equal(readCount, 0);
    assert.equal(versionCount, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a dangling symlinked configured storage root before scanning", async () => {
  if (process.platform === "win32") return;
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-graph-loader-dangling-"));
  try {
    const link = path.join(root, "link");
    await symlink(path.join(root, "missing-target"), link);

    let readCount = 0;
    let versionCount = 0;
    const storage = {
      dir: link,
      getCorpusScanVersion: async () => {
        versionCount += 1;
        return "v1";
      },
      readMemoryByPath: async () => {
        readCount += 1;
        return memory(path.join(link, "node.md"), "unexpected");
      },
    } as unknown as StorageManager;

    const loader = new GraphPathStateLoader();

    assert.equal(await loader.readNode(storage, "node.md", null, true), null);
    assert.equal(readCount, 0);
    assert.equal(versionCount, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
