import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as core from "./index.js";
import type { ExternalWikiRoot } from "./types.js";
import type {
  loadExternalWikiCatalog,
  parseExternalWikiCatalog,
  readExternalWikiPage,
  validateExternalWikiLayout,
} from "./external-wiki.js";

const externalWiki = core as typeof core & {
  loadExternalWikiCatalog: typeof loadExternalWikiCatalog;
  parseExternalWikiCatalog: typeof parseExternalWikiCatalog;
  readExternalWikiPage: typeof readExternalWikiPage;
  validateExternalWikiLayout: typeof validateExternalWikiLayout;
};

function wikiConfig(rootDir: string, overrides: Partial<ExternalWikiRoot> = {}): ExternalWikiRoot {
  return {
    id: "reading",
    rootDir,
    enabled: true,
    pagesDir: "wiki",
    indexFile: "INDEX.md",
    indexInQmd: false,
    includeInDefaultRecall: false,
    ...overrides,
  };
}

async function withWiki(
  run: (rootDir: string) => Promise<void>,
): Promise<void> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "remnic-external-wiki-"));
  try {
    await run(rootDir);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
}

test("external wiki reader APIs are exported from core", () => {
  assert.equal(typeof externalWiki.validateExternalWikiLayout, "function");
  assert.equal(typeof externalWiki.parseExternalWikiCatalog, "function");
  assert.equal(typeof externalWiki.loadExternalWikiCatalog, "function");
  assert.equal(typeof externalWiki.readExternalWikiPage, "function");
});

test("validates the required pages directory and optional wiki layout", async () => {
  await withWiki(async (rootDir) => {
    await mkdir(path.join(rootDir, "wiki"));
    await mkdir(path.join(rootDir, "raw"));
    await mkdir(path.join(rootDir, "outputs"));
    await writeFile(path.join(rootDir, "INDEX.md"), "# Catalog\n");

    const layout = await externalWiki.validateExternalWikiLayout(wikiConfig(rootDir));

    assert.equal(layout.rootDir, rootDir);
    assert.equal(layout.pagesDir, path.join(rootDir, "wiki"));
    assert.equal(layout.indexFile, path.join(rootDir, "INDEX.md"));
    assert.equal(layout.indexPresent, true);
    assert.equal(layout.rawDir, path.join(rootDir, "raw"));
    assert.equal(layout.outputsDir, path.join(rootDir, "outputs"));
  });
});

test("rejects missing pages directories and symlink escapes", async () => {
  await withWiki(async (rootDir) => {
    await assert.rejects(
      () => externalWiki.validateExternalWikiLayout(wikiConfig(rootDir)),
      /pages directory does not exist/,
    );

    const outsideDir = await mkdtemp(path.join(os.tmpdir(), "remnic-wiki-outside-"));
    try {
      await symlink(outsideDir, path.join(rootDir, "wiki"));
      await assert.rejects(
        () => externalWiki.validateExternalWikiLayout(wikiConfig(rootDir)),
        /pages directory escapes rootDir/,
      );
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });
});

test("parses markdown and wiki-link catalog entries deterministically", () => {
  const parsed = externalWiki.parseExternalWikiCatalog(
    [
      "# Catalog",
      "- [Cache consistency](wiki/cache-consistency.md) - Invalidation and ownership.",
      "- [[distributed-systems|Distributed systems]]: Coordination foundations.",
      "- [External](https://example.com/external.md) - ignored",
      "- [Escape](../outside.md) - ignored",
      "- [Duplicate](wiki/cache-consistency.md) - ignored",
    ].join("\n"),
    wikiConfig("/srv/wiki"),
  );

  assert.deepEqual(parsed, [
    {
      title: "Cache consistency",
      path: "cache-consistency.md",
      indexBlurb: "Invalidation and ownership.",
      indexLine: 2,
    },
    {
      title: "Distributed systems",
      path: "distributed-systems.md",
      indexBlurb: "Coordination foundations.",
      indexLine: 3,
    },
  ]);
});

test("loads a bounded index and falls back to a sorted page listing", async () => {
  await withWiki(async (rootDir) => {
    await mkdir(path.join(rootDir, "wiki", "nested"), { recursive: true });
    await writeFile(path.join(rootDir, "wiki", "zeta.md"), "# Zeta\n");
    await writeFile(path.join(rootDir, "wiki", "nested", "alpha.md"), "# Alpha\n");
    await writeFile(path.join(rootDir, "wiki", "ignored.txt"), "ignored\n");

    const fallback = await externalWiki.loadExternalWikiCatalog(wikiConfig(rootDir));
    assert.equal(fallback.wikiId, "reading");
    assert.equal(fallback.indexPresent, false);
    assert.deepEqual(fallback.entries, [
      { title: "Alpha", path: "nested/alpha.md" },
      { title: "Zeta", path: "zeta.md" },
    ]);

    await writeFile(
      path.join(rootDir, "INDEX.md"),
      "- [Zeta](wiki/zeta.md) - Last page.\n",
    );
    const indexed = await externalWiki.loadExternalWikiCatalog(wikiConfig(rootDir));
    assert.equal(indexed.indexPresent, true);
    assert.deepEqual(indexed.entries, [
      { title: "Zeta", path: "zeta.md", indexBlurb: "Last page.", indexLine: 1 },
    ]);

    await assert.rejects(
      () => externalWiki.loadExternalWikiCatalog(wikiConfig(rootDir), { maxIndexBytes: 8 }),
      /INDEX\.md exceeds 8 bytes/,
    );
  });
});

test("loads concept pages on demand with containment and byte limits", async () => {
  await withWiki(async (rootDir) => {
    await mkdir(path.join(rootDir, "wiki"));
    await writeFile(path.join(rootDir, "wiki", "concept.md"), "# Concept\n\nSource-backed synthesis.\n");
    await writeFile(path.join(rootDir, "secret.md"), "not a concept page\n");

    const page = await externalWiki.readExternalWikiPage(
      wikiConfig(rootDir),
      "concept.md",
      1_024,
    );
    assert.deepEqual(page, {
      wikiId: "reading",
      path: "concept.md",
      title: "Concept",
      content: "# Concept\n\nSource-backed synthesis.\n",
      bytes: 36,
    });

    await assert.rejects(
      () => externalWiki.readExternalWikiPage(wikiConfig(rootDir), "../secret.md", 1_024),
      /page path must stay within the pages directory/,
    );
    await assert.rejects(
      () => externalWiki.readExternalWikiPage(wikiConfig(rootDir), "concept.txt", 1_024),
      /page path must end in \.md/,
    );
    await assert.rejects(
      () => externalWiki.readExternalWikiPage(wikiConfig(rootDir), "concept.md", 8),
      /concept\.md exceeds 8 bytes/,
    );
  });
});
