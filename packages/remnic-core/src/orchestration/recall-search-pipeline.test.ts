import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";

import { parseConfig } from "../config.js";
import { RecallSearchPipelineCoordinator } from "./recall-search-pipeline.js";
import type { RecallSearchPipelineDeps } from "./recall-search-pipeline.js";
import type { MemoryFile, QmdSearchResult } from "../types.js";
import type { StorageManager } from "../index.js";

function result(namespace: string, path: string): QmdSearchResult {
  return { docid: `${namespace}:${path}`, namespace, path, score: 1, snippet: path };
}

function memory(path: string, status: string): MemoryFile {
  return {
    path,
    content: path,
    frontmatter: {
      status,
      memoryKind: "fact",
      created: "2026-07-19T00:00:00.000Z",
      updated: "2026-07-19T00:00:00.000Z",
    } as unknown as MemoryFile["frontmatter"],
  };
}

async function makeCoordinator(memoryDir: string): Promise<RecallSearchPipelineCoordinator> {
  const config = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    namespaces: true,
  });
  const deps = {
    config,
    storage: {} as StorageManager,
    readQmdResultMemory: async (
      resultPath: string,
      _fallbackStorage: StorageManager,
      _recallNamespaces: readonly string[],
      preferredNamespace?: string,
    ) => memory(resultPath, preferredNamespace === "private" ? "forgotten" : "active"),
  } as unknown as RecallSearchPipelineDeps;
  return new RecallSearchPipelineCoordinator(deps);
}

test("recall safety keeps same relative path distinct across namespaces", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-recall-map-"));
  try {
    const coordinator = await makeCoordinator(memoryDir);
    const results = [result("shared", "facts/same.md"), result("private", "facts/same.md")];

    const loaded = await coordinator.loadSearchResultMemoryMap(results, undefined, {
      recallNamespaces: ["shared", "private"],
    });
    const safe = coordinator.filterSearchResultsByRecallSafety(results, loaded.memoryByPath);

    assert.equal(loaded.memoryByPath.size, 2, "each namespace must retain its own loaded memory");
    assert.deepEqual(
      safe.map((candidate) => candidate.namespace),
      ["shared"],
      "status filtering must use the memory belonging to each result namespace",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
