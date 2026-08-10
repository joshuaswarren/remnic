import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { GraphPathStateLoader } from "./graph-path-state-loader.js";
import type { MemoryFile } from "../types.js";
import type { StorageManager } from "../index.js";

type LoaderInternals = {
  archivePathIndexes?: Map<string, { version: number; pathsByBasename: Map<string, string[]> }>;
  archivePathIndexBuilds?: Map<string, Promise<{ version: number; pathsByBasename: Map<string, string[]> } | null>>;
  buildArchivePathIndex: (
    storageRoot: string,
    version: number,
  ) => Promise<{ version: number; pathsByBasename: Map<string, string[]> } | null>;
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
  archiveVersionRef: { value: number } = { value: 1 },
  corpusVersionRef: { value: string } = { value: "hot:1:cold:1" },
): StorageManager {
  return {
    dir: root,
    getArchiveMutationVersion: () => archiveVersionRef.value,
    getCorpusScanVersion: async () => corpusVersionRef.value,
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
test("prefers an active cold direct path over an inactive hot duplicate", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-graph-loader-duplicate-tier-"));
  try {
    const hotPath = path.join(root, "node.md");
    const coldPath = path.join(root, "cold", "node.md");
    await mkdir(path.dirname(coldPath), { recursive: true });
    await writeFile(hotPath, "hot", "utf8");
    await writeFile(coldPath, "cold", "utf8");
    const hot = memory(hotPath, "inactive");
    hot.frontmatter.status = "superseded";
    const cold = memory(coldPath, "active");
    cold.frontmatter.status = "active";
    const storage = {
      dir: root,
      getArchiveMutationVersion: () => 1,
      getCorpusScanVersion: async () => "hot:1:cold:1",
      readMemoryByPath: async (filePath: string) =>
        filePath === hotPath ? hot : filePath === coldPath ? cold : null,
    } as unknown as StorageManager;

    assert.equal((await new GraphPathStateLoader().readNode(storage, "node.md", null, true))?.content, "active");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not poison a shared archive build with a short caller deadline", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-graph-loader-timeout-"));
  try {
    const archiveRoot = path.join(root, "archive");
    const archivePath = path.join(archiveRoot, "node.md");
    await mkdir(archiveRoot, { recursive: true });
    await writeFile(archivePath, "archive", "utf8");
    await Promise.all(
      Array.from({ length: 4096 }, (_, index) =>
        writeFile(path.join(archiveRoot, `noise-${index}.txt`), "noise", "utf8"),
      ),
    );
    const storage = fakeStorage(root, archivePath, memory(archivePath, "success"));
    const loader = new GraphPathStateLoader();

    const timedOut = loader.readNode(storage, "node.md", Date.now() + 1, true);
    await Promise.resolve();
    const successful = loader.readNode(storage, "node.md", Date.now() + 2_000, true);
    const [timedOutResult, successfulResult] = await Promise.all([timedOut, successful]);

    assert.equal(timedOutResult, null);
    assert.equal(successfulResult?.content, "success");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("ignores unrelated corpus version changes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-graph-loader-unrelated-"));
  try {
    const archivePath = path.join(root, "archive", "2026-01-01", "node.md");
    const corpusVersionRef = { value: "hot:1:cold:1" };
    const storage = fakeStorage(root, archivePath, memory(archivePath, "stable"), { value: 1 }, corpusVersionRef);
    const loader = new GraphPathStateLoader();
    const internals = loader as unknown as LoaderInternals;
    let builds = 0;
    internals.buildArchivePathIndex = async (_storageRoot, version) => {
      builds += 1;
      return { version, pathsByBasename: new Map([["node.md", [archivePath]]]) };
    };

    assert.equal((await loader.readNode(storage, "node.md", null, true))?.content, "stable");
    corpusVersionRef.value = "hot:2:cold:3";
    assert.equal((await loader.readNode(storage, "node.md", null, true))?.content, "stable");
    assert.equal(builds, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalidates archive index when archive mutation version changes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-graph-loader-invalidate-"));
  try {
    const archivePath = path.join(root, "archive", "2026-01-01", "node.md");
    const archiveVersionRef = { value: 1 };
    const storage = fakeStorage(root, archivePath, memory(archivePath, "fresh"), archiveVersionRef);
    const loader = new GraphPathStateLoader();
    const internals = loader as unknown as LoaderInternals;
    let builds = 0;
    internals.buildArchivePathIndex = async (_storageRoot, version) => {
      builds += 1;
      return { version, pathsByBasename: new Map([["node.md", [archivePath]]]) };
    };

    assert.equal((await loader.readNode(storage, "node.md", null, true))?.content, "fresh");
    archiveVersionRef.value = 2;
    assert.equal((await loader.readNode(storage, "node.md", null, true))?.content, "fresh");
    assert.equal(builds, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("discards an archive index when generation changes during its build", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-graph-loader-generation-race-"));
  try {
    const oldArchivePath = path.join(root, "archive", "2026-01-01", "node.md");
    const newArchivePath = path.join(root, "archive", "2026-01-02", "node.md");
    const archiveVersionRef = { value: 1 };
    const storage = {
      dir: root,
      getArchiveMutationVersion: () => archiveVersionRef.value,
      readMemoryByPath: async (filePath: string) => {
        if (filePath === oldArchivePath) return memory(filePath, "stale");
        if (filePath === newArchivePath) return memory(filePath, "fresh");
        return null;
      },
    } as unknown as StorageManager;
    const loader = new GraphPathStateLoader();
    const internals = loader as unknown as LoaderInternals;
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let builds = 0;
    internals.buildArchivePathIndex = async (_storageRoot, version) => {
      const build = builds++;
      if (build === 0) {
        started.resolve();
        await release.promise;
      }
      const archivePath = version === 1 ? oldArchivePath : newArchivePath;
      return { version, pathsByBasename: new Map([["node.md", [archivePath]]]) };
    };

    const resultPromise = loader.readNode(storage, "node.md", null, true);
    await started.promise;
    archiveVersionRef.value = 2;
    release.resolve();

    assert.equal((await resultPromise)?.content, "fresh");
    assert.equal(builds, 2);
    assert.equal(internals.archivePathIndexes?.size, 1);
    assert.equal([...internals.archivePathIndexes?.values() ?? []][0]?.version, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("bounds retries when archive generation changes during every build", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-graph-loader-generation-churn-"));
  try {
    const archiveVersionRef = { value: 1 };
    const storage = {
      dir: root,
      getArchiveMutationVersion: () => archiveVersionRef.value,
      readMemoryByPath: async () => null,
    } as unknown as StorageManager;
    const loader = new GraphPathStateLoader();
    const internals = loader as unknown as LoaderInternals;
    let builds = 0;
    internals.buildArchivePathIndex = async (_storageRoot, version) => {
      builds += 1;
      archiveVersionRef.value += 1;
      return { version, pathsByBasename: new Map([["node.md", []]]) };
    };

    assert.equal(await loader.readNode(storage, "node.md", null, true), null);
    assert.equal(builds, 2);
    assert.equal(internals.archivePathIndexes?.size ?? 0, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("discards an index when generation changes after build validation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-graph-loader-post-build-race-"));
  try {
    const oldArchivePath = path.join(root, "archive", "2026-01-01", "node.md");
    const newArchivePath = path.join(root, "archive", "2026-01-02", "node.md");
    const generations = [1, 1, 2, 2, 2, 2];
    let generationReads = 0;
    const storage = {
      dir: root,
      getArchiveMutationVersion: () =>
        generations[Math.min(generationReads++, generations.length - 1)] ?? 2,
      readMemoryByPath: async (filePath: string) => {
        if (filePath === oldArchivePath) return memory(filePath, "stale");
        if (filePath === newArchivePath) return memory(filePath, "fresh");
        return null;
      },
    } as unknown as StorageManager;
    const loader = new GraphPathStateLoader();
    const internals = loader as unknown as LoaderInternals;
    let builds = 0;
    internals.buildArchivePathIndex = async (_storageRoot, version) => {
      builds += 1;
      const archivePath = version === 1 ? oldArchivePath : newArchivePath;
      return { version, pathsByBasename: new Map([["node.md", [archivePath]]]) };
    };

    assert.equal((await loader.readNode(storage, "node.md", null, true))?.content, "fresh");
    assert.equal(builds, 2);
    assert.equal(internals.archivePathIndexes?.size, 1);
    assert.equal([...internals.archivePathIndexes?.values() ?? []][0]?.version, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("coalesces concurrent archive index builds for one key", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-graph-loader-coalesce-"));
  try {
    const archivePath = path.join(root, "archive", "2026-01-01", "node.md");
    const storage = fakeStorage(root, archivePath, memory(archivePath, "shared"));
    const loader = new GraphPathStateLoader();
    const internals = loader as unknown as LoaderInternals;
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let builds = 0;
    internals.buildArchivePathIndex = async (_storageRoot, version) => {
      builds += 1;
      started.resolve();
      await release.promise;
      return { version, pathsByBasename: new Map([["node.md", [archivePath]]]) };
    };

    const first = loader.readNode(storage, "node.md", null, true);
    await started.promise;
    const second = loader.readNode(storage, "node.md", null, true);
    release.resolve();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(firstResult?.content, "shared");
    assert.equal(secondResult?.content, "shared");
    assert.equal(builds, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("evicts prior archive indexes for the same storage root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-graph-loader-cache-"));
  try {
    const archiveVersionRef = { value: 1 };
    const archivePath = path.join(root, "archive", "2026-01-01", "node.md");
    await mkdir(path.dirname(archivePath), { recursive: true });
    const storage = fakeStorage(root, archivePath, memory(archivePath, "unused"), archiveVersionRef);
    const loader = new GraphPathStateLoader();
    const internals = loader as unknown as LoaderInternals;

    await loader.readNode(storage, "node.md", null, true);
    archiveVersionRef.value = 2;
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

test("bounds in-flight admission and coalesces same-key callers behind a full map", async () => {
  const loader = new GraphPathStateLoader();
  const internals = loader as unknown as LoaderInternals;
  const roots: string[] = [];
  const started = Array.from({ length: 34 }, () => Promise.withResolvers<void>());
  const release = Array.from({ length: 34 }, () => Promise.withResolvers<void>());
  let builds = 0;
  internals.buildArchivePathIndex = async (storageRoot, version) => {
    const buildIndex = builds++;
    started[buildIndex]?.resolve();
    await release[buildIndex]!.promise;
    return {
      version,
      pathsByBasename: new Map([["node.md", [path.join(storageRoot, "archive", "node.md")]]]),
    };
  };

  try {
    const requests: Array<Promise<MemoryFile | null>> = [];
    for (let index = 0; index < 32; index += 1) {
      const root = await mkdtemp(path.join(os.tmpdir(), "remnic-graph-loader-flight-"));
      roots.push(root);
      const archivePath = path.join(root, "archive", "node.md");
      requests.push(loader.readNode(fakeStorage(root, archivePath, memory(archivePath, String(index))), "node.md", null, true));
      await started[index]!.promise;
    }

    const targetRoot = await mkdtemp(path.join(os.tmpdir(), "remnic-graph-loader-flight-target-"));
    roots.push(targetRoot);
    const targetPath = path.join(targetRoot, "archive", "node.md");
    const targetStorage = fakeStorage(targetRoot, targetPath, memory(targetPath, "target"));
    const firstTarget = loader.readNode(targetStorage, "node.md", null, true);
    const secondTarget = loader.readNode(targetStorage, "node.md", null, true);
    for (let tick = 0; tick < 4; tick += 1) await Promise.resolve();
    assert.equal(builds, 32);

    release[0]!.resolve();
    await started[32]!.promise;
    assert.equal(builds, 33);
    release[32]!.resolve();
    for (let index = 1; index < 34; index += 1) release[index]!.resolve();
    const results = await Promise.all([...requests, firstTarget, secondTarget]);
    assert.equal(results.at(-2)?.content, "target");
    assert.equal(results.at(-1)?.content, "target");
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
test("rejects a symlinked archive root before enumerating its target", async () => {
  if (process.platform === "win32") return;
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-graph-loader-archive-symlink-"));
  try {
    const storageRoot = path.join(root, "storage");
    const externalArchiveRoot = path.join(root, "external-archive");
    const archiveRoot = path.join(storageRoot, "archive");
    const externalArchivePath = path.join(externalArchiveRoot, "node.md");
    await mkdir(storageRoot, { recursive: true });
    await mkdir(externalArchiveRoot, { recursive: true });
    await writeFile(externalArchivePath, "external", "utf8");
    await symlink(externalArchiveRoot, archiveRoot);

    const storage = {
      dir: storageRoot,
      getArchiveMutationVersion: () => 1,
      readMemoryByPath: async (filePath: string) =>
        filePath === externalArchivePath ? memory(externalArchivePath, "external") : null,
    } as unknown as StorageManager;
    const loader = new GraphPathStateLoader();
    const internals = loader as unknown as LoaderInternals;
    const buildArchivePathIndex = internals.buildArchivePathIndex;
    let builds = 0;
    internals.buildArchivePathIndex = async (rootPath, version) => {
      builds += 1;
      return buildArchivePathIndex.call(loader, rootPath, version);
    };

    assert.equal(await loader.readNode(storage, "node.md", null, true), null);
    assert.equal(await loader.readNode(storage, "node.md", null, true), null);
    assert.equal(builds, 1);
    assert.equal(internals.archivePathIndexes?.size ?? 0, 1);
    const cachedIndex = [...(internals.archivePathIndexes?.values() ?? [])][0];
    assert.equal(cachedIndex?.pathsByBasename.size, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not publish a partial index after the visited-entry cap", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-graph-loader-path-cap-"));
  try {
    const archiveRoot = path.join(root, "archive");
    const deepRoot = path.join(archiveRoot, "deep");
    await mkdir(deepRoot, { recursive: true });
    const noiseCount = 100_001;
    for (let start = 0; start < noiseCount; start += 1_000) {
      const end = Math.min(start + 1_000, noiseCount);
      await Promise.all(
        Array.from({ length: end - start }, (_, offset) => {
          const index = start + offset;
          return writeFile(path.join(deepRoot, `noise-${index}.txt`), "noise", "utf8");
        }),
      );
    }

    const storage = {
      dir: root,
      getArchiveMutationVersion: () => 1,
      readMemoryByPath: async () => null,
    } as unknown as StorageManager;
    const loader = new GraphPathStateLoader();
    const internals = loader as unknown as LoaderInternals;

    assert.equal(await loader.readNode(storage, "missing.md", null, true), null);
    assert.equal(internals.archivePathIndexes?.size ?? 0, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
