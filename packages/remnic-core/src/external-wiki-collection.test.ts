import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  type ExternalWikiCollectionBackend,
  ExternalWikiCollectionManager,
  type ExternalWikiCollectionRoot,
  externalWikiCollectionName,
} from "./external-wiki-collection.js";
import { NoopSearchBackend } from "./search/noop-backend.js";
import type { SearchResult } from "./search/port.js";

interface BackendFixture {
  backend: ExternalWikiCollectionBackend;
  calls: string[];
  results: SearchResult[];
  collectionCounts: Map<string, number>;
  collectionRoots: Map<string, string>;
}

function makeBackendFixture(overrides: Partial<ExternalWikiCollectionBackend> = {}): BackendFixture {
  const calls: string[] = [];
  const results: SearchResult[] = [];
  const collectionCounts = new Map<string, number>([["memories", 7]]);
  const collectionRoots = new Map<string, string>();
  const backend: ExternalWikiCollectionBackend = {
    supportsAdditionalCollections: () => true,
    ensureCollection: async (rootDir, collection) => {
      calls.push(`ensure:${collection}:${rootDir}`);
      if (!collectionRoots.has(collection)) {
        collectionCounts.set(collection, 1);
        collectionRoots.set(collection, rootDir);
      }
      return "present";
    },
    excludeCollectionFromGlobalSearch: async (collection) => {
      calls.push(`exclude:${collection}`);
    },
    updateCollectionStrict: async (collection) => {
      calls.push(`update:${collection}`);
    },
    embedCollection: async (collection) => {
      calls.push(`embed:${collection}`);
    },
    embedCollectionStrict: async (collection) => {
      calls.push(`embed:${collection}`);
    },
    hybridSearch: async (_query, collection) => {
      calls.push(`search:${collection}`);
      return results;
    },
    collectionRoot: async (collection) => collectionRoots.get(collection) ?? null,
    deleteCollection: async (collection) => {
      calls.push(`delete:${collection}`);
      collectionCounts.delete(collection);
      collectionRoots.delete(collection);
      return true;
    },
    collectionStatus: async (collection) => ({
      totalFiles: collectionCounts.get(collection) ?? null,
    }),
  };
  Object.assign(backend, overrides);
  return { backend, calls, results, collectionCounts, collectionRoots };
}

async function makeWiki(): Promise<{ rootDir: string; pagesDir: string }> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "remnic-external-wiki-"));
  const pagesDir = path.join(rootDir, "wiki");
  await mkdir(pagesDir);
  await mkdir(path.join(rootDir, "raw"));
  await writeFile(path.join(pagesDir, "retrieval.md"), "# Retrieval\n\nMeaning before exact words.\n", "utf8");
  await writeFile(path.join(rootDir, "raw", "capture.md"), "raw source", "utf8");
  return { rootDir, pagesDir };
}

function root(rootDir: string, overrides: Partial<ExternalWikiCollectionRoot> = {}): ExternalWikiCollectionRoot {
  return {
    id: "reading",
    rootDir,
    enabled: true,
    pagesDir: "wiki",
    indexInQmd: true,
    ...overrides,
  };
}

test("external wiki collection names are dedicated and predictable", () => {
  assert.equal(externalWikiCollectionName("Reading Notes"), "external-wiki-reading-notes");
  assert.throws(() => externalWikiCollectionName("---"), /usable characters/i);
});

test("wiki ids that sanitize to the same collection are rejected together", async () => {
  const wiki = await makeWiki();
  try {
    const fixture = makeBackendFixture();
    const manager = new ExternalWikiCollectionManager(fixture.backend, "memories");

    const statuses = await manager.refresh([
      root(wiki.rootDir, { id: "Reading Notes" }),
      root(wiki.rootDir, { id: "reading-notes" }),
    ]);

    assert.deepEqual(
      statuses.map((status) => status.state),
      ["error", "error"]
    );
    assert.ok(statuses.every((status) => status.lastError?.includes("same dedicated collection")));
    assert.deepEqual(fixture.calls, []);
  } finally {
    await rm(wiki.rootDir, { recursive: true, force: true });
  }
});

