import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseConfig } from "../config.js";
import { StorageManager } from "../index.js";
import {
  QmdResultResolver,
  qmdCollectionPathParts,
  qmdResultPathCandidates,
} from "./qmd-result-resolver.js";

test("qmdCollectionPathParts normalizes QMD URIs", () => {
  assert.deepEqual(
    qmdCollectionPathParts("qmd://openclaw-engram/facts/private.md"),
    { collection: "openclaw-engram", relativePath: "facts/private.md" },
  );
});

test("qmdResultPathCandidates probes the facts/ fallback for relative date paths", () => {
  const root = path.join(os.tmpdir(), "remnic-resolver-rel");
  const candidates = qmdResultPathCandidates(root, "2026-07-21/fact-x.md");
  assert.deepEqual(
    candidates.sort(),
    [
      path.join(root, "2026-07-21", "fact-x.md"),
      path.join(root, "facts", "2026-07-21", "fact-x.md"),
    ].sort(),
    "relative date paths probe both the literal and the facts/ location",
  );
});

test("qmdResultPathCandidates probes the facts/ fallback for absolute date paths inside the storage root (issue #2111)", () => {
  const root = path.join(os.tmpdir(), "remnic-resolver-abs");
  const absolute = path.join(root, "2026-07-21", "fact-x.md");
  const candidates = qmdResultPathCandidates(root, absolute);
  assert.deepEqual(
    candidates.sort(),
    [absolute, path.join(root, "facts", "2026-07-21", "fact-x.md")].sort(),
    "pre-absolutized date paths must probe the facts/ location too",
  );
});

test("qmdResultPathCandidates keeps non-date absolute paths literal", () => {
  const root = path.join(os.tmpdir(), "remnic-resolver-abs-nondate");
  const absolute = path.join(root, "entities", "person-x.md");
  assert.deepEqual(
    qmdResultPathCandidates(root, absolute),
    [absolute],
    "non-date absolute paths must not grow a facts/ variant",
  );
});

test("qmdResultPathCandidates rejects absolute paths outside the storage root", () => {
  const root = path.join(os.tmpdir(), "remnic-resolver-abs-outside");
  const outside = path.join(os.tmpdir(), "elsewhere", "2026-07-21", "fact-x.md");
  assert.deepEqual(
    qmdResultPathCandidates(root, outside),
    [],
    "containment must drop escaping paths, including their facts/ variant",
  );
});

