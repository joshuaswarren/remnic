import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parseConfig } from "../config.js";
import { StorageManager } from "../index.js";
import {
  QmdResultResolver,
  qmdResultPathCandidates,
} from "./qmd-result-resolver.js";

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