test("opt-in indexing targets only pagesDir and preserves the default collection", async () => {
  const wiki = await makeWiki();
  try {
    const fixture = makeBackendFixture();
    const manager = new ExternalWikiCollectionManager(fixture.backend, "memories");

    const statuses = await manager.refresh([root(wiki.rootDir)]);

    assert.deepEqual(fixture.calls, [
      `ensure:external-wiki-reading:${wiki.pagesDir}`,
      "exclude:external-wiki-reading",
      "update:external-wiki-reading",
      "embed:external-wiki-reading",
    ]);
    assert.equal(fixture.collectionCounts.get("memories"), 7);
    assert.equal(statuses[0]?.collection, "external-wiki-reading");
    assert.equal(statuses[0]?.documentCount, 1);
    assert.equal(statuses[0]?.state, "healthy");
    assert.ok(statuses[0]?.lastIndexedAt);
  } finally {

    await rm(wiki.rootDir, { recursive: true, force: true });
  }
});
test("changing a wiki pages root rebinds its existing collection", async () => {
  const firstWiki = await makeWiki();
  const secondWiki = await makeWiki();
  try {
    const fixture = makeBackendFixture();
    const manager = new ExternalWikiCollectionManager(fixture.backend, "memories");
    await manager.refresh([root(firstWiki.rootDir)]);
    fixture.calls.length = 0;

    const statuses = await manager.refresh([root(secondWiki.rootDir)]);

    assert.equal(statuses[0]?.state, "healthy");
    assert.deepEqual(fixture.calls, [
      `ensure:external-wiki-reading:${secondWiki.pagesDir}`,
      "delete:external-wiki-reading",
      `ensure:external-wiki-reading:${secondWiki.pagesDir}`,
      "exclude:external-wiki-reading",
      "update:external-wiki-reading",
      "embed:external-wiki-reading",
    ]);
    assert.equal(fixture.collectionRoots.get("external-wiki-reading"), secondWiki.pagesDir);
  } finally {
    await rm(firstWiki.rootDir, { recursive: true, force: true });
    await rm(secondWiki.rootDir, { recursive: true, force: true });
  }
});

test("unchanged pages skip work and changed pages trigger an incremental refresh", async () => {
  const wiki = await makeWiki();
  try {
    const fixture = makeBackendFixture();
    const manager = new ExternalWikiCollectionManager(fixture.backend, "memories");
    const configuredRoot = root(wiki.rootDir);
    await manager.refresh([configuredRoot]);
    fixture.calls.length = 0;

    await manager.refresh([configuredRoot]);
    assert.deepEqual(fixture.calls, []);

    await writeFile(
      path.join(wiki.pagesDir, "retrieval.md"),
      "# Retrieval\n\nMeaning survives a paraphrase and a changed page.\n",
      "utf8"
    );
    await manager.refresh([configuredRoot]);

    assert.deepEqual(fixture.calls, [
      `ensure:external-wiki-reading:${wiki.pagesDir}`,
      "exclude:external-wiki-reading",
      "update:external-wiki-reading",
      "embed:external-wiki-reading",
    ]);
  } finally {
    await rm(wiki.rootDir, { recursive: true, force: true });
  }
});

test("pagesDir cannot escape the configured wiki root", async () => {
  const wiki = await makeWiki();
  try {
    const fixture = makeBackendFixture();
    const manager = new ExternalWikiCollectionManager(fixture.backend, "memories");

    const statuses = await manager.refresh([root(wiki.rootDir, { pagesDir: "../raw" })]);

    assert.equal(statuses[0]?.state, "error");
    assert.match(statuses[0]?.lastError ?? "", /pagesDir must stay inside/i);
    assert.deepEqual(fixture.calls, []);
  } finally {
    await rm(wiki.rootDir, { recursive: true, force: true });
  }
});

test("pagesDir symlinks cannot escape the configured wiki root", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "remnic-external-wiki-root-"));
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), "remnic-external-wiki-outside-"));
  try {
    await writeFile(path.join(outsideDir, "outside.md"), "# Outside", "utf8");
    await symlink(outsideDir, path.join(rootDir, "wiki"), "dir");
    const fixture = makeBackendFixture();
    const manager = new ExternalWikiCollectionManager(fixture.backend, "memories");

    const statuses = await manager.refresh([root(rootDir)]);

    assert.equal(statuses[0]?.state, "error");
    assert.match(statuses[0]?.lastError ?? "", /pagesDir must stay inside/i);
    assert.deepEqual(fixture.calls, []);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});

test("default-off and disabled roots never touch the search backend", async () => {
  const wiki = await makeWiki();
  try {
    const fixture = makeBackendFixture();
    const manager = new ExternalWikiCollectionManager(fixture.backend, "memories");

    const statuses = await manager.refresh([
      root(wiki.rootDir, { id: "off", indexInQmd: false }),
      root(wiki.rootDir, { id: "disabled", enabled: false }),
    ]);

    assert.deepEqual(fixture.calls, []);
    assert.deepEqual(
      statuses.map((status) => status.state),
      ["disabled", "disabled"]
    );
  } finally {
    await rm(wiki.rootDir, { recursive: true, force: true });
  }
});