test("readQmdResultMemory resolves an absolute date path whose file lives under facts/ (issue #2111)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-resolver-e2e-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const factDir = path.join(dir, "facts", "2026-07-21");
    await mkdir(factDir, { recursive: true });
    const factPath = path.join(factDir, "fact-cookie-note.md");
    await writeFile(
      factPath,
      [
        "---",
        "id: fact-cookie-note",
        "category: fact",
        "created: 2026-07-21T00:00:00.000Z",
        "updated: 2026-07-21T00:00:00.000Z",
        "status: active",
        "---",
        "",
        "The storefront manages a uniqueId cookie with a 90-day expiration.",
        "",
      ].join("\n"),
      "utf8",
    );

    const config = parseConfig({ memoryDir: dir });
    const resolver = new QmdResultResolver({
      getConfig: () => config,
      storageFor: async () => storage,
      storageDirNamespace: () => config.defaultNamespace,
      qmdCollectionNamespaceFromPrefix: () => null,
      namespaceFromPath: () => config.defaultNamespace,
    });

    // Daemon-mode shape: the result path is already absolutized against the
    // storage root but is missing the facts/ segment because the hot-facts
    // collection was registered at the facts/ subtree.
    const preAbsolutized = path.join(dir, "2026-07-21", "fact-cookie-note.md");
    const memory = await resolver.readQmdResultMemory(preAbsolutized, storage);
    assert.ok(memory, "the memory must resolve via the facts/ fallback");
    assert.equal(memory.frontmatter.id, "fact-cookie-note");
    assert.equal(path.resolve(memory.path), path.resolve(factPath));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("private-result filtering can preserve unresolved custom-collection hits", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-resolver-custom-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const config = parseConfig({ memoryDir: dir });
    const resolver = new QmdResultResolver({
      getConfig: () => config,
      storageFor: async () => storage,
      storageDirNamespace: () => config.defaultNamespace,
      qmdCollectionNamespaceFromPrefix: () => null,
      namespaceFromPath: () => config.defaultNamespace,
    });
    const result = { docid: "external", path: "custom-collection/page.md", snippet: "page", score: 1 };

    assert.deepEqual(await resolver.filterPrivateSearchResults([result], storage), [result]);
    const configured = { ...result, path: `${config.qmdCollection}/page.md` };
    assert.deepEqual(await resolver.filterPrivateSearchResults([configured], storage), []);
    assert.deepEqual(await resolver.filterPrivateSearchResults([configured], storage, [], true), [configured]);
    const externalAbsolute = { ...result, path: path.join(os.tmpdir(), "external-collection", "page.md") };
    assert.deepEqual(await resolver.filterPrivateSearchResults([externalAbsolute], storage), [externalAbsolute]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("private-result filtering rejects unresolved internal-root hits", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-resolver-internal-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const config = parseConfig({ memoryDir: dir });
    const resolver = new QmdResultResolver({
      getConfig: () => config,
      storageFor: async () => storage,
      storageDirNamespace: () => config.defaultNamespace,
      qmdCollectionNamespaceFromPrefix: () => null,
      namespaceFromPath: () => config.defaultNamespace,
    });
    for (const root of ["activity", "archive", "artifacts", "cold", "entities", "identity", "state", "summaries", "transcripts"]) {
      const result = { docid: root, path: `${root}/missing.md`, snippet: "private", score: 1 };
      assert.deepEqual(await resolver.filterPrivateSearchResults([result], storage, [], true), []);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("private-result filtering resolves QMD URIs before checking passport privacy", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-resolver-qmd-uri-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const factDir = path.join(dir, "facts");
    await mkdir(factDir, { recursive: true });
    await writeFile(
      path.join(factDir, "private.md"),
      [
        "---",
        "id: private",
        "category: preference",
        "created: 2026-08-13T00:00:00.000Z",
        "updated: 2026-08-13T00:00:00.000Z",
        "status: active",
        "tags:",
        "  - support-passport-card",
        "---",
        "",
        "Private support card.",
        "",
      ].join("\n"),
      "utf8",
    );
    const config = parseConfig({ memoryDir: dir });
    const resolver = new QmdResultResolver({
      getConfig: () => config,
      storageFor: async () => storage,
      storageDirNamespace: () => config.defaultNamespace,
      qmdCollectionNamespaceFromPrefix: () => null,
      namespaceFromPath: () => config.defaultNamespace,
    });
    const result = {
      docid: "private",
      path: `qmd://${config.qmdCollection}/facts/private.md`,
      snippet: "Private support card.",
      score: 1,
    };

    assert.deepEqual(await resolver.filterPrivateSearchResults([result], storage), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("private-result filtering resolves bounded batches and reuses prefix results", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-resolver-batch-"));
  try {
    let activeReads = 0;
    let maximumReads = 0;
    const readCounts = new Map<string, number>();
    const storage = {
      dir,
      async readMemoryByPath(filePath: string) {
        const id = path.basename(filePath, ".md");
        readCounts.set(id, (readCounts.get(id) ?? 0) + 1);
        activeReads += 1;
        maximumReads = Math.max(maximumReads, activeReads);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeReads -= 1;
        return {
          path: filePath,
          content: `content for ${id}`,
          frontmatter: {
            id,
            category: "fact",
            created: "2026-08-13T00:00:00.000Z",
            updated: "2026-08-13T00:00:00.000Z",
            status: "active",
            tags: id === "memory-0" ? ["support-passport-card"] : [],
          },
        };
      },
    } as unknown as StorageManager;
    const config = parseConfig({ memoryDir: dir });
    const resolver = new QmdResultResolver({
      getConfig: () => config,
      storageFor: async () => storage,
      storageDirNamespace: () => config.defaultNamespace,
      qmdCollectionNamespaceFromPrefix: () => null,
      namespaceFromPath: () => config.defaultNamespace,
    });
    const results = Array.from({ length: 20 }, (_, index) => ({
      docid: `memory-${index}`,
      path: `facts/memory-${index}.md`,
      snippet: "candidate",
      score: 1,
    }));
    const visibilityCache = new Map<string, boolean>();

    const first = await resolver.filterPrivateSearchResults(
      results.slice(0, 16),
      storage,
      [],
      false,
      visibilityCache,
    );
    const second = await resolver.filterPrivateSearchResults(
      results,
      storage,
      [],
      false,
      visibilityCache,
    );

    assert.equal(first.length, 15);
    assert.equal(second.length, 19);
    assert.equal(maximumReads, 16);
    assert.equal([...readCounts.values()].reduce((total, count) => total + count, 0), 20);
    assert.equal(readCounts.get("memory-0"), 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
