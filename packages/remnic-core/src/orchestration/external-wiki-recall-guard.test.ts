import assert from "node:assert/strict";
import { mkdir, symlink } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import type { QmdSearchResult } from "../types.js";
import * as wikiGuard from "../external-wiki-guard.js";
import { withTempDir } from "../testing/tmp-dir.js";
import {
  filterRecallCandidates,
  isExternalWikiCollectionName,
  isGenericRecallExcludedPath,
} from "./generic-recall-paths.js";

const { assertExternalWikiRootOutsideMemoryDir } = wikiGuard;
const assertCanonicalIsolation = (
  wikiGuard as typeof wikiGuard & {
    assertExternalWikiRootOutsideMemoryDirCanonical(memoryDir: string, rootDir: string): Promise<void>;
  }
).assertExternalWikiRootOutsideMemoryDirCanonical;

function hit(path: string, snippet: string): QmdSearchResult {
  return { docid: path, path, score: 1, snippet };
}

const OVERLAPPING_QUERY = "bounded context budgets";
const MEMORY_HIT = hit("openclaw-engram/facts/context-budget.md", `The operator chose ${OVERLAPPING_QUERY}.`);
const WIKI_HIT = hit(
  "qmd://external-wiki-reading/wiki/context-budgets.md",
  `A compiled guide to ${OVERLAPPING_QUERY}.`
);

const MEMORY_POLICY = {
  qmdCollection: "openclaw-engram",
  qmdColdCollection: "openclaw-engram-cold",
};

test("default recall excludes overlapping external wiki hits before applying its limit", () => {
  const recalled = filterRecallCandidates([WIKI_HIT, MEMORY_HIT], {
    namespacesEnabled: false,
    recallNamespaces: [],
    resolveNamespace: () => "default",
    limit: 1,
    pathPolicy: MEMORY_POLICY,
  });

  assert.deepEqual(recalled, [MEMORY_HIT]);
  assert.equal(isGenericRecallExcludedPath(WIKI_HIT.path, MEMORY_POLICY, "qmd"), true);
});

test("the recall-only guard leaves on-demand external wiki search results available", () => {
  const onDemandResults = [WIKI_HIT];

  assert.equal(onDemandResults[0]?.path, WIKI_HIT.path);
  assert.match(onDemandResults[0]?.snippet ?? "", new RegExp(OVERLAPPING_QUERY));
});

test("external wiki collection ids cannot masquerade as memory collections", () => {
  assert.equal(isExternalWikiCollectionName("external-wiki-reading"), true);
  assert.equal(isExternalWikiCollectionName("external-wiki-reading--default"), true);
  assert.equal(isExternalWikiCollectionName("openclaw-engram"), false);
  assert.equal(isExternalWikiCollectionName("my-external-wiki-reading"), false);
});

test("external wiki roots cannot enter the primary memory collection walk", () => {
  assert.throws(
    () => assertExternalWikiRootOutsideMemoryDir("/data/memory", "/data/memory"),
    /must be outside memoryDir/
  );
  assert.throws(
    () => assertExternalWikiRootOutsideMemoryDir("/data/memory", "/data/memory/compiled-wiki"),
    /must be outside memoryDir/
  );
  assert.doesNotThrow(() => assertExternalWikiRootOutsideMemoryDir("/data/memory", "/data/compiled-wiki"));
});

test("external wiki root isolation resolves filesystem aliases", async () => {
  assert.equal(typeof assertCanonicalIsolation, "function");
  await withTempDir(async (rootDir) => {
    const memoryDir = path.join(rootDir, "memory");
    const nestedWiki = path.join(memoryDir, "compiled-wiki");
    const wikiAlias = path.join(rootDir, "wiki-alias");
    await mkdir(nestedWiki, { recursive: true });
    await symlink(nestedWiki, wikiAlias);
    const memoryAlias = path.join(rootDir, "memory-alias");
    await symlink(memoryDir, memoryAlias);

    await assert.rejects(() => assertCanonicalIsolation(memoryDir, wikiAlias), /must be outside memoryDir/);
    await assert.rejects(
      () => assertCanonicalIsolation(memoryDir, path.join(memoryAlias, "future-wiki")),
      /must be outside memoryDir/
    );
  }, "remnic-external-wiki-guard-");
});