test("unsupported extra collections report a clear error and search fails open", async () => {
  const wiki = await makeWiki();
  try {
    const fixture = makeBackendFixture({ supportsAdditionalCollections: () => false });
    const manager = new ExternalWikiCollectionManager(fixture.backend, "memories");

    const statuses = await manager.refresh([root(wiki.rootDir)]);
    const results = await manager.search("reading", "ideas expressed with different words", 5);

    assert.equal(statuses[0]?.state, "error");
    assert.match(statuses[0]?.lastError ?? "", /does not support dedicated external wiki collections/i);
    assert.equal(results, null);
    assert.deepEqual(fixture.calls, []);
  } finally {
    await rm(wiki.rootDir, { recursive: true, force: true });
  }
});

test("a backend with no additional-collection capability keeps indexing fail-open", async () => {
  const wiki = await makeWiki();
  try {
    const manager = new ExternalWikiCollectionManager(new NoopSearchBackend(), "memories");

    const statuses = await manager.refresh([root(wiki.rootDir)]);

    assert.equal(statuses[0]?.state, "error");
    assert.match(statuses[0]?.lastError ?? "", /does not support dedicated external wiki collections/i);
  } finally {
    await rm(wiki.rootDir, { recursive: true, force: true });
  }
});

test("healthy collection search uses hybrid retrieval and rejects results outside pagesDir", async () => {
  const wiki = await makeWiki();
  try {
    const fixture = makeBackendFixture();
    fixture.results.push(
      {
        docid: "retrieval",
        path: path.join(wiki.pagesDir, "retrieval.md"),
        snippet: "Meaning before exact words.",
        score: 0.91,
      },
      {
        docid: "raw-capture",
        path: path.join(wiki.rootDir, "raw", "capture.md"),

        snippet: "raw source",
        score: 0.99,
      }
    );
    const manager = new ExternalWikiCollectionManager(fixture.backend, "memories");
    await manager.refresh([root(wiki.rootDir)]);

    const results = await manager.search("reading", "ideas expressed with different words", 5);

    assert.deepEqual(
      results?.map((result) => result.docid),
      ["retrieval"]
    );
    assert.equal(fixture.calls.at(-1), "search:external-wiki-reading");
  } finally {
    await rm(wiki.rootDir, { recursive: true, force: true });
  }
});
test("failed global exclusion rolls back the collection before reporting an error", async () => {
  const wiki = await makeWiki();
  try {
    const fixture = makeBackendFixture({
      excludeCollectionFromGlobalSearch: async () => {
        throw new Error("exclude failed");
      },
    });
    const manager = new ExternalWikiCollectionManager(fixture.backend, "memories");

    const statuses = await manager.refresh([root(wiki.rootDir)]);

    assert.equal(statuses[0]?.state, "error");
    assert.equal(fixture.collectionRoots.has("external-wiki-reading"), false);
    assert.equal(fixture.calls.at(-1), "delete:external-wiki-reading");
  } finally {
    await rm(wiki.rootDir, { recursive: true, force: true });
  }
});

test("degraded hybrid search marks the collection unhealthy and falls back", async () => {
  const wiki = await makeWiki();
  try {
    const fixture = makeBackendFixture({
      hybridSearch: async (_query, _collection, _limit, execution) => {
        execution?.onDegradation?.({
          backend: "qmd",
          code: "backend_unavailable",
        });
        return [];
      },
    });
    const manager = new ExternalWikiCollectionManager(fixture.backend, "memories");
    await manager.refresh([root(wiki.rootDir)]);

    const results = await manager.search("reading", "paraphrase", 5);

    assert.equal(results, null);
    assert.equal(manager.statuses()[0]?.state, "error");
    assert.match(manager.statuses()[0]?.lastError ?? "", /search degraded/i);
  } finally {
    await rm(wiki.rootDir, { recursive: true, force: true });
  }
});

test("a collection name collision with primary memory is refused", async () => {
  const wiki = await makeWiki();
  try {
    const fixture = makeBackendFixture();
    const manager = new ExternalWikiCollectionManager(fixture.backend, "external-wiki-reading");

    const statuses = await manager.refresh([root(wiki.rootDir)]);

    assert.equal(statuses[0]?.state, "error");
    assert.match(statuses[0]?.lastError ?? "", /default memory collection/i);
    assert.deepEqual(fixture.calls, []);
  } finally {
    await rm(wiki.rootDir, { recursive: true, force: true });
  }
});

