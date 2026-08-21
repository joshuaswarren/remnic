import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { parseConfig } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";
import { StorageManager } from "../src/storage.js";
import type { QmdSearchResult } from "../src/types.js";

test("cold fallback excludes artifact paths from generic relevant memory recall", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-cold-artifact-parity-"));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "engram-cold-artifact-parity-workspace-"));

  try {
    const config = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir,
      qmdEnabled: true,
      qmdMaxResults: 4,
      qmdCollection: "engram-hot",
      qmdColdTierEnabled: true,
      qmdColdCollection: "engram-cold",
      verbatimArtifactsEnabled: false,
      embeddingFallbackEnabled: false,
      recallPlannerEnabled: true,
    });
    const orchestrator = new Orchestrator(config) as any;

    const coldStorage = new StorageManager(path.join(memoryDir, "cold"));
    const { id: factId } = await coldStorage.writeMemory("fact", "cold tier fact should remain visible", {
      source: "test",
    });
    const fact = await coldStorage.getMemoryById(factId);
    assert.ok(fact);

    const artifactId = await coldStorage.writeArtifact("artifact quote should never enter generic recall", {
      sourceMemoryId: factId,
      artifactType: "fact",
    });
    const day = new Date().toISOString().slice(0, 10);
    const artifactPath = path.join(memoryDir, "cold", "artifacts", day, `${artifactId}.md`);
    const artifact = await coldStorage.readMemoryByPath(artifactPath);
    assert.ok(artifact);

    orchestrator.qmd = {
      isAvailable: () => true,
      search: async () => [],
      hybridSearch: async () => [],
    };

    orchestrator.fetchQmdMemoryResultsWithArtifactTopUp = async (
      _prompt: string,
      _qmdFetchLimit: number,
      _qmdHybridFetchLimit: number,
      opts: { collection?: string },
    ): Promise<QmdSearchResult[]> => {
      if (opts.collection === "engram-cold") {
        return [
          {
            docid: artifact!.frontmatter.id,
            path: artifact!.path,
            score: 0.99,
            snippet: artifact!.content,
          },
          {
            docid: fact!.frontmatter.id,
            path: fact!.path,
            score: 0.98,
            snippet: fact!.content,
          },
        ];
      }
      return [];
    };

    const output = await orchestrator.recallInternal(
      "What happened in the archive?",
      "session-cold-artifact-isolation",
    );

    assert.match(output, /Long-Term Memories \(Fallback\)/);
    assert.match(output, /cold tier fact should remain visible/);
    assert.doesNotMatch(output, /artifact quote should never enter generic recall/);
  } finally {
    await rm(memoryDir, { recursive: true, force: true, maxRetries: 3 });
    await rm(workspaceDir, { recursive: true, force: true, maxRetries: 3 });
  }
});