test("concurrent config refreshes serialize so disable wins after enable", async () => {
  const wiki = await makeWiki();
  try {
    let releaseEnsure!: () => void;
    const blockedEnsure = new Promise<void>((resolve) => {
      releaseEnsure = resolve;
    });
    let signalEnsureStarted!: () => void;
    const ensureStarted = new Promise<void>((resolve) => {
      signalEnsureStarted = resolve;
    });
    const fixture = makeBackendFixture({
      ensureCollection: async (pagesDir, collection) => {
        fixture.calls.push(`ensure:${collection}:${pagesDir}`);
        signalEnsureStarted();
        await blockedEnsure;
        fixture.collectionCounts.set(collection, 1);
        return "present";
      },
    });
    const manager = new ExternalWikiCollectionManager(fixture.backend, "memories");

    const enabling = manager.refresh([root(wiki.rootDir)]);
    await ensureStarted;
    const disabling = manager.refresh([root(wiki.rootDir, { indexInQmd: false })]);
    releaseEnsure();
    await enabling;
    const disabledStatuses = await disabling;

    assert.equal(disabledStatuses[0]?.state, "disabled");
    assert.equal(manager.statuses()[0]?.state, "disabled");
    assert.equal(fixture.calls.at(-1), "delete:external-wiki-reading");
  } finally {
    await rm(wiki.rootDir, { recursive: true, force: true });
  }
});

test("purge serializes behind an in-flight refresh", async () => {
  const wiki = await makeWiki();
  try {
    let releaseEnsure!: () => void;
    const blockedEnsure = new Promise<void>((resolve) => {
      releaseEnsure = resolve;
    });
    let signalEnsureStarted!: () => void;
    const ensureStarted = new Promise<void>((resolve) => {
      signalEnsureStarted = resolve;
    });
    const fixture = makeBackendFixture({
      ensureCollection: async (pagesDir, collection) => {
        fixture.calls.push(`ensure:${collection}:${pagesDir}`);
        signalEnsureStarted();
        await blockedEnsure;
        fixture.collectionCounts.set(collection, 1);
        return "present";
      },
    });
    const manager = new ExternalWikiCollectionManager(fixture.backend, "memories");

    const indexing = manager.refresh([root(wiki.rootDir)]);
    await ensureStarted;
    const purging = manager.purge("reading");
    releaseEnsure();
    await indexing;
    assert.equal(await purging, true);

    assert.deepEqual(manager.statuses(), []);
    assert.equal(fixture.calls.at(-1), "delete:external-wiki-reading");
  } finally {
    await rm(wiki.rootDir, { recursive: true, force: true });
  }
});

test("a removed collection delete failure does not abort remaining wiki refreshes", async () => {
  const wiki = await makeWiki();
  try {
    const fixture = makeBackendFixture({
      deleteCollection: async (collection) => {
        if (collection === "external-wiki-first") throw new Error("delete failed");
        return true;
      },
    });
    const manager = new ExternalWikiCollectionManager(fixture.backend, "memories");
    await manager.refresh([root(wiki.rootDir, { id: "first" }), root(wiki.rootDir, { id: "second" })]);

    const statuses = await manager.refresh([root(wiki.rootDir, { id: "second" })]);

    assert.equal(statuses[0]?.wikiId, "second");
    assert.equal(statuses[0]?.state, "healthy");
    assert.equal(manager.statuses().find((status) => status.wikiId === "first")?.state, "error");
  } finally {
    await rm(wiki.rootDir, { recursive: true, force: true });
  }
});

test("turning indexing off removes a collection managed by this process", async () => {
  const wiki = await makeWiki();
  try {
    const fixture = makeBackendFixture();
    const manager = new ExternalWikiCollectionManager(fixture.backend, "memories");
    await manager.refresh([root(wiki.rootDir)]);
    fixture.calls.length = 0;

    const statuses = await manager.refresh([root(wiki.rootDir, { indexInQmd: false })]);

    assert.deepEqual(fixture.calls, ["delete:external-wiki-reading"]);
    assert.equal(statuses[0]?.state, "disabled");
  } finally {
    await rm(wiki.rootDir, { recursive: true, force: true });
  }
});

test("purge deletes a predictable dedicated collection without touching memory", async () => {
  const fixture = makeBackendFixture();
  const manager = new ExternalWikiCollectionManager(fixture.backend, "memories");

  const removed = await manager.purge("reading");

  assert.equal(removed, true);
  assert.deepEqual(fixture.calls, ["delete:external-wiki-reading"]);
  assert.equal(fixture.collectionCounts.get("memories"), 7);
});
